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
import { syncVisualMasks } from '../map/ShapeTexture';
import { getItem } from '../world/ItemFormat';
import { updateMaterialGlows } from '../map/MaterialGlow';
import { updateObjectLabels } from '../map/ObjectLabel';
import type { MapObject, MapObjectCircle, MapObjectPolygon, MapObjectRect } from '../map/MapFormat';
import { MATERIALS } from '../config/materials';
import { PLAYER_CONFIG } from '../entities/Player';
import { StickmanRenderer } from '../render/StickmanRenderer';
import { editorStore, PREFAB_RIG } from './EditorStore';
import type { EditorTab, ToolKind } from './EditorStore';
import { jumpMetrics, objectCenter, type Vec } from './geometry';
import { centroidOf, currentVertices, nearestEdge } from './polygonEdit';
import { setStatus } from './status';

/** 地图 Tab 中对象的 gizmo 操作（改大小 / 旋转） */
interface MapGizmoDrag {
  kind: 'resize' | 'rotate';
  targetKind: 'object' | 'prefab';
  id: string;
  /** 旋转/缩放枢轴（世界坐标） */
  pivot: Vec;
  /** 起始角度（度） */
  startAngle: number;
  /** 上一次的角度（旋转用增量） */
  lastAngle: number;
  startW: number;
  startH: number;
  startRadius: number;
  /** 自定义多边形顶点快照 */
  startVerts: Vec[] | null;
  startHalfW: number;
  startHalfH: number;
  /** 按下时指针相对枢轴的局部坐标（用于按位移增量缩放，避免抓取瞬间跳变） */
  grabLocal: Vec;
}

/** 预制件工作台上的鼠标操作（移动 / 改大小 / 旋转） */
type PrefabDrag =
  | { kind: 'move'; index: number; last: Vec }
  | { kind: 'resize'; index: number; center: Vec }
  | { kind: 'rotate'; index: number; center: Vec };

