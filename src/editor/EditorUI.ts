/**
 * 编辑器 UI（纯 DOM，无框架）。
 *
 * 设计原则：
 * - 面板**只读** store，通过调用 store 的方法写回 → 状态永远单一真源
 * - 正在输入的表单面板跳过重建（避免光标丢失），失去焦点后会自然同步
 * - 三个 Tab：地图 / 预制件 / 材质，各自左侧列表 + 右侧属性
 */
import Phaser from 'phaser';
import { editorStore } from './EditorStore';
import type { EditorTab, ToolKind } from './EditorStore';
import { MATERIALS, materialIds } from '../config/materials';
import { listMaps, listPrefabs } from '../map/MapRegistry';
import { getWeapon, listWeaponIds } from '../combat/WeaponFormat';
import { getItem, listItemIds } from '../world/ItemFormat';
import type { Issue } from '../map/MapValidator';
import type { MapObject, MapObjectLabel, ObjectLabelAnchor } from '../map/MapFormat';
import { setStatus, setStatusSink } from './status';
import { objectBounds, objectCenter } from './geometry';
import { textureUrl } from '../map/TextureLoader';
import type { EditorScene } from './EditorScene';

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'checked' || k === 'disabled' || k === 'value') {
      (el as unknown as Record<string, unknown>)[k] = v;
      continue;
    }
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

// ---------------- 表单控件 ----------------
function field(label: string, control: Node): HTMLElement {
  return h('label', { class: 'ed-field' }, [h('span', { class: 'ed-field-label' }, [label]), control]);
}

function numberInput(value: number, onChange: (v: number) => void, step = 1): HTMLInputElement {
  const input = h('input', { class: 'ed-input', type: 'number', step: String(step), value: String(value) });
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return input;
}

function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = h('input', { class: 'ed-input', type: 'text', value });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function selectInput(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
  placeholder?: string,
): HTMLSelectElement {
  const all = placeholder ? [{ value: '', label: placeholder }, ...options] : options;
  const select = h(
    'select',
    { class: 'ed-input' },
    all.map((o) => h('option', { value: o.value, selected: o.value === value }, [o.label])),
  );
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function colorInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = h('input', { type: 'color', value: value.startsWith('#') ? value : `#${value}` });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `ed-btn ${cls}`, onclick: onClick }, [label]);
}

// ---------------- 外壳 ----------------
let headerEl!: HTMLElement;
let leftEl!: HTMLElement;
let rightEl!: HTMLElement;
let statusTextEl!: HTMLElement;
let fpsEl!: HTMLElement;
let canvasHostEl!: HTMLElement;
let toastEl!: HTMLElement;

/** 预制件左栏「＋ 武器」用：当前选中的武器 id */
let prefabWeaponPick = 'ak47';

/** 左栏【随机武器】选项的哨兵值（不是真实武器 id） */
const RANDOM_WEAPON_SENTINEL = '__random__';

/** 所有叶子工具（快捷键、状态栏展示用） */
const TOOLS: Array<{ id: ToolKind; label: string; key: string }> = [
  { id: 'select', label: '选择', key: 'V' },
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'circle', label: '圆形', key: 'C' },
  { id: 'polygon', label: '多边形', key: 'P' },
  { id: 'spawn', label: '出生点', key: 'S' },
  { id: 'prefab', label: '放预制件', key: 'F' },
  { id: 'weapon', label: '投放点', key: 'B' },
  { id: 'joint', label: '关节', key: 'J' },
  { id: 'ruler', label: '尺子', key: 'M' },
  { id: 'ref', label: '参考火柴人', key: 'K' },
];

/**
 * 工具分组：一级选项是“几何体 / 放置预制件 / 投放点”，
 * 矩形·圆形·多边形 / 预制件库 / 武器选择是它们的二级选项，
 * 只有对应一级项被选中时才展示。
 */
type ToolGroupId = 'shape' | 'prefab' | 'weapon';

const TOOL_GROUP: Partial<Record<ToolKind, ToolGroupId>> = {
  rect: 'shape',
  circle: 'shape',
  polygon: 'shape',
  prefab: 'prefab',
  weapon: 'weapon',
};

const GROUP_PRIMARY: Array<{
  group: ToolGroupId | null;
  tool?: ToolKind;
  label: string;
  key: string;
}> = [
  { group: null, tool: 'select', label: '选择', key: 'V' },
  { group: 'shape', label: '几何体', key: 'R/C/P' },
  { group: null, tool: 'spawn', label: '出生点', key: 'S' },
  { group: 'prefab', label: '放置预制件', key: 'F' },
  { group: 'weapon', label: '投放点', key: 'B' },
  { group: null, tool: 'joint', label: '关节', key: 'J' },
  { group: null, tool: 'ruler', label: '尺子', key: 'M' },
  { group: null, tool: 'ref', label: '参考火柴人', key: 'K' },
];

const TOOL_LABEL: Record<string, string> = Object.fromEntries(TOOLS.map((t) => [t.id, t.label]));

const SHAPE_TOOLS: Array<{ id: ToolKind; label: string; key: string }> = [
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'circle', label: '圆形', key: 'C' },
  { id: 'polygon', label: '多边形', key: 'P' },
];

/** 地图 Tab 的左栏分区 */
type LeftPanelTab = 'place' | 'objects' | 'display';
const LEFT_TABS: Array<{ id: LeftPanelTab; label: string }> = [
  { id: 'place', label: '放置' },
  { id: 'objects', label: '对象列表' },
  { id: 'display', label: '显示' },
];

/** 预制件页的左栏分区 */
type PrefabLeftTab = 'parts' | 'library' | 'display';
const PREFAB_LEFT_TABS: Array<{ id: PrefabLeftTab; label: string }> = [
  { id: 'parts', label: '部件' },
  { id: 'library', label: '预制件库' },
  { id: 'display', label: '显示' },
];

let leftPanelTab: LeftPanelTab = 'place';
let prefabLeftTab: PrefabLeftTab = 'parts';

/** 左栏顶部的分区切换条（地图页 / 预制件页共用） */
function subTabs<T extends string>(
  tabs: Array<{ id: T; label: string }>,
  current: T,
  pick: (id: T) => void,
): HTMLElement {
  return h(
    'div',
    { class: 'ed-subtabs' },
    tabs.map((t) =>
      h(
        'button',
        { class: `ed-subtab ${current === t.id ? 'active' : ''}`, onclick: () => pick(t.id) },
        [t.label],
      ),
    ),
  );
}
/** 被手动收起的分组（当前工具仍属于它，只是二级选项隐藏） */
let collapsedGroup: ToolGroupId | null = null;

function groupOf(tool: ToolKind): ToolGroupId | null {
  return TOOL_GROUP[tool] ?? null;
}

/** 当前应该展开的二级面板（= 当前工具所属分组，除非被主动收起） */
function openToolGroup(): ToolGroupId | null {
  const g = groupOf(editorStore.tool);
  return g && collapsedGroup === g ? null : g;
}

/** 统一入口：切工具时同步分组页张状态 */
function setTool(tool: ToolKind): void {
  const store = editorStore;
  const prev = groupOf(store.tool);
  store.tool = tool;
  store.pendingJointBodyA = null;
  if (groupOf(tool) !== prev) collapsedGroup = null;
  store.touch();
}

/** 点一级选项：已选则收起/展开，未选则切到默认子工具并展开 */
function selectPrimaryTool(group: ToolGroupId | null, tool?: ToolKind): void {
  const store = editorStore;
  if (!group) {
    collapsedGroup = null;
    if (tool) setTool(tool);
    return;
  }
  if (groupOf(store.tool) === group) {
    collapsedGroup = collapsedGroup === group ? null : group;
    store.touch();
    return;
  }
  collapsedGroup = null;
  const fallback: ToolKind = group === 'shape' ? 'rect' : group;
  if (group === 'prefab' && !store.activePrefabId) store.activePrefabId = listPrefabs()[0]?.id ?? null;
  if (group === 'weapon' && !store.activeWeaponId) store.activeWeaponId = RANDOM_WEAPON_SENTINEL;
  setTool(fallback);
}

export function createShell(): void {
  document.body.innerHTML = '';
  headerEl = h('header', { class: 'ed-header' });
  leftEl = h('aside', { class: 'ed-left' });
  rightEl = h('aside', { class: 'ed-right' });
  statusTextEl = h('span', { class: 'ed-status-text' });
  fpsEl = h('span', { class: 'ed-status-fps' }, ['— fps']);
  toastEl = h('div', { class: 'ed-toast' });
  const testingExitBtn = h('button', { class: 'ed-testing-exit' }, ['返回编辑器']);
  testingExitBtn.addEventListener('click', () => stopPlayTest());
  canvasHostEl = h('div', { class: 'ed-canvas', id: 'canvas-host' }, [
    h('div', { class: 'ed-testing-hint' }, [
      h('span', {}, ['测试运行中 — 按 Esc 返回']),
      testingExitBtn,
    ]),
    toastEl,
  ]);

  const root = h('div', { id: 'editor-root' }, [
    headerEl,
    h('div', { class: 'ed-body' }, [leftEl, canvasHostEl, rightEl]),
    h('footer', { class: 'ed-status' }, [
      statusTextEl,
      fpsEl,
      h('span', { class: 'ed-status-keys' }, [
        '拖动=移动 · 中键/右键/空格=平移 · 滚轮=缩放 · 0=适配 · G=网格 · Del=删除 · Ctrl+Z/Y · Ctrl+D · Ctrl+S',
      ]),
    ]),
  ]);
  document.body.append(root);
}

// ---------------- 主绑定 ----------------
let game: Phaser.Game | null = null;
let testing = false;
let toastTimer = 0;

export function bindUI(phaserGame: Phaser.Game): void {
  game = phaserGame;
  setStatusSink((text) => {
    statusTextEl.textContent = text;
    statusTextEl.classList.add('ed-status-active');
  });
  editorStore.subscribe(render);
  window.addEventListener('keydown', onKeyDown);
  // FPS 指示（每 500ms 刷新一次，不参与面板重建）
  window.setInterval(() => {
    const fps = phaserGame.loop.actualFps;
    fpsEl.textContent = `${Math.round(fps)} fps`;
    fpsEl.classList.toggle('warn', fps < 45);
  }, 500);
  render();
}

function scene(): EditorScene | null {
  return (game?.scene.getScene('EditorScene') as EditorScene | undefined) ?? null;
}

let headerSig = '';
let leftSig = '';
let rightSig = '';
/** 上一次渲染时的选择（变化时强制重建面板，即使焦点在输入框里） */
let lastRenderedSelection = '';

/**
 * 渲染调度：给每个面板算一个"内容签名"，只有签名变了才重建 DOM。
 * 拖动过程中数据在连续变化但 UI 无需每帧重建（松手 commit 时 revision 变化 → 重建一次）。
 */
function render(): void {
  const store = editorStore;
  const issues = store.validateCurrent();
  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.length - errors;

  const hSig = `${store.tab}|${errors}|${warns}|${store.map.name}|${listMaps().length}|${testing}`;
  if (hSig !== headerSig) {
    headerSig = hSig;
    renderHeader();
  }

  const selection = store.selection.join(',');
  const selectionChanged = selection !== lastRenderedSelection;
  lastRenderedSelection = selection;
  const lSig = `${store.tab}|${leftPanelTab}|${prefabLeftTab}|${collapsedGroup}|${store.revision}|${selection}|${store.activePrefabId}|${store.activeMaterialId}|${store.activeWeaponId}|${store.tool}|${store.gridSize}|${store.snapToGrid}|${store.showGrid}|${store.showSpawnPoints}|${store.showWeaponSpawns}|${store.showPrefabRef}|${store.refFigures.length}|${store.selectedRefIndex}|${(store.prefabDraft.parts ?? []).length}|${materialIds().length}|${(store.map.objects ?? []).length}|${(store.map.prefabs ?? []).length}`;
  // 选择变了就必须重建：否则"在画布上点了对象，右侧属性还是旧的"（焦点还留在输入框里时最明显）
  if (lSig !== leftSig && (selectionChanged || !isEditingPanel(leftEl))) {
    leftSig = lSig;
    renderLeft();
  }

  const rSig = `${store.tab}|${store.revision}|${selection}|${store.activeMaterialId}|${store.selectedRefIndex}|${prefabRightTab}|${store.prefabJoints().length}`;
  if (rSig !== rightSig && (selectionChanged || !isEditingPanel(rightEl))) {
    rightSig = rSig;
    renderRight();
  }

  renderStatus();
  renderToast();
}

function isEditingPanel(panel: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active || !panel.contains(active)) return false;
  return active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA';
}

