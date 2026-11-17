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
import type { PrefabData, PrefabJoint, PrefabWeaponSpawn } from '../map/PrefabFormat';
import { PREFAB_FORMAT_VERSION } from '../map/PrefabFormat';
import { getDefaultMap, getMapByName, getPrefabTable, listPrefabs, dataHash } from '../map/MapRegistry';
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
import { getItem, listItemIds } from '../world/ItemFormat';
import { getWeapon, listWeaponIds } from '../combat/WeaponFormat';
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

/** 火柴人碰撞体半高（脚底相对原点 +48），参考火柴人的命中用 */
const PLAYER_HALF_HEIGHT = 48;

export type EditorTab = 'map' | 'prefab' | 'material';
export type ToolKind =
  | 'select'
  | 'rect'
  | 'circle'
  | 'polygon'
  | 'spawn'
  | 'prefab'
  | 'weapon'
  | 'joint'
  | 'ruler'
  /** 放置"参考火柴人"（只用于对照尺寸，不写入地图数据） */
  | 'ref';

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
  /**
   * 保存时「该地图/预制件文件」的内容指纹（null = 当时没有对应文件）。
   *
   * 用途与 materialsHash 同理：草稿进 localStorage 后，如果外部改了 JSON
   * （手改 / AI / git pull），恢复时以文件为准并提示，避免旧草稿静默描掉文件。
   */
  mapHash?: string | null;
  prefabHash?: string | null;
}

/**
 * 文件指纹缓存：同一页面生命周期内 data/*.json 不会变（变了会整页刷新），
 * 所以每份文件只算一次，避免每次 commit 都重新 stringify 整张地图。
 */
const mapHashCache = new Map<string, string | null>();
const prefabHashCache = new Map<string, string | null>();

function cachedMapHash(name: string): string | null {
  if (!mapHashCache.has(name)) {
    const file = getMapByName(name);
    mapHashCache.set(name, file ? dataHash(file) : null);
  }
  return mapHashCache.get(name) ?? null;
}

