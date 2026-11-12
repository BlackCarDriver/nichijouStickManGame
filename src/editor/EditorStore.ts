/**
 * 编辑器状态存储（单一真源）。
 *
 * - 所有可变数据都在这里：当前地图、预制件草稿、材质表、选中、工具、历史
 * - Phaser 场景只负责**渲染**这份状态；DOM 面板只负责**编辑**这份状态
 * - 快照式 undo/redo + localStorage 自动保存 → 崩溃不丢稿
 */
import type {
  MapData,
  MapJoint,
  MapObject,
  MapWeaponSpawn,
  PrefabInstance,
  SpawnPoint,
} from '../map/MapFormat';
import { MAP_FORMAT_VERSION } from '../map/MapFormat';
import type { PrefabData } from '../map/PrefabFormat';
import { PREFAB_FORMAT_VERSION } from '../map/PrefabFormat';
import { getDefaultMap, getPrefabTable, listPrefabs } from '../map/MapRegistry';
import { expandPrefab } from '../map/PrefabExpand';
import {
  MATERIALS,
  MATERIALS_FILE_HASH,
  addMaterial as addMaterialToTable,
  defaultMaterialJson,
  materialIds,
  materialToJson,
  patchMaterial,
  removeMaterial as removeMaterialFromTable,
  serializeMaterials,
  replaceMaterials,
} from '../config/materials';
import type { MaterialConfig, MaterialJson, MaterialsFile } from '../config/materials';
import { forgetTextureFailures } from '../map/TextureLoader';
import { listItemIds } from '../world/ItemFormat';
import {
  makeContext,
  validateMap,
  validateMaterialsFile,
  validatePrefab,
  type Issue,
} from '../map/MapValidator';
import {
  instanceBounds,
  objectBounds,
  objectCenter,
  pointInObject,
  unionBounds,
  type Bounds,
  type Vec,
} from './geometry';
import {
  convexHull,
  currentVertices,
  insertVertex,
  isConvex,
  moveVertex,
  removeVertex,
  worldVertices,
} from './polygonEdit';

export type EditorTab = 'map' | 'prefab' | 'material' | 'action';
export type ToolKind =
  | 'select'
  | 'rect'
  | 'circle'
  | 'polygon'
  | 'spawn'
  | 'prefab'
  | 'weapon'
  | 'joint'
  | 'ruler';

/** 关节锚点的命中半径（px）：比绘制半径略大，便于点中 */
export const JOINT_ANCHOR_HIT_RADIUS = 14;

const STORAGE_KEY = 'stickman.editor.v1';
const HISTORY_LIMIT = 80;

interface SavedState {
  v: 1;
  tab: EditorTab;
  map: MapData;
  prefabDraft: PrefabData;
  materials: MaterialsFile;
  /** 保存时 data/materials.json 的指纹：文件被外部修改过则丢弃旧材质快照 */
  materialsHash?: string;
}

/** 预制件工作台布局（场景与 store 共用，保证坐标一致） */
export const PREFAB_RIG = {
  width: 1600,
  height: 900,
  groundY: 700,
} as const;