function renderHeader(): void {
  const store = editorStore;
  const issues = store.validateCurrent();
  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.length - errors;

  const openMapSelect = h('select', {
    class: 'ed-input ed-openmap',
    onchange: (e: Event) => {
      const name = (e.target as HTMLSelectElement).value;
      const map = listMaps().find((item) => item.name === name);
      if (!map) return;
      store.map = JSON.parse(JSON.stringify(map));
      store.tab = 'map';
      store.selection = [];
      store.selectedRefIndex = null;
      store.tool = 'select';
      store.ruler = null;
      store.clearRefFigures();
      store.ensureIds();
      store.message = `已打开地图 ${name}`;
      store.commit();
      scene()?.refreshEditor();
    },
  }, [
    h('option', { value: '' }, ['打开已有地图…']),
    ...listMaps().map((m) => h('option', { value: m.name }, [m.name])),
  ]) as HTMLSelectElement;
  openMapSelect.value = store.map.name;

  headerEl.replaceChildren(
    h('div', { class: 'ed-brand' }, ['火柴人 · 地图编辑器']),
    h(
      'div',
      { class: 'ed-tabs' },
      (['map', 'prefab', 'material'] as EditorTab[]).map((tab) =>
        h(
          'button',
          {
            class: `ed-tab ${store.tab === tab ? 'active' : ''}`,
            onclick: () => {
              store.tab = tab;
              store.selection = [];
              store.selectedRefIndex = null;
              store.tool = 'select';
              store.ruler = null;
              store.touch();
            },
          },
          [tab === 'map' ? '地图' : tab === 'prefab' ? '预制件' : '材质'],
        ),
      ),
    ),
    h('div', { class: 'ed-actions' }, [
      openMapSelect,
      button('⟳ 重载文件', () => {
        const res = store.reloadCurrentFromFile();
        if (!res.ok) {
          store.message = `重载失败：${res.reason ?? '未知原因'}`;
          store.touch();
          return;
        }
        scene()?.refreshEditor();
      }),
      button('＋ 新建地图', () => {
        const name = window.prompt('新地图名称（建议英文，导出为 data/maps/<name>.json）', 'map_new');
        if (name === null) return;
        const res = store.newMap(name);
        if (!res.ok) {
          store.message = `新建失败：${res.reason ?? '未知原因'}`;
          store.touch();
          return;
        }
        scene()?.refreshEditor();
      }),
      button('导入', () => openJsonModal('导入（粘贴 JSON）', '', 'import')),
      button('导出', () => openJsonModal(`导出 ${store.exportFileName()}`, store.exportCurrent(), 'export')),
      button('复制', () => {
        void navigator.clipboard.writeText(store.exportCurrent());
        statusTextEl.textContent = '已复制当前数据到剪贴板';
      }),
      button(errors > 0 ? `校验：${errors} 错误` : warns > 0 ? `校验：${warns} 警告` : '校验通过', () =>
        showIssues(), errors > 0 ? 'danger' : warns > 0 ? 'warn' : 'ok'),
      button('▶ 测试', () => startPlayTest(), 'primary'),
    ]),
  );
}

/**
 * 选中内容的大小（状态栏底部展示）。
 *
 * - 地图/材质 Tab：单选按形状给出最直观的尺寸（圆用直径、多边形用包围盒）；
 *   多选给整体包围盒 + 件数
 * - 预制件 Tab：选中部件（可多选）的尺寸/整体包围盒
 */
function selectionSizeLabel(): string | null {
  const store = editorStore;
  const fmt = (w: number, h: number): string => `${Math.round(w)}×${Math.round(h)} px`;

  if (store.tab === 'prefab') {
    const idxs = store.selectedPartIndices();
    if (idxs.length === 0) return null;
    if (idxs.length === 1) {
      const part = store.prefabDraft.parts[idxs[0]];
      if (!part) return null;
      if (part.type === 'rect') return `矩形 ${fmt(part.w, part.h)}`;
      if (part.type === 'circle') return `圆形 ⌀${Math.round(part.radius * 2)} px`;
      const b = store.partWorldBounds(idxs[0]);
      return b ? `多边形 ${fmt(b.maxX - b.minX, b.maxY - b.minY)}` : null;
    }
    const boxes = idxs.map((i) => store.partWorldBounds(i)).filter((b): b is NonNullable<typeof b> => !!b);
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.minX));
    const maxX = Math.max(...boxes.map((b) => b.maxX));
    const minY = Math.min(...boxes.map((b) => b.minY));
    const maxY = Math.max(...boxes.map((b) => b.maxY));
    return `${idxs.length} 件 · ${fmt(maxX - minX, maxY - minY)}`;
  }

  // 地图 / 材质 Tab
  const single = store.selection.length === 1 ? store.selection[0] : null;
  if (single) {
    const obj = store.getObject(single);
    if (obj) {
      if (obj.type === 'rect') return `矩形 ${fmt(obj.w, obj.h)}`;
      if (obj.type === 'circle') return `圆形 ⌀${Math.round(obj.radius * 2)} px`;
      const b = store.selectionBounds();
      return b ? `多边形 ${fmt(b.maxX - b.minX, b.maxY - b.minY)}` : null;
    }
    if (store.getInstance(single)) {
      const b = store.selectionBounds();
      return b ? `预制件 ${fmt(b.maxX - b.minX, b.maxY - b.minY)}` : null;
    }
    if (/^spawn:/.test(single)) return '出生点（标记）';
    if (/^weapon:/.test(single)) return '武器点（标记）';
  }

  const b = store.selectionBounds();
  if (!b) return store.selectedRefIndex !== null ? '参考火柴人 ≈111 px 高' : null;
  return `${store.selection.length} 项 · ${fmt(b.maxX - b.minX, b.maxY - b.minY)}`;
}

function renderStatus(): void {
  const store = editorStore;
  const objCount = (store.map.objects ?? []).length + (store.map.prefabs ?? []).length;
  const sizeLabel = selectionSizeLabel();
  const parts = [
    `工具：${TOOL_LABEL[store.tool] ?? store.tool}`,
    `地图：${store.map.width}×${store.map.height}`,
    `网格：${store.gridSize}px${store.snapToGrid ? '（吸附）' : ''}`,
    `对象：${objCount}`,
    `选中：${store.selection.length}`,
  ];
  // 选中对象的实际尺寸（各 Tab 通用）：摆放/对尺寸时最常看的一个数
  if (sizeLabel) parts.push(`尺寸：${sizeLabel}`);
  if (store.tool === 'joint') parts.push(store.jointHint());
  if (store.tab === 'map' && store.selection.length === 1) {
    parts.push('绿方块=拖拽改大小 · 橙圆点=拖拽旋转 · Shift=不吸附');
  }
  const vcount = store.polygonVertexCount();
  if (vcount >= 3) {
    parts.push(`多边形顶点 ${vcount}：拖顶点=移动 · 双击边=加点 · Alt+点击=删点`);
  }
  statusTextEl.classList.remove('ed-status-active');
  statusTextEl.textContent = parts.join('　·　');
}

function renderToast(): void {
  const msg = editorStore.message;
  if (!msg) {
    toastEl.classList.remove('show');
    return;
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
    editorStore.clearMessage();
  }, 3200);
}

// ---------------- 左侧面板 ----------------
function renderLeft(): void {
  const store = editorStore;
  leftEl.replaceChildren();

  if (store.tab === 'map') {
    // ---- 左栏分区：放置 / 对象列表 / 显示 ----
    leftEl.append(
      subTabs(LEFT_TABS, leftPanelTab, (id) => {
        leftPanelTab = id;
        editorStore.touch();
      }),
    );

    if (leftPanelTab === 'objects') {
      const listEl = buildObjectList();
      listEl.classList.add('ed-list-fill');
      leftEl.append(
        h('h3', { class: 'ed-h3' }, [`对象列表（${(store.map.objects ?? []).length}）`]),
        h('p', { class: 'ed-help' }, ['数组越靠后 = 越上层（列表里显示在前面）。可拖动行调整遮挡顺序。']),
        listEl,
      );
      return;
    }

    if (leftPanelTab === 'display') {
      leftEl.append(
        h('h3', { class: 'ed-h3' }, ['网格']),
        h('div', { class: 'ed-row' }, [
          field('大小', numberInput(store.gridSize, (v) => { store.gridSize = Math.max(2, v); store.commit(); }, 2)),
        ]),
        h('label', { class: 'ed-check' }, [
          checkbox(store.snapToGrid, (v) => { store.snapToGrid = v; store.touch(); }),
          '拖动吸附到网格',
        ]),
        h('label', { class: 'ed-check' }, [
          checkbox(store.showGrid, (v) => { store.showGrid = v; store.touch(); }),
          '显示网格（G）',
        ]),
        h('h3', { class: 'ed-h3' }, ['显示元素']),
        h('label', { class: 'ed-check' }, [
          checkbox(store.showSpawnPoints, (v) => { store.showSpawnPoints = v; scene()?.refreshEditor(); store.touch(); }),
          '显示出生点',
        ]),
        h('label', { class: 'ed-check' }, [
          checkbox(store.showWeaponSpawns, (v) => { store.showWeaponSpawns = v; scene()?.refreshEditor(); store.touch(); }),
          '显示武器刷新点',
        ]),
        h('h3', { class: 'ed-h3' }, ['参考火柴人']),
        h('p', { class: 'ed-help' }, [
          `画布上 ${store.refFigures.length} 个（用「参考火柴人」工具点击画布放置，仅用于对照尺寸，不会写入地图）。`,
        ]),
        h('div', { class: 'ed-row' }, [
          button('清除全部', () => { store.clearRefFigures(); scene()?.refreshEditor(); }, 'danger'),
        ]),
        h('h3', { class: 'ed-h3' }, ['视图']),
        h('div', { class: 'ed-row' }, [button('适配地图（0）', () => scene()?.fitToMap())]),
        h('p', { class: 'ed-help' }, ['中键/右键/空格+左键 平移 · 滚轮缩放 · 地图边界外会压暗并画亮框。']),
      );
      return;
    }

    // ---- 放置 ----
    const group = openToolGroup();
    leftEl.append(
      h('h3', { class: 'ed-h3' }, ['工具']),
      h(
        'div',
        { class: 'ed-tools' },
        GROUP_PRIMARY.map((item) => {
          const active = item.group ? groupOf(store.tool) === item.group : store.tool === item.tool;
          const open = item.group !== null && group === item.group;
          return h(
            'button',
            {
              class: `ed-tool ${active ? 'active' : ''} ${open ? 'open' : ''}`,
              onclick: () => selectPrimaryTool(item.group, item.tool),
            },
            [
              `${item.label}`,
              h('span', { class: 'ed-key' }, [item.group ? `${open ? '▾' : '▸'} ${item.key}` : item.key]),
            ],
          );
        }),
      ),
      // ---- 二级选项（选中对应一级项时才展示）----
      ...(group === 'shape' ? [shapeSubPanel()] : []),
      ...(group === 'prefab' ? [prefabSubPanel()] : []),
      ...(group === 'weapon' ? [weaponSubPanel()] : []),
      // 新物体材质：与几何体/预制件配合使用；投放点无关，隐藏
      ...(store.tool === 'weapon'
        ? []
        : [
            h('h3', { class: 'ed-h3' }, ['新物体材质']),
            selectInput(
              materialIds().map((id) => ({ value: id, label: `${MATERIALS[id].name} (${id})` })),
              store.activeMaterialId,
              (v) => {
                store.activeMaterialId = v;
                store.touch();
              },
            ),
          ]),
      ...(store.tool === 'ref'
        ? [
            h('p', { class: 'ed-help' }, [
              '点击画布放置（Shift+点击 = 朝左），放完自动切回选择工具；之后可点选/拖动/Delete 删除。只在编辑器里显示，不会写进地图 JSON。',
            ]),
          ]
        : []),
      h('p', { class: 'ed-help' }, ['对象列表与显示开关在左栏顶部切换。']),
    );
    return;
  }

  if (store.tab === 'prefab') {
    // ---- 左栏分区：部件 / 预制件库 / 显示 ----
    leftEl.append(
      subTabs(PREFAB_LEFT_TABS, prefabLeftTab, (id) => {
        prefabLeftTab = id;
        editorStore.touch();
      }),
    );

    if (prefabLeftTab === 'library') {
      leftEl.append(prefabLibraryPanel());
      return;
    }

    if (prefabLeftTab === 'display') {
      leftEl.append(prefabDisplayPanel());
      return;
    }

    leftEl.append(prefabPartsPanel());
    return;
  }

  // 材质
  leftEl.append(
    h('h3', { class: 'ed-h3' }, ['材质列表']),
    h(
      'div',
      { class: 'ed-list ed-list-scroll' },
      materialIds().map((id) =>
        h(
          'button',
          {
            class: `ed-list-row ${store.activeMaterialId === id ? 'active' : ''}`,
            onclick: () => {
              store.activeMaterialId = id;
              store.touch();
            },
          },
          [
            MATERIALS[id].texture
              ? h('img', {
                  class: 'ed-tex-thumb',
                  src: materialTextureSrc(id),
                  alt: '',
                  style: `background:${MATERIALS[id].colorHex}`,
                  onerror: (e: Event) => {
                    (e.target as HTMLImageElement).style.opacity = '0';
                  },
                })
              : h('span', { class: 'ed-swatch', style: `background:${MATERIALS[id].colorHex}` }),
            h('span', { class: 'ed-list-main' }, [
              `${MATERIALS[id].damagePerSecond > 0 ? '⚠' : ''}${MATERIALS[id].glow ? '✦' : ''}${MATERIALS[id].explosive ? '✷' : ''} ${MATERIALS[id].name}`.trim(),
            ]),
            h('span', { class: 'ed-list-sub' }, [MATERIALS[id].damagePerSecond > 0 ? `${id} · ${MATERIALS[id].damagePerSecond}/s` : id]),
          ],
        ),
      ),
    ),
    h('div', { class: 'ed-row' }, [button('+ 新增材质', () => openNewMaterialModal())]),
    h('p', { class: 'ed-help' }, [
      '改完材质后：在画布上点选物体 → 右侧「▶ 测试（选中对象）」只看这个物体；「应用到选中对象」写进地图。',
    ]),
    h('p', { class: 'ed-help' }, ['导出 materials.json 后，把贴图文件放到 public/textures/ 下即可在游戏中使用。']),
  );
}

