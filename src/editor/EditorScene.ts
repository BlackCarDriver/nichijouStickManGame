/**
 * 编辑器画布场景。
 *
 * 职责边界：
 * - 只负责**渲染** store 的数据 + **收集**鼠标交互 → 调用 store 的方法
 * - 物理世界暂停（编辑时物体不下落），渲染直接复用游戏的 buildMap
 *   → 编辑器所见 = 游戏所得
 */
import Phaser from 'phaser';
import { buildMap, destroyMapRuntime } from '../map/MapLoader';
import type { MapObjectRuntime } from '../map/MapLoader';
import { ensureMaterialTextures, preloadMaterialTextures } from '../map/TextureLoader';
import { MATERIALS } from '../config/materials';
import { PLAYER_CONFIG } from '../entities/Player';
import { StickmanRenderer } from '../render/StickmanRenderer';
import { editorStore, PREFAB_RIG } from './EditorStore';
import type { EditorTab, ToolKind } from './EditorStore';
import { jumpMetrics, type Vec } from './geometry';
import { setStatus } from './status';

/** 预制件工作台上的鼠标操作（移动 / 改大小 / 旋转） */
type PrefabDrag =
  | { kind: 'move'; index: number; last: Vec }
  | { kind: 'resize'; index: number; center: Vec }
  | { kind: 'rotate'; index: number; center: Vec };

interface DragState {
  kind: 'move' | 'create' | 'ruler';
  start: Vec;
  current: Vec;
  /** create 工具类型 */
  createType?: ToolKind;
  /** move 起始位置（用于计算增量） */
  lastApplied: Vec;
}

const SPAWN_COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f];

export class EditorScene extends Phaser.Scene {
  private runtime: MapObjectRuntime[] = [];
  private gridGfx!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Graphics;
  private unsubscribe?: () => void;
  private rebuildQueued = false;
  private drag: DragState | null = null;
  private panning: { startScroll: Vec; pointer: Vec } | null = null;
  private spaceDown = false;
  private suppressRebuild = false;
  /** 预制件工作台的鼠标操作状态 */
  private prefabDrag: PrefabDrag | null = null;
  /** 火柴人参照（尺寸对比用） */
  private refFigure!: Phaser.GameObjects.Graphics;
  private refGuide!: Phaser.GameObjects.Graphics;
  private lastNotify = 0;
  private lastTab: EditorTab = 'map';

  constructor() {
    super('EditorScene');
  }

  preload(): void {
    preloadMaterialTextures(
      this,
      Object.values(MATERIALS).map((m) => m.texture),
    );
  }

  create(): void {
    editorStore.map; // 触发 store 初始化
    // 编辑时暂停物理：物体不下落，位置完全由数据决定
    this.matter.world.pause();

    this.gridGfx = this.add.graphics().setDepth(-1000);
    this.refGuide = this.add.graphics().setDepth(400);
    this.refFigure = this.add.graphics().setDepth(401);
    this.overlay = this.add.graphics().setDepth(1000);
    this.cameras.main.setBackgroundColor('#15151f');

    this.setupInput();

    this.unsubscribe = editorStore.subscribe(() => {
      if (this.suppressRebuild) {
        this.drawOverlay();
        return;
      }
      this.queueRebuild();
    });

    this.events.once('shutdown', () => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      try {
        destroyMapRuntime(this, this.runtime);
      } catch {
        /* 场景销毁时 body 可能已被移除 */
      }
      this.runtime = [];
    });