function cachedPrefabHash(id: string): string | null {
  if (!prefabHashCache.has(id)) {
    const file = listPrefabs().find((p) => p.id === id);
    prefabHashCache.set(id, file ? dataHash(file) : null);
  }
  return prefabHashCache.get(id) ?? null;
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
  /** 显示出生点标记（编辑器显示开关，不影响数据） */
  showSpawnPoints = true;
  /** 预制件工作台：显示左侧的灰色参照火柴人（编辑器显示开关） */
  showPrefabRef = true;
  /** 显示武器刷新点标记（编辑器显示开关，不影响数据） */
  showWeaponSpawns = true;
  /** 地图文档 */
  map: MapData;
  /** 预制件草稿（预制件 Tab 编辑的对象） */
  prefabDraft: PrefabData;
  /** 选中 id 列表（地图物体 id / 预制件实例 id / 预制件部件用 "part:<index>"） */
  selection: string[] = [];
  /** 预制件调色板中待放置的预制件 */
  activePrefabId: string | null = null;
  /** 当前选中的待投放武器 id（weapon 工具用） */
  /** 投放点待放置的内容 id（武器 id 或道具 id；`__random__` = 随机） */
  activeWeaponId: string | null = null;
  /** 材质 Tab 当前编辑的材质 */
  activeMaterialId = 'wood';
  /** 关节工具第一步选中的物体 id */
  pendingJointBodyA: string | null = null;
  /** 尺子工具 */
  ruler: { from: Vec; to: Vec } | null = null;
  /**
   * 画布上的"参考火柴人"（只用于对照尺寸，**不写入地图 JSON**）。
   * 属于编辑器临时标注，随地图切换清空。
   */
  refFigures: Array<{ x: number; y: number; facing: 1 | -1 }> = [];
  /** 当前选中的参考火柴人下标（与地图对象选择互斥） */
  selectedRefIndex: number | null = null;
  /** 编辑器内部剪贴板（物体/实例 或 预制件部件），不写入 JSON */
  private clipboard:
    | {
        kind: 'map';
        objects: MapObject[];
        instances: PrefabInstance[];
        spawns: SpawnPoint[];
        weapons: MapWeaponSpawn[];
      }
    | { kind: 'parts'; parts: MapObject[] }
    | null = null;
  /** 状态栏消息 */
  message = '';
  /** 材质文件被外部修改时的提示（只提示一次，不写入 message 以免被后续操作覆盖太快） */
  materialNotice = '';
  /** 地图/预制件文件被外部修改时的提示（与 materialNotice 同用法） */
  fileNotice = '';
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
  /** 新建预制件的会话内序号（保证连续新建的 id 不会互相复用） */
  private prefabSeq = 1;
  private silent = false;

  constructor() {
    this.map = clone(getDefaultMap());
    this.prefabDraft = emptyPrefabDraft();
    this.restore();
    this.ensureIds();
    this.resetHistory();
    // 材质文件被外部改过：把提示作为初始状态消息显示出来
    if (this.materialNotice) this.message = this.materialNotice;
    else if (this.fileNotice) this.message = this.fileNotice;
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
        // 记下"草稿基于哪份文件"，供 restore 判断文件是否被外部改过
        mapHash: cachedMapHash(this.map.name),
        prefabHash: cachedPrefabHash(this.prefabDraft.id),
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
      if (saved?.map) {
        const name = saved.map.name;
        const file = getMapByName(name);
        if (!file) {
          // 没有同名文件（编辑器里新建、尚未导出）：草稿就是唯一副本
          this.map = saved.map;
        } else if ((saved.mapHash ?? null) === dataHash(file)) {
          // 文件自存草稿以来没变过：保留草稿（可能含未导出的修改）
          this.map = saved.map;
        } else {
          // 文件被外部改过（或草稿来源不明）：以文件为准
          this.map = clone(file);
          this.fileNotice = `data/maps/${name}.json 已被外部修改：已重新载入文件版本（未导出的草稿已丢弃）`;
        }
      }
      if (saved?.prefabDraft) {
        const id = saved.prefabDraft.id;
        const file = listPrefabs().find((p) => p.id === id);
        if (!file) {
          this.prefabDraft = saved.prefabDraft;
        } else if ((saved.prefabHash ?? null) === dataHash(file)) {
          this.prefabDraft = saved.prefabDraft;
        } else {
          const restored = clone(file);
          this.stripPartIds(restored);
          this.prefabDraft = restored;
          this.fileNotice = `data/prefabs/${id}.json 已被外部修改：已重新载入文件版本（未导出的草稿已丢弃）`;
        }
      }
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
    this.refFigures = [];
    const clean = name.trim();
    if (!clean) return { ok: false, reason: '地图名不能为空' };
    const map: MapData = {
      version: MAP_FORMAT_VERSION,
      name: clean,
      mode: 'random',
      lives: 1,
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
    this.selectedRefIndex = null;
    this.notify();
  }

  toggleSelect(id: string): void {
    this.selection = this.selection.includes(id)
      ? this.selection.filter((s) => s !== id)
      : [...this.selection, id];
    this.selectedRefIndex = null;
    this.notify();
  }

  /** 选中一个参考火柴人（清空地图对象选择） */
  selectRef(index: number | null): void {
    this.selectedRefIndex = index;
    this.selection = [];
    this.notify();
  }

  /** 拖动参考火柴人（不记历史：它只是编辑器标注） */
  moveRefFigure(index: number, x: number, y: number): void {
    const fig = this.refFigures[index];
    if (!fig) return;
    fig.x = Math.round(x);
    fig.y = Math.round(y);
    this.touch();
  }

  deleteRefFigure(index: number): void {
    if (index < 0 || index >= this.refFigures.length) return;
    this.refFigures.splice(index, 1);
    this.selectedRefIndex = null;
    this.message = '已删除参考火柴人';
    this.touch();
  }

  /** 命中参考火柴人（身体矩形：脚底 y+48、头顶 y-63、左右各 22） */
  hitTestRef(p: Vec): number | null {
    for (let i = this.refFigures.length - 1; i >= 0; i--) {
      const f = this.refFigures[i];
      if (Math.abs(p.x - f.x) <= 22 && p.y >= f.y - 63 && p.y <= f.y + PLAYER_HALF_HEIGHT) return i;
    }
    return null;
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
    // 被“显示”开关隐藏的标记不参与命中，避免点到看不见的东西
    const spawns = this.showSpawnPoints ? this.map.spawnPoints ?? [] : [];
    for (let i = spawns.length - 1; i >= 0; i--) {
      const sp = spawns[i];
      if (Math.hypot(p.x - sp.x, p.y - sp.y) <= 26) return { kind: 'spawn', id: `spawn:${i}` };
    }
    const weapons = this.showWeaponSpawns ? this.map.weapons ?? [] : [];
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
  /**
   * 新增一个武器掉落点（默认固定武器 + 10 秒刷新一次）。
   * @param weaponId 固定武器 id（mode=fixed 时使用）
   * @param mode     fixed = 指定武器；random = 从候选池随机
   */
  addWeaponSpawn(
    weaponId: string,
    x: number,
    y: number,
    select = true,
    mode: 'fixed' | 'random' = 'fixed',
  ): void {
    if (!this.map.weapons) this.map.weapons = [];
    // 投放内容可以是武器，也可以是补给道具（医疗包/防弹衣）：
    // 道具写进 item 字段，武器写进 weapon —— 运行时按同一套规则解析。
    const isItem = !!weaponId && !getWeapon(weaponId) && !!getItem(weaponId);
    const point: MapWeaponSpawn =
      mode === 'random'
        ? { x, y, mode: 'random', pool: [], respawnMs: 10000, maxRespawns: 0 }
        : {
            x,
            y,
            mode: 'fixed',
            ...(isItem ? { item: weaponId } : { weapon: weaponId }),
            respawnMs: 10000,
            maxRespawns: 0,
          };
    this.map.weapons.push(point);
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

  /**
   * 关节可以指向的刚体 id 列表（给右栅“主体 A / 另一端 B”下拉用）。
   *
   * 与 MapLoader 的 `bodiesById` 完全对齐：
   * - 地图内联物体 → 自己的 id
   * - 预制件焊接体（bodyMode: compound） → 实例 id（整体一个刚体）
   * - 预制件松件 → 每个部件 `${instId}#i`
   */
  jointCandidates(): Array<{ id: string; label: string }> {
    const out: Array<{ id: string; label: string }> = [];
    for (const obj of this.map.objects ?? []) {
      if (!obj.id) continue;
      out.push({ id: obj.id, label: `物体 ${obj.id}（${obj.material}）` });
    }
    const table = this.prefabTable();
    for (const inst of this.map.prefabs ?? []) {
      if (!inst.id) continue;
      const prefab = table[inst.ref];
      if (!prefab) continue;
      if ((prefab.bodyMode ?? 'loose') === 'compound') {
        out.push({ id: inst.id, label: `预制件 ${inst.id}（焊接，${prefab.name}）` });
        continue;
      }
      for (const part of expandPrefab(prefab, inst)) {
        if (part.id) out.push({ id: part.id, label: `预制件 ${inst.id} 部件 ${part.id}` });
      }
    }
    return out;
  }

  /**
   * 指针下的“可作为关节端点的刚体 id”。
   *
   * 与 hitTest 的区别：预制件要返回**真正的刚体 id**——焊接体返回实例 id，
   * 松件按下哪个部件就返回哪个部件（`${instId}#i`）。
   */
  jointBodyAt(p: Vec): string | null {
    const table = this.prefabTable();
    const prefabs = this.map.prefabs ?? [];
    for (let i = prefabs.length - 1; i >= 0; i--) {
      const inst = prefabs[i];
      if (!inst.id) continue;
      const prefab = table[inst.ref];
      if (!prefab) continue;
      if ((prefab.bodyMode ?? 'loose') === 'compound') {
        const b = instanceBounds(inst, prefab);
        if (p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY) return inst.id;
        continue;
      }
      const parts = expandPrefab(prefab, inst);
      for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j].id && pointInObject(parts[j], p)) return parts[j].id as string;
      }
    }
    const objects = this.map.objects ?? [];
    for (let i = objects.length - 1; i >= 0; i--) {
      if (objects[i].id && pointInObject(objects[i], p)) return objects[i].id as string;
    }
    return null;
  }

  addJoint(bodyA: string, anchor: Vec, bodyB?: string): void {
    if (!this.map.joints) this.map.joints = [];
    const id = this.nextId('j');
    const joint: MapJoint = { id, type: 'revolute', bodyA, anchor: { x: anchor.x, y: anchor.y } };
    if (bodyB && bodyB !== bodyA) joint.bodyB = bodyB;
    this.map.joints.push(joint);
    this.pendingJointBodyA = null;
    this.commit();
  }

  removeJoint(index: number): void {
    this.map.joints?.splice(index, 1);
    this.selection = [];
    this.commit();
  }

  /** 修改关节锚点/主体（右栏表单用） */
  updateJoint(index: number, patch: Partial<Pick<MapJoint, 'anchor' | 'bodyA' | 'bodyB' | 'noCollide'>>): void {
    const j = (this.map.joints ?? [])[index];
    if (!j) return;
    if (patch.anchor) j.anchor = { ...j.anchor, ...patch.anchor };
    if (patch.bodyA !== undefined) j.bodyA = patch.bodyA;
    if (patch.bodyB !== undefined) j.bodyB = patch.bodyB === 'world' ? undefined : patch.bodyB;
    if (patch.noCollide !== undefined) j.noCollide = patch.noCollide;
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
    // 参考火柴人（编辑器标注）优先：它不在地图数据里
    if (this.selectedRefIndex !== null) {
      this.deleteRefFigure(this.selectedRefIndex);
      return;
    }
    if (this.selection.length === 0) return;

    // 0) 预制件自带的武器掉落点
    if (this.tab === 'prefab' && this.selectedPrefabWeaponIndex() !== null) {
      this.removePrefabWeaponSpawn(this.selectedPrefabWeaponIndex() as number);
      this.message = '已删除预制件的武器掉落点';
      return;
    }

    // 0) 预制件部件（预制件 Tab 的多选/范围选中 / Del 键 / 右栏「删除 N 个」）
    const partIdx = this.selectedPartIndices();
    if (this.tab === 'prefab' && partIdx.length > 0) {
      // 必须走 dropParts：它会同步重映射内部关节的部件下标（直接 filter 会让关节整体错位）
      const removed = this.dropParts(new Set(partIdx));
      this.selection = [];
      this.message = `已删除 ${removed} 个部件`;
      this.commit();
      return;
    }

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

  // ---------------- 复制 / 粘贴（编辑器内部剪贴板） ----------------

  /** 复制当前选择：地图 Tab 复制物体+预制件实例，预制件 Tab 复制部件 */
  copySelection(): boolean {
    if (this.tab === 'prefab') {
      const idxs = this.selectedPartIndices();
      if (idxs.length === 0) return false;
      this.clipboard = { kind: 'parts', parts: idxs.map((i) => clone(this.prefabDraft.parts[i])) };
      this.message = `已复制 ${idxs.length} 个部件`;
      this.touch();
      return true;
    }
    const objects = this.selectedObjects().map((o) => clone(o));
    const instances = this.selectedInstances().map((i) => clone(i));
    const spawns = this.selectedSpawnIndices().map((i) => clone(this.map.spawnPoints[i]));
    const weapons = this.selectedWeaponIndices().map((i) => clone((this.map.weapons ?? [])[i]));
    const total = objects.length + instances.length + spawns.length + weapons.length;
    if (total === 0) return false;
    this.clipboard = { kind: 'map', objects, instances, spawns, weapons };
    this.message = `已复制 ${total} 个对象`;
    this.touch();
    return true;
  }

  /** 是否可粘贴（剪贴板有内容且与当前 Tab 匹配） */
  canPaste(): boolean {
    if (!this.clipboard) return false;
    return this.tab === 'prefab' ? this.clipboard.kind === 'parts' : this.clipboard.kind === 'map';
  }

  /** 粘贴：偏移一格网格（避免和原件重叠），并选中新内容 */
  pasteClipboard(): boolean {
    const cb = this.clipboard;
    if (!cb) return false;
    const step = this.snapToGrid && this.gridSize > 0 ? this.gridSize : 20;

    if (cb.kind === 'parts') {
      if (this.tab !== 'prefab') return false;
      const newIds: string[] = [];
      cb.parts.forEach((part) => {
        const copy = clone(part);
        // 部件不带 id（复制的源部件理论上也没有，这里兜底）
        delete (copy as { id?: string }).id;
        copy.x += step;
        copy.y += step;
        this.prefabDraft.parts.push(copy);
        newIds.push(`part:${this.prefabDraft.parts.length - 1}`);
      });
      this.selection = newIds;
      this.message = `已粘贴 ${newIds.length} 个部件`;
      this.commit();
      return true;
    }

    if (this.tab === 'prefab') return false;
    const newIds: string[] = [];
    for (const obj of cb.objects) {
      const copy = clone(obj);
      copy.id = this.nextId('o');
      copy.x += step;
      copy.y += step;
      this.map.objects.push(copy);
      newIds.push(copy.id);
    }
    for (const inst of cb.instances) {
      const copy = clone(inst);
      copy.id = this.nextId('p');
      copy.x += step;
      copy.y += step;
      if (!this.map.prefabs) this.map.prefabs = [];
      this.map.prefabs.push(copy);
      newIds.push(copy.id);
    }
    // 出生点 / 武器点：粘贴到新下标，并选中它们
    const indexIds: string[] = [];
    for (const sp of cb.spawns) {
      this.map.spawnPoints.push({ x: sp.x + step, y: sp.y + step });
      indexIds.push(`spawn:${this.map.spawnPoints.length - 1}`);
    }
    for (const w of cb.weapons) {
      if (!this.map.weapons) this.map.weapons = [];
      this.map.weapons.push({ ...clone(w), x: w.x + step, y: w.y + step });
      indexIds.push(`weapon:${this.map.weapons.length - 1}`);
    }
    if (newIds.length === 0 && indexIds.length === 0) return false;
    this.selection = [...newIds, ...indexIds];
    this.message = `已粘贴 ${newIds.length} 个对象`;
    this.commit();
    return true;
  }

  // ---------------- 参考火柴人（只用于对照尺寸） ----------------

  addRefFigure(x: number, y: number, facing: 1 | -1 = 1): number {
    // 贴地：火柴人脚底对齐点击点下方（GROUND_OFFSET = 48），点哪站哪更直观
    this.refFigures.push({ x: Math.round(x), y: Math.round(y), facing });
    const index = this.refFigures.length - 1;
    this.selectRef(index);
    return index;
  }

  clearRefFigures(): void {
    this.selectedRefIndex = null;
    if (this.refFigures.length === 0) return;
    this.refFigures = [];
    this.touch();
  }

  // ---------------- 预制件部件：多选 / 范围选中 ----------------

  /** 当前选中的部件索引（支持多选，selection 里可含多个 part:N） */
  selectedPartIndices(): number[] {
    const out: number[] = [];
    for (const sel of this.selection) {
      if (!sel.startsWith('part:')) continue;
      const i = Number(sel.slice(5));
      if (Number.isInteger(i) && i >= 0 && i < this.prefabDraft.parts.length) out.push(i);
    }
    return out.sort((a, b) => a - b);
  }

  /** 范围选中：返回世界矩形（与部件包围盒）相交的所有部件索引 */
  partsInWorldRect(rect: { minX: number; minY: number; maxX: number; maxY: number }): number[] {
    const out: number[] = [];
    this.prefabDraft.parts.forEach((_, i) => {
      const b = this.partWorldBounds(i);
      if (!b) return;
      const hit = b.minX <= rect.maxX && b.maxX >= rect.minX && b.minY <= rect.maxY && b.maxY >= rect.minY;
      if (hit) out.push(i);
    });
    return out;
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
  /**
   * 多选部件一起吸附到网格：以**被拖动的那个部件**为基准，整体平移同样的量。
   *
   * 为什么不能逐个部件吸附：每个部件的坐标余数不同，逐个吸附会把相对位置改乱
   * （拼好的桌椅/门框一松手就"散架"）。整体平移则保持相对布局。
   */
  snapSelectedPartsTogether(anchorIndex: number): boolean {
    if (!this.snapToGrid || this.gridSize <= 0) return false;
    const idxs = this.selectedPartIndices();
    if (idxs.length <= 1) return this.snapPartToGrid(anchorIndex);
    const anchor = this.prefabDraft.parts[anchorIndex] ?? this.prefabDraft.parts[idxs[0]];
    if (!anchor) return false;
    const c = objectCenter(anchor);
    const dx = this.snapValue(c.x) - c.x;
    const dy = this.snapValue(c.y) - c.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return false;
    for (const i of idxs) {
      const part = this.prefabDraft.parts[i];
      if (!part) continue;
      part.x += dx;
      part.y += dy;
    }
    return true;
  }

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
    // id 必须唯一：导出文件名 = id；重名会让两个预制件互相覆盖、地图里的 ref 指向同一份
    this.prefabDraft.id = this.nextPrefabId('prefab');
    this.selection = [];
    this.message = `新建预制件 ${this.prefabDraft.id}`;
    this.commit();
  }

  /** 生成一个没被占用的预制件 id（与 data/prefabs 里已有的、以及本次会话已发出过的都不冲突） */
  private nextPrefabId(base: string): string {
    const taken = new Set(listPrefabs().map((p) => p.id));
    let id = `${base}_${this.prefabSeq}`;
    while (taken.has(id)) {
      this.prefabSeq++;
      id = `${base}_${this.prefabSeq}`;
    }
    this.prefabSeq++;
    return id;
  }

  /**
   * 预制件部件**不允许带 id**：实例化时部件 id 是 `${实例id}#序号` 动态生成的，
   * 写死 id 会让同一个预制件的多个实例撞 id（联机的"物体被摧毁"会串到另一个实例上）。
   * @returns 清掉的 id 个数
   */
  private stripPartIds(prefab: PrefabData): number {
    let removed = 0;
    for (const part of prefab.parts) {
      if (part.id !== undefined) {
        delete (part as { id?: string }).id;
        removed++;
      }
    }
    return removed;
  }

  loadPrefab(id: string): void {
    const found = listPrefabs().find((p) => p.id === id);
    if (!found) return;
    this.prefabDraft = clone(found);
    const stripped = this.stripPartIds(this.prefabDraft);
    this.selection = [];
    this.message = stripped > 0
      ? `已载入预制件 ${id}（已清掉 ${stripped} 个部件的固定 id，避免多实例撞 id）`
      : `已载入预制件 ${id}`;
    this.commit();
  }

  /**
   * 把当前 Tab 的数据重新从 `data/` 读一遍（顶栏「⟳ 重载文件」）。
   *
   * 为什么需要手动入口：外部改了 JSON 后页面会整页刷新，但编辑器默认会恢复
   * localStorage 草稿（草稿比文件新时这是对的）；用户手改 JSON 想“以文件为准”时
   * 除了清草稿，就该有个显式按钮。
   * 材质 Tab 的草稿是模块级替换，只能整页刷新才能生效。
   */
  reloadCurrentFromFile(): { ok: boolean; reason?: string } {
    if (this.tab === 'material') {
      window.location.reload();
      return { ok: true };
    }
    if (this.tab === 'prefab') {
      const id = this.prefabDraft.id;
      const file = listPrefabs().find((p) => p.id === id);
      if (!file) return { ok: false, reason: `data/prefabs/${id}.json 不存在（当前草稿只在本机）` };
      const restored = clone(file);
      this.stripPartIds(restored);
      this.prefabDraft = restored;
      this.selection = [];
      this.message = `⟳ 已从 data/prefabs/${id}.json 重新载入`;
      this.commit();
      return { ok: true };
    }
    const name = this.map.name;
    const file = getMapByName(name);
    if (!file) return { ok: false, reason: `data/maps/${name}.json 不存在（当前草稿只在本机）` };
    this.map = clone(file);
    this.selection = [];
    this.selectedRefIndex = null;
    this.tool = 'select';
    this.ruler = null;
    this.clearRefFigures();
    this.ensureIds();
    this.message = `⟳ 已从 data/maps/${name}.json 重新载入`;
    this.commit();
    return { ok: true };
  }

  updatePrefabMeta(patch: Partial<PrefabData>): void {
    Object.assign(this.prefabDraft, patch);
    this.commit();
  }

  addPart(part: MapObject): void {
    // 部件不带 id（见 stripPartIds 的说明）
    delete (part as { id?: string }).id;
    this.prefabDraft.parts.push(part);
    this.commit();
  }

  updatePart(index: number, patch: Record<string, unknown>): void {
    const part = this.prefabDraft.parts[index];
    if (!part) return;
    Object.assign(part as unknown as Record<string, unknown>, patch);
    this.commit();
  }

  /**
   * 删除若干部件，并**同步重映射内部关节的部件下标**。
   *
   * 内部关节用"部件下标"引用两端（不是 id），删任何一个部件都会让**后面所有下标前移**：
   * 不重映射的话，表面上是"删了一个无关部件"，实际所有关节会整体错位一位，
   * 连接关系全部变乱（这就是之前「左栏删按钮正常、Del 键删就全乱」的原因 ——
   * Del 走的 deleteSelected 直接 filter，没走这里）。
   *
   * @returns 实际删掉的部件数
   */
  private dropParts(drop: Set<number>): number {
    if (drop.size === 0) return 0;
    const parts = this.prefabDraft.parts;

    /** 旧下标 → 新下标 */
    const remap = new Map<number, number>();
    const kept: MapObject[] = [];
    parts.forEach((part, i) => {
      if (drop.has(i)) return;
      remap.set(i, kept.length);
      kept.push(part);
    });
    this.prefabDraft.parts = kept;

    // 关节：两端都被删 → 整条作废；否则按下标映射（A 端必须存在）
    const joints = this.prefabDraft.joints ?? [];
    const nextJoints: PrefabJoint[] = [];
    for (const j of joints) {
      const a = remap.get(j.bodyA);
      if (a === undefined) continue;
      if (typeof j.bodyB === 'number') {
        const b = remap.get(j.bodyB);
        if (b === undefined) continue;
        nextJoints.push({ ...j, bodyA: a, bodyB: b });
      } else {
        nextJoints.push({ ...j, bodyA: a });
      }
    }
    if (nextJoints.length > 0) this.prefabDraft.joints = nextJoints;
    else delete this.prefabDraft.joints;

    // 选中态里指向部件的条目也要跟着改，避免"删完选中的还是原来那个位置的部件"
    this.selection = this.selection
      .map((sel) => {
        const m = /^part:(\d+)$/.exec(sel);
        if (!m) return sel;
        const old = Number(m[1]);
        const now = remap.get(old);
        return now === undefined ? null : `part:${now}`;
      })
      .filter((sel): sel is string => sel !== null);

    return drop.size;
  }

  removePart(index: number): void {
    this.dropParts(new Set([index]));
    this.commit();
  }

  // ---------------- 预制件内部关节（吹链/三节棍）----------------
  prefabJoints(): PrefabJoint[] {
    return this.prefabDraft.joints ?? [];
  }

  /** 新增内部关节；bodyB 省略 = 固定在世界锚点（锚点为局部坐标） */
  addPrefabJoint(bodyA: number, anchor: Vec, bodyB?: number): void {
    if (!this.prefabDraft.joints) this.prefabDraft.joints = [];
    const joint: PrefabJoint = { bodyA, anchor: { x: anchor.x, y: anchor.y }, noCollide: true };
    if (bodyB !== undefined && bodyB !== bodyA) joint.bodyB = bodyB;
    this.prefabDraft.joints.push(joint);
    this.commit();
  }

  updatePrefabJoint(index: number, patch: Partial<PrefabJoint>): void {
    const j = this.prefabDraft.joints?.[index];
    if (!j) return;
    Object.assign(j, patch);
    if (j.bodyB === 'world') delete j.bodyB;
    this.commit();
  }

  removePrefabJoint(index: number): void {
    const joints = this.prefabDraft.joints;
    if (!joints) return;
    joints.splice(index, 1);
    if (joints.length === 0) delete this.prefabDraft.joints;
    this.commit();
  }

  /** 拖动中直接改关节（不记历史，松手再 commit） */
  patchPrefabJointLive(index: number, patch: Partial<PrefabJoint>): void {
    const j = this.prefabDraft.joints?.[index];
    if (!j) return;
    Object.assign(j, patch);
    this.touchLive();
  }

  /**
   * 改关节某一端连接的部件。
   * @param side 'a' | 'b'；`part = null` 仅对 b 有意义（改成固定在世界锚点）
   */
  setPrefabJointBody(index: number, side: 'a' | 'b', part: number | null): void {
    const j = this.prefabDraft.joints?.[index];
    if (!j) return;
    if (side === 'a') {
      if (part === null || part === j.bodyA) return;
      if (typeof j.bodyB === 'number' && part === j.bodyB) return;
      j.bodyA = part;
    } else {
      if (typeof j.bodyB === 'number' && part === j.bodyB) return;
      if (part === null) {
        // 拖到空白处：改成“固定在世界锚点”
        delete j.bodyB;
      } else {
        if (part === j.bodyA) return;
        j.bodyB = part;
      }
    }
    this.commit();
  }

  // ---------------- 预制件自带武器掉落点（局部坐标）----------------
  prefabWeaponSpawns(): PrefabWeaponSpawn[] {
    return this.prefabDraft.weapons ?? [];
  }

  /** 选中的预制件武器掉落点（selection 里只有一个 `pweapon:N` 时） */
  selectedPrefabWeaponIndex(): number | null {
    const m = /^pweapon:(\d+)$/.exec(this.selection[0] ?? '');
    if (!m || this.selection.length !== 1) return null;
    const i = Number(m[1]);
    return i < (this.prefabDraft.weapons ?? []).length ? i : null;
  }

  /**
   * 新增一个预制件武器掉落点（坐标为**预制件局部坐标**）。
   * 默认固定武器 + 10 秒刷新一次（与地图 Tab 的默认值一致）。
   */
  addPrefabWeaponSpawn(
    weaponId: string,
    local: Vec,
    mode: 'fixed' | 'random' = 'fixed',
  ): void {
    if (!this.prefabDraft.weapons) this.prefabDraft.weapons = [];
    const point: PrefabWeaponSpawn =
      mode === 'random'
        ? { x: local.x, y: local.y, mode: 'random', pool: [], respawnMs: 10000, maxRespawns: 0 }
        : { x: local.x, y: local.y, mode: 'fixed', weapon: weaponId, respawnMs: 10000, maxRespawns: 0 };
    this.prefabDraft.weapons.push(point);
    this.selection = [`pweapon:${this.prefabDraft.weapons.length - 1}`];
    this.commit();
  }

  updatePrefabWeaponSpawn(index: number, patch: Partial<PrefabWeaponSpawn>): void {
    const w = this.prefabDraft.weapons?.[index];
    if (!w) return;
    Object.assign(w, patch);
    this.commit();
  }

  /** 拖动中实时改坐标（不记历史，松手 commit） */
  patchPrefabWeaponSpawnLive(index: number, patch: Partial<PrefabWeaponSpawn>): void {
    const w = this.prefabDraft.weapons?.[index];
    if (!w) return;
    Object.assign(w, patch);
    this.touchLive();
  }

  removePrefabWeaponSpawn(index: number): void {
    const list = this.prefabDraft.weapons;
    if (!list) return;
    list.splice(index, 1);
    if (list.length === 0) delete this.prefabDraft.weapons;
    this.selection = [];
    this.commit();
  }

  /**
   * 新增预制件武器掉落点时的默认局部坐标：部件包围盒的下方内侧
   * （放在"武器架/桌面"上最符合直觉），没有再退回原点。
   */
  prefabDropLocalPoint(): Vec {
    const parts = this.prefabDraft.parts;
    if (parts.length === 0) return { x: 0, y: 0 };
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const part of parts) {
      const b = objectBounds(part);
      minY = Math.min(minY, b.minY);
      maxY = Math.max(maxY, b.maxY);
      minX = Math.min(minX, b.minX);
      maxX = Math.max(maxX, b.maxX);
    }
    if (!Number.isFinite(minY)) return { x: 0, y: 0 };
    return { x: Math.round((minX + maxX) / 2), y: Math.round(maxY - 12) };
  }

  /** 预制件武器掉落点的世界坐标（画布 = 预制件原点 + 局部坐标） */
  prefabWeaponWorld(index: number): Vec | null {
    const w = this.prefabDraft.weapons?.[index];
    if (!w) return null;
    const o = this.prefabRigOrigin();
    return { x: o.x + w.x, y: o.y + w.y };
  }

  /** 画布命中：指到哪个预制件武器掉落点（半径 22px，与地图 Tab 一致） */
  hitTestPrefabWeapon(world: Vec, radius = 22): number | null {
    const list = this.prefabDraft.weapons ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const p = this.prefabWeaponWorld(i);
      if (p && Math.hypot(world.x - p.x, world.y - p.y) <= radius) return i;
    }
    return null;
  }

  /** 关节锚点与两端的**世界坐标**（B 端为 world 时返回 null），画布绘制/命中用 */
  prefabJointWorld(index: number): { anchor: Vec; a: Vec | null; b: Vec | null } | null {
    const j = this.prefabDraft.joints?.[index];
    if (!j) return null;
    const o = this.prefabRigOrigin();
    return {
      anchor: { x: o.x + j.anchor.x, y: o.y + j.anchor.y },
      a: this.partWorldCenter(j.bodyA),
      b: typeof j.bodyB === 'number' ? this.partWorldCenter(j.bodyB) : null,
    };
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
  /**
   * 编辑器**画布**当前显示的场景。
   *
   * 设计原则：画布永远显示"你正在编辑的东西"——
   * 地图/材质 Tab 都显示你选中的那张地图（材质是给地图里的物体用的，
   * 切到材质 Tab 不该把你的地图换掉）；只有预制件 Tab 例外，
   * 因为预制件本身就是在工作台里编辑的。
   *
   * 材质/预制件的"样品试手感"走 testMap()（▶ 测试），不要动画布。
   */
  canvasMap(): MapData {
    if (this.tab === 'prefab') return this.prefabRig();
    return this.map;
  }

  /**
   * 材质 Tab 的「整体重刷」测试地图：把当前地图里**所有物体**的材质换成选中材质。
   *
   * 关键处理（否则地图会当场塌掉）：
   *  1. **冻结静态性**：地面/墙之所以不动是因为材质 fixed:true。若直接换成木头（fixed:false），
   *     地面会变成动态板块，整关崩塌。所以按"当前解析结果"把 fixed 显式写死到每个物体上。
   *  2. **清掉对象级外观覆盖**（color / texture / textureMode）：否则它们会盖住新材质的
   *     贴图和颜色，就看不出"把所有东西换成这个材质"的效果了。
   */
  /**
   * 材质 Tab 的测试地图：**只把当前选中的对象换成正在编辑的材质**。
   *
   * 为什么不再"整张地图重刷"：那会把地面/墙/家具一起换掉（地图当场变样），
   * 既看不清单个物体的手感，也容易把关卡弄塌。作者的真实意图是
   * "把这个材质放到这个物体上试试"，所以只动选中的物体。
   *
   * 没选中任何物体时返回原地图（等于普通试玩）。
   */
  materialTestMap(): MapData {
    const mat = this.activeMaterialId;
    const clone = JSON.parse(JSON.stringify(this.map)) as MapData;
    const ids = new Set(this.selection.filter((id) => !/^(spawn|weapon|joint|part):/.test(id)));
    if (ids.size === 0) return clone;

    for (const obj of clone.objects ?? []) {
      if (!obj.id || !ids.has(obj.id)) continue;
      obj.material = mat;
      // 对象级外观覆盖会盖住材质本身的观感 → 测试时清掉
      delete obj.color;
      delete obj.texture;
      delete obj.textureMode;
    }
    return clone;
  }

  /**
   * 材质 Tab 测试用的预制件表。
   *
   * 选中预制件实例时，**实例的所有部件**换成当前材质（实例本身没有材质字段，
   * 只能改它引用的那份展开结果）；没选中实例时原样返回。
   */
  materialTestPrefabs(): Record<string, PrefabData> {
    const table = this.prefabTable();
    const instIds = new Set(this.selectedInstances().map((i) => i.ref));
    if (instIds.size === 0) return table;

    const mat = this.activeMaterialId;
    const out: Record<string, PrefabData> = {};
    for (const [id, prefab] of Object.entries(table)) {
      if (!instIds.has(id)) {
        out[id] = prefab;
        continue;
      }
      const copy = JSON.parse(JSON.stringify(prefab)) as PrefabData;
      for (const part of copy.parts ?? []) part.material = mat;
      out[id] = copy;
    }
    return out;
  }

  /**
   * 把当前材质**真的写到选中的对象上**（写进地图数据，可撤销）。
   *
   * 预制件实例不在这里处理：实例没有材质字段，改的是"预制件模板"，
   * 会连带影响地图里所有同种实例 —— 那种改动属于预制件页的职责，
   * 所以这里明确拒绝并给出提示（测试用 materialTestPrefabs 临时替换即可）。
   */
  applyMaterialToSelection(): { ok: boolean; count: number; reason?: string } {
    const mat = this.activeMaterialId;
    if (!MATERIALS[mat]) return { ok: false, count: 0, reason: '材质不存在' };
    const objects = this.selectedObjects();
    if (objects.length === 0) {
      const hasInstance = this.selectedInstances().length > 0;
      return {
        ok: false,
        count: 0,
        reason: hasInstance ? '预制件实例请到「预制件」页改部件材质' : '先在地图上选中物体',
      };
    }
    for (const obj of objects) {
      obj.material = mat;
      delete obj.color;
      delete obj.texture;
      delete obj.textureMode;
    }
    this.message = `已把材质 ${mat} 应用到 ${objects.length} 个物体`;
    this.commit();
    return { ok: true, count: objects.length };
  }

  /**
   * **▶ 测试**要运行的场景（按当前 Tab）。
   *   - 地图 Tab  → 当前地图草稿
   *   - 材质 Tab  → 只把**选中的物体**换成选中材质（没选中就是原地图）
   *   - 预制件 Tab → 预制件工作台
   * @param useMaterialRig 材质 Tab 下改为跑"样品台"（固定/动态对照），用于单独试手感
   */
  testScene(useMaterialRig = false): { map: MapData; prefabs: Record<string, PrefabData> } {
    if (this.tab === 'prefab') {
      return { map: this.prefabRig(), prefabs: this.prefabTable() };
    }
    if (this.tab === 'material') {
      return useMaterialRig
        ? { map: this.materialRig(), prefabs: this.prefabTable() }
        : { map: this.materialTestMap(), prefabs: this.materialTestPrefabs() };
    }
    return { map: this.map, prefabs: this.prefabTable() };
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
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()), listItemIds(), listWeaponIds());
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
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()), listItemIds(), listWeaponIds());
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
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()), listItemIds(), listWeaponIds());
    const issues = validatePrefab(parsed, ctx);
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
    this.prefabDraft = parsed as PrefabData;
    const stripped = this.stripPartIds(this.prefabDraft);
    this.message = stripped > 0
      ? `已导入预制件 ${this.prefabDraft.id}（已清掉 ${stripped} 个部件的固定 id）`
      : `已导入预制件 ${this.prefabDraft.id}`;
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
    return this.pendingJointBodyA
      ? `已选主体 ${this.pendingJointBodyA}：点锚点建“→世界”，或点另一个物体建“→物体”`
      : '先点选一个物体（或预制件部件）作为主体（bodyA）';
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