/** 预制件页 · 部件：列表（可多选/删除）+ 新建部件 */
function prefabPartsPanel(): HTMLElement {
  const store = editorStore;
  const parts = store.prefabDraft.parts;
  const selected = store.selectedPartIndices();

  const rows = parts.map((p, i) => {
    const isSelected = selected.includes(i);
    const size = p.type === 'rect'
      ? `${Math.round(p.w)}×${Math.round(p.h)}`
      : `r ${Math.round(p.radius ?? 0)}`;
    return h(
      'button',
      {
        class: `ed-list-row ${isSelected ? 'active' : ''}`,
        onclick: (e: MouseEvent) => {
          // Ctrl/Shift/Cmd+点击 = 加选（和画布框选保持同一套多选语义）
          if (e.ctrlKey || e.metaKey || e.shiftKey) store.toggleSelect(`part:${i}`);
          else store.select([`part:${i}`]);
        },
      },
      [
        h('span', { class: 'ed-list-order' }, [String(i + 1)]),
        h('span', { class: 'ed-list-main' }, [`${p.type} · ${p.material}`]),
        h('span', { class: 'ed-list-sub' }, [size]),
        h('button', {
          class: 'ed-mini-danger',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.removePart(i);
          },
        }, ['删']),
      ],
    );
  });

  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`部件（${parts.length}）`]),
    h('p', { class: 'ed-help' }, [
      selected.length > 1
        ? `已选 ${selected.length} 个：拖动其中一个会整体移动（相对位置保持不变）；右侧可批量改材质/复制/删除。`
        : '点=选中 · Ctrl/Shift+点=加选 · 画布空白处拖动=框选 · Alt+拖动=任意处框选 · Del=删除',
    ]),
    h('div', { class: 'ed-list ed-list-fill' }, rows),
    h('h3', { class: 'ed-h3' }, [`武器掉落点（${store.prefabWeaponSpawns().length}）`]),
    h('div', { class: 'ed-list' }, store.prefabWeaponSpawns().map((w, i) =>
      h('button', {
        class: `ed-list-row ${store.selection.includes(`pweapon:${i}`) ? 'active' : ''}`,
        onclick: () => store.select([`pweapon:${i}`]),
      }, [
        h('span', { class: 'ed-list-order' }, [String(i + 1)]),
        h('span', { class: 'ed-list-main' }, [
          (w.mode ?? 'fixed') === 'random' ? '随机武器' : (getWeapon(w.weapon ?? w.type ?? '')?.name ?? w.weapon ?? w.type ?? '未指定'),
        ]),
        h('span', { class: 'ed-list-sub' }, [
          `${Math.round(w.x)}, ${Math.round(w.y)}${(w.respawnMs ?? 0) > 0 ? ' · 刷新' : ''}`,
        ]),
        h('button', {
          class: 'ed-mini-danger',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.removePrefabWeaponSpawn(i);
          },
        }, ['删']),
      ]),
    )),
    h('div', { class: 'ed-row' }, [
      selectInput(
        listWeaponIds().map((id) => ({ value: id, label: `${getWeapon(id)?.name ?? id} (${id})` })),
        'ak47',
        (v) => { prefabWeaponPick = v; },
      ),
      button('＋ 武器', () => {
        store.addPrefabWeaponSpawn(prefabWeaponPick, store.prefabDropLocalPoint());
      }),
      button('＋ 随机', () => {
        store.addPrefabWeaponSpawn('', store.prefabDropLocalPoint(), 'random');
      }),
    ]),
    h('p', { class: 'ed-help' }, [
      '武器点坐标是预制件局部坐标；放实例到地图时自动跟着旋转/翻转。加完后在画布上拖到合适位置。',
    ]),

    h('h3', { class: 'ed-h3' }, ['新建部件']),
    h('p', { class: 'ed-help' }, ['按钮=加默认尺寸部件；也可按 R / C / P 选形状后在**画布上拖出**任意大小的部件。']),
    h('div', { class: 'ed-chips' }, [
      h('button', {
        class: 'ed-chip',
        onclick: () => store.addPart({ type: 'rect', x: -40, y: 0, w: 80, h: 40, material: store.activeMaterialId }),
      }, ['+ 矩形']),
      h('button', {
        class: 'ed-chip',
        onclick: () => store.addPart({ type: 'circle', x: 0, y: 0, radius: 30, material: store.activeMaterialId }),
      }, ['+ 圆形']),
      h('button', {
        class: 'ed-chip',
        onclick: () => store.addPart({ type: 'polygon', x: 0, y: 0, sides: 3, radius: 40, material: store.activeMaterialId }),
      }, ['+ 多边形']),
    ]),
    h('p', { class: 'ed-help' }, [
      `新部件材质取当前选中的「${store.activeMaterialId}」（在材质 Tab 里切换）。`,
      '画布：拖动=移动 · 右下绿点=改大小 · 上方蓝点=旋转（Shift=不吸附/15°步进）。',
    ]),
  ]);
}

/** 预制件页 · 预制件库：载入已有 / 新建 / 元信息 */
function prefabLibraryPanel(): HTMLElement {
  const store = editorStore;
  const prefabs = listPrefabs();
  const draft = store.prefabDraft;

  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`已有预制件（${prefabs.length}）`]),
    h('div', { class: 'ed-list ed-list-scroll' }, prefabs.map((p) =>
      h(
        'button',
        {
          class: `ed-list-row ${draft.id === p.id ? 'active' : ''}`,
          onclick: () => store.loadPrefab(p.id),
        },
        [
          h('span', { class: 'ed-list-main' }, [p.name]),
          h('span', { class: 'ed-list-sub' }, [`${p.id} · ${p.parts.length} 件`]),
        ],
      ),
    )),
    h('div', { class: 'ed-row' }, [button('＋ 新建预制件', () => store.newPrefab())]),

    h('h3', { class: 'ed-h3' }, ['当前预制件']),
    field('id（= 文件名）', textInput(draft.id, (v) => store.updatePrefabMeta({ id: v.trim() || 'new_prefab' }))),
    field('名称', textInput(draft.name, (v) => store.updatePrefabMeta({ name: v }))),
    field(
      '物理形态',
      selectInput(
        [
          { value: 'loose', label: '松件 loose（部件各自独立）' },
          { value: 'compound', label: '焊接 compound（整体一个刚体）' },
        ],
        draft.bodyMode ?? 'loose',
        (v) => store.updatePrefabMeta({ bodyMode: v as 'loose' | 'compound' }),
      ),
    ),
    h('p', { class: 'ed-help' }, [
      draft.bodyMode === 'compound'
        ? '焊接：所有部件合并成一个刚体，整体被推/踢飞，整体掉耐久；物理属性取「面积最大部件」的材质。'
        : '松件：每个部件独立刚体，可逐块破坏；动态时整体受力可能散架。',
    ]),
    h('p', { class: 'ed-help' }, [
      `当前 ${draft.parts.length} 个部件，坐标是相对预制件中心的局部坐标；放到地图时由锚点（中心）定位。`,
    ]),
  ]);
}

/** 预制件页 · 显示：网格 / 参照物 / 视图 */
function prefabDisplayPanel(): HTMLElement {
  const store = editorStore;
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, ['网格']),
    h('div', { class: 'ed-row' }, [
      field('大小', numberInput(store.gridSize, (v) => { store.gridSize = Math.max(2, v); store.commit(); }, 2)),
    ]),
    h('label', { class: 'ed-check' }, [
      checkbox(store.snapToGrid, (v) => { store.snapToGrid = v; store.touch(); }),
      '拖动吸附到网格',
    ]),
    h('label', { class: 'ed-check' }, [
      checkbox(store.showGrid, (v) => { store.showGrid = v; store.touch(); }),
      '显示网格（G）',
    ]),
    h('h3', { class: 'ed-h3' }, ['显示元素']),
    h('label', { class: 'ed-check' }, [
      checkbox(store.showPrefabRef, (v) => { store.showPrefabRef = v; scene()?.refreshEditor(); store.touch(); }),
      '显示参照火柴人（≈111px 高，用来对比大小）',
    ]),
    h('h3', { class: 'ed-h3' }, ['视图']),
    h('div', { class: 'ed-row' }, [button('适配视图（0）', () => scene()?.fitToMap())]),
    h('p', { class: 'ed-help' }, [
      '中键/右键/空格+左键 平移 · 滚轮缩放 · 0 适配 · 画布左侧灰火柴人是参照物（不进数据）。',
    ]),
  ]);
}

/** 二级选项：几何体 → 矩形 / 圆形 / 多边形 */
function shapeSubPanel(): HTMLElement {
  const store = editorStore;
  return h('div', { class: 'ed-subgroup' }, [
    h('div', { class: 'ed-subgroup-title' }, ['几何形状']),
    h(
      'div',
      { class: 'ed-chips' },
      SHAPE_TOOLS.map((t) =>
        h(
          'button',
          {
            class: `ed-chip ${store.tool === t.id ? 'active' : ''}`,
            onclick: () => {
              collapsedGroup = null;
              setTool(t.id);
            },
          },
          [t.label, h('span', { class: 'ed-key' }, [t.key])],
        ),
      ),
    ),
    h('p', { class: 'ed-help' }, ['在画布上拖动生成形状；材质取下方「新物体材质」。']),
  ]);
}

/** 二级选项：放置预制件 → 预制件库 */
function prefabSubPanel(): HTMLElement {
  const store = editorStore;
  const prefabs = listPrefabs();
  return h('div', { class: 'ed-subgroup' }, [
    h('div', { class: 'ed-subgroup-title' }, [`预制件库（${prefabs.length}）`]),
    h(
      'div',
      { class: 'ed-list ed-list-scroll ed-list-short' },
      prefabs.map((p) =>
        h(
          'button',
          {
            class: `ed-list-row ${store.activePrefabId === p.id ? 'active' : ''}`,
            onclick: () => {
              store.activePrefabId = p.id;
              collapsedGroup = null;
              setTool('prefab');
              store.message = `已选择预制件 ${p.name}，点击画布放置`;
            },
          },
          [h('span', { class: 'ed-list-main' }, [p.name]), h('span', { class: 'ed-list-sub' }, [p.id])],
        ),
      ),
    ),
    h('p', { class: 'ed-help' }, ['点击画布放置；放置后可拖动/旋转，右侧属性面板可改翻转与固定。']),
  ]);
}

/** 二级选项：投放点 → 投放内容（武器 / 补给道具） */
function weaponSubPanel(): HTMLElement {
  const store = editorStore;
  return h('div', { class: 'ed-subgroup' }, [
    h('div', { class: 'ed-subgroup-title' }, ['投放内容']),
    selectInput(
      [
        { value: RANDOM_WEAPON_SENTINEL, label: '随机武器（从全部武器抽）' },
        ...listWeaponIds().map((id) => ({ value: id, label: `武器 · ${getWeapon(id)?.name ?? id} (${id})` })),
        ...listItemIds().map((id) => ({ value: id, label: `道具 · ${getItem(id)?.name ?? id} (${id})` })),
      ],
      store.activeWeaponId ?? '',
      (v) => {
        store.activeWeaponId = v || null;
        if (v) {
          store.message =
            v === RANDOM_WEAPON_SENTINEL ? '随机武器投放点：点击画布放置' : '已选择投放内容，点击画布放置';
        }
        store.touch();
      },
      '选择武器或道具…',
    ),
    h('p', { class: 'ed-help' }, [
      '点击画布放置；右侧属性面板可配刷新间隔与次数、以及"从天而降"。',
      '投放点可以放武器，也可以放医疗包/防弹衣（道具不占武器槽，触碰即用）。',
    ]),
  ]);
}

// ---------------- 右侧面板 ----------------
/**
 * 对象列表（层级 = 数组顺序，越靠后越在上层；列表里**上层显示在前面**）。
 *
 * - 重建时保留滚动位置（拖动对象时列表不会跳回顶部）
 * - 选择变化时把选中项滚进可视区
 * - 支持**拖动排序**调整遮挡关系，另有 ↑↓ 按钮做精确微调
 */
let objectListScrollTop = 0;
let lastListSelectionKey = '';
/** 拖拽中的对象 id */
let draggingObjectId: string | null = null;

