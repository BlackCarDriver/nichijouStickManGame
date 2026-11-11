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
import type { MapObject, MapObjectCircle, MapObjectPolygon, MapObjectRect } from '../map/MapFormat';
import { MATERIALS } from '../config/materials';
import { PLAYER_CONFIG } from '../entities/Player';
import { StickmanRenderer } from '../render/StickmanRenderer';
import { editorStore, PREFAB_RIG } from './EditorStore';
import type { EditorTab, ToolKind } from './EditorStore';
import { jumpMetrics, objectCenter, type Vec } from './geometry';
import { centroidOf, currentVertices, nearestEdge } from './polygonEdit';
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
  /** 多边形顶点拖动状态 */
  private vertexDrag: { index: number } | null = null;
  /** 双击检测 */
  private lastDownTime = 0;
  private lastDownPos: Vec | null = null;
  /** 最近一次移动时是否按住 Shift（Shift = 不吸附） */
  private lastShift = false;
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
    this.rebuildQueued = true;
  }

  /** 每帧最多重建一次（在 update 早期处理） */
  update(): void {
    // 兜底：鼠标已松开但拖动状态残留（例如在画布外松开、窗口失焦）
    if ((this.prefabDrag || this.vertexDrag || this.drag) && !this.input.activePointer.isDown) {
      this.onPointerUp();
    }
    if (!this.rebuildQueued) return;
    this.rebuildQueued = false;
    this.rebuildAll();
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

  /** 虚线（Graphics 没有原生 dash） */
  private drawDashed(g: Phaser.GameObjects.Graphics, a: Vec, b: Vec, dash: number): void {
    const total = Math.hypot(b.x - a.x, b.y - a.y);
    if (total < 1e-6) return;
    const ux = (b.x - a.x) / total;
    const uy = (b.y - a.y) / total;
    const steps = Math.max(1, Math.floor(total / (dash * 2)));
    for (let i = 0; i < steps; i++) {
      const from = i * dash * 2;
      const to = Math.min(from + dash, total);
      g.lineBetween(a.x + ux * from, a.y + uy * from, a.x + ux * to, a.y + uy * to);
    }
  }

  /** 双击检测（320ms 内 + 同位置附近） */
  private detectDoubleClick(p: Vec): boolean {
    const now = performance.now();
    const close = this.lastDownPos
      ? Math.hypot(p.x - this.lastDownPos.x, p.y - this.lastDownPos.y) < 12 / this.cameras.main.zoom
      : false;
    const isDouble = now - this.lastDownTime < 320 && close;
    this.lastDownTime = now;
    this.lastDownPos = p;
    return isDouble;
  }

  /**
   * 顶点编辑交互（优先于物体拖动）：
   * - 拖动顶点 = 移动；Alt + 点击顶点 = 删除；双击边 = 插入顶点
   */
  private tryVertexEdit(p: Vec, altKey: boolean, doubleClick: boolean): boolean {
    const store = editorStore;
    const verts = store.polygonWorldVertices();
    if (verts.length < 3) return false;
    const z = this.cameras.main.zoom;
    const hs = 9 / z;

    const vi = verts.findIndex((v) => Math.hypot(p.x - v.x, p.y - v.y) <= hs);
    if (vi >= 0) {
      if (altKey) {
        store.polygonDeleteVertex(vi);
        return true;
      }
      this.vertexDrag = { index: vi };
      this.suppressRebuild = true;
      return true;
    }

    // 点在边附近：双击=插点，否则"吃掉"这次点击保持选中（避免点边时把物体取消选中）
    const edge = nearestEdge(verts, p, 14 / z);
    if (edge >= 0) {
      if (doubleClick) {
        store.polygonInsertVertex(edge, p);
      }
      return true;
    }
    return false;
  }

  // ---------------- 预制件工作台交互 ----------------
  private prefabPointerDown(p: Vec, altKey = false, doubleClick = false): void {
    const store = editorStore;
    // 顶点手柄优先级最高（选中多边形部件时）
    if (this.tryVertexEdit(p, altKey, doubleClick)) return;

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
          this.suppressRebuild = true;
          return;
        }
        if (Math.hypot(p.x - rotateHandle.x, p.y - rotateHandle.y) <= hs) {
          this.prefabDrag = { kind: 'rotate', index: idx, center: c };
          this.suppressRebuild = true;
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
    this.suppressRebuild = true;
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
      // 拖动过程中不吸附（像素级跟手），松手时再对齐网格
      const raw = { x: center.x + (p.x - d.last.x), y: center.y + (p.y - d.last.y) };
      const target = raw;
      d.last = p;
      const lc = store.worldToPartLocal(target);
      if (part.type === 'rect') {
        store.patchPartLive(d.index, { x: lc.x - part.w / 2, y: lc.y - part.h / 2 });
      } else {
        store.patchPartLive(d.index, { x: lc.x, y: lc.y });
      }
      this.applyLiveVisual(this.partRuntimeId(d.index), part, store.prefabRigOrigin());
      this.drawOverlay();
      return;
    }

    if (d.kind === 'resize') {
      const cLocal = store.worldToPartLocal(d.center);
      if (part.type === 'rect') {
        const halfW = Math.abs(local.x - cLocal.x);
        const halfH = Math.abs(local.y - cLocal.y);
        const w = Math.max(4, halfW * 2);
        const h = Math.max(4, halfH * 2);
        store.patchPartLive(d.index, { x: cLocal.x - w / 2, y: cLocal.y - h / 2, w, h });
      } else {
        const r = Math.hypot(local.x - cLocal.x, local.y - cLocal.y);
        store.patchPartLive(d.index, { radius: Math.max(3, r) });
      }
      this.applyLiveVisual(this.partRuntimeId(d.index), part, store.prefabRigOrigin());
      this.drawOverlay();
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
    this.applyLiveVisual(this.partRuntimeId(d.index), part, store.prefabRigOrigin());
    this.drawOverlay();
  }

  private prefabPointerUp(): boolean {
    const d = this.prefabDrag;
    if (!d) return false;
    this.prefabDrag = null;
    const store = editorStore;
    // 松手时吸附到网格（按住 Shift 则不吸附）
    if (!this.lastShift) {
      if (d.kind === 'move') store.snapPartToGrid(d.index);
      else if (d.kind === 'resize') {
        const part = store.prefabDraft.parts[d.index];
        if (part?.type === 'rect' && store.snapToGrid) {
          const c = objectCenter(part);
          const w = Math.max(4, store.snapValue(part.w));
          const h = Math.max(4, store.snapValue(part.h));
          store.patchPartLive(d.index, { x: c.x - w / 2, y: c.y - h / 2, w, h });
        } else if (part && store.snapToGrid) {
          const r = (part as { radius?: number }).radius;
          if (typeof r === 'number') store.patchPartLive(d.index, { radius: Math.max(3, store.snapValue(r)) });
        }
      } else if (d.kind === 'rotate') {
        const part = store.prefabDraft.parts[d.index];
        if (part) store.patchPartLive(d.index, { angle: Math.round(part.angle ?? 0) });
      }
    }
    this.lastShift = false;
    this.suppressRebuild = false; // 松手后完整重建一次，保证物理体与数据一致
    store.commit();
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

    // 多边形顶点手柄（地图 / 预制件两种 Tab 通用）
    const polyVerts = store.polygonWorldVertices();
    if (polyVerts.length >= 3) {
      const z = this.cameras.main.zoom;
      const hs = 4.5 / z;
      // 凹形提示：Matter 会按凸包处理，用红色虚线画出"物理实际形状"
      if (store.polygonIsConcave()) {
        const hull = store.polygonConvexHullWorld();
        g.lineStyle(1.5, 0xff6b6b, 0.9);
        for (let i = 0; i < hull.length; i++) {
          this.drawDashed(g, hull[i], hull[(i + 1) % hull.length], 6 / z);
        }
      }
      for (const v of polyVerts) {
        const pad = 1.5 / z;
        g.fillStyle(0x0a0a12, 0.9);
        g.fillRect(v.x - hs - pad, v.y - hs - pad, (hs + pad) * 2, (hs + pad) * 2);
        g.fillStyle(0x48dbfb, 1);
        g.fillRect(v.x - hs, v.y - hs, hs * 2, hs * 2);
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
    // 在画布外松开鼠标也要结束拖动
    this.input.on('pointerupoutside', this.onPointerUp, this);
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

    const doubleClick = this.detectDoubleClick(p);
    const altKey = (pointer.event as MouseEvent | undefined)?.altKey === true;

    if (store.tab === 'prefab') {
      this.prefabPointerDown(p, altKey, doubleClick);
      this.drawOverlay();
      return;
    }

    // 地图 Tab：选择工具下优先响应多边形顶点手柄
    if (store.tool === 'select' && this.tryVertexEdit(p, altKey, doubleClick)) {
      this.drawOverlay();
      return;
    }
    this.lastShift = (pointer.event as MouseEvent | undefined)?.shiftKey === true;

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

    if (this.vertexDrag) {
      const store = editorStore;
      const shift = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
      const target = store.snapToGrid && !shift ? store.snapPoint(p) : p;
      store.polygonMoveVertex(this.vertexDrag.index, target);
      // 实时重画多边形（不重建整个物理世界）
      const t = store.polygonTarget();
      if (t) {
        if (t.scope === 'map') {
          const obj = store.getObject(t.id);
          if (obj) this.applyLiveVisual(t.id, obj, { x: 0, y: 0 });
        } else {
          const part = store.prefabDraft.parts[t.index];
          if (part) this.applyLiveVisual(this.partRuntimeId(t.index), part, store.prefabRigOrigin());
        }
      }
      this.drawOverlay();
      return;
    }

    if (this.prefabDrag) {
      const shift = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
      this.lastShift = shift;
      this.prefabPointerMove(p, shift);
      return;
    }

    if (!this.drag) return;

    if (this.drag.kind === 'move') {
      // 拖动过程中用原始坐标（像素级跟手），松手时再吸附
      const target = p;
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
    if (this.vertexDrag) {
      this.vertexDrag = null;
      this.suppressRebuild = false;
      editorStore.commit();
      return;
    }
    if (this.prefabPointerUp()) return;
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;

    if (drag.kind === 'move') {
      if (!this.lastShift) store.snapSelectedToGrid();
      this.lastShift = false;
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

  /**
   * 拖动过程中的"实时视觉更新"：只改已存在的显示对象（位置/尺寸/旋转/顶点），
   * 不销毁重建（避免每帧新建 TileSprite/刚体导致的掉帧）。松手后统一重建一次。
   *
   * 注意：Phaser Matter 里 gameObject.x/y 是 body.position 的代理，
   * 所以设置位置会同时移动刚体，视觉与物理保持一致。
   */
  private applyLiveVisual(runtimeId: string, obj: MapObject, offset: Vec): void {
    const item = this.runtime.find((r) => r.id === runtimeId);
    if (!item) return;
    const mat = MATERIALS[obj.material];
    const alpha = mat?.opacity ?? 1;
    const color = obj.color ? parseInt(obj.color.replace('#', ''), 16) : (mat?.color ?? 0xffffff);
    const rot = ((obj.angle ?? 0) * Math.PI) / 180;
    const v = item.visual;

    if (v instanceof Phaser.GameObjects.TileSprite) {
      const r = obj as MapObjectRect;
      v.setPosition(offset.x + r.x + r.w / 2, offset.y + r.y + r.h / 2);
      if (v.width !== r.w || v.height !== r.h) v.setSize(r.w, r.h);
      if (v.rotation !== rot) v.setRotation(rot);
      if (v.alpha !== alpha) v.setAlpha(alpha);
    } else if (v instanceof Phaser.GameObjects.Image) {
      const r = obj as MapObjectRect;
      v.setPosition(offset.x + r.x + r.w / 2, offset.y + r.y + r.h / 2);
      if (v.displayWidth !== r.w || v.displayHeight !== r.h) v.setDisplaySize(r.w, r.h);
      if (v.rotation !== rot) v.setRotation(rot);
      if (v.alpha !== alpha) v.setAlpha(alpha);
    } else if (v instanceof Phaser.GameObjects.Rectangle) {
      const r = obj as MapObjectRect;
      v.setPosition(offset.x + r.x + r.w / 2, offset.y + r.y + r.h / 2);
      v.setSize(r.w, r.h);
      v.setFillStyle(color, 1);
      v.setRotation(rot);
      v.setAlpha(alpha);
    } else if (v instanceof Phaser.GameObjects.Arc) {
      const c = obj as MapObjectCircle;
      v.setPosition(offset.x + c.x, offset.y + c.y);
      v.setRadius(c.radius);
      v.setFillStyle(color, 1);
      v.setAlpha(alpha);
    } else if (v instanceof Phaser.GameObjects.Container) {
      const p = obj as MapObjectPolygon;
      const vs = currentVertices(p);
      const cen = centroidOf(vs);
      v.setPosition(offset.x + p.x + cen.x, offset.y + p.y + cen.y);
      v.setRotation(rot);
      v.setAlpha(alpha);
      const g = v.getAt(0);
      if (g instanceof Phaser.GameObjects.Graphics) {
        g.clear();
        g.fillStyle(color, 1);
        g.lineStyle(2, 0x000000, 0.5);
        const pts = vs.map((pt) => new Phaser.Geom.Point(pt.x, pt.y));
        g.fillPoints(pts, true);
        g.strokePoints(pts, true);
      }
    }
  }

  /** 预制件部件对应的运行时 id */
  private partRuntimeId(index: number): string {
    return `${editorStore.prefabDraft.id}#${index}`;
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