interface DragState {
  kind: 'move' | 'create' | 'ruler' | 'marquee' | 'refmove';
  /** refmove：被拖动的参考火柴人下标 */
  refIndex?: number;
  /** refmove：按下点到火柴人的偏移（避免拖动瞬间吸附到指针） */
  refOffset?: Vec;
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
  /** 尺子读数标签（屏幕尺寸恒定的世界空间文本） */
  private rulerLabel!: Phaser.GameObjects.Text;
  /** 空投区域区间标签（按区域数量按需创建/复用） */
  private zoneLabels: Phaser.GameObjects.Text[] = [];
  /** 参考火柴人的绘制对象（每个火柴人一个 Graphics） */
  private refUserGfx: Phaser.GameObjects.Graphics[] = [];
  private unsubscribe?: () => void;
  private rebuildQueued = false;
  private drag: DragState | null = null;
  private panning: { startScroll: Vec; pointer: Vec } | null = null;
  private spaceDown = false;
  private suppressRebuild = false;
  /** 预制件工作台的鼠标操作状态 */
  private prefabDrag: PrefabDrag | null = null;
  /** 预制件内部关节的拖动（锚点 / A 端 / B 端） */
  private prefabJointDrag: { index: number; side: 'a' | 'b' | 'anchor' } | null = null;
  /** 拖动端点时指针当前指到的部件（松手才真正改连接） */
  private prefabJointHoverPart: number | null = null;
  /** 拖动端点时的鼠标世界位置（端点跟手） */
  private prefabJointDragPos: Vec | null = null;
  /** 鼠标悬停的关节（用于高亮） */
  private prefabJointHover: number | null = null;
  /** 预制件武器掉落点的拖动 */
  private prefabWeaponDrag: { index: number; offset: Vec } | null = null;
  /** 关节编号标签（按需创建/复用） */
  private prefabJointLabels: Phaser.GameObjects.Text[] = [];
  /** 多边形顶点拖动状态 */
  private vertexDrag: { index: number } | null = null;
  /** 地图 Tab 的 gizmo 拖动状态 */
  private mapGizmoDrag: MapGizmoDrag | null = null;
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
    this.rulerLabel = this.add
      .text(0, 0, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        color: '#e8f4ff',
        backgroundColor: '#0b0b14',
        padding: { x: 5, y: 2 },
      })
      .setDepth(2000)
      .setAlpha(0.92)
      .setOrigin(0, 1)
      .setVisible(false);
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

  /** 外部切换地图后立即请求一次画布重建。 */
  refreshEditor(): void {
    this.rebuildQueued = true;
  }

  /** 每帧最多重建一次（在 update 早期处理） */
  update(_time?: number): void {
    // 贴图版圆/多边形的蒙版跟随视觉（拖动/旋转/焊接体都靠它；数量很少，开销可忽略）
    syncVisualMasks(this.runtime);
    // 材质发光：跟随物体 + 呼吸/闪烁（编辑器里也实时可见）
    updateMaterialGlows(this.runtime, this.time.now);
    updateObjectLabels(this.runtime);
    // 兜底：鼠标已松开但拖动状态残留（例如在画布外松开、窗口失焦）
    if (
      (this.prefabDrag ||
        this.prefabJointDrag ||
        this.prefabWeaponDrag ||
        this.vertexDrag ||
        this.mapGizmoDrag ||
        this.drag) &&
      !this.input.activePointer.isDown
    ) {
      this.onPointerUp();
    }
    if (
      !this.prefabDrag &&
      !this.prefabJointDrag &&
      !this.prefabWeaponDrag &&
      !this.vertexDrag &&
      !this.mapGizmoDrag &&
      !this.drag &&
      !this.panning
    ) {
      this.updateHoverCursor();
    }
    if (!this.rebuildQueued) return;
    this.rebuildQueued = false;
    this.rebuildAll();
  }

  /** 悬停在手柄上时给出正确的鼠标指针 */
  private updateHoverCursor(): void {
    const store = editorStore;
    const canvas = this.input.manager.canvas;
    if (!canvas) return;
    let cursor = 'default';
    const p = this.worldPoint(this.input.activePointer);
    const z = this.cameras.main.zoom;
    const hs = 10 / z;

    if (store.tab === 'map' && store.tool === 'select') {
      const giz = this.mapGizmoHandles();
      if (giz) {
        if (giz.canResize && Math.hypot(p.x - giz.resize.x, p.y - giz.resize.y) <= hs) cursor = 'nwse-resize';
        else if (Math.hypot(p.x - giz.rotate.x, p.y - giz.rotate.y) <= hs) cursor = 'grab';
      }
    } else if (store.tab === 'prefab') {
      // 内部关节手柄优先（可直接拖到别的部件上改连接）
      const jointHit = this.prefabJointHandleAt(p);
      if (jointHit) cursor = 'grab';
      const hover = jointHit?.index ?? null;
      if (hover !== this.prefabJointHover) {
        this.prefabJointHover = hover;
        this.drawOverlay();
      }
      const idx = store.selectedPartIndex();
      const b = idx === null ? null : store.partWorldBounds(idx);
      if (b && !jointHit) {
        if (Math.hypot(p.x - b.maxX, p.y - b.maxY) <= hs) cursor = 'nwse-resize';
        else if (Math.hypot(p.x - (b.minX + b.maxX) / 2, p.y - b.minY - 30 / z) <= hs) cursor = 'grab';
      }
    }
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  // ---------------- 预制件内部关节：绘制 / 拖动 ----------------

  /** 关节端点手柄离锚点的距离（世界单位，按缩放换算，保证屏幕上恒定） */
  private jointKnobDistance(): number {
    return 30 / this.cameras.main.zoom;
  }

  /**
   * 关节的两条"手臂"端点：从锚点朝两端部件的方向伸出固定距离。
   *
   * 端点故意**不放在部件中心**：部件中心同时也是拖动/选择部件的抓取点，
   * 叠在一起会让"想拖部件"变成"拖关节端点"。
   */
  private prefabJointKnob(index: number): { a: Vec; b: Vec; worldEnd: boolean } | null {
    const store = editorStore;
    const world = store.prefabJointWorld(index);
    if (!world) return null;
    const dist = this.jointKnobDistance();
    const along = (from: Vec, to: Vec): Vec => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return { x: from.x, y: from.y - dist };
      const step = Math.min(dist, Math.max(10, len * 0.75));
      return { x: from.x + (dx / len) * step, y: from.y + (dy / len) * step };
    };
    return {
      a: world.a ? along(world.anchor, world.a) : { x: world.anchor.x - dist, y: world.anchor.y },
      b: world.b ? along(world.anchor, world.b) : { x: world.anchor.x, y: world.anchor.y - dist },
      worldEnd: !world.b,
    };
  }

  /**
   * 命中关节手柄。
   *
   * 端点（A/B 小圆点）只对**当前高亮的那条关节**显示与命中：链节很密，8 条关节的
   * 端点全画出来会互相叠在一起（44px 一节、缩到 0.5 倍时按钮比链节还大），
   * 谁也别想点准。所以交互是：鼠标移到锚点 → 该关节高亮并露出两个端点 → 把端点拖到
   * 别的部件上改连接。
   */
  private prefabJointHandleAt(p: Vec): { index: number; side: 'a' | 'b' | 'anchor' } | null {
    const store = editorStore;
    const z = this.cameras.main.zoom;
    const knobR = 11 / z;
    const anchorR = 9 / z;

    // 1) 已高亮的关节：先判它的两个端点（拖到一半也不会因为掠过别的锚点而丢焦点）
    const hot = this.prefabJointHover ?? this.prefabJointDrag?.index ?? null;
    if (hot !== null) {
      const knobs = this.prefabJointKnob(hot);
      if (knobs) {
        if (Math.hypot(p.x - knobs.a.x, p.y - knobs.a.y) <= knobR) return { index: hot, side: 'a' };
        if (Math.hypot(p.x - knobs.b.x, p.y - knobs.b.y) <= knobR) return { index: hot, side: 'b' };
      }
    }

    // 2) 锚点：取最近的一条
    let best: { index: number; side: 'anchor' } | null = null;
    let bestDist = anchorR;
    for (let i = store.prefabJoints().length - 1; i >= 0; i--) {
      const world = store.prefabJointWorld(i);
      if (!world) continue;
      const d = Math.hypot(p.x - world.anchor.x, p.y - world.anchor.y);
      if (d <= bestDist) {
        bestDist = d;
        best = { index: i, side: 'anchor' };
      }
    }
    return best;
  }

  private prefabJointLabel(index: number): Phaser.GameObjects.Text {
    let label = this.prefabJointLabels[index];
    if (!label) {
      label = this.add
        .text(0, 0, '', {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '10px',
          color: '#ff9de0',
          backgroundColor: '#0b0b14',
          padding: { x: 4, y: 1 },
        })
        .setDepth(2000)
        .setAlpha(0.92)
        .setOrigin(0.5, 1)
        .setVisible(false);
      this.prefabJointLabels[index] = label;
    }
    return label;
  }

  /**
   * 画预制件内部关节：锚点十字 + 两条手臂指向它连接的两个部件（部件用同色描边标出）。
   * 拖动端点 → 改连接的部件；拖动锚点 → 移动铰链位置。
   */
  private drawPrefabJoints(g: Phaser.GameObjects.Graphics): void {
    const store = editorStore;
    const joints = store.prefabJoints();
    const z = this.cameras.main.zoom;
    const unit = 1 / z;
    const ORANGE = 0xffa94d;

    for (let i = joints.length; i < this.prefabJointLabels.length; i++) {
      this.prefabJointLabels[i].setVisible(false);
    }

    joints.forEach((joint, i) => {
      const world = store.prefabJointWorld(i);
      const knobs = this.prefabJointKnob(i);
      if (!world || !knobs) return;
      const hot = this.prefabJointHover === i || this.prefabJointDrag?.index === i;
      const anchor = world.anchor;

      // ---- 两端部件的描边：一眼看出这条关节连的是哪两个物体 ----
      const outline = (partIndex: number, color: number) => {
        const b = store.partWorldBounds(partIndex);
        if (!b) return;
        g.lineStyle((hot ? 2 : 1) * Math.max(1, Math.min(2, 1 / z)), color, hot ? 0.95 : 0.45);
        g.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      };
      outline(joint.bodyA, 0x4dd6ff);
      if (typeof joint.bodyB === 'number') outline(joint.bodyB, ORANGE);

      // ---- 端点跟手：拖动中把被拖的那个端点画在鼠标位置 ----
      const dragSide = this.prefabJointDrag?.index === i ? this.prefabJointDrag.side : null;
      const dragPos = dragSide && dragSide !== 'anchor' ? this.prefabJointDragPos : null;
      if (dragPos && dragSide === 'a') knobs.a = { x: dragPos.x, y: dragPos.y };
      if (dragPos && dragSide === 'b') knobs.b = { x: dragPos.x, y: dragPos.y };

      // ---- 手臂：锚点 → 两端 ----
      g.lineStyle(Math.max(1, 1.5 * unit), 0x9d6bff, hot ? 0.95 : 0.45);
      g.lineBetween(anchor.x, anchor.y, knobs.a.x, knobs.a.y);
      g.lineBetween(anchor.x, anchor.y, knobs.b.x, knobs.b.y);

      // ---- 端点手柄：只在高亮/拖动时露出（密链节下全画会互相重叠，点不准）----
      const showKnobs = hot;
      const knobR = 6 * unit + 1.5;
      if (showKnobs) {
        g.fillStyle(0x0b0b14, 0.9);
        g.fillCircle(knobs.a.x, knobs.a.y, knobR + 1.5);
        g.fillStyle(0x4dd6ff, 1);
        g.fillCircle(knobs.a.x, knobs.a.y, knobR);

        if (dragPos && (dragSide === 'a' || dragSide === 'b')) {
          const color = dragSide === 'a' ? 0x4dd6ff : ORANGE;
          g.lineStyle(2 * unit + 1, color, 1);
          g.strokeCircle(knobs[dragSide].x, knobs[dragSide].y, knobR + 2);
        }

        if (knobs.worldEnd) {
          g.fillStyle(0x0b0b14, 0.9);
          g.fillRect(knobs.b.x - knobR - 1.5, knobs.b.y - knobR - 1.5, (knobR + 1.5) * 2, (knobR + 1.5) * 2);
          g.fillStyle(0xffffff, 0.9);
          g.fillRect(knobs.b.x - knobR, knobs.b.y - knobR, knobR * 2, knobR * 2);
        } else {
          g.fillStyle(0x0b0b14, 0.9);
          g.fillCircle(knobs.b.x, knobs.b.y, knobR + 1.5);
          g.fillStyle(ORANGE, 1);
          g.fillCircle(knobs.b.x, knobs.b.y, knobR);
        }
      }

      // ---- 锚点十字 ----
      const crossR = 8 * unit + 2;
      g.lineStyle(Math.max(1, 2 * unit), 0xff5cc8, hot ? 1 : 0.85);
      g.strokeCircle(anchor.x, anchor.y, crossR);
      g.lineBetween(anchor.x - crossR - 3, anchor.y, anchor.x + crossR + 3, anchor.y);
      g.lineBetween(anchor.x, anchor.y - crossR - 3, anchor.x, anchor.y + crossR + 3);
      g.fillStyle(0xff5cc8, 0.9);
      g.fillCircle(anchor.x, anchor.y, 3);

      // ---- 编号标签 ----
      const label = this.prefabJointLabel(i);
      label.setVisible(true);
      label.setScale(unit);
      label.setText(`#${i + 1}${knobs.worldEnd ? ' → world' : ''}`);
      label.setPosition(anchor.x, anchor.y - (crossR + 6) * unit * 1.4);
    });

    // ---- 正在拖端点：高亮当前指向的部件（松手生效）----
    if (this.prefabJointDrag && this.prefabJointDrag.side !== 'anchor' && this.prefabJointHoverPart !== null) {
      const b = store.partWorldBounds(this.prefabJointHoverPart);
      if (b) {
        const color = this.prefabJointDrag.side === 'a' ? 0x4dd6ff : ORANGE;
        g.lineStyle(3, color, 1);
        g.strokeRect(b.minX - 2, b.minY - 2, b.maxX - b.minX + 4, b.maxY - b.minY + 4);
      }
    }
  }

  /**
   * 画预制件自带的武器掉落点。
   * 视觉与地图 Tab 的武器点一致（圆底 + 小枪 + 随机"?" + 可刷新绿点），
   * 这样"预制件里的枪位"和"地图里的枪位"看起来是同一个东西。
   */
  private drawPrefabWeapons(g: Phaser.GameObjects.Graphics): void {
    const store = editorStore;
    const list = store.prefabWeaponSpawns();
    if (list.length === 0) return;
    list.forEach((w, i) => {
      const p = store.prefabWeaponWorld(i);
      if (!p) return;
      const selected = store.selection.includes(`pweapon:${i}`);
      g.fillStyle(0x2b2b36, 0.85);
      g.fillCircle(p.x, p.y, 20);
      g.lineStyle(selected ? 3 : 2, selected ? 0xffffff : 0xf5d76e, 1);
      g.strokeCircle(p.x, p.y, 20);

      const isRandom = (w.mode ?? 'fixed') === 'random';
      const color = isRandom ? 0x66d9ef : 0xf5d76e;
      g.lineStyle(3, color, 1);
      g.lineBetween(p.x - 9, p.y, p.x + 9, p.y);
      g.lineBetween(p.x + 4, p.y - 5, p.x + 9, p.y);
      g.fillStyle(color, 1);
      g.fillCircle(p.x - 10, p.y + 3, 3);
      if (isRandom) {
        g.lineStyle(1.8, color, 1);
        g.beginPath();
        g.arc(p.x + 12, p.y + 11, 4.5, Math.PI * 0.9, Math.PI * 2.3, false);
        g.strokePath();
        g.fillStyle(color, 1);
        g.fillCircle(p.x + 12, p.y + 20, 1.7);
      }
      if ((w.respawnMs ?? 0) > 0) {
        g.fillStyle(0x54d2b0, 1);
        g.fillCircle(p.x - 12, p.y + 13, 3.2);
      }
    });
  }

  /** 拖动关节手柄时（每帧移动） */
  private prefabJointPointerMove(p: Vec): void {
    const d = this.prefabJointDrag;
    if (!d) return;
    const store = editorStore;
    this.prefabJointDragPos = p;
    if (d.side === 'anchor') {
      store.patchPrefabJointLive(d.index, { anchor: store.worldToPartLocal(p) });
      return;
    }
    this.prefabJointHoverPart = store.hitTestPart(p);
  }

  /** 松开关节手柄：端点落到哪个部件就连哪个；落到空白处 = 改回 world */
  private prefabJointPointerUp(): void {
    const d = this.prefabJointDrag;
    if (!d) return;
    this.prefabJointDrag = null;
    this.prefabJointDragPos = null;
    const target = this.prefabJointHoverPart;
    this.prefabJointHoverPart = null;
    const store = editorStore;
    if (d.side === 'anchor') {
      store.commit();
    } else if (d.side === 'a') {
      if (target !== null) {
        store.setPrefabJointBody(d.index, 'a', target);
        store.message = `关节 #${d.index + 1} 的 A 端 → 部件 #${target}`;
      }
    } else {
      store.setPrefabJointBody(d.index, 'b', target);
      store.message =
        target === null ? `关节 #${d.index + 1} 的 B 端 → world（固定在世界锚点）` : `关节 #${d.index + 1} 的 B 端 → 部件 #${target}`;
    }
    this.drawOverlay();
  }

  private rebuildAll(): void {
    const store = editorStore;
    if (store.tab !== this.lastTab) {
      this.lastTab = store.tab;
      this.fitToMap();
    }
    // 贴图按需加载：新增/替换贴图后加载完再重建一次
    // 材质贴图 + 地图物体自带的对象级贴图（后者可能是编辑器里刚填的路径）
    const objectTextureRefs = (store.canvasMap().objects ?? [])
      .map((o) => (o.type === 'rect' ? o.texture : undefined))
      .filter((t): t is string => !!t);
    ensureMaterialTextures(
      this,
      [
        ...Object.values(MATERIALS).map((m) => ({
          ref: m.texture,
          override: m.texture ? store.textureOverrides.get(m.texture) : undefined,
        })),
        ...objectTextureRefs.map((ref) => ({ ref, override: store.textureOverrides.get(ref) })),
      ],
      () => this.queueRebuild(),
    );
    try {
      destroyMapRuntime(this, this.runtime);
    } catch {
      /* ignore */
    }
    this.runtime = buildMap(this, store.canvasMap(), store.prefabTable());
    this.drawGrid();
    this.drawReferenceFigure();
    this.drawOverlay();
  }

  /**
   * 当前可见的世界矩形。
   *
   * 不用 `cameras.main.worldView`：那是 `preRender()` 才算出来的，
   * `fitToMap()` 里刚改完 zoom/scroll 就立刻 drawGrid 时它还是脏的（首屏网格/遮罩会缺）。
   * 这里用 scrollX/scrollY/zoom 现算，和 Camera.preRender 的公式一致。
   */
  private viewRect(): { x: number; y: number; w: number; h: number } {
    const cam = this.cameras.main;
    const w = cam.width / cam.zoom;
    const h = cam.height / cam.zoom;
    return {
      x: cam.scrollX + cam.width / 2 - w / 2,
      y: cam.scrollY + cam.height / 2 - h / 2,
      w,
      h,
    };
  }

  private drawGrid(): void {
    const g = this.gridGfx;
    g.clear();
    const store = editorStore;
    if (!store.showGrid || store.gridSize <= 0) return;

    const view = this.viewRect();
    const step = store.gridSize;
    const major = step * 5;
    const startX = Math.floor(view.x / step) * step;
    const endX = Math.ceil((view.x + view.w) / step) * step;
    const startY = Math.floor(view.y / step) * step;
    const endY = Math.ceil((view.y + view.h) / step) * step;

    for (let x = startX; x <= endX; x += step) {
      const isMajor = x % major === 0;
      g.lineStyle(1, isMajor ? 0x3a3a52 : 0x26263a, isMajor ? 0.9 : 0.6);
      g.lineBetween(x, view.y, x, view.y + view.h);
    }
    for (let y = startY; y <= endY; y += step) {
      const isMajor = y % major === 0;
      g.lineStyle(1, isMajor ? 0x3a3a52 : 0x26263a, isMajor ? 0.9 : 0.6);
      g.lineBetween(view.x, y, view.x + view.w, y);
    }
  }

  /** 预制件/材质工作台里画一个火柴人 + 高度标尺，作为尺寸参照 */
  private drawReferenceFigure(): void {
    const store = editorStore;
    const g = this.refFigure;
    const guide = this.refGuide;
    guide.clear();
    if (store.tab === 'map' || !store.showPrefabRef) {
      g.setVisible(false);
      return;
    }
    g.setVisible(true);
    const map = store.canvasMap();
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

  /** 单选的地图对象 / 预制件实例（多选时不给 gizmo） */
  private singleTarget(): { kind: 'object' | 'prefab'; id: string } | null {
    const store = editorStore;
    if (store.tab !== 'map' || store.selection.length !== 1) return null;
    const id = store.selection[0];
    if (store.getObject(id)) return { kind: 'object', id };
    if (store.getInstance(id)) return { kind: 'prefab', id };
    return null;
  }

  /** 选中对象的旋转/缩放枢轴 */
  private pivotOf(target: { kind: 'object' | 'prefab'; id: string }): Vec | null {
    const store = editorStore;
    if (target.kind === 'prefab') {
      const inst = store.getInstance(target.id);
      return inst ? { x: inst.x, y: inst.y } : null;
    }
    const obj = store.getObject(target.id);
    if (!obj) return null;
    if (obj.type === 'rect') return { x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 };
    if (obj.type === 'circle') return { x: obj.x, y: obj.y };
    const cen = centroidOf(currentVertices(obj));
    return { x: obj.x + cen.x, y: obj.y + cen.y };
  }

  /** 地图 Tab 的 gizmo 手柄位置 */
  private mapGizmoHandles(): {
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    center: Vec;
    resize: Vec;
    rotate: Vec;
    canResize: boolean;
  } | null {
    const target = this.singleTarget();
    if (!target) return null;
    const b = editorStore.selectionBounds();
    const pivot = this.pivotOf(target);
    if (!b || !pivot) return null;
    const z = this.cameras.main.zoom;
    return {
      bounds: b,
      center: pivot,
      resize: { x: b.maxX + 12 / z, y: b.maxY + 12 / z },
      rotate: { x: pivot.x, y: b.minY - 30 / z },
      canResize: target.kind === 'object',
    };
  }

  /** 命中 gizmo 手柄 → 开始拖动 */
  private tryMapGizmo(p: Vec, shiftKey: boolean): boolean {
    const giz = this.mapGizmoHandles();
    if (!giz) return false;
    const store = editorStore;
    const target = this.singleTarget();
    if (!target) return false;
    const z = this.cameras.main.zoom;
    const hs = 10 / z;

    const startDrag = (kind: 'resize' | 'rotate'): void => {
      const obj = target.kind === 'object' ? store.getObject(target.id) : null;
      const inst = target.kind === 'prefab' ? store.getInstance(target.id) : null;
      const b = store.selectionBounds();
      const angle = (obj?.angle ?? inst?.angle ?? 0) as number;
      const verts = obj?.type === 'polygon' && obj.vertices ? obj.vertices.map((v) => ({ ...v })) : null;
      const rad0 = (angle * Math.PI) / 180;
      const cos0 = Math.cos(rad0);
      const sin0 = Math.sin(rad0);
      const dx0 = p.x - giz.center.x;
      const dy0 = p.y - giz.center.y;
      this.mapGizmoDrag = {
        kind,
        targetKind: target.kind,
        id: target.id,
        pivot: giz.center,
        grabLocal: { x: dx0 * cos0 + dy0 * sin0, y: -dx0 * sin0 + dy0 * cos0 },
        startAngle: angle,
        lastAngle: angle,
        startW: obj?.type === 'rect' ? obj.w : 0,
        startH: obj?.type === 'rect' ? obj.h : 0,
        startRadius: obj && obj.type !== 'rect' ? (obj.radius ?? 40) : 0,
        startVerts: verts,
        startHalfW: b ? Math.max(1, (b.maxX - b.minX) / 2) : 1,
        startHalfH: b ? Math.max(1, (b.maxY - b.minY) / 2) : 1,
      };
      this.lastShift = shiftKey;
      this.suppressRebuild = true;
    };

    if (giz.canResize && Math.hypot(p.x - giz.resize.x, p.y - giz.resize.y) <= hs) {
      startDrag('resize');
      return true;
    }
    if (Math.hypot(p.x - giz.rotate.x, p.y - giz.rotate.y) <= hs) {
      startDrag('rotate');
      return true;
    }
    return false;
  }

  /** gizmo 拖动中 */
  private mapGizmoMove(p: Vec, shiftKey: boolean): void {
    const d = this.mapGizmoDrag;
    if (!d) return;
    const store = editorStore;

    // 相对枢轴的局部坐标（反旋转）
    const rad = (d.startAngle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = p.x - d.pivot.x;
    const dy = p.y - d.pivot.y;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;

    if (d.kind === 'rotate') {
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      while (deg > 180) deg -= 360;
      while (deg < -180) deg += 360;
      if (shiftKey) deg = Math.round(deg / 15) * 15;
      const delta = deg - d.lastAngle;
      d.lastAngle = deg;
      if (d.targetKind === 'object') {
        const obj = store.getObject(d.id);
        if (!obj) return;
        store.patchObjectLive(d.id, { angle: Math.round(deg * 10) / 10 });
        this.applyLiveVisual(d.id, obj, { x: 0, y: 0 });
      } else {
        // 预制件实例：整体绕 anchor 旋转（增量变换每个部件的视觉）
        store.patchInstanceLive(d.id, { angle: Math.round(deg * 10) / 10 });
        this.rotateRuntimeInstance(d.id, d.pivot, delta);
      }
      this.drawOverlay();
      return;
    }

    // resize：用"指针位移增量"改包围盒半尺寸（抓取瞬间不跳变）
    const halfW = Math.max(2, d.startHalfW + (lx - d.grabLocal.x));
    const halfH = Math.max(2, d.startHalfH + (ly - d.grabLocal.y));
    if (d.targetKind === 'object') {
      const obj = store.getObject(d.id);
      if (!obj) return;
      if (obj.type === 'rect') {
        const w = Math.max(4, halfW * 2);
        const h = Math.max(4, halfH * 2);
        store.patchObjectLive(d.id, {
          w,
          h,
          x: d.pivot.x - w / 2,
          y: d.pivot.y - h / 2,
        });
      } else if (obj.type === 'circle' || obj.sides !== undefined) {
        store.patchObjectLive(d.id, { radius: Math.max(3, Math.max(halfW, halfH)) });
      } else {
        // 自定义顶点多边形：按起始顶点整体缩放
        const sx = Math.max(0.05, halfW / d.startHalfW);
        const sy = Math.max(0.05, halfH / d.startHalfH);
        const verts = (d.startVerts ?? []).map((v) => ({ x: v.x * sx, y: v.y * sy }));
        store.patchObjectLive(d.id, { vertices: verts });
      }
      const fresh = store.getObject(d.id);
      if (fresh) this.applyLiveVisual(d.id, fresh, { x: 0, y: 0 });
      this.drawOverlay();
    }
  }

  /** 预制件实例整体绕枢轴旋转（拖动中增量更新视觉，不重建） */
  private rotateRuntimeInstance(instId: string, pivot: Vec, deltaDeg: number): void {
    if (deltaDeg === 0) return;
    const delta = (deltaDeg * Math.PI) / 180;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const prefix = `${instId}#`;
    for (const item of this.runtime) {
      if (item.id !== instId && !item.id.startsWith(prefix)) continue;
      const v = item.visual as unknown as {
        x: number;
        y: number;
        rotation: number;
        setPosition: (x: number, y: number) => void;
        setRotation: (r: number) => void;
        setAlpha: (a: number) => void;
      };
      const px = v.x - pivot.x;
      const py = v.y - pivot.y;
      v.setPosition(pivot.x + px * cos - py * sin, pivot.y + px * sin + py * cos);
      v.setRotation(v.rotation + delta);

      // 焊接体还要把刚体转过去（编辑器暂停物理，否则松手重建前物理与视觉不一致）
      if (item.compound && item.body) {
        const b = item.body;
        const bx = b.position.x - pivot.x;
        const by = b.position.y - pivot.y;
        this.matter.body.setPosition(b, {
          x: pivot.x + bx * cos - by * sin,
          y: pivot.y + bx * sin + by * cos,
        });
        this.matter.body.setAngle(b, b.angle + delta);
        v.setPosition(b.position.x, b.position.y);
        v.setRotation(b.angle);
      }
    }
  }

  /** gizmo 松手：吸附 + 提交 */
  private mapGizmoUp(shiftKey: boolean): boolean {
    const d = this.mapGizmoDrag;
    if (!d) return false;
    this.mapGizmoDrag = null;
    const store = editorStore;
    if (!shiftKey) {
      if (d.kind === 'resize') {
        store.snapSelectedShape();
      } else {
        const obj = store.getObject(d.id);
        const inst = store.getInstance(d.id);
        const angle = Math.round(obj?.angle ?? inst?.angle ?? d.lastAngle);
        if (obj) store.patchObjectLive(d.id, { angle });
        else if (inst) store.patchInstanceLive(d.id, { angle });
      }
    }
    this.suppressRebuild = false;
    store.commit();
    return true;
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
  private prefabPointerDown(p: Vec, altKey = false, doubleClick = false, addSelect = false): void {
    const store = editorStore;
    // 顶点手柄优先级最高（选中多边形部件时）
    if (this.tryVertexEdit(p, altKey, doubleClick)) return;

    // Alt + 拖动 = 从任意位置框选（起点压在部件上也行）
    // 需求来源：部件比较大时"空白处起手"很难找，只能框到一个，误以为框选坏了。
    if (altKey) {
      this.drag = { kind: 'marquee', start: p, current: p, lastApplied: { x: 0, y: 0 } };
      return;
    }

    const z = this.cameras.main.zoom;
    const hs = 9 / z;
    const idx = store.selectedPartIndex();

    if (idx !== null) {
      const b = store.partWorldBounds(idx);
      const c = store.partWorldCenter(idx);
      if (b && c) {
        const resizeHandle = { x: b.maxX, y: b.maxY };
        const rotateHandle = { x: (b.minX + b.maxX) / 2, y: b.minY - 30 / z };
        const welded = store.prefabDraft.bodyMode === 'compound';
        if (Math.hypot(p.x - resizeHandle.x, p.y - resizeHandle.y) <= hs) {
          this.prefabDrag = { kind: 'resize', index: idx, center: c };
          this.suppressRebuild = welded;
          return;
        }
        if (Math.hypot(p.x - rotateHandle.x, p.y - rotateHandle.y) <= hs) {
          this.prefabDrag = { kind: 'rotate', index: idx, center: c };
          this.suppressRebuild = welded;
          return;
        }
      }
    }

    const hit = store.hitTestPart(p);
    if (hit === null) {
      // 空白处按下 = 拉框多选（松开时才决定选中哪些部件）
      this.drag = { kind: 'marquee', start: p, current: p, lastApplied: { x: 0, y: 0 } };
      return;
    }
    if (addSelect) {
      // Ctrl/Shift + 点击：加选 / 取消勾选（不进入拖动）
      store.toggleSelect(`part:${hit}`);
      return;
    }
    // 点已在多选里的部件：保持多选（方便整体拖动）
    if (!store.selection.includes(`part:${hit}`)) store.select([`part:${hit}`]);
    this.prefabDrag = { kind: 'move', index: hit, last: p };
    // 焊接体只有一个刚体，无法局部移动 → 走重建路径（部件数量少，开销可接受）
    this.suppressRebuild = store.prefabDraft.bodyMode !== 'compound';
  }

  private prefabPointerMove(p: Vec, shiftKey: boolean): void {
    const d = this.prefabDrag;
    if (!d) return;
    const store = editorStore;
    const part = store.prefabDraft.parts[d.index];
    if (!part) return;
    const local = store.worldToPartLocal(p);

    if (d.kind === 'move') {
      // 多选拖动：拖其中任意一个 → 所有选中的部件一起移动（保持相对位置）
      const selected = store.selectedPartIndices();
      if (selected.length > 1 && selected.includes(d.index)) {
        const dx = p.x - d.last.x;
        const dy = p.y - d.last.y;
        d.last = p;
        for (const idx of selected) {
          const item = store.prefabDraft.parts[idx];
          if (!item) continue;
          store.patchPartLive(idx, { x: item.x + dx, y: item.y + dy });
        }
        if (store.prefabDraft.bodyMode === 'compound') this.queueRebuild();
        else {
          for (const idx of selected) {
            const item = store.prefabDraft.parts[idx];
            if (item) this.applyLiveVisual(this.partRuntimeId(idx), item, store.prefabRigOrigin());
          }
        }
        this.drawOverlay();
        return;
      }

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
      if (store.prefabDraft.bodyMode === 'compound') this.queueRebuild();
      else this.applyLiveVisual(this.partRuntimeId(d.index), part, store.prefabRigOrigin());
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
      if (store.prefabDraft.bodyMode === 'compound') this.queueRebuild();
      else this.applyLiveVisual(this.partRuntimeId(d.index), part, store.prefabRigOrigin());
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
      // 多选时整体吸附：逐个吸附会把相对位置改乱（拼好的门框会"散架"）
      if (d.kind === 'move') store.snapSelectedPartsTogether(d.index);
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
    this.rulerLabel.setVisible(false);
    for (const label of this.zoneLabels) label.setVisible(false);
    if (store.tab !== 'map') for (const fig of this.refUserGfx) fig.setVisible(false);

    // 预制件工作台：选中部件的 gizmo（缩放手柄 + 旋转手柄）+ 内部关节
    if (store.tab === 'prefab') {
      this.drawPrefabJoints(g);
      this.drawPrefabWeapons(g);

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
      // 地图边界（框外压暗 + 亮框 + 四角标记，让"地图范围"一眼可见）
      this.drawMapBounds(g);

      // 空投区域（只在自动空投开启时才有意义）
      this.drawDropZones(g);

      // 参考火柴人（编辑器标注，不写入地图数据）
      this.drawRefFigures(g);

      // 出生点
      // 出生点（可选中/拖动）：选中时加一圈高亮
      const spawnPoints = store.showSpawnPoints ? store.map.spawnPoints : [];
      spawnPoints.forEach((sp, i) => {
        const color = SPAWN_COLORS[i % SPAWN_COLORS.length];
        const selected = store.selection.includes(`spawn:${i}`);
        g.lineStyle(3, color, 1);
        g.strokeCircle(sp.x, sp.y, 26);
        g.lineBetween(sp.x - 34, sp.y, sp.x + 34, sp.y);
        g.lineBetween(sp.x, sp.y - 34, sp.x, sp.y + 34);
        g.fillStyle(color, 0.15);
        g.fillCircle(sp.x, sp.y, 26);
        if (selected) {
          g.lineStyle(2, 0xffffff, 0.95);
          g.strokeCircle(sp.x, sp.y, 33);
        }
        g.fillStyle(color, 1);
        g.fillCircle(sp.x + 20, sp.y - 20, 9);
      });

      // 地图投放点（武器 / 补给道具）
      const weaponSpawns = store.showWeaponSpawns ? store.weaponSpawns() : [];
      weaponSpawns.forEach((w, i) => {
        const selected = store.selection.includes(`weapon:${i}`);
        const isRandom = (w.mode ?? 'fixed') === 'random';
        // 内容类型：道具用绿/青色 + 医疗十字/盾牌图标，武器用黄色 + 枪形图标
        const fixedId = w.item ?? w.weapon ?? w.type ?? '';
        const itemDef = fixedId ? getItem(fixedId) : undefined;
        const isItem = !!itemDef;
        const ringColor = selected ? 0xffffff : isItem ? 0x4ade80 : 0xf5d76e;
        g.fillStyle(0x2b2b36, 0.85);
        g.fillCircle(w.x, w.y, 20);
        g.lineStyle(selected ? 3 : 2, ringColor, 1);
        g.strokeCircle(w.x, w.y, 20);
        const color = isItem ? 0x4ade80 : isRandom ? 0x66d9ef : 0xf5d76e;
        if (isItem) {
          // 道具图标：heal = 医疗十字；shield = 盾牌轮廓
          g.lineStyle(3, color, 1);
          if (itemDef?.kind === 'shield') {
            g.beginPath();
            g.moveTo(w.x - 8, w.y - 7);
            g.lineTo(w.x, w.y - 11);
            g.lineTo(w.x + 8, w.y - 7);
            g.lineTo(w.x + 8, w.y + 2);
            g.lineTo(w.x, w.y + 11);
            g.lineTo(w.x - 8, w.y + 2);
            g.closePath();
            g.strokePath();
          } else {
            g.lineBetween(w.x - 8, w.y, w.x + 8, w.y);
            g.lineBetween(w.x, w.y - 8, w.x, w.y + 8);
          }
        } else {
          // 小型"枪"图形，便于和出生点区分
          g.lineStyle(3, color, 1);
          g.lineBetween(w.x - 9, w.y, w.x + 9, w.y);
          g.lineBetween(w.x + 4, w.y - 5, w.x + 9, w.y);
          g.fillStyle(color, 1);
          g.fillCircle(w.x - 10, w.y + 3, 3);
        }
        // 随机点：右下角画一个"?"（圆弧 + 点）
        if (isRandom) {
          g.lineStyle(1.8, color, 1);
          g.beginPath();
          g.arc(w.x + 12, w.y + 11, 4.5, Math.PI * 0.9, Math.PI * 2.3, false);
          g.strokePath();
          g.fillStyle(color, 1);
          g.fillCircle(w.x + 12, w.y + 20, 1.7);
        }
        // 允许刷新：左下角绿点
        if ((w.respawnMs ?? 0) > 0) {
          g.fillStyle(0x54d2b0, 1);
          g.fillCircle(w.x - 12, w.y + 13, 3.2);
        }
      });

      // 关节：主体中心 → 锚点（锚点可点选、可拖动）
      store.joints().forEach((j, i) => {
        const selected = store.selection.includes(`joint:${i}`);
        const center = store.centerOfObject(j.bodyA);
        g.lineStyle(2, selected ? 0xffffff : 0xff5ce6, selected ? 1 : 0.9);
        if (center) g.lineBetween(center.x, center.y, j.anchor.x, j.anchor.y);
        g.fillStyle(0xff5ce6, 1);
        g.fillCircle(j.anchor.x, j.anchor.y, 5);
        g.lineStyle(2, selected ? 0xffffff : 0xff5ce6, 1);
        g.strokeCircle(j.anchor.x, j.anchor.y, 11);
        if (selected) {
          // 选中：外圈加一层粗白环 + 十字，明确"这是可以拖的锚点"
          g.lineStyle(2, 0xffffff, 0.95);
          g.strokeCircle(j.anchor.x, j.anchor.y, 16);
          g.lineBetween(j.anchor.x - 20, j.anchor.y, j.anchor.x - 14, j.anchor.y);
          g.lineBetween(j.anchor.x + 14, j.anchor.y, j.anchor.x + 20, j.anchor.y);
          g.lineBetween(j.anchor.x, j.anchor.y - 20, j.anchor.x, j.anchor.y - 14);
          g.lineBetween(j.anchor.x, j.anchor.y + 14, j.anchor.x, j.anchor.y + 20);
        }
      });
    }

    // 地图 Tab：选中对象的旋转 / 缩放手柄
    if (store.tab === 'map') {
      const giz = this.mapGizmoHandles();
      if (giz) {
        const z = this.cameras.main.zoom;
        const hs = 6 / z;
        // 旋转手柄（包围盒顶边中点上方）
        g.lineStyle(2, 0xffc048, 0.85);
        g.lineBetween(giz.rotate.x, giz.bounds.minY, giz.rotate.x, giz.rotate.y);
        g.fillStyle(0xffc048, 1);
        g.fillCircle(giz.rotate.x, giz.rotate.y, hs);
        // 缩放手柄（包围盒右下外侧）
        if (giz.canResize) {
          g.fillStyle(0x2ecc71, 1);
          g.fillRect(giz.resize.x - hs, giz.resize.y - hs, hs * 2, hs * 2);
        }
        // 枢轴
        g.fillStyle(0xffffff, 0.65);
        g.fillCircle(giz.center.x, giz.center.y, hs * 0.45);
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

    // 框选矩形
    if (this.drag?.kind === 'marquee') {
      const { start, current } = this.drag;
      const zoom = this.cameras.main.zoom;
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const w = Math.abs(current.x - start.x);
      const h = Math.abs(current.y - start.y);
      g.fillStyle(0x48dbfb, 0.1);
      g.fillRect(x, y, w, h);
      g.lineStyle(1.5 / zoom, 0x48dbfb, 0.95);
      const dash = 6 / zoom;
      this.drawDashed(g, { x, y }, { x: x + w, y }, dash);
      this.drawDashed(g, { x: x + w, y }, { x: x + w, y: y + h }, dash);
      this.drawDashed(g, { x: x + w, y: y + h }, { x, y: y + h }, dash);
      this.drawDashed(g, { x, y: y + h }, { x, y }, dash);
    }

    // 尺子：拖动中实时预览（虚线），松手后保留测量结果（实线）
    const rulerPreview =
      this.drag?.kind === 'ruler' ? { from: this.drag.start, to: this.drag.current } : null;
    const ruler = rulerPreview ?? store.ruler;
    if (ruler) {
      const zoom = this.cameras.main.zoom;
      const color = rulerPreview ? 0x7bed9f : 0xffffff;
      if (rulerPreview) {
        g.lineStyle(2, color, 0.95);
        this.drawDashed(g, ruler.from, ruler.to, 8 / zoom);
      } else {
        g.lineStyle(2, color, 0.85);
        g.lineBetween(ruler.from.x, ruler.from.y, ruler.to.x, ruler.to.y);
      }
      g.fillStyle(color, 1);
      g.fillCircle(ruler.from.x, ruler.from.y, 4.5 / zoom);
      g.fillCircle(ruler.to.x, ruler.to.y, 4.5 / zoom);

      // 实时读数：屏幕尺寸恒定的标签（挂在终点右上）
      const d = Math.hypot(ruler.to.x - ruler.from.x, ruler.to.y - ruler.from.y);
      const m = jumpMetrics(PLAYER_CONFIG.moveSpeed, PLAYER_CONFIG.jumpVelocity);
      const verdict = d <= m.safeGap ? '可轻松跳过' : d <= m.distance ? '极限' : '跳不过去';
      this.rulerLabel
        .setVisible(true)
        .setScale(1 / zoom)
        .setPosition(ruler.to.x + 12 / zoom, ruler.to.y - 10 / zoom)
        .setText(`${Math.round(d)}px · ${verdict}`);
    }
  }

  /**
   * 参考火柴人（编辑器标注）。
   *
   * 用途只有一个：对照物品/平台的尺寸。**不写入地图 JSON**（存在 store.refFigures 里），
   * 随地图切换/刷新清空。每个火柴人单独一个 Graphics ——
   * `StickmanRenderer.draw()` 会先 `clear()`，共用一个会把其它火柴人擦掉。
   */
  private drawRefFigures(g: Phaser.GameObjects.Graphics): void {
    const store = editorStore;
    const figures = store.refFigures;

    // 按需增删 Graphics 对象
    while (this.refUserGfx.length > figures.length) {
      this.refUserGfx.pop()?.destroy();
    }
    while (this.refUserGfx.length < figures.length) {
      this.refUserGfx.push(this.add.graphics().setDepth(402).setAlpha(0.55));
    }

    const zoom = this.cameras.main.zoom;
    figures.forEach((f, i) => {
      const fig = this.refUserGfx[i];
      fig.setVisible(true).setPosition(f.x, f.y).setScale(f.facing, 1);
      StickmanRenderer.draw(fig, {
        color: 0x9fb3c8,
        gaitTime: 0,
        pose: 'idle',
        moving: false,
        grounded: true,
        hitIntensity: 0,
        hitPhase: 0,
        velocityX: 0,
        velocityY: 0,
        facing: f.facing,
      });

      // 选中高亮：虚线框 + 底部光圈
      if (store.selectedRefIndex === i) {
        const z = this.cameras.main.zoom;
        g.lineStyle(2 / z, 0x4dd6ff, 0.95);
        const l = f.x - 24;
        const t = f.y - 68;
        const r = f.x + 24;
        const bt = f.y + 52;
        const dash = 6 / z;
        this.drawDashed(g, { x: l, y: t }, { x: r, y: t }, dash);
        this.drawDashed(g, { x: r, y: t }, { x: r, y: bt }, dash);
        this.drawDashed(g, { x: r, y: bt }, { x: l, y: bt }, dash);
        this.drawDashed(g, { x: l, y: bt }, { x: l, y: t }, dash);
        g.fillStyle(0x4dd6ff, 0.12);
        g.fillEllipse(f.x, f.y + PLAYER_CONFIG.bodyHeight / 2, 44, 12);
      }

      // 身高标尺（画在 overlay 上，跟着缩放保持可读）
      const feet = f.y + PLAYER_CONFIG.bodyHeight / 2;
      const head = f.y - 63;
      const bx = f.x + (f.facing > 0 ? 42 : -42);
      g.lineStyle(1.5 / zoom, 0x9fb3c8, 0.6);
      g.lineBetween(bx, head, bx, feet);
      const tick = 5 / zoom;
      g.lineBetween(bx - tick, head, bx + tick, head);
      g.lineBetween(bx - tick, feet, bx + tick, feet);
      g.lineStyle(1 / zoom, 0x9fb3c8, 0.25);
      g.lineBetween(f.x - 26, feet, f.x + 26, feet);
    });
  }

  /**
   * 空投区域（`weaponDropZones`）。
   *
   * 语义只有一个：**随机空投的 x 区间**（掉落高度固定从屏幕上方落下，y/h 不参与计算）。
   * 而且只在 `autoDrop.enabled` 开启时才会被 `DropSystem` / 服务端读取 ——
   * 所以这里的画法要对齐这个事实：
   * - 自动空投关闭（默认）：**不画**，避免"看起来能配置掉落范围"的误导；
   * - 开启：画成一条带端点箭头 + 刻度 + `x` 读数的区间线，作者填的 y/h 只作为极淡的参考带。
   */
  private drawDropZones(g: Phaser.GameObjects.Graphics): void {
    const map = editorStore.map;
    const zones = map.weaponDropZones ?? [];
    if (zones.length === 0 || map.autoDrop?.enabled !== true) return;

    const zoom = this.cameras.main.zoom;
    const unit = 1 / zoom; // 1 屏幕像素对应的世界长度

    zones.forEach((z, i) => {
      const x0 = z.x;
      const x1 = z.x + z.w;
      const cy = z.y + z.h / 2;

      // 作者填的矩形：只是一条"摆放参考带"，不参与任何计算
      g.fillStyle(0xf1c40f, 0.05);
      g.fillRect(x0, z.y, z.w, z.h);
      g.lineStyle(unit, 0xf1c40f, 0.18);
      g.strokeRect(x0, z.y, z.w, z.h);

      // 主区间线
      g.lineStyle(2 * unit, 0xf1c40f, 0.95);
      g.lineBetween(x0, cy, x1, cy);

      // 端点刻度
      const tick = 7 * unit;
      g.lineBetween(x0, cy - tick, x0, cy + tick);
      g.lineBetween(x1, cy - tick, x1, cy + tick);

      // 两端向外箭头（表示"这一段 x 区间"）
      const arrow = 9 * unit;
      g.lineBetween(x0, cy, x0 - arrow, cy - arrow * 0.55);
      g.lineBetween(x0, cy, x0 - arrow, cy + arrow * 0.55);
      g.lineBetween(x1, cy, x1 + arrow, cy - arrow * 0.55);
      g.lineBetween(x1, cy, x1 + arrow, cy + arrow * 0.55);

      // 读数：屏幕尺寸恒定
      const label = this.zoneLabel(i);
      label
        .setVisible(true)
        .setScale(unit)
        .setPosition(x0, cy - 6 * unit)
        .setText(`空投 x ${Math.round(x0)}–${Math.round(x1)}`);
    });
  }

  /** 按需创建 / 复用空投区域标签 */
  private zoneLabel(index: number): Phaser.GameObjects.Text {
    let label = this.zoneLabels[index];
    if (!label) {
      label = this.add
        .text(0, 0, '', {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '11px',
          color: '#f7e08a',
          backgroundColor: '#0b0b14',
          padding: { x: 4, y: 1 },
        })
        .setDepth(2000)
        .setAlpha(0.92)
        .setOrigin(0, 1)
        .setVisible(false);
      this.zoneLabels[index] = label;
    }
    return label;
  }

  /**
   * 地图范围可视化：框外压暗 + 亮色边框 + 四角加粗标记。
   *
   * 只画"视口 ∩ 框外"的四块区域（缩得很小时也不会画巨大矩形）；
   * 压暗层同时把网格/框外物体一并盖住，一眼就能看出哪里是可玩范围。
   */
  private drawMapBounds(g: Phaser.GameObjects.Graphics): void {
    const map = editorStore.map;
    const zoom = this.cameras.main.zoom;
    const v = this.viewRect();
    const vx1 = v.x + v.w;
    const vy1 = v.y + v.h;

    const mask = (x0: number, y0: number, x1: number, y1: number): void => {
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) return;
      g.fillStyle(0x05050a, 0.5);
      g.fillRect(x0, y0, w, h);
    };
    // 上 / 下（整宽）
    mask(v.x, v.y, vx1, Math.min(vy1, 0));
    mask(v.x, Math.max(v.y, map.height), vx1, vy1);
    // 左 / 右（只补地图高度区间，避免和上下重叠处二次压暗）
    const midY0 = Math.max(v.y, 0);
    const midY1 = Math.min(vy1, map.height);
    mask(v.x, midY0, Math.min(vx1, 0), midY1);
    mask(Math.max(v.x, map.width), midY0, vx1, midY1);

    // 边框
    g.lineStyle(2.5, 0x4dd6ff, 0.9);
    g.strokeRect(0, 0, map.width, map.height);

    // 四角括号：长度按缩放换算，屏幕上尺寸恒定
    const len = 26 / zoom;
    const thick = 3.5 / zoom;
    g.lineStyle(thick, 0xffffff, 0.95);
    const corners: Array<[number, number, number, number]> = [
      [0, 0, 1, 1],
      [map.width, 0, -1, 1],
      [0, map.height, 1, -1],
      [map.width, map.height, -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      g.lineBetween(cx, cy, cx + sx * len, cy);
      g.lineBetween(cx, cy, cx, cy + sy * len);
    }
  }

  // ---------------- 相机 ----------------
  fitToMap(): void {
    const map = editorStore.canvasMap();
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
    const mouseEvent = pointer.event as MouseEvent | undefined;
    const altKey = mouseEvent?.altKey === true;
    const addSelect = mouseEvent?.ctrlKey === true || mouseEvent?.metaKey === true || mouseEvent?.shiftKey === true;

    if (store.tab === 'prefab') {
      // 形状工具：在预制件画布上直接拖出一个新部件（坐标自动转成预制件局部坐标）
      if (store.tool === 'rect' || store.tool === 'circle' || store.tool === 'polygon') {
        this.drag = { kind: 'create', start: p, current: p, createType: store.tool, lastApplied: { x: 0, y: 0 } };
        this.drawOverlay();
        return;
      }

      // 内部关节手柄优先：锚点 / 端点都是可拖的
      const jointHit = this.prefabJointHandleAt(p);
      if (jointHit) {
        this.prefabJointDrag = jointHit;
        this.prefabJointHoverPart = null;
        this.prefabJointDragPos = p;
        this.drawOverlay();
        return;
      }
      // 武器掉落点：点中就直接拖（比部件小，优先级在关节手柄之后、部件之前）
      const weaponHit = store.hitTestPrefabWeapon(p);
      if (weaponHit !== null) {
        const world = store.prefabWeaponWorld(weaponHit);
        store.select([`pweapon:${weaponHit}`]);
        if (world) this.prefabWeaponDrag = { index: weaponHit, offset: { x: p.x - world.x, y: p.y - world.y } };
        this.drawOverlay();
        return;
      }

      this.prefabPointerDown(p, altKey, doubleClick, addSelect);
      this.drawOverlay();
      return;
    }

    // 材质 Tab：只允许"选中对象"（用来只对选中对象做材质测试/应用），
    // 不允许放置/移动/改数据 —— 画布显示的是同一张地图，误点不该改到它。
    if (store.tab === 'material') {
      const hit = store.hitTest(p);
      if (hit && (hit.kind === 'object' || hit.kind === 'prefab')) store.select([hit.id]);
      else store.select([]);
      this.drawOverlay();
      return;
    }

    // 只有地图 Tab 才允许"编辑地图"（放置/选择/关节/尺子）。
    if (store.tab !== 'map') return;

    const shiftKey = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
    // 地图 Tab：选择工具下优先响应多边形顶点手柄 / gizmo 手柄
    if (store.tool === 'select' && this.tryVertexEdit(p, altKey, doubleClick)) {
      this.drawOverlay();
      return;
    }
    if (store.tool === 'select' && this.tryMapGizmo(p, shiftKey)) {
      this.drawOverlay();
      return;
    }
    this.lastShift = shiftKey;

    switch (store.tool) {
      case 'select': {
        // 参考火柴人优先：它是编辑器标注，常摆在地面附近/物体前面
        const refIndex = store.hitTestRef(p);
        if (refIndex !== null) {
          store.selectRef(refIndex);
          const fig = store.refFigures[refIndex];
          this.drag = {
            kind: 'refmove',
            refIndex,
            refOffset: { x: p.x - fig.x, y: p.y - fig.y },
            start: p,
            current: p,
            lastApplied: { x: 0, y: 0 },
          };
          this.suppressRebuild = true;
          break;
        }
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
          // 投放是"一次性"动作：切回选择工具，避免连点造出一堆预制件
          store.tool = 'select';
          store.message = '已放置预制件（已切回选择工具）';
          store.touch();
        } else {
          store.message = '请先在左侧选择一个预制件';
          store.touch();
        }
        break;
      }
      case 'weapon': {
        if (store.activeWeaponId) {
          const sp = store.snapPoint(p);
          // '__random__' 是左栏"随机武器"的哨兵值
          const isRandom = store.activeWeaponId === '__random__';
          store.addWeaponSpawn(
            isRandom ? '' : store.activeWeaponId,
            sp.x,
            sp.y,
            true,
            isRandom ? 'random' : 'fixed',
          );
          store.tool = 'select';
          store.message = isRandom
            ? '已放置随机武器掉落点（已切回选择工具）'
            : '已放置武器掉落点（已切回选择工具）';
          store.touch();
        } else {
          store.message = '请先在左侧选择要投放的武器';
          store.touch();
        }
        break;
      }
      case 'joint': {
        if (!store.pendingJointBodyA) {
          // 可以点选：地图物体 / 预制件焊接体 / 预制件松件里的某一个部件
          const bodyId = store.jointBodyAt(p);
          if (bodyId) {
            store.pendingJointBodyA = bodyId;
            store.message = store.jointHint();
            store.touch();
          } else {
            store.message = '关节：请先点选一个物体（地图物体或预制件）作为主体';
            store.touch();
          }
        } else {
          const anchor = store.snapPoint(p);
          // 第二下点到的若是另一个刚体，就直接连成“物体→物体”，否则连世界锚点
          const target = store.jointBodyAt(p);
          const bodyB = target && target !== store.pendingJointBodyA ? target : undefined;
          store.addJoint(store.pendingJointBodyA, anchor, bodyB);
          setStatus(
            `已创建关节：${store.joints().length} 个${bodyB ? `（${store.pendingJointBodyA ?? ''} → ${bodyB}）` : '（→ 世界锚点）'}`,
          );
        }
        break;
      }
      case 'ruler': {
        const sp = store.snapPoint(p);
        this.drag = { kind: 'ruler', start: sp, current: sp, lastApplied: { x: 0, y: 0 } };
        break;
      }
      case 'ref': {
        // 参考火柴人：点哪站哪（脚底对齐点击点），只用于对照尺寸，不进地图数据
        // Shift = 朝左，方便对照左右对称的物件
        const sp = store.snapPoint(p);
        const faceLeft = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
        store.addRefFigure(sp.x, sp.y + PLAYER_CONFIG.bodyHeight / 2, faceLeft ? -1 : 1);
        store.message = '已放置参考火柴人（可拖动/Delete 删除；已切回选择工具）';
        // 放完立刻切回选择工具：避免连点误放一堆
        store.tool = 'select';
        store.touch();
        break;
      }
    }
    this.drawOverlay();
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const store = editorStore;
    const p = this.worldPoint(pointer);

    // 框选（预制件 Tab）：只更新预览矩形，松开时才落选择
    if (this.drag?.kind === 'marquee') {
      this.drag.current = p;
      this.drawOverlay();
      return;
    }

    // 拖动参考火柴人（地图 Tab）
    if (this.drag?.kind === 'refmove' && this.drag.refIndex !== undefined) {
      const shift = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
      const target = shift ? p : store.snapPoint(p);
      const off = this.drag.refOffset ?? { x: 0, y: 0 };
      store.moveRefFigure(this.drag.refIndex, target.x - off.x, target.y - off.y);
      this.drawOverlay();
      return;
    }

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

    if (this.mapGizmoDrag) {
      const shift = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
      this.lastShift = shift;
      this.mapGizmoMove(p, shift);
      return;
    }

    if (this.prefabWeaponDrag) {
      const o = store.prefabRigOrigin();
      const local = { x: p.x - this.prefabWeaponDrag.offset.x - o.x, y: p.y - this.prefabWeaponDrag.offset.y - o.y };
      store.patchPrefabWeaponSpawnLive(this.prefabWeaponDrag.index, {
        x: store.snapToGrid ? store.snapValue(local.x) : Math.round(local.x),
        y: store.snapToGrid ? store.snapValue(local.y) : Math.round(local.y),
      });
      this.drawOverlay();
      return;
    }

    if (this.prefabJointDrag) {
      this.prefabJointPointerMove(p);
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
    if (this.mapGizmoDrag) {
      const shift = this.lastShift;
      this.lastShift = false;
      this.mapGizmoUp(shift);
      return;
    }
    if (this.vertexDrag) {
      this.vertexDrag = null;
      this.suppressRebuild = false;
      editorStore.commit();
      return;
    }
    if (this.prefabWeaponDrag) {
      this.prefabWeaponDrag = null;
      store.commit();
      this.drawOverlay();
      return;
    }

    if (this.prefabJointDrag) {
      this.prefabJointPointerUp();
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
      if (store.tab === 'prefab') this.createPartFromDrag(drag);
      else this.createFromDrag(drag);
      return;
    }

    if (drag.kind === 'refmove') {
      this.suppressRebuild = false;
      this.lastShift = false;
      store.message = '参考火柴人已移动（Delete 删除）';
      store.touch();
      this.drawOverlay();
      return;
    }

    if (drag.kind === 'marquee') {
      const rect = {
        minX: Math.min(drag.start.x, drag.current.x),
        minY: Math.min(drag.start.y, drag.current.y),
        maxX: Math.max(drag.start.x, drag.current.x),
        maxY: Math.max(drag.start.y, drag.current.y),
      };
      const hit = store.partsInWorldRect(rect);
      // 面积太小的拖动视为"点空白 → 清空选择"
      const tiny = Math.hypot(drag.current.x - drag.start.x, drag.current.y - drag.start.y) < 4;
      store.select(tiny ? [] : hit.map((i) => `part:${i}`));
      if (!tiny) store.message = `框选了 ${hit.length} 个部件`;
      this.drawOverlay();
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

  /**
   * 在预制件画布上拖出一个新部件。
   *
   * 与地图 Tab 的 createFromDrag 是同一套交互，只是坐标要换成**预制件局部坐标**
   * （画布原点 = prefabRigOrigin）。之前预制件 Tab 里形状工具是“点了没反应”，
   * 只能靠左栏「+ 矩形」按钮加默认尺寸的部件。
   */
  private createPartFromDrag(drag: DragState): void {
    const store = editorStore;
    const origin = store.prefabRigOrigin();
    const toLocal = (pt: Vec): Vec => ({ x: pt.x - origin.x, y: pt.y - origin.y });
    const a = toLocal(drag.start);
    const b = toLocal(drag.current);
    const minX = Math.min(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    const centerX = (a.x + b.x) / 2;
    const centerY = (a.y + b.y) / 2;
    const minSize = Math.max(store.gridSize, 8);
    const material = store.activeMaterialId;

    if (drag.createType === 'rect') {
      store.addPart({ type: 'rect', x: minX, y: minY, w: Math.max(w, minSize), h: Math.max(h, minSize), material });
    } else if (drag.createType === 'circle') {
      store.addPart({ type: 'circle', x: centerX, y: centerY, radius: Math.max(w, h, minSize) / 2, material });
    } else {
      store.addPart({ type: 'polygon', x: centerX, y: centerY, sides: 3, radius: Math.max(w, h, minSize) / 2, material });
    }
    store.tool = 'select';
    this.drawOverlay();
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

    if (obj.type === 'circle') {
      const c = obj as MapObjectCircle;
      const cx = offset.x + c.x;
      const cy = offset.y + c.y;
      if (v instanceof Phaser.GameObjects.Arc) {
        v.setPosition(cx, cy);
        v.setRadius(c.radius);
        v.setFillStyle(color, 1);
        v.setAlpha(alpha);
      } else if (v instanceof Phaser.GameObjects.TileSprite) {
        // 贴图版圆形：尺寸 = 外接正方形（蒙版在松手重建时按新半径重建）
        v.setPosition(cx, cy);
        if (v.width !== c.radius * 2 || v.height !== c.radius * 2) v.setSize(c.radius * 2, c.radius * 2);
        v.setAlpha(alpha);
      } else if (v instanceof Phaser.GameObjects.Image) {
        v.setPosition(cx, cy);
        if (v.displayWidth !== c.radius * 2 || v.displayHeight !== c.radius * 2) {
          v.setDisplaySize(c.radius * 2, c.radius * 2);
        }
        v.setAlpha(alpha);
      }
    } else if (obj.type === 'rect') {
      const r = obj as MapObjectRect;
      if (v instanceof Phaser.GameObjects.TileSprite) {
        v.setPosition(offset.x + r.x + r.w / 2, offset.y + r.y + r.h / 2);
        if (v.width !== r.w || v.height !== r.h) v.setSize(r.w, r.h);
        if (v.rotation !== rot) v.setRotation(rot);
        if (v.alpha !== alpha) v.setAlpha(alpha);
      } else if (v instanceof Phaser.GameObjects.Image) {
        v.setPosition(offset.x + r.x + r.w / 2, offset.y + r.y + r.h / 2);
        if (v.displayWidth !== r.w || v.displayHeight !== r.h) v.setDisplaySize(r.w, r.h);
        if (v.rotation !== rot) v.setRotation(rot);
        if (v.alpha !== alpha) v.setAlpha(alpha);
      } else if (v instanceof Phaser.GameObjects.Rectangle) {
        v.setPosition(offset.x + r.x + r.w / 2, offset.y + r.y + r.h / 2);
        v.setSize(r.w, r.h);
        v.setFillStyle(color, 1);
        v.setRotation(rot);
        v.setAlpha(alpha);
      }
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
    // 贴图版圆/多边形的蒙版是独立对象，改完视觉立刻跟上（否则拖动时贴图会"错位裁切"）
    syncVisualMasks(this.runtime);
    updateMaterialGlows(this.runtime, this.time.now);
    updateObjectLabels(this.runtime);
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
      if (item.compound && item.body) {
        // 焊接体：Container 没有物理绑定，必须移动刚体再同步视觉
        const b = item.body;
        this.matter.body.setPosition(b, { x: b.position.x + dx, y: b.position.y + dy });
        const v = item.visual as unknown as Phaser.GameObjects.Components.Transform;
        v.setPosition(b.position.x, b.position.y);
        continue;
      }
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
