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
import { RIG_BONES, chain2, solveLegIKWithHint, upVec } from '../render/StickmanRig';
import { StickmanRenderer } from '../render/StickmanRenderer';
import { editorStore, PREFAB_RIG } from './EditorStore';
import type { EditorTab, ToolKind } from './EditorStore';
import { jumpMetrics, objectCenter, type Vec } from './geometry';
import { centroidOf, currentVertices, nearestEdge } from './polygonEdit';
import { setStatus } from './status';
import { actionStore } from './ActionStore';
import type { ActionPose, ActionWeapon } from './ActionFormat';
import { getWeapon } from '../combat/WeaponFormat';
import { drawHeldWeapon } from '../render/WeaponRenderer';

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
  kind: 'move' | 'create' | 'ruler';
  start: Vec;
  current: Vec;
  /** create 工具类型 */
  createType?: ToolKind;
  /** move 起始位置（用于计算增量） */
  lastApplied: Vec;
}

const SPAWN_COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f];

interface ActionDrag {
  handle: 'hip' | 'shoulder' | 'frontElbow' | 'frontHand' | 'backElbow' | 'backHand' | 'footL' | 'footR' | 'kneeL' | 'kneeR';
}

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
  /** 动作编辑画布中的当前关节拖动 */
  private actionDrag: ActionDrag | null = null;

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

  /** 外部切换地图后立即请求一次画布重建。 */
  refreshEditor(): void {
    this.rebuildQueued = true;
  }

  /** 每帧最多重建一次（在 update 早期处理） */
  update(_time?: number, delta = 0): void {
    actionStore.tick(delta);
    // 兜底：鼠标已松开但拖动状态残留（例如在画布外松开、窗口失焦）
    if ((this.prefabDrag || this.vertexDrag || this.mapGizmoDrag || this.drag) && !this.input.activePointer.isDown) {
      this.onPointerUp();
    }
    if (!this.prefabDrag && !this.vertexDrag && !this.mapGizmoDrag && !this.drag && !this.panning) {
      this.updateHoverCursor();
    }
    if (editorStore.tab === 'action') {
      this.drawReferenceFigure();
      this.drawOverlay();
      return;
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
      const idx = store.selectedPartIndex();
      const b = idx === null ? null : store.partWorldBounds(idx);
      if (b) {
        if (Math.hypot(p.x - b.maxX, p.y - b.maxY) <= hs) cursor = 'nwse-resize';
        else if (Math.hypot(p.x - (b.minX + b.maxX) / 2, p.y - b.minY - 30 / z) <= hs) cursor = 'grab';
      }
    }
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
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
    if (store.tab === 'action') {
      const origin = this.actionOrigin();
      g.setVisible(true);
      g.setPosition(origin.x, origin.y);
      this.drawActionFigure(g, actionStore.currentPose, actionStore.current.weapon);
      guide.clear();
      guide.lineStyle(1, 0x8fa3b8, 0.3);
      guide.lineBetween(origin.x - 220, origin.y + 48, origin.x + 260, origin.y + 48);
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

  private actionOrigin(): Vec {
    const map = editorStore.canvasMap();
    return { x: map.width / 2, y: map.height / 2 + 80 };
  }

  private actionArm(root: Vec, shoulder: number, elbow: number): { joint: Vec; end: Vec } {
    return chain2(root.x, root.y, shoulder, RIG_BONES.UPPER_ARM, elbow, RIG_BONES.FOREARM, 1, 'down');
  }

  private drawActionFigure(g: Phaser.GameObjects.Graphics, pose: ActionPose, weapon: ActionWeapon): void {
    g.clear();
    const hip = { x: pose.rootX, y: pose.rootY };
    const footL = { x: hip.x + pose.footLX, y: hip.y + pose.footLY };
    const footR = { x: hip.x + pose.footRX, y: hip.y + pose.footRY };
    const legs = [
      solveLegIKWithHint(
        hip.x,
        hip.y,
        footL.x,
        footL.y,
        hip.x + pose.kneeLHintX,
        hip.y + pose.kneeLHintY,
      ),
      solveLegIKWithHint(
        hip.x,
        hip.y,
        footR.x,
        footR.y,
        hip.x + pose.kneeRHintX,
        hip.y + pose.kneeRHintY,
      ),
    ];
    const legChains = [
      chain2(hip.x, hip.y, legs[0].thighAngle, RIG_BONES.THIGH, legs[0].kneeBend, RIG_BONES.SHIN, 1, 'down'),
      chain2(hip.x, hip.y, legs[1].thighAngle, RIG_BONES.THIGH, legs[1].kneeBend, RIG_BONES.SHIN, 1, 'down'),
    ];
    g.lineStyle(5.5, 0x8fa3b8, 1);
    for (const leg of legChains) {
      g.lineBetween(hip.x, hip.y, leg.joint.x, leg.joint.y);
      g.lineBetween(leg.joint.x, leg.joint.y, leg.end.x, leg.end.y);
      g.fillStyle(0xdce7f0, 1);
      g.fillCircle(leg.joint.x, leg.joint.y, 2.5);
    }

    const torsoAngle = pose.torsoTilt + pose.torsoTwist * 0.35;
    const torso = upVec(torsoAngle, RIG_BONES.TORSO, 1);
    const shoulder = { x: hip.x + torso.x, y: hip.y + torso.y };
    g.lineStyle(7, 0x8fa3b8, 1);
    g.lineBetween(hip.x, hip.y, shoulder.x, shoulder.y);
    const neck = upVec(pose.headTilt, RIG_BONES.NECK, 1);
    const headBase = { x: shoulder.x + neck.x, y: shoulder.y + neck.y };
    const head = upVec(pose.headTilt, RIG_BONES.HEAD_R * 0.75, 1);
    g.fillStyle(0x8fa3b8, 1);
    g.fillCircle(headBase.x + head.x, headBase.y + head.y + pose.headOffsetY, RIG_BONES.HEAD_R);

    const frontRoot = { x: shoulder.x + 3.5, y: shoulder.y + 1.5 };
    const backRoot = { x: shoulder.x - 3.5, y: shoulder.y + 1.5 };
    const front = this.actionArm(frontRoot, pose.armFrontShoulder, pose.armFrontElbow);
    const back = this.actionArm(backRoot, pose.armBackShoulder, pose.armBackElbow);
    g.lineStyle(4, 0x8fa3b8, 1);
    g.lineBetween(frontRoot.x, frontRoot.y, front.joint.x, front.joint.y);
    g.lineBetween(front.joint.x, front.joint.y, front.end.x, front.end.y);
    g.lineBetween(backRoot.x, backRoot.y, back.joint.x, back.joint.y);
    g.lineBetween(back.joint.x, back.joint.y, back.end.x, back.end.y);
    g.fillStyle(0xdce7f0, 1);
    g.fillCircle(front.joint.x, front.joint.y, 2.2);
    g.fillCircle(back.joint.x, back.joint.y, 2.2);

    if (weapon !== 'none') {
      const weaponId = weapon === 'spear' ? 'spear' : weapon === 'dagger' ? 'dagger' : 'lightsaber';
      const visual = getWeapon(weaponId)?.visual;
      if (visual) {
        const twoHanded = weapon === 'spear';
        const aim = twoHanded
          ? Math.atan2(front.end.y - back.end.y, front.end.x - back.end.x)
          : Math.atan2(front.end.y - frontRoot.y, front.end.x - frontRoot.x);
        const hand = twoHanded
          ? {
              x: (front.end.x + back.end.x) * 0.5,
              y: (front.end.y + back.end.y) * 0.5,
            }
          : front.end;
        drawHeldWeapon(g, { visual, facing: 1, aim, hand });
      }
    }
  }

  private actionHandlePoints(pose: ActionPose): Record<ActionDrag['handle'], Vec> {
    const hip = { x: pose.rootX, y: pose.rootY };
    const torsoAngle = pose.torsoTilt + pose.torsoTwist * 0.35;
    const torso = upVec(torsoAngle, RIG_BONES.TORSO, 1);
    const shoulder = { x: hip.x + torso.x, y: hip.y + torso.y };
    const frontRoot = { x: shoulder.x + 3.5, y: shoulder.y + 1.5 };
    const backRoot = { x: shoulder.x - 3.5, y: shoulder.y + 1.5 };
    const front = this.actionArm(frontRoot, pose.armFrontShoulder, pose.armFrontElbow);
    const back = this.actionArm(backRoot, pose.armBackShoulder, pose.armBackElbow);
    const leftLeg = solveLegIKWithHint(
      hip.x,
      hip.y,
      hip.x + pose.footLX,
      hip.y + pose.footLY,
      hip.x + pose.kneeLHintX,
      hip.y + pose.kneeLHintY,
    );
    const rightLeg = solveLegIKWithHint(
      hip.x,
      hip.y,
      hip.x + pose.footRX,
      hip.y + pose.footRY,
      hip.x + pose.kneeRHintX,
      hip.y + pose.kneeRHintY,
    );
    return {
      hip,
      shoulder,
      frontElbow: front.joint,
      frontHand: front.end,
      backElbow: back.joint,
      backHand: back.end,
      footL: { x: hip.x + pose.footLX, y: hip.y + pose.footLY },
      footR: { x: hip.x + pose.footRX, y: hip.y + pose.footRY },
      kneeL: leftLeg.knee,
      kneeR: rightLeg.knee,
    };
  }

  private actionArmPose(root: Vec, target: Vec): { shoulder: number; elbow: number } {
    const dx = target.x - root.x;
    const dy = target.y - root.y;
    const l1 = RIG_BONES.UPPER_ARM;
    const l2 = RIG_BONES.FOREARM;
    const distance = Math.max(Math.abs(l1 - l2) + 0.5, Math.min(l1 + l2 - 0.01, Math.hypot(dx, dy)));
    const cosB = (l1 * l1 + distance * distance - l2 * l2) / (2 * l1 * distance);
    const bendAtRoot = Math.acos(Math.max(-1, Math.min(1, cosB)));
    return {
      shoulder: (Math.atan2(dx, dy) - bendAtRoot) * (180 / Math.PI),
      elbow: bendAtRoot * 2 * (180 / Math.PI),
    };
  }

  private drawActionHandles(): void {
    const g = this.overlay;
    const origin = this.actionOrigin();
    const points = this.actionHandlePoints(actionStore.currentPose);
    const entries: Array<[ActionDrag['handle'], number]> = [
      ['hip', 0xf1c40f],
      ['shoulder', 0xf1c40f],
      ['frontElbow', 0x48dbfb],
      ['frontHand', 0x2ecc71],
      ['backElbow', 0x48dbfb],
      ['backHand', 0x2ecc71],
      ['footL', 0xff8c42],
      ['footR', 0xff8c42],
      ['kneeL', 0xffd166],
      ['kneeR', 0xffd166],
    ];
    for (const [name, color] of entries) {
      const p = points[name];
      const x = origin.x + p.x;
      const y = origin.y + p.y;
      g.lineStyle(1.5, color, 0.9);
      g.strokeCircle(x, y, 7);
      g.fillStyle(color, 0.9);
      g.fillCircle(x, y, 3.5);
    }
    g.lineStyle(1, 0xffffff, 0.25);
    g.lineBetween(origin.x - 220, origin.y, origin.x + 260, origin.y);
    g.lineBetween(origin.x, origin.y - 120, origin.x, origin.y + 70);
  }

  private actionPointerDown(p: Vec): void {
    const origin = this.actionOrigin();
    const local = { x: p.x - origin.x, y: p.y - origin.y };
    const points = this.actionHandlePoints(actionStore.currentPose);
    const order: ActionDrag['handle'][] = ['frontHand', 'backHand', 'frontElbow', 'backElbow', 'kneeL', 'kneeR', 'footL', 'footR', 'shoulder', 'hip'];
    const hit = order.find((name) => Math.hypot(local.x - points[name].x, local.y - points[name].y) <= 12 / this.cameras.main.zoom);
    if (!hit) return;
    actionStore.ensureKeyframeAtTime();
    this.actionDrag = { handle: hit };
  }

  private actionPointerMove(p: Vec): void {
    if (!this.actionDrag) return;
    const origin = this.actionOrigin();
    const local = { x: p.x - origin.x, y: p.y - origin.y };
    const pose = actionStore.currentPose;
    const hip = { x: pose.rootX, y: pose.rootY };
    const torsoAngle = pose.torsoTilt + pose.torsoTwist * 0.35;
    const torso = upVec(torsoAngle, RIG_BONES.TORSO, 1);
    const shoulder = { x: hip.x + torso.x, y: hip.y + torso.y };
    const frontRoot = { x: shoulder.x + 3.5, y: shoulder.y + 1.5 };
    const backRoot = { x: shoulder.x - 3.5, y: shoulder.y + 1.5 };
    const patch: Partial<ActionPose> = {};
    switch (this.actionDrag.handle) {
      case 'hip':
        patch.rootX = local.x;
        patch.rootY = local.y;
        break;
      case 'shoulder':
        patch.torsoTilt = (Math.atan2(local.x - hip.x, -(local.y - hip.y)) * 180) / Math.PI - pose.torsoTwist * 0.35;
        break;
      case 'frontHand': {
        const arm = this.actionArmPose(frontRoot, local);
        patch.armFrontShoulder = arm.shoulder;
        patch.armFrontElbow = arm.elbow;
        break;
      }
      case 'backHand': {
        const arm = this.actionArmPose(backRoot, local);
        patch.armBackShoulder = arm.shoulder;
        patch.armBackElbow = arm.elbow;
        break;
      }
      case 'frontElbow':
        patch.armFrontShoulder = (Math.atan2(local.x - frontRoot.x, local.y - frontRoot.y) * 180) / Math.PI;
        patch.armFrontElbow = pose.armFrontElbow;
        break;
      case 'backElbow':
        patch.armBackShoulder = (Math.atan2(local.x - backRoot.x, local.y - backRoot.y) * 180) / Math.PI;
        patch.armBackElbow = pose.armBackElbow;
        break;
      case 'kneeL':
        patch.kneeLHintX = local.x - pose.rootX;
        patch.kneeLHintY = local.y - pose.rootY;
        break;
      case 'kneeR':
        patch.kneeRHintX = local.x - pose.rootX;
        patch.kneeRHintY = local.y - pose.rootY;
        break;
      case 'footL':
        patch.footLX = local.x - pose.rootX;
        patch.footLY = local.y - pose.rootY;
        break;
      case 'footR':
        patch.footRX = local.x - pose.rootX;
        patch.footRY = local.y - pose.rootY;
        break;
    }
    actionStore.updateCurrentPoseLive(patch);
  }

  private actionPointerUp(): boolean {
    if (!this.actionDrag) return false;
    this.actionDrag = null;
    actionStore.commit();
    return true;
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
      store.select([]);
      return;
    }
    store.select([`part:${hit}`]);
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

    if (store.tab === 'action') {
      this.drawActionHandles();
      return;
    }

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
      // 出生点（可选中/拖动）：选中时加一圈高亮
      store.map.spawnPoints.forEach((sp, i) => {
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

      // 地图武器投放点
      store.weaponSpawns().forEach((w, i) => {
        const selected = store.selection.includes(`weapon:${i}`);
        g.fillStyle(0x2b2b36, 0.85);
        g.fillCircle(w.x, w.y, 20);
        g.lineStyle(selected ? 3 : 2, selected ? 0xffffff : 0xf5d76e, 1);
        g.strokeCircle(w.x, w.y, 20);
        // 小型"枪"图形，便于和出生点区分
        const isRandom = (w.mode ?? 'fixed') === 'random';
        const color = isRandom ? 0x66d9ef : 0xf5d76e;
        g.lineStyle(3, color, 1);
        g.lineBetween(w.x - 9, w.y, w.x + 9, w.y);
        g.lineBetween(w.x + 4, w.y - 5, w.x + 9, w.y);
        g.fillStyle(color, 1);
        g.fillCircle(w.x - 10, w.y + 3, 3);
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
    const altKey = (pointer.event as MouseEvent | undefined)?.altKey === true;

    if (store.tab === 'prefab') {
      this.prefabPointerDown(p, altKey, doubleClick);
      this.drawOverlay();
      return;
    }
    if (store.tab === 'action') {
      this.actionPointerDown(p);
      this.drawOverlay();
      return;
    }

    // 只有地图 Tab 才允许"编辑地图"（放置/选择/关节/尺子）。
    // 材质/动作 Tab 画布显示的是同一张地图，但在那里误点不该改到地图数据。
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

    if (this.actionDrag) {
      this.actionPointerMove(p);
      this.drawReferenceFigure();
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
    if (this.actionDrag) {
      this.actionPointerUp();
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
