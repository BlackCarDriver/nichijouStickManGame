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

export type EditorTab = 'map' | 'prefab' | 'material';
export type ToolKind = 'select' | 'rect' | 'circle' | 'polygon' | 'spawn' | 'prefab' | 'joint' | 'ruler';

const STORAGE_KEY = 'stickman.editor.v1';
const HISTORY_LIMIT = 80;

interface SavedState {
  v: 1;
  tab: EditorTab;
  map: MapData;
  prefabDraft: PrefabData;
  materials: MaterialsFile;
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
  /** 材质 Tab 当前编辑的材质 */
  activeMaterialId = 'wood';
  /** 关节工具第一步选中的物体 id */
  pendingJointBodyA: string | null = null;
  /** 尺子工具 */
  ruler: { from: Vec; to: Vec } | null = null;
  /** 状态栏消息 */
  message = '';
  /**
   * 编辑器内的贴图预览覆盖（贴图引用 → data URL）。
   * 用于：选了本地图片但还没落到 public/textures 时，编辑器里也能立即看到效果。
   * 不写入 JSON、不进 localStorage。
   */
  readonly textureOverrides = new Map<string, string>();

  private history: string[] = [];
  private index = -1;
  private listeners = new Set<() => void>();
  private idSeq = 1;
  private silent = false;

  constructor() {
    this.map = clone(getDefaultMap());
    this.prefabDraft = emptyPrefabDraft();
    this.restore();
    this.ensureIds();
    this.resetHistory();
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
    }, 90);
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
      if (saved?.materials) replaceMaterials(saved.materials);
      if (saved?.tab) this.tab = saved.tab;
    } catch {
      /* 损坏的存档：用默认地图 */
    }
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
    return !!(this.getObject(id) || this.getInstance(id));
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
  hitTest(p: Vec): { kind: 'object' | 'prefab'; id: string } | null {
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

  addJoint(bodyA: string, anchor: Vec): void {
    if (!this.map.joints) this.map.joints = [];
    const id = this.nextId('j');
    this.map.joints.push({ id, type: 'revolute', bodyA, anchor: { x: anchor.x, y: anchor.y } });
    this.pendingJointBodyA = null;
    this.commit();
  }

  removeJoint(index: number): void {
    this.map.joints?.splice(index, 1);
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
  }

  deleteSelected(): void {
    if (this.selection.length === 0) return;
    const ids = new Set(this.selection);
    this.map.objects = this.map.objects.filter((o) => !o.id || !ids.has(o.id));
    this.map.prefabs = (this.map.prefabs ?? []).filter((p) => !p.id || !ids.has(p.id));
    // 连带删除引用已删物体的关节
    this.map.joints = (this.map.joints ?? []).filter(
      (j) => !ids.has(j.bodyA) && (!j.bodyB || j.bodyB === 'world' || !ids.has(j.bodyB)),
    );
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
    const parts = expandPrefab(this.prefabDraft, {
      ref: this.prefabDraft.id,
      x: origin.x,
      y: origin.y,
    });
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
        ...parts,
      ],
    };
  }

  /** 材质工作台：同一种材质的三种形状 + 地面，用于试手感 */
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
        { x: 220, y: groundY - 48 },
        { x: 1380, y: groundY - 48 },
      ],
      objects: [
        { id: 'rig_ground', type: 'rect', x: 0, y: groundY, w: W, h: H - groundY, material: 'ground' },
        { id: 'rig_plate', type: 'rect', x: 380, y: groundY - 60, w: 260, h: 24, material: mat, fixed: true },
        { id: 'rig_box', type: 'rect', x: 700, y: groundY - 90, w: 90, h: 90, material: mat },
        { id: 'rig_ball', type: 'circle', x: 980, y: groundY - 40, radius: 40, material: mat },
        { id: 'rig_hex', type: 'polygon', x: 1200, y: groundY - 60, sides: 6, radius: 60, material: mat, fixed: true },
      ],
    };
  }

  // ---------------- 校验 ----------------
  validateCurrent(): Issue[] {
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()));
    if (this.tab === 'prefab') return validatePrefab(this.prefabDraft, ctx);
    if (this.tab === 'material') return validateMaterialsFile(serializeMaterials());
    return validateMap(this.map, ctx);
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
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()));
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
    const ctx = makeContext(materialIds(), Object.values(this.prefabTable()));
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