function buildObjectList(): HTMLElement {
  const store = editorStore;
  // 展示顺序：数组末尾（最上层）显示在最前
  const displayOrder = [...(store.map.objects ?? [])].reverse();
  const list = h('div', { class: 'ed-list ed-list-scroll' });

  const clearDropMarks = (): void => {
    for (const row of Array.from(list.children)) row.classList.remove('drop-above', 'drop-below');
  };

  for (const o of displayOrder) {
    const selected = !!o.id && store.selection.includes(o.id);
    const indexInArray = (store.map.objects ?? []).indexOf(o);
    const isTop = indexInArray === (store.map.objects ?? []).length - 1;
    const isBottom = indexInArray === 0;

    const row = h(
      'button',
      {
        class: `ed-list-row ${selected ? 'active' : ''}`,
        draggable: 'true',
        onclick: () => store.select(o.id ? [o.id] : []),
      },
      [
        h('span', { class: 'ed-list-order' }, [String(indexInArray + 1)]),
        h('span', { class: 'ed-list-main' }, [`${o.type} · ${o.material}${o.texture ? ' · 贴图' : ''}`]),
        h('span', { class: 'ed-list-sub' }, [o.id ?? '(无 id)']),
      ],
    );
    if (selected) row.dataset.selected = '1';

    // ---- 拖动排序（调整遮挡层级）----
    row.addEventListener('dragstart', (e) => {
      if (!o.id) return;
      draggingObjectId = o.id;
      row.classList.add('dragging');
      (e as DragEvent).dataTransfer?.setData('text/plain', o.id);
      const dt = (e as DragEvent).dataTransfer;
      if (dt) dt.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      draggingObjectId = null;
      row.classList.remove('dragging');
      clearDropMarks();
    });
    row.addEventListener('dragover', (e) => {
      if (!draggingObjectId || draggingObjectId === o.id) return;
      e.preventDefault(); // 允许放置
      const rect = row.getBoundingClientRect();
      const above = (e as DragEvent).clientY < rect.top + rect.height / 2;
      clearDropMarks();
      row.classList.add(above ? 'drop-above' : 'drop-below');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const dragged = draggingObjectId;
      clearDropMarks();
      if (!dragged || !o.id || dragged === o.id) return;
      const rect = row.getBoundingClientRect();
      const above = (e as DragEvent).clientY < rect.top + rect.height / 2;
      // 列表是倒序展示：视觉上"放在上面"= 数组里更靠后 = 层级更高
      const moved = store.moveObjectRelative(dragged, o.id, above);
      if (moved) {
        store.select([dragged]);
        store.message = `已调整层级（${above ? '上移' : '下移'}）`;
        store.touch();
      }
    });

    // ---- ↑↓ 按钮：精确微调 ----
    row.append(
      h('span', { class: 'ed-list-move' }, [
        h('button', {
          class: 'ed-mini',
          title: '上移一层（更靠前）',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.select(o.id ? [o.id] : []);
            store.raiseSelected('up');
          },
          disabled: isTop,
        }, ['↑']),
        h('button', {
          class: 'ed-mini',
          title: '下移一层（更靠后）',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.select(o.id ? [o.id] : []);
            store.raiseSelected('down');
          },
          disabled: isBottom,
        }, ['↓']),
      ]),
    );

    list.append(row);
  }

  list.scrollTop = objectListScrollTop;
  list.addEventListener('scroll', () => {
    objectListScrollTop = list.scrollTop;
  });

  const selectionKey = store.selection.join(',');
  if (selectionKey !== lastListSelectionKey) {
    lastListSelectionKey = selectionKey;
    const activeRow = list.querySelector('[data-selected="1"]');
    if (activeRow) requestAnimationFrame(() => activeRow.scrollIntoView({ block: 'nearest' }));
  }

  return list;
}

function renderRight(): void {
  const store = editorStore;
  rightEl.replaceChildren();

  if (store.tab === 'map') {
    const spawnIndex = store.selectedSpawnIndex();
    const weaponIndex = store.selectedWeaponIndex();
    const jointIndex = store.selectedJointIndex();
    const obj = store.firstSelectedObject();
    const inst = store.firstSelectedInstance();
    if (store.selectedRefIndex !== null) rightEl.append(refFigureForm(store.selectedRefIndex));
    else if (spawnIndex !== null) rightEl.append(spawnForm(spawnIndex));
    else if (weaponIndex !== null) rightEl.append(weaponSpawnForm(weaponIndex));
    else if (jointIndex !== null) rightEl.append(jointForm(jointIndex));
    else if (obj) rightEl.append(objectForm(obj));
    else if (inst) rightEl.append(instanceForm());
    else rightEl.append(mapForm());
    rightEl.append(issuesPanel('校验', store.validateCurrent()));
    return;
  }

  if (store.tab === 'prefab') {
    const weaponIdx = store.selectedPrefabWeaponIndex();
    if (weaponIdx !== null) {
      rightEl.append(prefabWeaponSpawnForm(weaponIdx));
      rightEl.append(issuesPanel('预制件校验', store.validateCurrent()));
      return;
    }
    const partIdxs = store.selectedPartIndices();
    if (partIdxs.length > 1) {
      rightEl.append(partsMultiForm(partIdxs));
    } else if (partIdxs.length === 1) {
      // 单选：右栏分「部件 / 内部关节」两个 Tab
      rightEl.append(prefabPartTabs(partIdxs[0]));
      rightEl.append(issuesPanel('预制件校验', store.validateCurrent()));
      return;
    } else {
      rightEl.append(
        h('h3', { class: 'ed-h3' }, ['预制件说明']),
        h('p', { class: 'ed-help' }, [
          '部件坐标是相对预制件中心的局部坐标。放置到地图时由锚点（中心）定位。',
          '左侧可载入已有预制件、增删部件；选中部件后可在此精确填写属性。',
          '画布：拖空白处=框选（Alt+拖动=任意处框选）· Ctrl/Shift+点=加选 · 拖动选中项=整体移动。',
          '画布左侧的灰色火柴人 ≈ 111px 高，用来对比预制件实际大小。',
        ]),
      );
    }
    rightEl.append(prefabJointsPanel());
    rightEl.append(issuesPanel('预制件校验', store.validateCurrent()));
    return;
  }

  rightEl.append(materialForm(), issuesPanel('材质校验', store.validateCurrent()));
}

/** 文字标签的九宫格选项 */
const LABEL_ANCHORS: Array<{ value: ObjectLabelAnchor; label: string }> = [
  { value: 'center', label: '居中' },
  { value: 'top', label: '上' },
  { value: 'bottom', label: '下' },
  { value: 'left', label: '左' },
  { value: 'right', label: '右' },
  { value: 'topLeft', label: '左上' },
  { value: 'topRight', label: '右上' },
  { value: 'bottomLeft', label: '左下' },
  { value: 'bottomRight', label: '右下' },
];

/**
 * 物体文字的表单项（地图物体 / 预制件部件共用）。
 *
 * 文案清空 = 删除文字（不留空节点，避免 JSON 里堆垃圾）。
 * 文案输入框失焦时补一次 touch：否则「填完文案 → 出现字号/颜色/位置」这步会被
 * “正在输入时不重建面板”的保护挡住，得再点一下别处才刷新。
 */
function labelFields(
  label: MapObjectLabel | undefined,
  update: (label: MapObjectLabel | undefined) => void,
): Child[] {
  const cur = label;
  const textInputEl = textInput(cur?.text ?? '', (v) => {
    const text = v.trim();
    update(text ? { ...cur, text } : undefined);
  });
  textInputEl.addEventListener('blur', () => editorStore.touch());

  const rows: Child[] = [
    h('h3', { class: 'ed-h3' }, ['文字（显示在物体上）']),
    field('文案', textInputEl),
  ];
  if (cur && cur.text.trim()) {
    const patchLabel = (p: Partial<MapObjectLabel>) => update({ ...cur, ...p });
    rows.push(
      h('div', { class: 'ed-grid2' }, [
        field('字号（px）', numberInput(cur.size ?? 20, (v) => patchLabel({ size: Math.max(4, Math.round(v)) }), 1)),
        field('颜色', colorInput(cur.color ?? '#ffffff', (v) => patchLabel({ color: v }))),
      ]),
      field('位置', selectInput(LABEL_ANCHORS, cur.anchor ?? 'center', (v) =>
        patchLabel({ anchor: v as ObjectLabelAnchor }),
      )),
      h('p', { class: 'ed-help' }, ['纯视觉：不参与物理，随物体移动/旋转；自动加描边保证可读。']),
      h('div', { class: 'ed-row' }, [button('删除文字', () => update(undefined), 'danger')]),
    );
  }
  return rows;
}

function objectForm(obj: MapObject): HTMLElement {
  const store = editorStore;
  const multi = store.selection.length > 1;
  const patch = (p: Record<string, unknown>) => store.patchSelected(p);

  const fixedValue = obj.fixed === undefined ? 'default' : obj.fixed ? 'true' : 'false';
  const layer = obj.layer ?? 'solid';

  const rows: Child[] = [
    h('h3', { class: 'ed-h3' }, [`选中 ${multi ? `(${store.selection.length} 个)` : obj.type}`]),
    field('id（关节引用/定位都用它，可改）', textInput(obj.id ?? '', (v) => {
      const res = store.renameSelectedId(v);
      if (!res.ok) {
        store.message = `改名失败：${res.reason ?? '未知原因'}`;
        store.touch();
      } else {
        store.message = `id 已改为 ${v.trim()}`;
        store.touch();
      }
    })),
    field('材质', selectInput(
      materialIds().map((id) => ({ value: id, label: `${MATERIALS[id].name} (${id})` })),
      obj.material,
      (v) => patch({ material: v }),
    )),
    h('div', { class: 'ed-grid2' }, [
      field(obj.type === 'rect' ? 'x（左上角）' : 'x（中心）', numberInput(obj.x, (v) => patch({ x: v }))),
      field(obj.type === 'rect' ? 'y（左上角）' : 'y（中心）', numberInput(obj.y, (v) => patch({ y: v }))),
    ]),
  ];

  if (obj.type === 'rect') {
    rows.push(
      h('div', { class: 'ed-grid2' }, [
        field('宽 w', numberInput(obj.w, (v) => patch({ w: Math.max(2, v) }))),
        field('高 h', numberInput(obj.h, (v) => patch({ h: Math.max(2, v) }))),
      ]),
    );
  } else if (obj.type === 'circle') {
    rows.push(field('半径', numberInput(obj.radius, (v) => patch({ radius: Math.max(2, v) }))));
  } else {
    const isRegular = !obj.vertices || obj.vertices.length === 0;
    if (isRegular) {
      rows.push(
        h('div', { class: 'ed-grid2' }, [
          field('边数', numberInput(obj.sides ?? 3, (v) => patch({ sides: Math.max(3, Math.round(v)) }))),
          field('半径', numberInput(obj.radius ?? 40, (v) => patch({ radius: Math.max(2, v) }))),
        ]),
      );
    } else {
      const vcount = obj.vertices?.length ?? 0;
      rows.push(
        h('p', { class: 'ed-help' }, [
          vcount > 0 ? `自定义顶点 ${vcount} 个 — 画布上直接拖拽顶点编辑` : '正多边形',
        ]),
        h('div', { class: 'ed-row' }, [
          button('转为可编辑顶点', () => {
            store.polygonMakeEditable();
            store.message = '已转为自定义顶点，可在画布上拖拽';
            store.touch();
          }),
        ]),
        field('半径（正多边形用）', numberInput(obj.radius ?? 40, (v) => patch({ radius: Math.max(2, v) }))),
      );
    }
  }

  rows.push(
    field('旋转角（度，顺时针）', numberInput(obj.angle ?? 0, (v) => patch({ angle: v }), 1)),
    field('固定状态', selectInput(
      [
        { value: 'default', label: '材质默认' },
        { value: 'true', label: '固定（静态）' },
        { value: 'false', label: '可动' },
      ],
      fixedValue,
      (v) => patch({ fixed: v }),
    )),
    field('图层', selectInput(
      [
        { value: 'solid', label: 'solid（参与物理）' },
        { value: 'decor', label: 'decor（纯视觉）' },
      ],
      layer,
      (v) => patch({ layer: v }),
    )),
    h('label', { class: 'ed-check' }, [checkbox(obj.oneWay === true, (v) => patch({ oneWay: v })), '单向平台']),
    h('div', { class: 'ed-row' }, [
      h('label', { class: 'ed-check' }, [
        checkbox(!!obj.color, (v) => patch({ color: v ? MATERIALS[obj.material].colorHex : undefined })),
        '覆盖颜色',
      ]),
      obj.color
        ? colorInput(obj.color, (v) => patch({ color: v }))
        : h('span', { class: 'ed-help' }, [MATERIALS[obj.material].colorHex]),
    ]),
    ...labelFields(obj.label, (label) => patch({ label })),
    ...(obj.type === 'rect'
      ? [
          h('h3', { class: 'ed-h3' }, ['贴图（所有形状）']),
          field('贴图路径', textInput(obj.texture ?? '', (v) => patch({ texture: v.trim() || undefined }))),
          h('p', { class: 'ed-help' }, [
            `留空 = 跟随材质贴图（当前材质：${MATERIALS[obj.material].texture ?? '无'}）。`,
            '填 public 下相对路径，如 textures/metal.png，也可用 data:image/... 内联。',
          ]),
          field('铺法', selectInput(
            [
              { value: 'tile', label: 'tile（平铺）' },
              { value: 'stretch', label: 'stretch（拉伸铺满）' },
            ],
            obj.textureMode ?? MATERIALS[obj.material].textureMode ?? 'tile',
            (v) => patch({ textureMode: v }),
          )),
        ]
      : []),
    h('div', { class: 'ed-row' }, [
      button('复制（Ctrl+C）', () => store.copySelection()),
      button('粘贴（Ctrl+V）', () => store.pasteClipboard()),
      button('删除', () => store.deleteSelected(), 'danger'),
    ]),
  );

  return h('div', {}, rows);
}