export function emptyPrefabDraft(): PrefabData {
  return {
    version: PREFAB_FORMAT_VERSION,
    id: 'new_prefab',
    name: '新预制件',
    anchor: 'center',
    bodyMode: 'loose',
    parts: [{ type: 'rect', x: -40, y: 0, w: 80, h: 40, material: 'wood' }],
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class EditorStore {
  tab: EditorTab = 'map';
  tool: ToolKind = 'select';
  gridSize = 20;
  snapToGrid = true;
  showGrid = true;
  /** 地图文档 */
  map: MapData;
  /** 预制件草稿（预制件 Tab 编辑的对象） */
  prefabDraft: PrefabData;
  /** 选中 id 列表（地图物体 id / 预制件实例 id / 预制件部件用 "part:<index>"） */
  selection: string[] = [];
  /** 预制件调色板中待放置的预制件 */
  activePrefabId: string | null = null;
  /** 当前选中的待投放武器 id（weapon 工具用） */
  activeWeaponId: string | null = null;
  /** 材质 Tab 当前编辑的材质 */
  activeMaterialId = 'wood';
  /** 关节工具第一步选中的物体 id */
  pendingJointBodyA: string | null = null;
  /** 尺子工具 */
  ruler: { from: Vec; to: Vec } | null = null;
  /** 状态栏消息 */
  message = '';
  /** 材质文件被外部修改时的提示（只提示一次，不写入 message 以免被后续操作覆盖太快） */
  materialNotice = '';
  /**
   * 编辑器内的贴图预览覆盖（贴图引用 → data URL）。
   * 用于：选了本地图片但还没落到 public/textures 时，编辑器里也能立即看到效果。
   * 不写入 JSON、不进 localStorage。
   */
  readonly textureOverrides = new Map<string, string>();

  private history: string[] = [];
  private index = -1;
  /** 数据版本号：每次 commit / undo / redo 自增，UI 用它判断是否需要重建面板 */
  private rev = 0;
  private issuesCache: Issue[] | null = null;
  private issuesCacheRev = -1;
  private issuesCacheTab: EditorTab | null = null;
  private listeners = new Set<() => void>();
  private idSeq = 1;
  private silent = false;

  constructor() {
    this.map = clone(getDefaultMap());
    this.prefabDraft = emptyPrefabDraft();
    this.restore();
    this.ensureIds();
    this.resetHistory();
    // 材质文件被外部改过：把提示作为初始状态消息显示出来
    if (this.materialNotice) this.message = this.materialNotice;
  }

  // ---------------- 订阅 / 通知 ----------------
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    if (this.silent) return;
    for (const fn of this.listeners) fn();
  }

  // ---------------- 历史 ----------------
  private snapshot(): string {
    return JSON.stringify({ map: this.map, prefabDraft: this.prefabDraft });
  }

  resetHistory(): void {
    this.history = [this.snapshot()];
    this.index = 0;
  }

  get revision(): number {
    return this.rev;
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.history.length - 1;
  }

  /** 提交一次修改：入历史 + 自动保存 + 通知重绘 */
  commit(): void {
    const snap = this.snapshot();
    if (this.history[this.index] !== snap) {
      this.history = this.history.slice(0, this.index + 1);
      this.history.push(snap);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      this.index = this.history.length - 1;
    }
    this.rev++;
    this.autosave();
    this.notify();
  }

  /** 只通知不记历史（离散操作 / Tab 切换等） */
  touch(): void {
    this.notify();
  }

  private liveTimer = 0;

  /**
   * 拖动过程中的节流通知：拖动时每帧都在改数据，
   * 但不需要每帧重建整个 DOM 面板（约 90ms 一次即可）。
   */
  touchLive(): void {
    if (this.liveTimer) return;
    this.liveTimer = window.setTimeout(() => {
      this.liveTimer = 0;
      this.notify();
    }, 250);
  }

  undo(): void {
    if (!this.canUndo()) return;
    this.index--;
    this.applySnapshot(this.history[this.index]);
  }

  redo(): void {
    if (!this.canRedo()) return;
    this.index++;
    this.applySnapshot(this.history[this.index]);
  }

  private applySnapshot(snap: string): void {
    const data = JSON.parse(snap) as { map: MapData; prefabDraft: PrefabData };
    this.map = data.map;
    this.prefabDraft = data.prefabDraft;
    this.selection = this.selection.filter((id) => this.exists(id));
    this.rev++;
    this.autosave();
    this.notify();
  }

  // ---------------- 持久化 ----------------
  private autosave(): void {
    try {
      const payload: SavedState = {
        v: 1,
        tab: this.tab,
        map: this.map,
        prefabDraft: this.prefabDraft,
        materials: serializeMaterials(),
        materialsHash: MATERIALS_FILE_HASH,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* 存储满/隐私模式：忽略 */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedState;
      if (saved?.map) this.map = saved.map;
      if (saved?.prefabDraft) this.prefabDraft = saved.prefabDraft;
      if (saved?.materials) {
        // 只有"文件没被外部改过"时才恢复材质草稿。
        // 否则直接用文件版本（否则 AI/手改/ git pull 新增的材质会被旧快照抹掉，
        // 表现为地图报"未知材质"）
        if (saved.materialsHash && saved.materialsHash === MATERIALS_FILE_HASH) {
          replaceMaterials(saved.materials);
        } else {
          this.materialNotice =
            'data/materials.json 已被外部修改：已重新载入文件版本（未保存的材质草稿已丢弃）';
        }
      }
      if (saved?.tab) this.tab = saved.tab;
    } catch {
      /* 损坏的存档：用默认地图 */
    }
  }

  /** 新建空白地图（一键新增），返回是否成功 */
  newMap(name: string): { ok: boolean; reason?: string } {
    const clean = name.trim();
    if (!clean) return { ok: false, reason: '地图名不能为空' };
    const map: MapData = {
      version: MAP_FORMAT_VERSION,
      name: clean,
      width: 2400,
      height: 1200,
      spawnPoints: [
        { x: 150, y: 1072 },
        { x: 2250, y: 1072 },
      ],
      weaponDropZones: [{ x: 200, y: 80, w: 2000, h: 100 }],
      objects: [
        { id: 'ground', type: 'rect', x: 0, y: 1120, w: 2400, h: 80, material: 'ground' },
        { id: 'wall_left', type: 'rect', x: 0, y: 0, w: 40, h: 1200, material: 'wall' },
        { id: 'wall_right', type: 'rect', x: 2360, y: 0, w: 40, h: 1200, material: 'wall' },
      ],
      prefabs: [],
      joints: [],
    };
    this.map = map;
    this.selection = [];
    this.tool = 'select';
    this.ruler = null;
    this.ensureIds();
    // 立刻存为新草稿（含新地图数据）
    this.message = `已新建地图 ${clean}（记得导出到 data/maps/${clean}.json）`;
    this.commit();
    return { ok: true };
  }

  /**
   * 调整对象在数组中的位置 = 调整绘制层级（数组越靠后越在上层）。
   * @param id        被移动的对象/预制件实例 id
   * @param toIndex   目标下标（在目标数组中的位置）
   */
  moveObjectToIndex(id: string, toIndex: number): void {
    const isPrefab = !!this.getInstance(id);
    const list: Array<MapObject | PrefabInstance> = isPrefab
      ? (this.map.prefabs ?? [])
      : (this.map.objects ?? []);
    const from = list.findIndex((o) => o.id === id);
    if (from < 0) return;
    const [item] = list.splice(from, 1);
    const clamped = Math.max(0, Math.min(list.length, toIndex));
    list.splice(clamped, 0, item);
    this.commit();
  }

  /**
   * 把对象放到另一个对象的上面/下面（层级 = 数组顺序，越后越上层）。
   * 与对象列表的拖拽排序对应（列表是"上层在前"的倒序展示）。
   */
  moveObjectRelative(id: string, targetId: string, placeAbove: boolean): boolean {
    if (id === targetId) return false;
    const isPrefab = !!this.getInstance(id);
    const list: Array<MapObject | PrefabInstance> = isPrefab
      ? (this.map.prefabs ?? [])
      : (this.map.objects ?? []);
    const from = list.findIndex((o) => o.id === id);
    if (from < 0) return false;
    const [item] = list.splice(from, 1);
    const tIdx = list.findIndex((o) => o.id === targetId);
    if (tIdx < 0) {
      list.splice(from, 0, item); // 还原
      return false;
    }
    list.splice(placeAbove ? tIdx + 1 : tIdx, 0, item);
    this.commit();
    return true;
  }

  /** 把选中对象上移一层 / 下移一层（层级 = 绘制顺序） */
  raiseSelected(layer: 'up' | 'down'): boolean {
    if (this.selection.length !== 1) return false;
    const id = this.selection[0];
    const isPrefab = !!this.getInstance(id);
    const list: Array<MapObject | PrefabInstance> = isPrefab
      ? (this.map.prefabs ?? [])
      : (this.map.objects ?? []);
    const from = list.findIndex((o) => o.id === id);
    if (from < 0) return false;
    const to = layer === 'up' ? Math.min(list.length - 1, from + 1) : Math.max(0, from - 1);
    if (to === from) return false;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    this.commit();
    return true;
  }

  resetToDefault(): void {
    this.map = clone(getDefaultMap());
    this.selection = [];
    this.ensureIds();
    this.message = '已重置为默认地图';
    this.commit();
  }

  // ---------------- id 管理 ----------------
  private exists(id: string): boolean {
    if (this.getObject(id) || this.getInstance(id)) return true;
    const spawn = /^spawn:(\d+)$/.exec(id);
    if (spawn) return Number(spawn[1]) < (this.map.spawnPoints ?? []).length;
    const weapon = /^weapon:(\d+)$/.exec(id);
    if (weapon) return Number(weapon[1]) < (this.map.weapons ?? []).length;
    const joint = /^joint:(\d+)$/.exec(id);
    if (joint) return Number(joint[1]) < (this.map.joints ?? []).length;
    return false;
  }

  /** 选中的出生点下标（选择里只有一个 spawn: 时） */
  selectedSpawnIndex(): number | null {
    if (this.selection.length !== 1) return null;
    const m = /^spawn:(\d+)$/.exec(this.selection[0]);
    return m ? Number(m[1]) : null;
  }

  /** 选中的武器投放点下标 */
  selectedWeaponIndex(): number | null {
    if (this.selection.length !== 1) return null;
    const m = /^weapon:(\d+)$/.exec(this.selection[0]);
    return m ? Number(m[1]) : null;
  }

  selectedSpawnIndices(): number[] {
    return this.selection
      .map((id) => /^spawn:(\d+)$/.exec(id))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]));
  }

  /** 选中的关节下标（选择里只有一个 joint: 时） */
  selectedJointIndex(): number | null {
    if (this.selection.length !== 1) return null;
    const m = /^joint:(\d+)$/.exec(this.selection[0]);
    return m ? Number(m[1]) : null;
  }

  selectedJointIndices(): number[] {
    return this.selection
      .map((id) => /^joint:(\d+)$/.exec(id))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]));
  }

  selectedWeaponIndices(): number[] {
    return this.selection
      .map((id) => /^weapon:(\d+)$/.exec(id))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]));
  }

  private nextId(prefix: string): string {
    let id = `${prefix}${this.idSeq++}`;
    while (this.exists(id)) id = `${prefix}${this.idSeq++}`;
    return id;
  }

  /** 给所有缺失 id 的物体/实例补 id（编辑器依赖 id 做选择与关节引用） */
  ensureIds(): void {
    for (const obj of this.map.objects ?? []) {
      if (!obj.id) obj.id = this.nextId('o');
    }
    for (const inst of this.map.prefabs ?? []) {
      if (!inst.id) inst.id = this.nextId('p');
    }
  }

  // ---------------- 吸附 ----------------
  snapValue(v: number): number {
    return this.snapToGrid && this.gridSize > 0 ? Math.round(v / this.gridSize) * this.gridSize : v;
  }

  snapPoint(p: Vec): Vec {
    return { x: this.snapValue(p.x), y: this.snapValue(p.y) };
  }

  // ---------------- 查询 ----------------
  getObject(id: string): MapObject | undefined {
    return (this.map.objects ?? []).find((o) => o.id === id);
  }

  getInstance(id: string): PrefabInstance | undefined {
    return (this.map.prefabs ?? []).find((p) => p.id === id);
  }

  selectedObjects(): MapObject[] {
    return this.selection.map((id) => this.getObject(id)).filter((o): o is MapObject => !!o);
  }

  selectedInstances(): PrefabInstance[] {
    return this.selection.map((id) => this.getInstance(id)).filter((p): p is PrefabInstance => !!p);
  }

  select(ids: string[]): void {
    this.selection = ids;
    this.notify();
  }

  toggleSelect(id: string): void {
    this.selection = this.selection.includes(id)
      ? this.selection.filter((s) => s !== id)
      : [...this.selection, id];
    this.notify();
  }

  selectionBounds(): Bounds | null {
    const boxes: Bounds[] = [];
    for (const id of this.selection) {
      const obj = this.getObject(id);
      if (obj) {
        boxes.push(objectBounds(obj));
        continue;
      }
      const inst = this.getInstance(id);
      if (inst) boxes.push(instanceBounds(inst, this.prefabTable()[inst.ref]));
      const spawn = /^spawn:(\d+)$/.exec(id);
      if (spawn) {
        const sp = (this.map.spawnPoints ?? [])[Number(spawn[1])];
        if (sp) boxes.push({ minX: sp.x - 26, minY: sp.y - 26, maxX: sp.x + 26, maxY: sp.y + 26 });
      }
      const weapon = /^weapon:(\d+)$/.exec(id);
      if (weapon) {
        const w = (this.map.weapons ?? [])[Number(weapon[1])];
        if (w) boxes.push({ minX: w.x - 22, minY: w.y - 22, maxX: w.x + 22, maxY: w.y + 22 });
      }
      const joint = /^joint:(\d+)$/.exec(id);
      if (joint) {
        const a = (this.map.joints ?? [])[Number(joint[1])]?.anchor;
        if (a) boxes.push({ minX: a.x - 16, minY: a.y - 16, maxX: a.x + 16, maxY: a.y + 16 });
      }
    }
    return boxes.length ? unionBounds(boxes) : null;
  }

  /** 预制件表：注册表里的 + 当前草稿 */
  prefabTable(): Record<string, PrefabData> {
    const table = getPrefabTable();
    table[this.prefabDraft.id] = this.prefabDraft;
    return table;
  }

  /** 命中测试：从后往前（后画的在上） */
  hitTest(p: Vec): { kind: 'object' | 'prefab' | 'spawn' | 'weapon' | 'joint'; id: string } | null {
    // 交互标记优先于几何体：出生点/武器点常摆在地面上，否则永远选不中
    const spawns = this.map.spawnPoints ?? [];
    for (let i = spawns.length - 1; i >= 0; i--) {
      const sp = spawns[i];
      if (Math.hypot(p.x - sp.x, p.y - sp.y) <= 26) return { kind: 'spawn', id: `spawn:${i}` };
    }
    const weapons = this.map.weapons ?? [];
    for (let i = weapons.length - 1; i >= 0; i--) {
      const w = weapons[i];
      if (Math.hypot(p.x - w.x, p.y - w.y) <= 22) return { kind: 'weapon', id: `weapon:${i}` };
    }
    // 关节锚点：通常正落在物体内部（跷跷板支点），必须比几何体先判
    const joints = this.map.joints ?? [];
    for (let i = joints.length - 1; i >= 0; i--) {
      const a = joints[i].anchor;
      if (Math.hypot(p.x - a.x, p.y - a.y) <= JOINT_ANCHOR_HIT_RADIUS) {
        return { kind: 'joint', id: `joint:${i}` };
      }
    }
    const prefabs = this.map.prefabs ?? [];
    for (let i = prefabs.length - 1; i >= 0; i--) {
      const inst = prefabs[i];
      if (!inst.id) continue;
      const prefab = this.prefabTable()[inst.ref];
      if (!prefab) continue;
      for (const part of expandPrefab(prefab, inst)) {
        if (pointInObject(part, p)) return { kind: 'prefab', id: inst.id };
      }
    }
    const objects = this.map.objects ?? [];
    for (let i = objects.length - 1; i >= 0; i--) {
      if (objects[i].id && pointInObject(objects[i], p)) {
        return { kind: 'object', id: objects[i].id as string };
      }
    }
    return null;
  }

  /**
   * 重命名当前选中的对象/实例的 id。
   * 会同步修复引用它的关节（bodyA/bodyB），并校验唯一性与字符合法性。
   * @returns { ok, reason }
   */
  renameSelectedId(rawId: string): { ok: boolean; reason?: string } {
    if (this.selection.length !== 1) return { ok: false, reason: '只能单个改名' };
    const oldId = this.selection[0];
    const newId = rawId.trim();
    if (oldId.startsWith('spawn:') || oldId.startsWith('weapon:')) {
      return { ok: false, reason: '出生点/武器点没有 id' };
    }
    if (oldId.startsWith('part:')) return { ok: false, reason: '预制件部件没有 id' };
    if (!newId) return { ok: false, reason: 'id 不能为空' };
    if (!/^[A-Za-z0-9_\-]+$/.test(newId)) return { ok: false, reason: 'id 只能包含字母、数字、_ 和 -' };
    if (newId === oldId) return { ok: true };
    if (this.getIdOwner(newId)) return { ok: false, reason: `id "${newId}" 已被占用` };
    if ((this.map.joints ?? []).some((j) => j.id === newId)) {
      return { ok: false, reason: `id "${newId}" 与关节 id 冲突` };
    }

    const obj = this.getObject(oldId);
    const inst = this.getInstance(oldId);
    if (!obj && !inst) return { ok: false, reason: '没找到该对象' };
    if (obj) obj.id = newId;
    if (inst) inst.id = newId;

    // 修复关节引用
    for (const j of this.map.joints ?? []) {
      if (j.bodyA === oldId) j.bodyA = newId;
      if (j.bodyB === oldId) j.bodyB = newId;
    }
    this.selection = [newId];
    this.commit();
    return { ok: true };
  }

  /** 该 id 是否已被其它对象/实例占用 */
  getIdOwner(id: string): MapObject | PrefabInstance | undefined {
    return this.getObject(id) ?? this.getInstance(id);
  }

  // ---------------- 地图编辑 ----------------
  addObject(obj: MapObject, select = true): void {
    obj.id = this.nextId('o');
    this.map.objects.push(obj);
    if (select) this.selection = [obj.id];
    this.commit();
  }

  addPrefabInstance(ref: string, x: number, y: number): void {
    if (!this.map.prefabs) this.map.prefabs = [];
    const id = this.nextId('p');
    this.map.prefabs.push({ id, ref, x, y });
    this.selection = [id];
    this.commit();
  }

  addSpawn(x: number, y: number): void {
    this.map.spawnPoints.push({ x, y });
    this.commit();
  }

  updateSpawn(index: number, patch: Partial<SpawnPoint>): void {
    const s = this.map.spawnPoints[index];
    if (!s) return;
    Object.assign(s, patch);
    this.commit();
  }

  removeSpawn(index: number): void {
    this.map.spawnPoints.splice(index, 1);
    this.commit();
  }

  /** 地图武器生成点列表 */
  weaponSpawns(): MapWeaponSpawn[] {
    return this.map.weapons ?? [];
  }

  /** 投放一件武器（select=true 时选中它，便于立刻拖动/改类型） */
  addWeaponSpawn(type: string, x: number, y: number, select = true): void {
    if (!this.map.weapons) this.map.weapons = [];
    this.map.weapons.push({ type, x, y });
    if (select) this.selection = [`weapon:${this.map.weapons.length - 1}`];
    this.commit();
  }

  updateWeaponSpawn(index: number, patch: Partial<MapWeaponSpawn>): void {
    const w = (this.map.weapons ?? [])[index];
    if (!w) return;
    Object.assign(w, patch);
    this.commit();
  }

  removeWeaponSpawn(index: number): void {
    if (!this.map.weapons) return;
    this.map.weapons.splice(index, 1);
    this.selection = [];
    this.commit();
  }

  addJoint(bodyA: string, anchor: Vec): void {
    if (!this.map.joints) this.map.joints = [];
    const id = this.nextId('j');
    this.map.joints.push({ id, type: 'revolute', bodyA, anchor: { x: anchor.x, y: anchor.y } });
    this.pendingJointBodyA = null;
    this.commit();
  }

  removeJoint(index: number): void {
    this.map.joints?.splice(index, 1);
    this.selection = [];
    this.commit();
  }

  /** 修改关节锚点/主体（右栏表单用） */
  updateJoint(index: number, patch: Partial<Pick<MapJoint, 'anchor' | 'bodyB'>>): void {
    const j = (this.map.joints ?? [])[index];
    if (!j) return;
    if (patch.anchor) j.anchor = { ...j.anchor, ...patch.anchor };
    if (patch.bodyB !== undefined) j.bodyB = patch.bodyB;
    this.commit();
  }

  /** 修改所有选中对象/实例的属性 */
  patchSelected(patch: Record<string, unknown>): void {
    for (const obj of this.selectedObjects()) {
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'angle' || k === 'w' || k === 'h' || k === 'radius' || k === 'x' || k === 'y') {
          if (typeof v === 'number' && Number.isFinite(v)) (obj as unknown as Record<string, unknown>)[k] = v;
        } else if (k === 'fixed' || k === 'oneWay') {
          (obj as unknown as Record<string, unknown>)[k] = v === 'default' ? undefined : v;
        } else {
          (obj as unknown as Record<string, unknown>)[k] = v;
        }
      }
    }
    for (const inst of this.selectedInstances()) {
      if (typeof patch.x === 'number') inst.x = patch.x;
      if (typeof patch.y === 'number') inst.y = patch.y;
      if (typeof patch.angle === 'number') inst.angle = patch.angle;
      if ('flipX' in patch) inst.flipX = patch.flipX as boolean;
      if ('fixed' in patch) inst.fixed = patch.fixed === 'default' ? undefined : (patch.fixed as boolean);
    }
    this.commit();
  }

  /** 拖动中的即时修改（不记历史，只有节流通知） */
  patchObjectLive(id: string, patch: Record<string, unknown>): void {
    const obj = this.getObject(id);
    if (!obj) return;
    Object.assign(obj as unknown as Record<string, unknown>, patch);
    this.touchLive();
  }

  /** 预制件实例的即时修改 */
  patchInstanceLive(id: string, patch: Record<string, unknown>): void {
    const inst = this.getInstance(id);
    if (!inst) return;
    Object.assign(inst as unknown as Record<string, unknown>, patch);
    this.touchLive();
  }

  /** 平移选中物体（拖动过程中调用，不记历史） */
  translateSelected(dx: number, dy: number): void {
    for (const obj of this.selectedObjects()) {
      obj.x += dx;
      obj.y += dy;
    }
    for (const inst of this.selectedInstances()) {
      inst.x += dx;
      inst.y += dy;
    }
    for (const i of this.selectedSpawnIndices()) {
      const sp = this.map.spawnPoints[i];
      if (sp) {
        sp.x += dx;
        sp.y += dy;
      }
    }
    for (const i of this.selectedWeaponIndices()) {
      const w = (this.map.weapons ?? [])[i];
      if (w) {
        w.x += dx;
        w.y += dy;
      }
    }
    for (const i of this.selectedJointIndices()) {
      const j = (this.map.joints ?? [])[i];
      if (j) {
        j.anchor.x += dx;
        j.anchor.y += dy;
      }
    }
  }

  deleteSelected(): void {
    if (this.selection.length === 0) return;

    // 1) 下标型选择（出生点 / 武器点）：删完后后面的下标会前移，所以统一清空选择
    const spawnIdx = new Set(this.selectedSpawnIndices());
    const weaponIdx = new Set(this.selectedWeaponIndices());
    if (spawnIdx.size > 0) {
      this.map.spawnPoints = this.map.spawnPoints.filter((_, i) => !spawnIdx.has(i));
    }
    if (weaponIdx.size > 0) {
      this.map.weapons = (this.map.weapons ?? []).filter((_, i) => !weaponIdx.has(i));
    }
    const jointIdx = new Set(this.selectedJointIndices());
    if (jointIdx.size > 0) {
      this.map.joints = (this.map.joints ?? []).filter((_, i) => !jointIdx.has(i));
    }

    // 2) id 型选择（物体 / 预制件实例）
    const ids = new Set(this.selection.filter((id) => !/^(spawn|weapon|joint|part):/.test(id)));
    if (ids.size > 0) {
      this.map.objects = this.map.objects.filter((o) => !o.id || !ids.has(o.id));
      this.map.prefabs = (this.map.prefabs ?? []).filter((p) => !p.id || !ids.has(p.id));
      // 连带删除引用已删物体的关节
      this.map.joints = (this.map.joints ?? []).filter(
        (j) => !ids.has(j.bodyA) && (!j.bodyB || j.bodyB === 'world' || !ids.has(j.bodyB)),
      );
    }

    this.selection = [];
    this.commit();
  }


  duplicateSelected(): void {
    const newIds: string[] = [];
    for (const obj of this.selectedObjects()) {
      const copy = clone(obj);
      copy.id = this.nextId('o');
      copy.x += 20;
      copy.y += 20;
      this.map.objects.push(copy);
      newIds.push(copy.id);
    }
    for (const inst of this.selectedInstances()) {
      const copy = clone(inst);
      copy.id = this.nextId('p');
      copy.x += 20;
      copy.y += 20;
      if (!this.map.prefabs) this.map.prefabs = [];
      this.map.prefabs.push(copy);
      newIds.push(copy.id);
    }
    if (newIds.length) {
      this.selection = newIds;
      this.commit();
    }
  }

  /**
   * 把当前选中对象整体吸附到网格（松手时调用）。
   * 以第一个选中对象的"参考点"为基准：rect 用左上角，circle/polygon/预制件实例用中心。
   */
  snapSelectedToGrid(): boolean {
    if (!this.snapToGrid || this.gridSize <= 0 || this.selection.length === 0) return false;
    const firstId = this.selection[0];
    let ref: Vec | null = null;
    const obj = this.getObject(firstId);
    if (obj) {
      ref = obj.type === 'rect' ? { x: obj.x, y: obj.y } : { x: obj.x, y: obj.y };
    } else {
      const inst = this.getInstance(firstId);
      if (inst) ref = { x: inst.x, y: inst.y };
    }
    if (!ref) return false;
    const dx = this.snapValue(ref.x) - ref.x;
    const dy = this.snapValue(ref.y) - ref.y;
    if (dx === 0 && dy === 0) return false;
    this.translateSelected(dx, dy);
    return true;
  }

  /** 松手时把选中对象的尺寸/角度吸附到规范值 */
  snapSelectedShape(): void {
    if (this.selection.length !== 1) return;
    const obj = this.getObject(this.selection[0]);
    if (!obj || this.gridSize <= 0) return;
    if (!this.snapToGrid) return;
    const g = this.gridSize;
    if (obj.type === 'rect') {
      const cx = obj.x + obj.w / 2;
      const cy = obj.y + obj.h / 2;
      const w = Math.max(g, this.snapValue(obj.w));
      const h = Math.max(g, this.snapValue(obj.h));
      obj.x = cx - w / 2;
      obj.y = cy - h / 2;
      obj.w = w;
      obj.h = h;
    } else if (obj.type === 'circle') {
      obj.radius = Math.max(g / 2, this.snapValue(obj.radius));
    } else if (obj.sides !== undefined) {
      obj.radius = Math.max(g / 2, this.snapValue(obj.radius ?? 40));
    }
  }

  /** 预制件部件吸附到网格（松手时调用） */
  snapPartToGrid(index: number): boolean {
    if (!this.snapToGrid || this.gridSize <= 0) return false;
    const part = this.prefabDraft.parts[index];
    if (!part) return false;
    const c = objectCenter(part);
    const dx = this.snapValue(c.x) - c.x;
    const dy = this.snapValue(c.y) - c.y;
    if (dx === 0 && dy === 0) return false;
    if (part.type === 'rect') {
      part.x += dx;
      part.y += dy;
    } else {
      part.x += dx;
      part.y += dy;
    }
    return true;
  }

  nudge(dx: number, dy: number): void {
    if (this.selection.length === 0) return;
    this.translateSelected(dx, dy);
    this.commit();
  }

  // ---------------- 预制件编辑 ----------------
  newPrefab(): void {
    this.prefabDraft = emptyPrefabDraft();
    this.selection = [];
    this.commit();
  }

  loadPrefab(id: string): void {
    const found = listPrefabs().find((p) => p.id === id);
    if (!found) return;
    this.prefabDraft = clone(found);
    this.selection = [];
    this.message = `已载入预制件 ${id}`;
    this.commit();
  }

  updatePrefabMeta(patch: Partial<PrefabData>): void {
    Object.assign(this.prefabDraft, patch);
    this.commit();
  }

  addPart(part: MapObject): void {
    this.prefabDraft.parts.push(part);
    this.commit();
  }

  updatePart(index: number, patch: Record<string, unknown>): void {
    const part = this.prefabDraft.parts[index];
    if (!part) return;
    Object.assign(part as unknown as Record<string, unknown>, patch);
    this.commit();
  }

  removePart(index: number): void {
    this.prefabDraft.parts.splice(index, 1);
    this.commit();
  }

  // ---------------- 材质编辑 ----------------
  updateMaterial(id: string, patch: Partial<MaterialJson>): void {
    if (!patchMaterial(id, patch)) return;
    // 贴图变了就清掉失败缓存，允许重新尝试加载
    if ('texture' in patch) forgetTextureFailures();
    this.commit();
  }

  /** 新增材质（id 重复则失败） */
  addMaterial(id: string, name: string, templateId?: string): { ok: boolean; reason?: string } {
    const clean = id.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(clean)) {
      return { ok: false, reason: 'id 只能包含字母/数字/下划线，且以字母开头' };
    }
    if (MATERIALS[clean]) return { ok: false, reason: `材质 "${clean}" 已存在` };
    const base = templateId && MATERIALS[templateId] ? materialToJson(MATERIALS[templateId]) : defaultMaterialJson(clean);
    addMaterialToTable(clean, { ...base, name: name.trim() || clean });
    this.activeMaterialId = clean;
    this.message = `已新增材质 ${clean}`;
    this.commit();
    return { ok: true };
  }

  /** 材质被多少地方引用 */
  materialUsage(id: string): { objects: number; prefabParts: number; instances: number } {
    const objects = (this.map.objects ?? []).filter((o) => o.material === id).length;
    const prefabParts = this.prefabDraft.parts.filter((p) => p.material === id).length;
    const instances = (this.map.prefabs ?? []).filter((inst) => {
      const prefab = this.prefabTable()[inst.ref];
      return !!prefab && prefab.parts.some((p) => p.material === id);
    }).length;
    return { objects, prefabParts, instances };
  }

  /** 删除材质（被引用时拒绝，避免地图出现空洞） */
  deleteMaterial(id: string): { ok: boolean; reason?: string } {
    if (materialIds().length <= 1) return { ok: false, reason: '至少要保留一个材质' };
    const usage = this.materialUsage(id);
    const used = usage.objects + usage.prefabParts + usage.instances;
    if (used > 0) {
      return {
        ok: false,
        reason: `该材质仍被引用（地图物体 ${usage.objects}、预制件部件 ${usage.prefabParts}、预制件实例 ${usage.instances}），请先改掉引用`,
      };
    }
    removeMaterialFromTable(id);
    if (this.activeMaterialId === id) this.activeMaterialId = materialIds()[0];
    this.message = `已删除材质 ${id}`;
    this.commit();
    return { ok: true };
  }

  /** 记录编辑器内的贴图预览覆盖 */
  setTextureOverride(ref: string, dataUrl: string | null): void {
    if (dataUrl) this.textureOverrides.set(ref, dataUrl);
    else this.textureOverrides.delete(ref);
    forgetTextureFailures();
  }

  materialConfig(id: string): MaterialConfig | undefined {
    return MATERIALS[id];
  }

  // ---------------- 多边形顶点编辑 ----------------
  /** 当前可做顶点编辑的目标（单选的多边形：地图物体 或 预制件部件） */
  polygonTarget(): { scope: 'map'; id: string } | { scope: 'prefab'; index: number } | null {
    if (this.tab === 'prefab') {
      const idx = this.selectedPartIndex();
      if (idx === null) return null;
      const part = this.prefabDraft.parts[idx];
      return part?.type === 'polygon' ? { scope: 'prefab', index: idx } : null;
    }
    if (this.tab !== 'map' || this.selection.length !== 1) return null;
    const obj = this.getObject(this.selection[0]);
    return obj?.type === 'polygon' ? { scope: 'map', id: this.selection[0] } : null;
  }

  private polygonOf(target: { scope: 'map'; id: string } | { scope: 'prefab'; index: number }) {
    if (target.scope === 'map') {
      const obj = this.getObject(target.id);
      return obj?.type === 'polygon' ? obj : null;
    }
    const part = this.prefabDraft.parts[target.index];
    return part?.type === 'polygon' ? part : null;
  }

  /** 多边形中心在世界中的坐标（旋转枢轴） */
  polygonOriginWorld(target: { scope: 'map'; id: string } | { scope: 'prefab'; index: number }): Vec | null {
    const poly = this.polygonOf(target);
    if (!poly) return null;
    if (target.scope === 'map') return { x: poly.x, y: poly.y };
    const o = this.prefabRigOrigin();
    return { x: o.x + poly.x, y: o.y + poly.y };
  }

  /** 当前选中多边形的世界顶点（供画布画手柄/命中） */
  polygonWorldVertices(): Vec[] {
    const t = this.polygonTarget();
    if (!t) return [];
    const poly = this.polygonOf(t);
    const origin = this.polygonOriginWorld(t);
    if (!poly || !origin) return [];
    return worldVertices(poly, origin);
  }

  /** 当前多边形是否为凹形（Matter 会按凸包处理） */
  polygonIsConcave(): boolean {
    const t = this.polygonTarget();
    const poly = t ? this.polygonOf(t) : null;
    return !!poly && !isConvex(currentVertices(poly));
  }

  /** 当前多边形的凸包（世界坐标，用于提示"物理实际形状"） */
  polygonConvexHullWorld(): Vec[] {
    const t = this.polygonTarget();
    if (!t) return [];
    const poly = this.polygonOf(t);
    const origin = this.polygonOriginWorld(t);
    if (!poly || !origin) return [];
    const local = convexHull(currentVertices(poly));
    const rot = ((poly.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return local.map((v) => ({
      x: origin.x + v.x * cos - v.y * sin,
      y: origin.y + v.x * sin + v.y * cos,
    }));
  }

  private applyPolygonResult(
    target: { scope: 'map'; id: string } | { scope: 'prefab'; index: number },
    res: { vertices: Vec[]; shift: Vec },
  ): void {
    const poly = this.polygonOf(target);
    if (!poly) return;
    poly.vertices = res.vertices;
    poly.x += res.shift.x;
    poly.y += res.shift.y;
    // 转成自定义顶点后，正多边形简写不再适用
    delete (poly as { sides?: number }).sides;
    delete (poly as { radius?: number }).radius;
  }

  /** 拖动顶点（过程中调用，不记历史） */
  polygonMoveVertex(index: number, world: Vec): void {
    const t = this.polygonTarget();
    if (!t) return;
    const poly = this.polygonOf(t);
    const origin = this.polygonOriginWorld(t);
    if (!poly || !origin) return;
    const res = moveVertex(poly, index, world, origin);
    if (!res) return;
    this.applyPolygonResult(t, res);
    this.touchLive();
  }

  /** 在边上插入顶点 */
  polygonInsertVertex(edgeIndex: number, world: Vec): void {
    const t = this.polygonTarget();
    if (!t) return;
    const poly = this.polygonOf(t);
    const origin = this.polygonOriginWorld(t);
    if (!poly || !origin) return;
    const res = insertVertex(poly, edgeIndex, world, origin);
    if (!res) return;
    this.applyPolygonResult(t, res);
    this.message = `已插入顶点（共 ${res.vertices.length} 个）`;
    this.commit();
  }

  /** 删除顶点（至少保留 3 个） */
  polygonDeleteVertex(index: number): boolean {
    const t = this.polygonTarget();
    if (!t) return false;
    const poly = this.polygonOf(t);
    if (!poly) return false;
    const res = removeVertex(poly, index);
    if (!res) {
      this.message = '多边形至少需要 3 个顶点';
      this.touch();
      return false;
    }
    this.applyPolygonResult(t, res);
    this.message = `已删除顶点（剩 ${res.vertices.length} 个）`;
    this.commit();
    return true;
  }

  /** 顶点数量（供属性面板显示） */
  polygonVertexCount(): number {
    const t = this.polygonTarget();
    if (!t) return 0;
    const poly = this.polygonOf(t);
    return poly ? currentVertices(poly).length : 0;
  }

  /** 把正多边形简写固化成显式顶点（不改形状） */
  polygonMakeEditable(): void {
    const t = this.polygonTarget();
    if (!t) return;
    const poly = this.polygonOf(t);
    if (!poly || (poly.vertices && poly.vertices.length >= 3)) return;
    this.applyPolygonResult(t, { vertices: currentVertices(poly).map((v) => ({ ...v })), shift: { x: 0, y: 0 } });
    this.commit();
  }

  // ---------------- 预制件工作台几何 ----------------
  /** 工作台原点（预制件局部坐标 0,0 对应的世界坐标） */
  prefabRigOrigin(): Vec {
    return { x: PREFAB_RIG.width / 2, y: PREFAB_RIG.groundY - 120 };
  }

  /** 世界坐标 → 预制件局部坐标 */
  worldToPartLocal(world: Vec): Vec {
    const o = this.prefabRigOrigin();
    return { x: world.x - o.x, y: world.y - o.y };
  }

  /** 命中测试预制件部件（后添加的在上层） */
  hitTestPart(world: Vec): number | null {
    const local = this.worldToPartLocal(world);
    const parts = this.prefabDraft.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (pointInObject(parts[i], local)) return i;
    }
    return null;
  }

  /** 部件在世界中的包围盒 */
  partWorldBounds(index: number): Bounds | null {
    const part = this.prefabDraft.parts[index];
    if (!part) return null;
    const b = objectBounds(part);
    const o = this.prefabRigOrigin();
    return { minX: b.minX + o.x, minY: b.minY + o.y, maxX: b.maxX + o.x, maxY: b.maxY + o.y };
  }

  /** 部件在世界中的中心（旋转枢轴） */
  partWorldCenter(index: number): Vec | null {
    const part = this.prefabDraft.parts[index];
    if (!part) return null;
    const c = objectCenter(part);
    const o = this.prefabRigOrigin();
    return { x: c.x + o.x, y: c.y + o.y };
  }

  /** 当前选中的部件索引（selection 里形如 "part:3"） */
  selectedPartIndex(): number | null {
    const sel = this.selection.find((s) => s.startsWith('part:'));
    if (!sel) return null;
    const i = Number(sel.slice(5));
    return Number.isInteger(i) && i >= 0 && i < this.prefabDraft.parts.length ? i : null;
  }

  /** 拖动中的即时修改（不记历史，松手时 commit） */
  patchPartLive(index: number, patch: Record<string, unknown>): void {
    const part = this.prefabDraft.parts[index];
    if (!part) return;
    Object.assign(part as unknown as Record<string, unknown>, patch);
    this.touchLive();
  }

  // ---------------- 渲染数据 ----------------
  /** 当前 Tab 下编辑器画布应渲染的地图 */
  renderMap(): MapData {
    if (this.tab === 'prefab') return this.prefabRig();
    if (this.tab === 'material') return this.materialRig();
    return this.map;
  }

  /** 预制件工作台：地面 + 预制件展开 */
  private prefabRig(): MapData {
    const W = PREFAB_RIG.width;
    const H = PREFAB_RIG.height;
    const groundY = PREFAB_RIG.groundY;
    const origin = this.prefabRigOrigin();
    return {
      version: MAP_FORMAT_VERSION,
      name: `__prefab_rig`,
      width: W,
      height: H,
      spawnPoints: [
        { x: W / 2 - 320, y: groundY - 48 },
        { x: W / 2 + 320, y: groundY - 48 },
      ],
      objects: [
        {
          id: 'rig_ground',
          type: 'rect',
          x: 0,
          y: groundY,
          w: W,
          h: H - groundY,
          material: 'ground',
        },
      ],
      // 用"预制件实例"渲染，这样 bodyMode(松件/焊接) 与实际游戏完全一致
      prefabs: [{ id: this.prefabDraft.id, ref: this.prefabDraft.id, x: origin.x, y: origin.y }],
    };
  }

  /**
   * 材质工作台：用同一种材质摆出「固定」与「动态」两组对照。
   *
   * 关键：动态物体必须**从空中开始**，否则它们一开始就站在地面上，
   * 根本看不到"会不会掉落"（踩不到坑的人会以为 fixed 没生效）。
   *   - 左侧 fixed:true → 悬在空中不动，证明"固定"
   *   - 右侧不填 fixed → 从空中落下，证明"动态"
   * 另有斜面对照，用来试摩擦（冰面 vs 木头）。
   */
  private materialRig(): MapData {
    const W = 1600;
    const H = 900;
    const groundY = 700;
    const mat = this.activeMaterialId;
    return {
      version: MAP_FORMAT_VERSION,
      name: `__material_rig_${mat}`,
      width: W,
      height: H,
      spawnPoints: [
        { x: 120, y: groundY - 48 },
        { x: 1480, y: groundY - 48 },
      ],
      objects: [
        { id: 'rig_ground', type: 'rect', x: 0, y: groundY, w: W, h: H - groundY, material: 'ground' },

        // ===== 固定对照（左）：悬空也不动 =====
        { id: 'rig_fixed_plate', type: 'rect', x: 260, y: 330, w: 240, h: 24, material: mat, fixed: true },
        { id: 'rig_fixed_hex', type: 'polygon', x: 300, y: 470, sides: 6, radius: 60, material: mat, fixed: true },
        // 斜面对照：站上去试摩擦/滑动（冰面会滑，木头不会）
        { id: 'rig_fixed_ramp', type: 'rect', x: 320, y: 600, w: 260, h: 20, material: mat, fixed: true, angle: -14 },

        // ===== 动态对照（右）：从空中落下，证明"没勾固定就会掉" =====
        { id: 'rig_dynamic_box', type: 'rect', x: 820, y: 240, w: 90, h: 90, material: mat },
        { id: 'rig_dynamic_ball', type: 'circle', x: 1080, y: 200, radius: 40, material: mat },
        { id: 'rig_dynamic_plank', type: 'rect', x: 1140, y: 320, w: 200, h: 16, material: mat },
      ],
    };
  }

  // ---------------- 校验 ----------------
  validateCurrent(): Issue[] {
    if (this.issuesCache && this.issuesCacheRev === this.rev && this.issuesCacheTab === this.tab) {
      return this.issuesCache;
    }
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()), listItemIds());
    const issues =
      this.tab === 'prefab'
        ? validatePrefab(this.prefabDraft, ctx)
        : this.tab === 'material'
          ? validateMaterialsFile(serializeMaterials())
          : validateMap(this.map, ctx);
    this.issuesCache = issues;
    this.issuesCacheRev = this.rev;
    this.issuesCacheTab = this.tab;
    return issues;
  }

  // ---------------- 导入 / 导出 ----------------
  exportMapJson(): string {
    return JSON.stringify(this.map, null, 2);
  }

  exportPrefabJson(): string {
    return JSON.stringify(this.prefabDraft, null, 2);
  }

  exportMaterialsJson(): string {
    return JSON.stringify(serializeMaterials(), null, 2);
  }

  importMapJson(text: string): { ok: boolean; issues: Issue[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, issues: [{ level: 'error', path: 'json', message: `JSON 解析失败：${(e as Error).message}` }] };
    }
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()), listItemIds());
    const issues = validateMap(parsed, ctx);
    const fatal = issues.filter((i) => i.level === 'error');
    if (fatal.length > 0) return { ok: false, issues };
    this.map = parsed as MapData;
    this.map.objects ??= [];
    this.selection = [];
    this.ensureIds();
    this.message = `已导入地图 ${this.map.name}`;
    this.commit();
    return { ok: true, issues };
  }

  importPrefabJson(text: string): { ok: boolean; issues: Issue[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, issues: [{ level: 'error', path: 'json', message: `JSON 解析失败：${(e as Error).message}` }] };
    }
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()), listItemIds());
    const issues = validatePrefab(parsed, ctx);
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
    this.prefabDraft = parsed as PrefabData;
    this.message = `已导入预制件 ${this.prefabDraft.id}`;
    this.commit();
    return { ok: true, issues };
  }

  importMaterialsJson(text: string): { ok: boolean; issues: Issue[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, issues: [{ level: 'error', path: 'json', message: `JSON 解析失败：${(e as Error).message}` }] };
    }
    const issues = validateMaterialsFile(parsed);
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
    replaceMaterials(parsed as MaterialsFile);
    this.message = '已导入材质表';
    this.commit();
    return { ok: true, issues };
  }

  /** 当前 Tab 对应的导出文件名 */
  exportFileName(): string {
    if (this.tab === 'prefab') return `${this.prefabDraft.id}.json`;
    if (this.tab === 'material') return 'materials.json';
    return `${this.map.name}.json`;
  }

  /** 当前 Tab 对应的导出内容 */
  exportCurrent(): string {
    if (this.tab === 'prefab') return this.exportPrefabJson();
    if (this.tab === 'material') return this.exportMaterialsJson();
    return this.exportMapJson();
  }

  importCurrent(text: string): { ok: boolean; issues: Issue[] } {
    if (this.tab === 'prefab') return this.importPrefabJson(text);
    if (this.tab === 'material') return this.importMaterialsJson(text);
    return this.importMapJson(text);
  }

  /** 选中物体的中心点（供 UI 显示） */
  selectionCenter(): Vec | null {
    const b = this.selectionBounds();
    return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null;
  }

  /** 选中第一个物体（属性面板用） */
  firstSelectedObject(): MapObject | null {
    const obj = this.selectedObjects()[0];
    if (obj) return obj;
    return null;
  }

  firstSelectedInstance(): PrefabInstance | null {
    return this.selectedInstances()[0] ?? null;
  }

  /** 便于 UI 判断 joint 步进状态 */
  jointHint(): string {
    return this.pendingJointBodyA ? `已选主体 ${this.pendingJointBodyA}，点击锚点位置` : '先点选一个物体作为主体（bodyA）';
  }

  centerOfObject(id: string): Vec | null {
    const obj = this.getObject(id);
    return obj ? objectCenter(obj) : null;
  }

  joints(): MapJoint[] {
    return this.map.joints ?? [];
  }

  /** 关闭消息提示 */
  clearMessage(): void {
    this.message = '';
    this.notify();
  }
}

export const editorStore = new EditorStore();