    this.rebuildAll();
    this.fitToMap();
    this.lastTab = editorStore.tab;
  }

  // ---------------- 渲染 ----------------
  private queueRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    this.time.delayedCall(0, () => {
      this.rebuildQueued = false;
      this.rebuildAll();
    });
  }

  private rebuildAll(): void {
    const store = editorStore;
    if (store.tab !== this.lastTab) {
      this.lastTab = store.tab;
      this.fitToMap();
    }
    // 贴图按需加载：新增/替换贴图后加载完再重建一次
    ensureMaterialTextures(
      this,
      Object.values(MATERIALS).map((m) => ({
        ref: m.texture,
        override: m.texture ? store.textureOverrides.get(m.texture) : undefined,
      })),
      () => this.queueRebuild(),
    );
    try {
      destroyMapRuntime(this, this.runtime);
    } catch {
      /* ignore */
    }
    this.runtime = buildMap(this, store.renderMap(), store.prefabTable());
    this.drawGrid();
    this.drawReferenceFigure();
    this.drawOverlay();
  }

  private drawGrid(): void {
    const g = this.gridGfx;
    g.clear();
    const store = editorStore;
    if (!store.showGrid || store.gridSize <= 0) return;

    const view = this.cameras.main.worldView;
    const step = store.gridSize;
    const major = step * 5;
    const startX = Math.floor(view.x / step) * step;
    const endX = Math.ceil((view.x + view.width) / step) * step;
    const startY = Math.floor(view.y / step) * step;
    const endY = Math.ceil((view.y + view.height) / step) * step;

    for (let x = startX; x <= endX; x += step) {
      const isMajor = x % major === 0;
      g.lineStyle(1, isMajor ? 0x3a3a52 : 0x26263a, isMajor ? 0.9 : 0.6);
      g.lineBetween(x, view.y, x, view.y + view.height);
    }
    for (let y = startY; y <= endY; y += step) {
      const isMajor = y % major === 0;
      g.lineStyle(1, isMajor ? 0x3a3a52 : 0x26263a, isMajor ? 0.9 : 0.6);
      g.lineBetween(view.x, y, view.x + view.width, y);
    }
  }

  /** 预制件/材质工作台里画一个火柴人 + 高度标尺，作为尺寸参照 */
  private drawReferenceFigure(): void {
    const store = editorStore;
    const g = this.refFigure;
    const guide = this.refGuide;
    guide.clear();
    if (store.tab === 'map') {
      g.setVisible(false);
      return;
    }
    g.setVisible(true);
    const map = store.renderMap();
    const spawn = map.spawnPoints[0] ?? { x: 200, y: PREFAB_RIG.groundY - 48 };
    // 预制件 Tab 把参照放到预制件左侧，避免和部件重叠
    const fx = store.tab === 'prefab' ? store.prefabRigOrigin().x - 260 : spawn.x;
    const fy = spawn.y;

    g.setPosition(fx, fy);
    StickmanRenderer.draw(g, {
      color: 0x8fa3b8,
      gaitTime: 0,
      pose: 'idle',
      moving: false,
      grounded: true,
      hitIntensity: 0,
      hitPhase: 0,
      velocityX: 0,
      velocityY: 0,
    });

    // 高度标尺：脚底(中心+48) → 头顶(中心-63)，总高约 111px
    const feet = fy + PLAYER_CONFIG.bodyHeight / 2;
    const head = fy - 63;
    const bx = fx + 46;
    guide.lineStyle(1, 0x8fa3b8, 0.55);
    guide.lineBetween(bx, head, bx, feet);
    guide.lineBetween(bx - 6, head, bx + 6, head);
    guide.lineBetween(bx - 6, feet, bx + 6, feet);
    guide.lineStyle(1, 0x8fa3b8, 0.18);
    guide.lineBetween(bx - 60, feet, bx + 160, feet);
  }

  // ---------------- 预制件工作台交互 ----------------
  private prefabPointerDown(p: Vec): void {
    const store = editorStore;
    const z = this.cameras.main.zoom;
    const hs = 9 / z;
    const idx = store.selectedPartIndex();

    if (idx !== null) {
      const b = store.partWorldBounds(idx);
      const c = store.partWorldCenter(idx);
      if (b && c) {
        const resizeHandle = { x: b.maxX, y: b.maxY };
        const rotateHandle = { x: (b.minX + b.maxX) / 2, y: b.minY - 30 / z };
        if (Math.hypot(p.x - resizeHandle.x, p.y - resizeHandle.y) <= hs) {
          this.prefabDrag = { kind: 'resize', index: idx, center: c };
          return;
        }
        if (Math.hypot(p.x - rotateHandle.x, p.y - rotateHandle.y) <= hs) {
          this.prefabDrag = { kind: 'rotate', index: idx, center: c };
          return;
        }
      }
    }

    const hit = store.hitTestPart(p);
    if (hit === null) {
      store.select([]);
      return;
    }
    store.select([`part:${hit}`]);
    this.prefabDrag = { kind: 'move', index: hit, last: p };
  }

  private prefabPointerMove(p: Vec, shiftKey: boolean): void {
    const d = this.prefabDrag;
    if (!d) return;
    const store = editorStore;
    const part = store.prefabDraft.parts[d.index];
    if (!part) return;
    const local = store.worldToPartLocal(p);

    if (d.kind === 'move') {
      const center = store.partWorldCenter(d.index);
      if (!center) return;
      const target = store.snapPoint({
        x: center.x + (p.x - d.last.x),
        y: center.y + (p.y - d.last.y),
      });
      d.last = p;
      const lc = store.worldToPartLocal(target);
      if (part.type === 'rect') {
        store.patchPartLive(d.index, { x: lc.x - part.w / 2, y: lc.y - part.h / 2 });
      } else {
        store.patchPartLive(d.index, { x: lc.x, y: lc.y });
      }
      this.queueRebuild();
      return;
    }

    if (d.kind === 'resize') {
      const cLocal = store.worldToPartLocal(d.center);
      if (part.type === 'rect') {
        const halfW = Math.abs(local.x - cLocal.x);
        const halfH = Math.abs(local.y - cLocal.y);
        const w = Math.max(4, store.snapToGrid ? store.snapValue(halfW * 2) : halfW * 2);
        const h = Math.max(4, store.snapToGrid ? store.snapValue(halfH * 2) : halfH * 2);
        store.patchPartLive(d.index, { x: cLocal.x - w / 2, y: cLocal.y - h / 2, w, h });
      } else {
        const r = Math.hypot(local.x - cLocal.x, local.y - cLocal.y);
        store.patchPartLive(d.index, {
          radius: Math.max(3, store.snapToGrid ? store.snapValue(r) : r),
        });
      }
      this.queueRebuild();
      return;
    }

    // rotate
    const dx = p.x - d.center.x;
    const dy = p.y - d.center.y;
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;
    if (shiftKey) deg = Math.round(deg / 15) * 15;
    store.patchPartLive(d.index, { angle: Math.round(deg * 10) / 10 });
    this.queueRebuild();
  }

  private prefabPointerUp(): boolean {
    if (!this.prefabDrag) return false;
    this.prefabDrag = null;
    editorStore.commit();
    return true;
  }

  private drawOverlay(): void {
    const store = editorStore;
    const g = this.overlay;
    g.clear();

    // 预制件工作台：选中部件的 gizmo（缩放手柄 + 旋转手柄）
    if (store.tab === 'prefab') {
      const idx = store.selectedPartIndex();
      const b = idx === null ? null : store.partWorldBounds(idx);
      const c = idx === null ? null : store.partWorldCenter(idx);
      if (b && c) {
        const z = this.cameras.main.zoom;
        const hs = 6 / z;
        g.lineStyle(2, 0x4dd6ff, 1);
        g.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
        // 旋转手柄（上方）
        const rx = (b.minX + b.maxX) / 2;
        const ry = b.minY - 30 / z;
        g.lineStyle(2, 0x4dd6ff, 0.7);
        g.lineBetween(rx, b.minY, rx, ry);
        g.fillStyle(0x4dd6ff, 1);
        g.fillCircle(rx, ry, hs);
        // 缩放手柄（右下角）
        g.fillStyle(0x2ecc71, 1);
        g.fillRect(b.maxX - hs, b.maxY - hs, hs * 2, hs * 2);
        // 中心点（旋转枢轴）
        g.fillStyle(0xffffff, 0.7);
        g.fillCircle(c.x, c.y, hs * 0.55);
      }
    }

    if (store.tab === 'map') {
      // 地图边界
      g.lineStyle(2, 0x555577, 0.8);
      g.strokeRect(0, 0, store.map.width, store.map.height);

      // 空投区域
      for (const z of store.map.weaponDropZones ?? []) {
        g.lineStyle(2, 0xf1c40f, 0.5);
        g.strokeRect(z.x, z.y, z.w, z.h);
        g.lineStyle(1, 0xf1c40f, 0.2);
        g.lineBetween(z.x, z.y + z.h / 2, z.x + z.w, z.y + z.h / 2);
      }

      // 出生点
      store.map.spawnPoints.forEach((sp, i) => {
        const color = SPAWN_COLORS[i % SPAWN_COLORS.length];
        g.lineStyle(3, color, 1);
        g.strokeCircle(sp.x, sp.y, 26);
        g.lineBetween(sp.x - 34, sp.y, sp.x + 34, sp.y);
        g.lineBetween(sp.x, sp.y - 34, sp.x, sp.y + 34);
        g.fillStyle(color, 0.15);
        g.fillCircle(sp.x, sp.y, 26);
      });

      // 关节：主体中心 → 锚点
      for (const j of store.joints()) {
        const center = store.centerOfObject(j.bodyA);
        g.lineStyle(2, 0xff5ce6, 0.9);
        if (center) g.lineBetween(center.x, center.y, j.anchor.x, j.anchor.y);
        g.fillStyle(0xff5ce6, 1);
        g.fillCircle(j.anchor.x, j.anchor.y, 5);
        g.lineStyle(2, 0xff5ce6, 1);
        g.strokeCircle(j.anchor.x, j.anchor.y, 11);
      }
    }

    // 选中框
    const b = store.selectionBounds();
    if (b) {
      g.lineStyle(2, 0x4dd6ff, 1);
      g.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      g.fillStyle(0x4dd6ff, 1);
      for (const [hx, hy] of [
        [b.minX, b.minY],
        [b.maxX, b.minY],
        [b.minX, b.maxY],
        [b.maxX, b.maxY],
      ]) {
        g.fillRect(hx - 3, hy - 3, 6, 6);
      }
    }

    // 创建预览
    if (this.drag?.kind === 'create') {
      const { start, current } = this.drag;
      const minX = Math.min(start.x, current.x);
      const minY = Math.min(start.y, current.y);
      const w = Math.abs(current.x - start.x);
      const h = Math.abs(current.y - start.y);
      g.lineStyle(2, 0x7bed9f, 0.9);
      if (this.drag.createType === 'circle') {
        g.strokeCircle((start.x + current.x) / 2, (start.y + current.y) / 2, Math.max(w, h) / 2);
      } else {
        g.strokeRect(minX, minY, w, h);
      }
      g.lineStyle(1, 0x7bed9f, 0.4);
      g.lineBetween(minX, minY, minX + w, minY + h);
    }

    // 尺子
    if (store.ruler) {
      const { from, to } = store.ruler;
      g.lineStyle(2, 0xffffff, 0.85);
      g.lineBetween(from.x, from.y, to.x, to.y);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(from.x, from.y, 4);
      g.fillCircle(to.x, to.y, 4);
    }
  }

  // ---------------- 相机 ----------------
  fitToMap(): void {
    const map = editorStore.renderMap();
    const cam = this.cameras.main;
    const zoom = Math.min(cam.width / map.width, cam.height / map.height) * 0.88;
    cam.setZoom(Phaser.Math.Clamp(zoom, 0.08, 3));
    cam.centerOn(map.width / 2, map.height / 2);
    this.drawGrid();
    this.drawOverlay();
  }

  private worldPoint(pointer: Phaser.Input.Pointer): Vec {
    const p = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return { x: p.x, y: p.y };
  }

  // ---------------- 输入 ----------------
  private setupInput(): void {
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.on(
      'wheel',
      (pointer: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
        const cam = this.cameras.main;
        const before = this.worldPoint(pointer);
        const factor = dy > 0 ? 0.9 : 1.1;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, 0.08, 4));
        const after = this.worldPoint(pointer);
        // 以鼠标位置为锚点缩放
        cam.scrollX += before.x - after.x;
        cam.scrollY += before.y - after.y;
        this.drawGrid();
        this.drawOverlay();
      },
    );
    this.input.keyboard?.on('keydown-SPACE', () => {
      this.spaceDown = true;
    });
    this.input.keyboard?.on('keyup-SPACE', () => {
      this.spaceDown = false;
    });
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    const store = editorStore;
    const p = this.worldPoint(pointer);

    if (pointer.rightButtonDown() || pointer.middleButtonDown() || this.spaceDown) {
      this.panning = {
        startScroll: { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY },
        pointer: { x: pointer.x, y: pointer.y },
      };
      return;
    }

    if (store.tab === 'prefab') {
      this.prefabPointerDown(p);
      this.drawOverlay();
      return;
    }

    switch (store.tool) {
      case 'select': {
        const hit = store.hitTest(p);
        if (hit) {
          if (pointer.event.shiftKey) {
            store.toggleSelect(hit.id);
          } else if (!store.selection.includes(hit.id)) {
            store.select([hit.id]);
          }
          this.drag = { kind: 'move', start: p, current: p, lastApplied: { x: 0, y: 0 } };
          this.suppressRebuild = true;
        } else {
          store.select([]);
        }
        break;
      }
      case 'rect':
      case 'circle':
      case 'polygon': {
        const sp = store.snapPoint(p);
        this.drag = { kind: 'create', start: sp, current: sp, createType: store.tool, lastApplied: { x: 0, y: 0 } };
        break;
      }
      case 'spawn': {
        const sp = store.snapPoint(p);
        store.addSpawn(sp.x, sp.y);
        break;
      }
      case 'prefab': {
        if (store.activePrefabId) {
          const sp = store.snapPoint(p);
          store.addPrefabInstance(store.activePrefabId, sp.x, sp.y);
        } else {
          store.message = '请先在左侧选择一个预制件';
          store.touch();
        }
        break;
      }
      case 'joint': {
        if (!store.pendingJointBodyA) {
          const hit = store.hitTest(p);
          if (hit?.kind === 'object') {
            store.pendingJointBodyA = hit.id;
            store.message = store.jointHint();
            store.touch();
          } else {
            store.message = '关节：请先点选一个地图物体（不能用预制件部件）';
            store.touch();
          }
        } else {
          const anchor = store.snapPoint(p);
          store.addJoint(store.pendingJointBodyA, anchor);
          setStatus(`已创建关节：${store.joints().length} 个`);
        }
        break;
      }
      case 'ruler': {
        const sp = store.snapPoint(p);
        this.drag = { kind: 'ruler', start: sp, current: sp, lastApplied: { x: 0, y: 0 } };
        break;
      }
    }
    this.drawOverlay();
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const store = editorStore;
    const p = this.worldPoint(pointer);

    if (this.panning) {
      const cam = this.cameras.main;
      cam.scrollX = this.panning.startScroll.x - (pointer.x - this.panning.pointer.x) / cam.zoom;
      cam.scrollY = this.panning.startScroll.y - (pointer.y - this.panning.pointer.y) / cam.zoom;
      this.drawGrid();
      this.drawOverlay();
      return;
    }

    if (this.prefabDrag) {
      const shift = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
      this.prefabPointerMove(p, shift);
      return;
    }

    if (!this.drag) return;

    if (this.drag.kind === 'move') {
      const target = store.snapPoint(p);
      const dx = target.x - this.drag.start.x - this.drag.lastApplied.x;
      const dy = target.y - this.drag.start.y - this.drag.lastApplied.y;
      if (dx === 0 && dy === 0) return;
      this.drag.lastApplied = { x: this.drag.lastApplied.x + dx, y: this.drag.lastApplied.y + dy };
      store.translateSelected(dx, dy);
      this.translateRuntime(dx, dy);
      this.drawOverlay();
      // 节流通知 UI 更新数值
      const now = performance.now();
      if (now - this.lastNotify > 90) {
        this.lastNotify = now;
        store.touch();
      }
      return;
    }

    this.drag.current = store.snapPoint(p);
    this.drawOverlay();

    if (this.drag.kind === 'ruler') {
      const d = Math.hypot(this.drag.current.x - this.drag.start.x, this.drag.current.y - this.drag.start.y);
      const m = jumpMetrics(PLAYER_CONFIG.moveSpeed, PLAYER_CONFIG.jumpVelocity);
      const verdict = d <= m.safeGap ? '可轻松跳过' : d <= m.distance ? '极限' : '跳不过去';
      setStatus(
        `尺子：${Math.round(d)}px ｜ 跳跃能力 高 ${Math.round(m.height)}px / 远 ${Math.round(m.distance)}px（安全 ${Math.round(m.safeGap)}px）→ ${verdict}`,
      );
    }
  }

  private onPointerUp(): void {
    const store = editorStore;
    if (this.panning) {
      this.panning = null;
      return;
    }
    if (this.prefabPointerUp()) return;
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;

    if (drag.kind === 'move') {
      this.suppressRebuild = false;
      store.commit();
      return;
    }

    if (drag.kind === 'create') {
      this.createFromDrag(drag);
      return;
    }

    if (drag.kind === 'ruler') {
      store.ruler = { from: drag.start, to: drag.current };
      const d = Math.hypot(drag.current.x - drag.start.x, drag.current.y - drag.start.y);
      const m = jumpMetrics(PLAYER_CONFIG.moveSpeed, PLAYER_CONFIG.jumpVelocity);
      const verdict = d <= m.safeGap ? '可轻松跳过' : d <= m.distance ? '极限' : '跳不过去';
      setStatus(
        `尺子：${Math.round(d)}px ｜ 跳跃能力 高 ${Math.round(m.height)}px / 远 ${Math.round(m.distance)}px（安全 ${Math.round(m.safeGap)}px）→ ${verdict}`,
      );
      this.drawOverlay();
    }
  }

  private createFromDrag(drag: DragState): void {
    const store = editorStore;
    const { start, current, createType } = drag;
    const minX = Math.min(start.x, current.x);
    const minY = Math.min(start.y, current.y);
    const maxX = Math.max(start.x, current.x);
    const maxY = Math.max(start.y, current.y);
    const w = maxX - minX;
    const h = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const minSize = Math.max(store.gridSize, 10);
    const material = store.activeMaterialId;

    if (createType === 'rect') {
      store.addObject({
        type: 'rect',
        x: minX,
        y: minY,
        w: Math.max(w, minSize),
        h: Math.max(h, minSize),
        material,
      });
    } else if (createType === 'circle') {
      store.addObject({
        type: 'circle',
        x: centerX,
        y: centerY,
        radius: Math.max(w, h, minSize) / 2,
        material,
      });
    } else {
      store.addObject({
        type: 'polygon',
        x: centerX,
        y: centerY,
        sides: 3,
        radius: Math.max(w, h, minSize) / 2,
        material,
      });
    }
    store.tool = 'select';
    this.drawOverlay();
  }

  /** 拖动时直接平移已渲染的运行时对象（避免整图重建卡顿） */
  private translateRuntime(dx: number, dy: number): void {
    const sel = new Set(editorStore.selection);
    const prefixes = [...sel].map((id) => `${id}#`);
    for (const item of this.runtime) {
      const match = sel.has(item.id) || prefixes.some((pre) => item.id.startsWith(pre));
      if (!match) continue;
      if (item.body) {
        this.matter.body.setPosition(item.body, {
          x: item.body.position.x + dx,
          y: item.body.position.y + dy,
        });
      } else {
        const visual = item.visual as unknown as { x: number; y: number };
        if (typeof visual.x === 'number') {
          visual.x += dx;
          visual.y += dy;
        }
      }
    }
  }
}

/** 工具函数：矩形右边界 */