function instanceForm(): HTMLElement {
  const store = editorStore;
  const inst = store.firstSelectedInstance();
  if (!inst) return h('div');
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, ['预制件实例']),
    field('id（可改）', textInput(inst.id ?? '', (v) => {
      const res = store.renameSelectedId(v);
      if (!res.ok) {
        store.message = `改名失败：${res.reason ?? '未知原因'}`;
        store.touch();
      }
    })),
    h('p', { class: 'ed-help' }, [
      `ref: ${inst.ref} · 形态: ${listPrefabs().find((p) => p.id === inst.ref)?.bodyMode === 'compound' ? '焊接' : '松件'}`,
    ]),
    ...(() => {
      // 实例包含的部件（只读）：选中实例时也能看到"这个预制件里有什么"，
      // 不用切回预制件 Tab 才知道尺寸/材质
      const prefab = listPrefabs().find((p) => p.id === inst.ref);
      if (!prefab) return [];
      const parts = prefab.parts ?? [];
      return [
        h('h3', { class: 'ed-h3' }, [`包含的部件（${parts.length}）`]),
        h('div', { class: 'ed-list ed-list-scroll' }, parts.map((part, i) => {
          const size = part.type === 'rect'
            ? `${Math.round(part.w)}×${Math.round(part.h)}`
            : `r ${Math.round(part.radius ?? 0)}`;
          return h('div', { class: 'ed-list-row', style: 'cursor:default' }, [
            h('span', { class: 'ed-list-main' }, [`#${i} ${part.type} · ${part.material}`]),
            h('span', { class: 'ed-list-sub' }, [size]),
          ]);
        })),
        h('p', { class: 'ed-help' }, ['只读：要改部件请切到「预制件」Tab（地图里所有该预制件的实例一起变）。']),
      ];
    })(),
    h('div', { class: 'ed-grid2' }, [
      field('x（中心）', numberInput(inst.x, (v) => store.patchSelected({ x: v }))),
      field('y（中心）', numberInput(inst.y, (v) => store.patchSelected({ y: v }))),
    ]),
    field('旋转角（度）', numberInput(inst.angle ?? 0, (v) => store.patchSelected({ angle: v }))),
    h('label', { class: 'ed-check' }, [
      checkbox(inst.flipX === true, (v) => store.patchSelected({ flipX: v })),
      '水平翻转',
    ]),
    field('固定状态', selectInput(
      [
        { value: 'default', label: '材质默认' },
        { value: 'true', label: '固定（家具）' },
        { value: 'false', label: '可动' },
      ],
      inst.fixed === undefined ? 'default' : inst.fixed ? 'true' : 'false',
      (v) => store.patchSelected({ fixed: v }),
    )),
    h('div', { class: 'ed-row' }, [
      button('复制（Ctrl+C）', () => store.copySelection()),
      button('粘贴（Ctrl+V）', () => store.pasteClipboard()),
      button('删除', () => store.deleteSelected(), 'danger'),
    ]),
  ]);
}

/** 参考火柴人属性（编辑器标注，不写入地图数据） */
function refFigureForm(index: number): HTMLElement {
  const store = editorStore;
  const fig = store.refFigures[index];
  if (!fig) return h('div', {}, ['参考火柴人已不存在']);
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`参考火柴人 #${index + 1}`]),
    h('p', { class: 'ed-help' }, [
      '只用于对照尺寸：不会写入地图 JSON，也不参与物理/碰撞。画布上可直接拖动。',
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('x', numberInput(fig.x, (v) => { store.moveRefFigure(index, v, fig.y); })),
      field('y', numberInput(fig.y, (v) => { store.moveRefFigure(index, fig.x, v); })),
    ]),
    h('label', { class: 'ed-check' }, [
      checkbox(fig.facing === -1, (v) => {
        fig.facing = v ? -1 : 1;
        store.touch();
      }),
      '朝左',
    ]),
    h('div', { class: 'ed-row' }, [
      button('删除（Delete）', () => store.deleteRefFigure(index), 'danger'),
      button(`清除全部（${store.refFigures.length}）`, () => store.clearRefFigures()),
    ]),
  ]);
}

/** 出生点属性（选中画布上的出生点后显示，可直接拖动画布移动） */
function spawnForm(index: number): HTMLElement {
  const store = editorStore;
  const sp = store.map.spawnPoints[index];
  if (!sp) return h('div');
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`出生点 #${index + 1}`]),
    h('p', { class: 'ed-help' }, ['画布上可直接拖动；也可在此精确定位。']),
    h('div', { class: 'ed-grid2' }, [
      field('x', numberInput(sp.x, (v) => store.updateSpawn(index, { x: v }))),
      field('y', numberInput(sp.y, (v) => store.updateSpawn(index, { y: v }))),
    ]),
    h('div', { class: 'ed-row' }, [
      button('删除该出生点', () => store.removeSpawn(index), 'danger'),
    ]),
  ]);
}

/** 关节属性（锚点可精确输入；画布上可直接拖动锚点） */
function jointForm(index: number): HTMLElement {
  const store = editorStore;
  const j = store.joints()[index];
  if (!j) return h('div');
  const candidates = store.jointCandidates();
  // 当前引用的 id 可能已经不在列表里（物体被删）——也补进去，避免下拉“跳回第一个”
  const withCurrent = (id: string | undefined, extra: Array<{ value: string; label: string }>) => {
    if (!id || extra.some((o) => o.value === id)) return extra;
    return [...extra, { value: id, label: `⚠ ${id}（已不存在）` }];
  };
  const bodyAOptions = withCurrent(
    j.bodyA,
    candidates.map((c) => ({ value: c.id, label: c.label })),
  );
  const bodyBOptions = withCurrent(
    j.bodyB,
    candidates.map((c) => ({ value: c.id, label: c.label })),
  );
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`关节 #${index + 1}（${j.type}）`]),
    h('p', { class: 'ed-help' }, [
      '销轴连接：两端可以绕锚点自由旋转（吊链 / 跷跷板 / 三节棍）。',
      '“→世界”表示固定在世界锚点上（像挂在天花板上）。',
    ]),
    field('主体 A（bodyA）', selectInput(bodyAOptions, j.bodyA, (v) => store.updateJoint(index, { bodyA: v }))),
    field(
      '另一端（bodyB）',
      selectInput(
        [{ value: 'world', label: 'world（固定在世界锚点）' }, ...bodyBOptions],
        j.bodyB ?? 'world',
        (v) => store.updateJoint(index, { bodyB: v }),
      ),
    ),
    h('label', { class: 'ed-check' }, [
      checkbox(j.noCollide === true, (v) => store.updateJoint(index, { noCollide: v })),
      '两端互不碰撞（链条/三节棍必开，否则旋转时端面会互顶）',
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('锚点 x', numberInput(j.anchor.x, (v) => store.updateJoint(index, { anchor: { x: v, y: j.anchor.y } }))),
      field('锚点 y', numberInput(j.anchor.y, (v) => store.updateJoint(index, { anchor: { x: j.anchor.x, y: v } }))),
    ]),
    h('p', { class: 'ed-help' }, ['画布上可直接拖动粉色锚点；也可在此精确填写。']),
    h('div', { class: 'ed-row' }, [
      button('删除该关节', () => store.removeJoint(index), 'danger'),
    ]),
  ]);
}

/** 武器掉落点属性（固定 / 随机 / 刷新配置） */
function weaponSpawnForm(index: number): HTMLElement {
  const store = editorStore;
  const w = store.weaponSpawns()[index];
  if (!w) return h('div');
  const mode = w.mode ?? 'fixed';
  const fixedId = w.item ?? w.weapon ?? w.type ?? '';
  const fixedIsItem = !!getItem(fixedId) && !getWeapon(fixedId);

  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`投放点 #${index + 1}`]),
    h('p', { class: 'ed-help' }, [
      '开局在这里刷一份内容（武器，或医疗包/防弹衣）；可配置被捡走后是否重新刷新。画布上可拖动。',
    ]),
    field('模式', selectInput(
      [
        { value: 'fixed', label: '固定内容（每次刷同一个）' },
        { value: 'random', label: '随机（从候选池抽）' },
      ],
      mode,
      (v) => store.updateWeaponSpawn(index, { mode: v as 'fixed' | 'random' }),
    )),

    ...(mode === 'fixed'
      ? [
          field('投放内容', selectInput(
            [
              ...listWeaponIds().map((id) => ({ value: id, label: `武器 · ${getWeapon(id)?.name ?? id} (${id})` })),
              ...listItemIds().map((id) => ({ value: id, label: `道具 · ${getItem(id)?.name ?? id} (${id})` })),
            ],
            fixedId,
            (v) => {
              // 道具写 item、武器写 weapon：两种字段分开存，语义更清楚
              const isItem = !!getItem(v) && !getWeapon(v);
              store.updateWeaponSpawn(index, isItem ? { item: v, weapon: undefined } : { item: undefined, weapon: v });
            },
          )),
        ]
      : [
          field('候选池（逗号分隔，留空 = 全部武器）', textInput((w.pool ?? []).join(', '), (v) => {
            const pool = v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            store.updateWeaponSpawn(index, { pool });
          })),
          h('p', { class: 'ed-help' }, [
            `可用武器：${listWeaponIds().join(', ')}`,
            `可用道具：${listItemIds().join(', ')}（可混着写，例：ak47, medkit）`,
          ]),
        ]),

    h('div', { class: 'ed-grid2' }, [
      field('刷新间隔（ms，0=不刷新）', numberInput(w.respawnMs ?? 0, (v) => store.updateWeaponSpawn(index, { respawnMs: Math.max(0, Math.round(v)) }))),
      field('最多刷新次数（空=无限）', numberInput(w.maxRespawns ?? 0, (v) => store.updateWeaponSpawn(index, { maxRespawns: Math.max(0, Math.round(v)) }))),
    ]),
    h('p', { class: 'ed-help' }, [
      '说明：刷新间隔 0 或"最多刷新次数"=0 → 只开局刷一次，捡走就没了；',
      '间隔 >0 且次数留空（=无限）→ 被捡走后按间隔一直补。',
    ]),

    h('label', { class: 'ed-check' }, [
      checkbox((w as { fromSky?: boolean }).fromSky === true, (v) => store.updateWeaponSpawn(index, { fromSky: v })),
      '从天而降（默认关闭 = 直接出现在该点）',
    ]),
    h('p', { class: 'ed-help' }, [
      '默认原地生成：内容就出现在你放的这个点上（放进"门"里、掩体里都不会被屋顶挡住）。',
      '勾选后改为从它上方 240px 落下 —— 上方有屋顶/门框时会停在屋顶上。',
      fixedIsItem ? '当前内容：补给道具（不占武器槽，触碰即用）。' : '当前内容：武器。',
    ]),
    h('p', { class: 'ed-help' }, ['位置：直接在画布上拖动该掉落点即可（无需手动填坐标）。']),
    h('div', { class: 'ed-row' }, [
      button('删除该掉落点', () => store.removeWeaponSpawn(index), 'danger'),
    ]),
  ]);
}

function mapForm(): HTMLElement {
  const store = editorStore;
  const map = store.map;
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, ['地图属性']),
    field('名称', textInput(map.name, (v) => { map.name = v; store.commit(); })),
    h('div', { class: 'ed-grid2' }, [
      field('宽', numberInput(map.width, (v) => { map.width = Math.max(100, v); store.commit(); })),
      field('高', numberInput(map.height, (v) => { map.height = Math.max(100, v); store.commit(); })),
    ]),
    h('h3', { class: 'ed-h3' }, [`出生点（${map.spawnPoints.length}）`]),
    h(
      'div',
      { class: 'ed-list' },
      map.spawnPoints.map((sp, i) =>
        h('div', { class: 'ed-spawn-row' }, [
          h('span', { class: 'ed-list-sub' }, [`#${i + 1}`]),
          numberInput(sp.x, (v) => store.updateSpawn(i, { x: v })),
          numberInput(sp.y, (v) => store.updateSpawn(i, { y: v })),
          h('button', { class: 'ed-mini-danger', onclick: () => store.removeSpawn(i) }, ['删']),
        ]),
      ),
    ),
    h('div', { class: 'ed-row' }, [
      button('+ 在中心添加出生点', () => store.addSpawn(Math.round(map.width / 2), Math.round(map.height - 130))),
    ]),
    h('h3', { class: 'ed-h3' }, ['自动空投（默认关闭）']),
    h('p', { class: 'ed-help' }, [
      '关闭时：天上什么都不掉 —— 武器和药包/护盾都只来自「投放点」（和 items[] 固定点）。',
      '开启后：从天上随机掉武器（维持数量），并同时按 items.json 的 maintain 补药包/护盾。',
      '投放 x 范围用「空投区域」。',
    ]),
    h('label', { class: 'ed-check' }, [
      checkbox(map.autoDrop?.enabled === true, (v) => {
        map.autoDrop = { ...(map.autoDrop ?? {}), enabled: v };
        store.commit();
      }),
      '启用全局自动空投',
    ]),
    ...(map.autoDrop?.enabled === true
      ? [
          h('div', { class: 'ed-grid2' }, [
            field('维持数量', numberInput(map.autoDrop.count ?? 4, (v) => {
              map.autoDrop = { ...(map.autoDrop ?? {}), count: Math.max(0, Math.round(v)) };
              store.commit();
            })),
            field('检查间隔 ms', numberInput(map.autoDrop.intervalMs ?? 2800, (v) => {
              map.autoDrop = { ...(map.autoDrop ?? {}), intervalMs: Math.max(200, Math.round(v)) };
              store.commit();
            })),
          ]),
          field('开局投放数量', numberInput(map.autoDrop.initial ?? 3, (v) => {
            map.autoDrop = { ...(map.autoDrop ?? {}), initial: Math.max(0, Math.round(v)) };
            store.commit();
          })),
        ]
      : []),

    h('h3', { class: 'ed-h3' }, [`关节（${store.joints().length}）`]),
    h(
      'div',
      { class: 'ed-list' },
      store.joints().map((j, i) =>
        h('div', { class: 'ed-spawn-row' }, [
          h('span', { class: 'ed-list-main' }, [`${j.bodyA} → ${j.bodyB ?? 'world'}`]),
          numberInput(j.anchor.x, (v) => { j.anchor.x = v; store.commit(); }),
          numberInput(j.anchor.y, (v) => { j.anchor.y = v; store.commit(); }),
          h('button', { class: 'ed-mini-danger', onclick: () => store.removeJoint(i) }, ['删']),
        ]),
      ),
    ),
    h('h3', { class: 'ed-h3' }, [`空投区域（${(map.weaponDropZones ?? []).length}）`]),
    h('p', { class: 'ed-help' }, [
      map.autoDrop?.enabled === true
        ? '生效中：随机空投的落点 x 会落在下面这些区间里（画布上显示为带箭头的黄线）。'
        : '未生效：只有勾选上面的「启用全局自动空投」才会用到这些区域，画布上也不再显示。',
      '只用到 x 与 w（掉落高度固定从屏幕上方落下），y/h 仅作摆放参考；数值在 JSON 的 weaponDropZones 里改。',
    ]),
    ...(map.weaponDropZones ?? []).map((z, i) =>
      h('div', { class: 'ed-list-row', style: 'cursor:default' }, [
        h('span', { class: 'ed-list-main' }, [`#${i + 1} x ${Math.round(z.x)} – ${Math.round(z.x + z.w)}`]),
        h('span', { class: 'ed-list-sub' }, [`y ${Math.round(z.y)} h ${Math.round(z.h)}`]),
      ]),
    ),
    h('div', { class: 'ed-row' }, [button('重置为默认地图', () => store.resetToDefault(), 'danger')]),
  ]);
}

/** 预制件右栏的两个 Tab：部件属性 / 内部关节 */
type PrefabRightTab = 'part' | 'joints';
let prefabRightTab: PrefabRightTab = 'part';

/** 单个部件选中时的右栏：Tab 切换「部件属性」与「内部关节」 */
function prefabPartTabs(index: number): HTMLElement {
  const tabs = subTabs<PrefabRightTab>(
    [
      { id: 'part', label: '部件' },
      { id: 'joints', label: '内部关节' },
    ],
    prefabRightTab,
    (id) => {
      if (prefabRightTab === id) return;
      prefabRightTab = id;
      renderRight();
    },
  );
  return h('div', {}, [
    tabs,
    prefabRightTab === 'joints' ? prefabJointsPanel(index) : partForm(index),
  ]);
}

/**
 * 内部关节面板。
 * @param focus 传入部件下标时只显示该部件相关的关节，并提供「连接到…」的快捷建关节入口；
 *              不传则显示全部（多选/未选中时用）。
 */
/**
 * 预制件自带的武器掉落点属性面板。
 * 字段与地图 Tab 的「武器掉落点」完全一致，只有坐标是**预制件局部坐标**。
 */
function prefabWeaponSpawnForm(index: number): HTMLElement {
  const store = editorStore;
  const w = store.prefabWeaponSpawns()[index];
  if (!w) return h('div');
  const mode = w.mode ?? 'fixed';
  const fixedId = w.weapon ?? w.type ?? '';

  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`武器掉落点 #${index + 1}（预制件）`]),
    h('p', { class: 'ed-help' }, [
      '预制件里带的枪位：每放一个实例，就会在对应位置刷一把武器（坐标是预制件局部坐标，跟随实例旋转/翻转）。',
    ]),
    field('模式', selectInput(
      [
        { value: 'fixed', label: '固定武器（每次刷同一把）' },
        { value: 'random', label: '随机武器（从候选池抽）' },
      ],
      mode,
      (v) => store.updatePrefabWeaponSpawn(index, { mode: v as 'fixed' | 'random' }),
    )),
    ...(mode === 'fixed'
      ? [
          field('武器', selectInput(
            listWeaponIds().map((id) => ({ value: id, label: `${getWeapon(id)?.name ?? id} (${id})` })),
            fixedId,
            (v) => store.updatePrefabWeaponSpawn(index, { weapon: v }),
          )),
        ]
      : [
          field('候选池（逗号分隔，留空 = 全部武器）', textInput((w.pool ?? []).join(', '), (v) => {
            const pool = v.split(',').map((x) => x.trim()).filter(Boolean);
            store.updatePrefabWeaponSpawn(index, { pool });
          })),
          h('p', { class: 'ed-help' }, [`可用：${listWeaponIds().join(', ')}`]),
        ]),
    h('div', { class: 'ed-grid2' }, [
      field('刷新间隔（ms，0=不刷新）', numberInput(w.respawnMs ?? 0, (v) => store.updatePrefabWeaponSpawn(index, { respawnMs: Math.max(0, Math.round(v)) }))),
      field('最多刷新次数（0=只刷一次）', numberInput(w.maxRespawns ?? 0, (v) => store.updatePrefabWeaponSpawn(index, { maxRespawns: Math.max(0, Math.round(v)) }))),
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('局部 x', numberInput(w.x, (v) => store.updatePrefabWeaponSpawn(index, { x: v }))),
      field('局部 y', numberInput(w.y, (v) => store.updatePrefabWeaponSpawn(index, { y: v }))),
    ]),
    h('label', { class: 'ed-check' }, [
      checkbox((w as { fromSky?: boolean }).fromSky === true, (v) => store.updatePrefabWeaponSpawn(index, { fromSky: v })),
      '从天而降（默认关闭 = 直接出现在该点）',
    ]),
    h('p', { class: 'ed-help' }, ['位置：画布上直接拖动这个枪位即可；也可以在上面填局部坐标。']),
    h('div', { class: 'ed-row' }, [
      button('删除该掉落点', () => store.removePrefabWeaponSpawn(index), 'danger'),
    ]),
  ]);
}

function prefabJointsPanel(focus?: number): HTMLElement {
  const store = editorStore;
  const parts = store.prefabDraft.parts;
  const all = store.prefabJoints();
  const partOptions = parts.map((p, i) => ({ value: String(i), label: `#${i} ${p.material}` }));
  const selected = store.selectedPartIndices();

  const involved = all
    .map((j, k) => ({ j, k }))
    .filter(({ j }) => focus === undefined || j.bodyA === focus || j.bodyB === focus);

  /** 两件 → 中心连线中点（链节叠放时正好是接缝）；单件 → 该件上边中点 */
  const anchorFor = (idxs: number[]): { x: number; y: number } | null => {
    if (idxs.length === 2) {
      const a = parts[idxs[0]];
      const b = parts[idxs[1]];
      if (!a || !b) return null;
      const ca = objectCenter(a);
      const cb = objectCenter(b);
      return { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
    }
    if (idxs.length === 1) {
      const part = parts[idxs[0]];
      if (!part) return null;
      const b = objectBounds(part);
      return { x: (b.minX + b.maxX) / 2, y: b.minY };
    }
    return null;
  };

  const rows: Child[] = [
    h('h3', { class: 'ed-h3' }, [
      focus === undefined ? `内部关节（${all.length}）` : `内部关节（该部件 ${involved.length} / 共 ${all.length}）`,
    ]),
    h('p', { class: 'ed-help' }, [
      '销轴连接：两端绕锚点自由旋转（吊链 / 三节棍 / 吊平台）。锚点是局部坐标，实例化到地图时自动跟着旋转/平移。',
      '画布上：鼠标移到粉色十字会高亮这条关节并露出两个端点，把端点拖到别的部件上就改连接（拖到空白 = 改成 world）。',
    ]),
  ];

  // ---- 选中单个部件时：直接在这里连一条新关节 ----
  if (focus !== undefined) {
    const others = partOptions.filter((o) => o.value !== String(focus));
    const target = h('select', { class: 'ed-input' }, [
      h('option', { value: 'world' }, ['world（固定在世界锚点）']),
      ...others.map((o) => h('option', { value: o.value }, [o.label])),
    ]) as HTMLSelectElement;
    rows.push(
      h('div', { class: 'ed-row' }, [
        h('span', { class: 'ed-help', style: 'margin:0' }, [`#${focus} →`]),
        target,
        button('＋ 连接', () => {
          const value = target.value;
          if (value === 'world') {
            const anchor = anchorFor([focus]);
            if (!anchor) return;
            store.addPrefabJoint(focus, anchor);
            store.message = `已建关节 #${focus} → world（锚点取该件上边中点）`;
            return;
          }
          const other = Number(value);
          const anchor = anchorFor([focus, other]);
          if (!anchor) return;
          store.addPrefabJoint(focus, anchor, other);
          store.message = `已建关节 #${focus} → #${other}（锚点取两件中心连线中点）`;
        }, 'primary'),
      ]),
      h('p', { class: 'ed-help' }, [
        '叠在一起的链节：中心距 = 节长，锚点就落在接缝上；吊链/三节棍保留「两端不互撞」。',
      ]),
    );
  }

  if (involved.length === 0) {
    rows.push(
      h('p', { class: 'ed-help' }, [
        focus === undefined ? '还没有内部关节。' : `部件 #${focus} 还没有关节——用上面的「＋ 连接」加一条。`,
      ]),
    );
  }

  involved.forEach(({ j, k }) => {
    rows.push(
      h('div', { class: 'ed-joint-card' }, [
        h('div', { class: 'ed-row ed-row-between' }, [
          h('span', { class: 'ed-help', style: 'margin:0' }, [`#${k + 1}`]),
          button('删除', () => editorStore.removePrefabJoint(k), 'danger'),
        ]),
        field('A', selectInput(partOptions, String(j.bodyA), (v) => editorStore.updatePrefabJoint(k, { bodyA: Number(v) }))),
        field('B', selectInput(
          [{ value: 'world', label: 'world（固定在世界锚点）' }, ...partOptions],
          j.bodyB === undefined ? 'world' : String(j.bodyB),
          (v) => editorStore.updatePrefabJoint(k, { bodyB: v === 'world' ? 'world' : Number(v) }),
        )),
        h('div', { class: 'ed-grid2' }, [
          field('锚点 x', numberInput(j.anchor.x, (v) => editorStore.updatePrefabJoint(k, { anchor: { x: v, y: j.anchor.y } }))),
          field('锚点 y', numberInput(j.anchor.y, (v) => editorStore.updatePrefabJoint(k, { anchor: { x: j.anchor.x, y: v } }))),
        ]),
        h('label', { class: 'ed-check' }, [
          checkbox(j.noCollide === true, (v) => editorStore.updatePrefabJoint(k, { noCollide: v })),
          '两端不互撞',
        ]),
      ]),
    );
  });

  // ---- 未指定 focus（多选/未选中）：保留"选中 2 件一起连"的批量入口 ----
  if (focus === undefined) {
    rows.push(
      h('div', { class: 'ed-row' }, [
        button(
          selected.length === 2 ? `＋ 连选中的 2 件（#${selected[0]} → #${selected[1]}）` : '＋ 连选中的 2 件（先选两件）',
          () => {
            const anchor = anchorFor(selected);
            if (selected.length !== 2 || !anchor) {
              store.message = '先在画布上选中 2 个部件（Ctrl/Shift+点击加选）再建关节';
              store.touch();
              return;
            }
            store.addPrefabJoint(selected[0], anchor, selected[1]);
            store.message = `已建关节 #${selected[0]} → #${selected[1]}（锚点取两件中心连线的中点，可在上方微调）`;
          },
          'primary',
        ),
        button(
          selected.length === 1 ? `＋ 选中件 #${selected[0]} ↔ 世界` : '＋ 选中件 ↔ 世界',
          () => {
            const anchor = anchorFor(selected);
            if (selected.length !== 1 || !anchor) {
              store.message = '先选中 1 个部件再建“→世界”关节';
              store.touch();
              return;
            }
            store.addPrefabJoint(selected[0], anchor);
            store.message = `已建关节 #${selected[0]} → world（锚点取该件上边中点）`;
          },
        ),
      ]),
    );
  }

  return h('div', {}, rows);
}

function partForm(index: number): HTMLElement {
  const store = editorStore;
  const part = store.prefabDraft.parts[index];
  if (!part) return h('div');
  const rows: Child[] = [
    h('h3', { class: 'ed-h3' }, [`部件 #${index}（${part.type}）`]),
    field('材质', selectInput(
      materialIds().map((id) => ({ value: id, label: `${MATERIALS[id].name} (${id})` })),
      part.material,
      (v) => store.updatePart(index, { material: v }),
    )),
    h('div', { class: 'ed-grid2' }, [
      field(part.type === 'rect' ? 'x（左上角）' : 'x（中心）', numberInput(part.x, (v) => store.updatePart(index, { x: v }))),
      field(part.type === 'rect' ? 'y（左上角）' : 'y（中心）', numberInput(part.y, (v) => store.updatePart(index, { y: v }))),
    ]),
  ];
  if (part.type === 'rect') {
    rows.push(
      h('div', { class: 'ed-grid2' }, [
        field('宽', numberInput(part.w, (v) => store.updatePart(index, { w: Math.max(2, v) }))),
        field('高', numberInput(part.h, (v) => store.updatePart(index, { h: Math.max(2, v) }))),
      ]),
    );
  } else if (part.type === 'circle') {
    rows.push(field('半径', numberInput(part.radius, (v) => store.updatePart(index, { radius: Math.max(2, v) }))));
  } else {
    const vcount = part.vertices?.length ?? 0;
    rows.push(
      h('div', { class: 'ed-grid2' }, [
        field('边数', numberInput(part.sides ?? 3, (v) => store.updatePart(index, { sides: Math.max(3, Math.round(v)) }))),
        field('半径', numberInput(part.radius ?? 40, (v) => store.updatePart(index, { radius: Math.max(2, v) }))),
      ]),
      h('p', { class: 'ed-help' }, [
        vcount > 0
          ? `自定义顶点 ${vcount} 个 — 画布上拖顶点=移动 · 双击边=加点 · Alt+点击=删点`
          : '画布上拖动蓝色顶点即可转为自定义形状（边数/半径随后失效）',
      ]),
    );
  }
  rows.push(
    ...labelFields(part.label, (label) => store.updatePart(index, { label })),
    field('旋转角（度）', numberInput(part.angle ?? 0, (v) => store.updatePart(index, { angle: v }))),
    h('div', { class: 'ed-row' }, [
      button('删除部件', () => store.removePart(index), 'danger'),
    ]),
  );
  return h('div', {}, rows);
}

/** 预制件 Tab：多选部件（框选/Ctrl+点击）后的批量面板 */
function partsMultiForm(indices: number[]): HTMLElement {
  const store = editorStore;
  const parts = indices.map((i) => store.prefabDraft.parts[i]).filter(Boolean);
  const materialsUsed = [...new Set(parts.map((p) => p.material))];
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`已选 ${indices.length} 个部件`]),
    h('p', { class: 'ed-help' }, [
      '框选：空白处按住拖动（部件太大不好找空地时，用 Alt+拖动 可从任意位置起手）· 加选：Ctrl/Shift+点击 · 拖动其中一个会带着全部一起移动。',
    ]),
    h('div', { class: 'ed-list ed-list-scroll' }, indices.map((i) => {
      const part = store.prefabDraft.parts[i];
      if (!part) return null;
      const size = part.type === 'rect'
        ? `${Math.round(part.w)}×${Math.round(part.h)}`
        : `r ${Math.round(part.radius ?? 0)}`;
      return h('div', { class: 'ed-list-row', style: 'cursor:default' }, [
        h('span', { class: 'ed-list-main' }, [`#${i} ${part.type} · ${part.material}`]),
        h('span', { class: 'ed-list-sub' }, [size]),
      ]);
    })),
    field('批量改材质', selectInput(
      [
        { value: '', label: `保持原样（${materialsUsed.join(' / ') || '—'}）` },
        ...materialIds().map((id) => ({ value: id, label: `${MATERIALS[id].name} (${id})` })),
      ],
      '',
      (v) => {
        if (!v) return;
        for (const i of indices) store.patchPartLive(i, { material: v });
        store.commit();
      },
    )),
    h('div', { class: 'ed-row' }, [
      button('复制（Ctrl+C）', () => store.copySelection()),
      button('粘贴（Ctrl+V）', () => store.pasteClipboard()),
      button(`删除 ${indices.length} 个`, () => store.deleteSelected(), 'danger'),
    ]),
  ]);
}

/** 当前材质的发光配置 → 可直接写回 JSON 的形态 */
function glowJson(mat: { glow: { colorHex: string; brightness: number; radius: number; mode: string } | null }) {
  const g = mat.glow;
  return {
    color: g?.colorHex ?? '#ffffff',
    brightness: g?.brightness ?? 1,
    radius: g?.radius ?? 18,
    mode: g?.mode ?? 'constant',
  };
}

/** 当前材质的爆炸配置 → 可直接写回 JSON 的形态 */
function explosiveJson(mat: {
  explosive: { damage: number; radius: number; knockback: number } | null;
}) {
  return {
    damage: mat.explosive?.damage ?? 40,
    radius: mat.explosive?.radius ?? 120,
    knockback: mat.explosive?.knockback ?? 12,
  };
}

function materialForm(): HTMLElement {
  const store = editorStore;
  const mat = MATERIALS[store.activeMaterialId];
  if (!mat) return h('div', {}, ['未选择材质']);
  const upd = (patch: Record<string, unknown>) => store.updateMaterial(mat.id, patch as never);
  const usage = store.materialUsage(mat.id);
  const selectionCount = store.selection.filter((id) => !/^(spawn|weapon|joint|part):/.test(id)).length;

  // 透明度滑杆（带实时数值显示）
  const opacityVal = h('span', { class: 'ed-slider-val' }, [mat.opacity.toFixed(2)]);
  const opacitySlider = h('input', {
    class: 'ed-slider',
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    value: String(mat.opacity),
  }) as HTMLInputElement;
  opacitySlider.addEventListener('input', () => {
    const v = Number(opacitySlider.value);
    opacityVal.textContent = v.toFixed(2);
    upd({ opacity: v });
  });

  return h('div', {}, [
    h('div', { class: 'ed-row ed-row-between' }, [
      h('h3', { class: 'ed-h3', style: 'margin:0' }, [`材质 ${mat.id}`]),
      h('div', { class: 'ed-row', style: 'margin:0' }, [
        button('新建副本', () => openNewMaterialModal(mat.id)),
        button('▶ 测试', () => startPlayTest(), 'primary'),
        button(
          '删除',
          () => {
            const r = store.deleteMaterial(mat.id);
            if (!r.ok) {
              store.message = r.reason ?? '删除失败';
              store.touch();
            }
          },
          'danger',
        ),
      ]),
    ]),
    h('p', { class: 'ed-help' }, [
      `被引用：地图物体 ${usage.objects} · 预制件部件 ${usage.prefabParts} · 预制件实例 ${usage.instances}`,
    ]),

    // ---- 外观 ----
    h('h3', { class: 'ed-h3' }, ['外观']),
    field('名称', textInput(mat.name, (v) => upd({ name: v }))),
    h('div', { class: 'ed-row' }, [
      h('span', { class: 'ed-swatch big', style: `background:${mat.colorHex}` }),
      colorInput(mat.colorHex, (v) => upd({ color: v })),
      h('span', { class: 'ed-help', style: 'margin:0' }, ['兜底颜色（无贴图时的填充色）']),
    ]),
    h('div', { class: 'ed-row' }, [
      h('span', { class: 'ed-field-label' }, ['透明度']),
      opacitySlider,
      opacityVal,
    ]),

    // ---- 发光 ----
    h('h3', { class: 'ed-h3' }, ['发光']),
    h('label', { class: 'ed-check' }, [
      checkbox(mat.glow !== null, (v) => {
        upd(
          v
            ? { glow: { color: mat.colorHex, brightness: 1, radius: 18, mode: 'constant' } }
            : { glow: undefined },
        );
      }),
      '启用发光（在物体背后叠加光晕）',
    ]),
    ...(mat.glow
      ? [
          h('div', { class: 'ed-row' }, [
            h('span', { class: 'ed-swatch big', style: `background:${mat.glow.colorHex}` }),
            colorInput(mat.glow.colorHex, (v) => upd({ glow: { ...glowJson(mat), color: v } })),
            h('span', { class: 'ed-help', style: 'margin:0' }, ['光晕颜色']),
          ]),
          h('div', { class: 'ed-grid2' }, [
            field('亮度（0~3）', numberInput(mat.glow.brightness, (v) => upd({ glow: { ...glowJson(mat), brightness: Math.max(0, Math.min(3, v)) } }), 0.1)),
            field('范围（px）', numberInput(mat.glow.radius, (v) => upd({ glow: { ...glowJson(mat), radius: Math.max(1, Math.round(v)) } }), 2)),
          ]),
          field('发光方式', selectInput(
            [
              { value: 'constant', label: '常亮' },
              { value: 'pulse', label: '呼吸（缓慢明暗）' },
              { value: 'flicker', label: '闪烁（不规则闪动）' },
            ],
            mat.glow.mode,
            (v) => upd({ glow: { ...glowJson(mat), mode: v } }),
          )),
          h('p', { class: 'ed-help' }, [
            '发光是叠加混合：亮度越高越亮（>1 会发光过曝），范围是光晕向外扩多远。',
            '呼吸/闪烁是纯表现，各端相位由物体 id 决定 → 联机时两端一致。',
          ]),
        ]
      : []),

    // ---- 爆炸 ----
    h('h3', { class: 'ed-h3' }, ['爆炸（被破坏时）']),
    h('label', { class: 'ed-check' }, [
      checkbox(mat.explosive !== null, (v) => {
        upd(v ? { explosive: { damage: 40, radius: 120 } } : { explosive: undefined });
      }),
      '启用爆炸（被破坏时原地爆炸，无弹片）',
    ]),
    ...(mat.explosive
      ? [
          h('div', { class: 'ed-grid2' }, [
            field('伤害（中心）', numberInput(mat.explosive.damage, (v) => upd({ explosive: { ...explosiveJson(mat), damage: Math.max(0, v) } }), 5)),
            field('范围（px）', numberInput(mat.explosive.radius, (v) => upd({ explosive: { ...explosiveJson(mat), radius: Math.max(1, Math.round(v)) } }), 10)),
          ]),
          field('击退强度', numberInput(mat.explosive.knockback, (v) => upd({ explosive: { ...explosiveJson(mat), knockback: Math.max(0, v) } }), 1)),
          h('p', { class: 'ed-help' }, [
            `伤害按距离线性衰减：中心 ${Math.round(mat.explosive.damage)} → 半径边缘 0（范围 ${Math.round(mat.explosive.radius)}px）。`,
            '爆炸同时会推动周围刚体、并按伤害破坏附近的物体（可燃物连锁爆炸）；不产生弹片。',
          ]),
        ]
      : []),

    // ---- 物理 ----
    h('h3', { class: 'ed-h3' }, ['物理']),
    h('label', { class: 'ed-check' }, [checkbox(mat.fixed, (v) => upd({ fixed: v })), '默认固定（静态，不推不落）']),
    h('p', { class: 'ed-help' }, [
      mat.fixed
        ? '当前：固定 —— 用此材质新建的物体默认钉在原地，不会掉落/被推动（地图物体/预制件部件里仍可单独覆盖）。'
        : '当前：动态 —— 用此材质新建的物体默认会掉落、可被推动/踢飞。',
      '画布始终显示你正在编辑的那张地图（切换 Tab 不会换掉它）。',
    ]),
    h('h3', { class: 'ed-h3' }, ['接触伤害']),
    h('div', { class: 'ed-grid2' }, [
      field('伤害 / 秒（0 = 无）', numberInput(mat.damagePerSecond, (v) => upd({ damagePerSecond: Math.max(0, v) }))),
    ]),
    h('p', { class: 'ed-help' }, [
      mat.damagePerSecond > 0
        ? `火柴人贴着这种材质的物体时，每秒掉 ${mat.damagePerSecond} 点血（岩浆/尖刺/毒液池）。`
        : '0 = 只是普通物体；填了数值就变成"危险物"：贴着它每秒掉这么多血。',
    ]),

    h('h3', { class: 'ed-h3' }, ['测试这个材质']),
    h('p', { class: 'ed-help' }, [
      `先在画布上选中物体（当前选中 ${selectionCount} 个），「▶ 测试」只会把它们换成这个材质。`,
      '没选中时「▶ 测试」= 直接试玩当前地图（不做任何替换）。',
    ]),
    h('div', { class: 'ed-row' }, [
      button('▶ 测试（选中对象）', () => startPlayTest(), 'primary'),
      button('应用到选中对象', () => {
        const r = store.applyMaterialToSelection();
        if (!r.ok) {
          store.message = r.reason ?? '应用失败';
          store.touch();
        }
      }),
      button('样品台测试', () => startPlayTest(true)),
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('密度', numberInput(mat.density, (v) => upd({ density: Math.max(0.0001, v) }), 0.001)),
      field('反弹', numberInput(mat.bounce, (v) => upd({ bounce: clamp01(v) }), 0.01)),
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('动摩擦', numberInput(mat.friction, (v) => upd({ friction: clamp01(v) }), 0.01)),
      field('静摩擦', numberInput(mat.frictionStatic, (v) => upd({ frictionStatic: clamp01(v) }), 0.01)),
    ]),
    h('p', { class: 'ed-help' }, ['密度决定质量：玩家≈ 6.9；80×80 纸箱≈ 6.4；300×16 木板≈ 9.6。']),

    // ---- 破坏 ----
    h('h3', { class: 'ed-h3' }, ['破坏']),
    h('label', { class: 'ed-check' }, [checkbox(mat.destructible, (v) => upd({ destructible: v })), '可被破坏']),
    h('div', { class: 'ed-grid2' }, [
      field('耐受度', numberInput(mat.durability, (v) => upd({ durability: Math.max(0, v) }))),
      field('受伤倍率', numberInput(mat.damageMultiplier, (v) => upd({ damageMultiplier: Math.max(0, v) }), 0.1)),
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('硬度', numberInput(mat.hardness, (v) => upd({ hardness: Math.max(0, v) }), 0.5)),
    ]),
    h('p', { class: 'ed-help' }, ['硬度抵扣伤害：单次伤害 ≤ 硬度则完全打不动；投掷武器也插不进去（会掉在地上）。']),
    h('label', { class: 'ed-check' }, [checkbox(mat.stickable === true, (v) => upd({ stickable: v })), '投掷武器总能钉进去（如地面）']),
    h('p', { class: 'ed-help' }, ['不勾选时按"投掷伤害 > 硬度"判定。']),

    // ---- 子弹 ----
    h('h3', { class: 'ed-h3' }, ['子弹交互']),
    h('label', { class: 'ed-check' }, [checkbox(mat.bulletBounce, (v) => upd({ bulletBounce: v })), '子弹击中会反弹']),
    h('label', { class: 'ed-check' }, [checkbox(mat.bulletPierce, (v) => upd({ bulletPierce: v })), '子弹可穿透']),

    // ---- 贴图（放在最底部）----
    h('h3', { class: 'ed-h3' }, ['贴图']),
    ...textureSection(mat.id, upd),
  ]);
}

/** 材质贴图区（放在表单最底部） */
function textureSection(materialId: string, upd: (patch: Record<string, unknown>) => void): Child[] {
  const store = editorStore;
  const mat = MATERIALS[materialId];
  const previewSrc = materialTextureSrc(materialId);
  const hasOverride = !!mat.texture && store.textureOverrides.has(mat.texture);

  return [
    previewSrc
      ? h('img', {
          class: 'ed-tex-preview',
          src: previewSrc,
          alt: '贴图预览',
          onerror: (e: Event) => {
            (e.target as HTMLImageElement).style.display = 'none';
          },
        })
      : h('div', { class: 'ed-tex-empty' }, ['未设置贴图（使用纯色）']),
    field(
      '路径 / dataURL',
      textInput(mat.texture ?? '', (v) => {
        const next = v.trim();
        upd({ texture: next === '' ? undefined : next });
      }),
    ),
    field(
      '铺图模式',
      selectInput(
        [
          { value: 'tile', label: 'tile 平铺（可无缝重复）' },
          { value: 'stretch', label: 'stretch 拉伸铺满' },
        ],
        mat.textureMode,
        (v) => upd({ textureMode: v }),
      ),
    ),
    h('div', { class: 'ed-row' }, [
      button('选择贴图文件…', () => pickTextureFile(materialId)),
      button('下载贴图', () => downloadMaterialTexture(materialId)),
      button('内嵌 base64', () => embedTexture(materialId)),
      button('清除', () => {
        if (mat.texture) store.setTextureOverride(mat.texture, null);
        upd({ texture: undefined });
      }),
    ]),
    hasOverride
      ? h('p', { class: 'ed-help warn' }, [
          '当前是本地预览：点「下载贴图」把文件放到 public/textures/ 后，游戏里才会显示。',
        ])
      : null,
    h('p', { class: 'ed-help' }, ['贴图目前只作用于矩形物体；圆形/多边形仍用纯色。']),
  ];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 材质贴图的可显示地址（优先本地预览覆盖） */
function materialTextureSrc(materialId: string): string {
  const mat = MATERIALS[materialId];
  if (!mat?.texture) return '';
  return editorStore.textureOverrides.get(mat.texture) ?? textureUrl(mat.texture);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** 选本地图片 → 绑定为 textures/<文件名>，并在编辑器内即时预览 */
function pickTextureFile(materialId: string): void {
  const input = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      if (!dataUrl) return;
      const ref = `textures/${sanitizeFileName(file.name)}`;
      editorStore.setTextureOverride(ref, dataUrl);
      editorStore.updateMaterial(materialId, { texture: ref });
      editorStore.message = `已绑定贴图 ${ref} — 点「下载贴图」把文件放进 public/textures/`;
    };
    reader.readAsDataURL(file);
  });
  input.click();
}

/** 导出贴图文件（供放入 public/textures/） */
function downloadMaterialTexture(materialId: string): void {
  const mat = MATERIALS[materialId];
  if (!mat?.texture) {
    editorStore.message = '该材质还没有贴图';
    editorStore.touch();
    return;
  }
  const src = editorStore.textureOverrides.get(mat.texture) ?? (mat.texture.startsWith('data:') ? mat.texture : null);
  if (!src) {
    editorStore.message = '贴图已是 public 下的文件，无需下载';
    editorStore.touch();
    return;
  }
  const fileName = mat.texture.startsWith('data:') ? `${materialId}.png` : (mat.texture.split('/').pop() ?? `${materialId}.png`);
  const a = h('a', { href: src, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  editorStore.message = `已下载 ${fileName}，放到 public/textures/ 下即可`;
  editorStore.touch();
}

/** 把本地预览的贴图内嵌成 base64（JSON 自包含，方便分享/单文件） */
function embedTexture(materialId: string): void {
  const mat = MATERIALS[materialId];
  if (!mat?.texture) {
    editorStore.message = '该材质还没有贴图';
    editorStore.touch();
    return;
  }
  const override = editorStore.textureOverrides.get(mat.texture);
  if (!override) {
    editorStore.message = '只有「选择贴图文件」选入的图片才能内嵌；已在 public 下的文件无需内嵌';
    editorStore.touch();
    return;
  }
  editorStore.setTextureOverride(mat.texture, null);
  editorStore.updateMaterial(materialId, { texture: override });
  editorStore.message = '已把贴图内嵌为 base64（materials.json 会变大）';
}

/** 新增材质弹窗 */
function openNewMaterialModal(templateId?: string): void {
  const idInput = h('input', { class: 'ed-input' }) as HTMLInputElement;
  idInput.value = templateId ? `${templateId}_copy` : '';
  idInput.placeholder = 'material_id（字母开头）';
  const nameInput = h('input', { class: 'ed-input' }) as HTMLInputElement;
  nameInput.value = templateId && MATERIALS[templateId] ? `${MATERIALS[templateId].name}副本` : '新材质';
  const templateSelect = h('select', { class: 'ed-input' }, [
    h('option', { value: '' }, ['从默认模板开始']),
    ...materialIds().map((id) => h('option', { value: id, selected: id === templateId }, [MATERIALS[id].name])),
  ]) as HTMLSelectElement;
  templateSelect.value = templateId ?? '';
  const errEl = h('div', { class: 'ed-help danger' });

  const overlay = h('div', { class: 'ed-modal-overlay' }, [
    h('div', { class: 'ed-modal narrow' }, [
      h('h3', {}, ['新增材质']),
      field('id', idInput),
      field('名称', nameInput),
      field('模板', templateSelect),
      errEl,
      h('div', { class: 'ed-modal-actions' }, [
        button(
          '创建',
          () => {
            const res = editorStore.addMaterial(idInput.value, nameInput.value, templateSelect.value || undefined);
            if (!res.ok) {
              errEl.textContent = res.reason ?? '创建失败';
              return;
            }
            overlay.remove();
          },
          'primary',
        ),
        button('取消', () => overlay.remove()),
      ]),
    ]),
  ]);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
  idInput.focus();
}

function issuesPanel(title: string, issues: Issue[]): HTMLElement {
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  const head =
    issues.length === 0
      ? h('h3', { class: 'ed-h3 ok' }, [`${title}：通过`])
      : h('h3', { class: `ed-h3 ${errors.length ? 'danger' : 'warn'}` }, [
          `${title}：${errors.length} 错误 / ${warns.length} 警告`,
        ]);
  const list = issues.slice(0, 20).map((i) =>
    h('div', { class: `ed-issue ${i.level}` }, [
      h('span', { class: 'ed-issue-path' }, [i.path]),
      h('span', { class: 'ed-issue-msg' }, [i.message]),
    ]),
  );
  if (issues.length > 20) list.push(h('div', { class: 'ed-issue' }, [`… 还有 ${issues.length - 20} 条`]));
  return h('div', { class: 'ed-issues' }, [head, ...list]);
}

// ---------------- 导入/导出弹窗 ----------------
function openJsonModal(title: string, initial: string, mode: 'import' | 'export'): void {
  const store = editorStore;
  const textarea = h('textarea', { class: 'ed-textarea', spellcheck: 'false' }) as HTMLTextAreaElement;
  textarea.value = initial;
  const messageEl = h('div', { class: 'ed-modal-issues' });

  const overlay = h('div', { class: 'ed-modal-overlay' }, [
    h('div', { class: 'ed-modal' }, [
      h('h3', {}, [title]),
      textarea,
      messageEl,
      h('div', { class: 'ed-modal-actions' }, [
        mode === 'import'
          ? button('应用', () => {
              const result = store.importCurrent(textarea.value);
              messageEl.replaceChildren(
                ...result.issues.slice(0, 10).map((i) =>
                  h('div', { class: `ed-issue ${i.level}` }, [`${i.path}: ${i.message}`]),
                ),
              );
              if (result.ok) {
                close();
              }
            }, 'primary')
          : button('下载文件', () => download(store.exportFileName(), textarea.value), 'primary'),
        mode === 'export'
          ? button('复制', () => {
              void navigator.clipboard.writeText(textarea.value);
            })
          : null,
        button('关闭', () => close()),
      ]),
    ]),
  ]);

  function close(): void {
    overlay.remove();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  textarea.focus();
  if (mode === 'export') textarea.select();
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showIssues(): void {
  const issues = editorStore.validateCurrent();
  const modal = h('div', { class: 'ed-modal-overlay' }, [
    h('div', { class: 'ed-modal' }, [
      h('h3', {}, [`校验结果（${issues.length}）`]),
      h(
        'div',
        { class: 'ed-modal-issues scroll' },
        issues.length === 0
          ? [h('div', { class: 'ed-issue' }, ['没有问题 ✅'])]
          : issues.map((i) => h('div', { class: `ed-issue ${i.level}` }, [`${i.path}: ${i.message}`])),
      ),
      h('div', { class: 'ed-modal-actions' }, [button('关闭', () => modal.remove())]),
    ]),
  ]);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.append(modal);
}

// ---------------- Play test ----------------
function startPlayTest(useMaterialRig = false): void {
  if (!game || testing) return;
  const store = editorStore;
  const errors = store.validateCurrent().filter((i) => i.level === 'error');
  if (errors.length > 0) {
    store.message = `有 ${errors.length} 个错误，先修复再测试（点右上「校验」查看）`;
    store.touch();
    return;
  }
  testing = true;
  document.body.classList.add('testing');
  try {
    // ▶ 测试 运行"当前 Tab 该测的场景"（testScene），与画布显示的内容（canvasMap）无关：
    //   地图 Tab → 当前地图草稿；材质 Tab → 当前地图整体重刷成选中材质；
    //   预制件 Tab → 预制件工作台；材质 Tab + useMaterialRig → 材质样品台
    const scene = store.testScene(useMaterialRig);
    const map = JSON.parse(JSON.stringify(scene.map));
    game.scene.stop('GameScene');
    game.scene.stop('EditorScene');
    game.scene.start('GameScene', {
      map,
      // 用编辑器内的预制件表（含未保存的焊接开关等改动；材质测试时部件材质也一并替换）
      prefabs: JSON.parse(JSON.stringify(scene.prefabs)),
      onExit: () => stopPlayTest(),
    });
    setStatus('测试中：WASD/方向键 移动，W/↑ 跳跃，Esc 返回编辑器');
  } catch (err) {
    // 启动失败（数据异常等）不能把编辑器留在"测试中"状态，否则用户会卡在灰屏
    console.error('[编辑器] 测试启动失败:', err);
    testing = false;
    document.body.classList.remove('testing');
    try {
      game.scene.start('EditorScene');
    } catch (e2) {
      console.error('[编辑器] 恢复编辑器也失败了:', e2);
    }
    store.message = `测试启动失败：${(err as Error).message}`;
    store.touch();
  }
}

function stopPlayTest(): void {
  if (!game || !testing) return;
  testing = false;
  document.body.classList.remove('testing');
  // 两个操作分别容错：GameScene 收尾出错也必须把编辑器恢复回来，
  // 否则画面会停在测试的最后一帧（真实踩过的坑：ImpactDamageSystem.destroy 抛异常把收尾打断）
  try {
    game.scene.stop('GameScene');
  } catch (err) {
    console.error('[编辑器] 关闭测试场景失败:', err);
  }
  try {
    game.scene.start('EditorScene');
  } catch (err) {
    console.error('[编辑器] 返回编辑器失败:', err);
  }
  editorStore.message = '已返回编辑器';
  editorStore.touch();
}

// ---------------- 快捷键 ----------------
function onKeyDown(e: KeyboardEvent): void {
  // 测试运行中：所有快捷键交给游戏场景（Esc 由 GameScene 处理）
  if (testing) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
  const store = editorStore;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    store.redo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    store.duplicateSelected();
    return;
  }
  if (mod && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    store.copySelection();
    return;
  }
  if (mod && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    store.pasteClipboard();
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    download(store.exportFileName(), store.exportCurrent());
    return;
  }
  if (mod) return;

  switch (e.key) {
    case 'Escape':
      collapsedGroup = null;
      setTool('select');
      store.ruler = null;
      return;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      store.deleteSelected();
      return;
    case 'ArrowLeft':
      e.preventDefault();
      store.nudge(e.shiftKey ? -store.gridSize : -1, 0);
      return;
    case 'ArrowRight':
      e.preventDefault();
      store.nudge(e.shiftKey ? store.gridSize : 1, 0);
      return;
    case 'ArrowUp':
      e.preventDefault();
      store.nudge(0, e.shiftKey ? -store.gridSize : -1);
      return;
    case 'ArrowDown':
      e.preventDefault();
      store.nudge(0, e.shiftKey ? store.gridSize : 1);
      return;
    case '0':
      scene()?.fitToMap();
      return;
    case 'g':
    case 'G':
      store.showGrid = !store.showGrid;
      store.touch();
      return;
    default:
      break;
  }

  const toolKey = e.key.toLowerCase();
  const found = TOOLS.find((t) => t.key.toLowerCase() === toolKey);
  if (found) {
    // 快捷键切到几何体/预制件/武器时，二级面板跟着展开
    collapsedGroup = null;
    setTool(found.id);
  }
}

/** 供外部（main）查询是否处于测试模式 */
export function isTesting(): boolean {
  return testing;
}
