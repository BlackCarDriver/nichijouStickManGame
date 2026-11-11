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
import type { Issue } from '../map/MapValidator';
import type { MapObject } from '../map/MapFormat';
import { setStatus, setStatusSink } from './status';
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
): HTMLSelectElement {
  const select = h(
    'select',
    { class: 'ed-input' },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, [o.label])),
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
let canvasHostEl!: HTMLElement;
let toastEl!: HTMLElement;

const TOOLS: Array<{ id: ToolKind; label: string; key: string }> = [
  { id: 'select', label: '选择', key: 'V' },
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'circle', label: '圆形', key: 'C' },
  { id: 'polygon', label: '多边形', key: 'P' },
  { id: 'spawn', label: '出生点', key: 'S' },
  { id: 'prefab', label: '放预制件', key: 'F' },
  { id: 'joint', label: '关节', key: 'J' },
  { id: 'ruler', label: '尺子', key: 'M' },
];

export function createShell(): void {
  document.body.innerHTML = '';
  headerEl = h('header', { class: 'ed-header' });
  leftEl = h('aside', { class: 'ed-left' });
  rightEl = h('aside', { class: 'ed-right' });
  statusTextEl = h('span', { class: 'ed-status-text' });
  toastEl = h('div', { class: 'ed-toast' });
  canvasHostEl = h('div', { class: 'ed-canvas', id: 'canvas-host' }, [
    h('div', { class: 'ed-testing-hint' }, ['测试运行中 — 按 Esc 返回编辑器']),
    toastEl,
  ]);

  const root = h('div', { id: 'editor-root' }, [
    headerEl,
    h('div', { class: 'ed-body' }, [leftEl, canvasHostEl, rightEl]),
    h('footer', { class: 'ed-status' }, [
      statusTextEl,
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
  render();
}

function scene(): EditorScene | null {
  return (game?.scene.getScene('EditorScene') as EditorScene | undefined) ?? null;
}

function render(): void {
  renderHeader();
  if (!isEditingPanel(leftEl)) renderLeft();
  if (!isEditingPanel(rightEl)) renderRight();
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
      h('select', {
        class: 'ed-input ed-openmap',
        onchange: (e: Event) => {
          const name = (e.target as HTMLSelectElement).value;
          const map = listMaps().find((m) => m.name === name);
          if (!map) return;
          store.map = JSON.parse(JSON.stringify(map));
          store.selection = [];
          store.ensureIds();
          store.message = `已打开地图 ${name}`;
          store.commit();
        },
      }, [
        h('option', { value: '' }, ['打开已有地图…']),
        ...listMaps().map((m) => h('option', { value: m.name }, [m.name])),
      ]),
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

function renderStatus(): void {
  const store = editorStore;
  const objCount = (store.map.objects ?? []).length + (store.map.prefabs ?? []).length;
  const toolLabel = TOOLS.find((t) => t.id === store.tool)?.label ?? store.tool;
  const parts = [
    `工具：${toolLabel}`,
    `网格：${store.gridSize}px${store.snapToGrid ? '（吸附）' : ''}`,
    `对象：${objCount}`,
    `选中：${store.selection.length}`,
  ];
  if (store.tool === 'joint') parts.push(store.jointHint());
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
    leftEl.append(
      h('h3', { class: 'ed-h3' }, ['工具']),
      h(
        'div',
        { class: 'ed-tools' },
        TOOLS.map((t) =>
          h(
            'button',
            {
              class: `ed-tool ${store.tool === t.id ? 'active' : ''}`,
              onclick: () => {
                store.tool = t.id;
                store.pendingJointBodyA = null;
                store.touch();
              },
            },
            [`${t.label}`, h('span', { class: 'ed-key' }, [t.key])],
          ),
        ),
      ),
      h('div', { class: 'ed-row' }, [
        field('网格', numberInput(store.gridSize, (v) => { store.gridSize = Math.max(2, v); store.commit(); }, 2)),
        h('label', { class: 'ed-check' }, [checkbox(store.snapToGrid, (v) => { store.snapToGrid = v; store.touch(); }), '吸附']),
        h('label', { class: 'ed-check' }, [checkbox(store.showGrid, (v) => { store.showGrid = v; store.touch(); }), '显示网格']),
      ]),
      h('h3', { class: 'ed-h3' }, ['新物体材质']),
      selectInput(
        materialIds().map((id) => ({ value: id, label: `${MATERIALS[id].name} (${id})` })),
        store.activeMaterialId,
        (v) => {
          store.activeMaterialId = v;
          store.touch();
        },
      ),
      h('h3', { class: 'ed-h3' }, ['预制件库']),
      h(
        'div',
        { class: 'ed-list' },
        listPrefabs().map((p) =>
          h(
            'button',
            {
              class: `ed-list-row ${store.activePrefabId === p.id ? 'active' : ''}`,
              onclick: () => {
                store.activePrefabId = p.id;
                store.tool = 'prefab';
                store.message = `已选择预制件 ${p.name}，点击画布放置`;
                store.touch();
              },
            },
            [h('span', { class: 'ed-list-main' }, [p.name]), h('span', { class: 'ed-list-sub' }, [p.id])],
          ),
        ),
      ),
      h('h3', { class: 'ed-h3' }, [`对象列表（${(store.map.objects ?? []).length}）`]),
      h(
        'div',
        { class: 'ed-list ed-list-scroll' },
        [...(store.map.objects ?? [])].reverse().map((o) =>
          h(
            'button',
            {
              class: `ed-list-row ${store.selection.includes(o.id ?? '') ? 'active' : ''}`,
              onclick: () => store.select(o.id ? [o.id] : []),
            },
            [
              h('span', { class: 'ed-list-main' }, [`${o.type} · ${o.material}`]),
              h('span', { class: 'ed-list-sub' }, [o.id ?? '(无 id)']),
            ],
          ),
        ),
      ),
    );
    return;
  }

  if (store.tab === 'prefab') {
    leftEl.append(
      h('h3', { class: 'ed-h3' }, ['预制件']),
      h(
        'div',
        { class: 'ed-list' },
        listPrefabs().map((p) =>
          h('button', { class: 'ed-list-row', onclick: () => store.loadPrefab(p.id) }, [
            h('span', { class: 'ed-list-main' }, [p.name]),
            h('span', { class: 'ed-list-sub' }, [p.id]),
          ]),
        ),
      ),
      h('div', { class: 'ed-row' }, [button('新建预制件', () => store.newPrefab())]),
      h('h3', { class: 'ed-h3' }, ['元信息']),
      field('id（= 文件名）', textInput(store.prefabDraft.id, (v) => store.updatePrefabMeta({ id: v.trim() || 'new_prefab' }))),
      field('名称', textInput(store.prefabDraft.name, (v) => store.updatePrefabMeta({ name: v }))),
      h('h3', { class: 'ed-h3' }, [`部件（${store.prefabDraft.parts.length}）`]),
      h(
        'div',
        { class: 'ed-list ed-list-scroll' },
        store.prefabDraft.parts.map((p, i) =>
          h(
            'button',
            {
              class: `ed-list-row ${store.selection.includes(`part:${i}`) ? 'active' : ''}`,
              onclick: () => store.select([`part:${i}`]),
            },
            [
              h('span', { class: 'ed-list-main' }, [`#${i} ${p.type} · ${p.material}`]),
              h('button', {
                class: 'ed-mini-danger',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  store.removePart(i);
                },
              }, ['删']),
            ],
          ),
        ),
      ),
      h('div', { class: 'ed-row' }, [
        button('+ 矩形', () => store.addPart({ type: 'rect', x: -40, y: 0, w: 80, h: 40, material: store.activeMaterialId })),
        button('+ 圆形', () => store.addPart({ type: 'circle', x: 0, y: 0, radius: 30, material: store.activeMaterialId })),
        button('+ 多边形', () => store.addPart({ type: 'polygon', x: 0, y: 0, sides: 3, radius: 40, material: store.activeMaterialId })),
      ]),
    );
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
            h('span', { class: 'ed-swatch', style: `background:${MATERIALS[id].colorHex}` }),
            h('span', { class: 'ed-list-main' }, [MATERIALS[id].name]),
            h('span', { class: 'ed-list-sub' }, [id]),
          ],
        ),
      ),
    ),
  );
}

// ---------------- 右侧面板 ----------------
function renderRight(): void {
  const store = editorStore;
  rightEl.replaceChildren();

  if (store.tab === 'map') {
    const obj = store.firstSelectedObject();
    const inst = store.firstSelectedInstance();
    if (obj) rightEl.append(objectForm(obj));
    else if (inst) rightEl.append(instanceForm());
    else rightEl.append(mapForm());
    rightEl.append(issuesPanel('校验', store.validateCurrent()));
    return;
  }

  if (store.tab === 'prefab') {
    const sel = store.selection[0];
    if (sel?.startsWith('part:')) {
      const index = Number(sel.slice(5));
      rightEl.append(partForm(index));
    } else {
      rightEl.append(
        h('h3', { class: 'ed-h3' }, ['预制件说明']),
        h('p', { class: 'ed-help' }, [
          '部件坐标是相对预制件中心的局部坐标。放置到地图时由锚点（中心）定位。',
          '左侧可载入已有预制件、增删部件；选中部件的属性在此编辑。',
        ]),
      );
    }
    rightEl.append(issuesPanel('预制件校验', store.validateCurrent()));
    return;
  }

  rightEl.append(materialForm(), issuesPanel('材质校验', store.validateCurrent()));
}

function objectForm(obj: MapObject): HTMLElement {
  const store = editorStore;
  const multi = store.selection.length > 1;
  const patch = (p: Record<string, unknown>) => store.patchSelected(p);

  const fixedValue = obj.fixed === undefined ? 'default' : obj.fixed ? 'true' : 'false';
  const layer = obj.layer ?? 'solid';

  const rows: Child[] = [
    h('h3', { class: 'ed-h3' }, [`选中 ${multi ? `(${store.selection.length} 个)` : obj.type}`]),
    h('p', { class: 'ed-help' }, [`id: ${obj.id ?? '(无)'}`]),
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
      rows.push(
        h('p', { class: 'ed-help' }, [`自定义顶点（${obj.vertices?.length ?? 0} 个）— 请直接编辑 JSON`]),
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
    h('div', { class: 'ed-row' }, [
      button('复制', () => store.duplicateSelected()),
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
    h('p', { class: 'ed-help' }, [`id: ${inst.id} · ref: ${inst.ref}`]),
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
      button('复制', () => store.duplicateSelected()),
      button('删除', () => store.deleteSelected(), 'danger'),
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
    h('p', { class: 'ed-help' }, ['预留字段（M4 武器掉落使用），可在 JSON 中编辑 x/y/w/h。']),
    h('div', { class: 'ed-row' }, [button('重置为默认地图', () => store.resetToDefault(), 'danger')]),
  ]);
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
    rows.push(
      h('div', { class: 'ed-grid2' }, [
        field('边数', numberInput(part.sides ?? 3, (v) => store.updatePart(index, { sides: Math.max(3, Math.round(v)) }))),
        field('半径', numberInput(part.radius ?? 40, (v) => store.updatePart(index, { radius: Math.max(2, v) }))),
      ]),
    );
  }
  rows.push(
    field('旋转角（度）', numberInput(part.angle ?? 0, (v) => store.updatePart(index, { angle: v }))),
    h('div', { class: 'ed-row' }, [button('删除部件', () => store.removePart(index), 'danger')]),
  );
  return h('div', {}, rows);
}

function materialForm(): HTMLElement {
  const store = editorStore;
  const mat = MATERIALS[store.activeMaterialId];
  if (!mat) return h('div', {}, ['未选择材质']);
  const upd = (patch: Record<string, unknown>) => store.updateMaterial(mat.id, patch as never);
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`材质 ${mat.id}`]),
    h('div', { class: 'ed-row' }, [
      h('span', { class: 'ed-swatch big', style: `background:${mat.colorHex}` }),
      colorInput(mat.colorHex, (v) => upd({ colorHex: v, color: parseInt(v.slice(1), 16) })),
    ]),
    field('名称', textInput(mat.name, (v) => upd({ name: v }))),
    h('div', { class: 'ed-grid2' }, [
      field('耐受度', numberInput(mat.durability, (v) => upd({ durability: Math.max(0, v) }))),
      field('反弹', numberInput(mat.bounce, (v) => upd({ bounce: v }), 0.01)),
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('密度', numberInput(mat.density, (v) => upd({ density: Math.max(0.0001, v) }), 0.001)),
      field('动摩擦', numberInput(mat.friction, (v) => upd({ friction: v }), 0.01)),
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('静摩擦', numberInput(mat.frictionStatic, (v) => upd({ frictionStatic: v }), 0.01)),
      h('div', {}, []),
    ]),
    h('label', { class: 'ed-check' }, [checkbox(mat.destructible, (v) => upd({ destructible: v })), '可破坏']),
    h('label', { class: 'ed-check' }, [checkbox(mat.fixed, (v) => upd({ fixed: v })), '默认固定']),
    h('p', { class: 'ed-help' }, [
      '密度决定质量：玩家约 6.9。箱子约 6、木板约 10 时才推得动/压得动。',
    ]),
    h('div', { class: 'ed-row' }, [button('▶ 用此材质测试', () => startPlayTest(), 'primary')]),
  ]);
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
function startPlayTest(): void {
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
  const map = JSON.parse(JSON.stringify(store.renderMap()));
  game.scene.stop('EditorScene');
  game.scene.start('GameScene', {
    map,
    onExit: () => stopPlayTest(),
  });
  setStatus('测试中：WASD/方向键 移动，W/↑ 跳跃，Esc 返回编辑器');
}

function stopPlayTest(): void {
  if (!game || !testing) return;
  testing = false;
  document.body.classList.remove('testing');
  game.scene.stop('GameScene');
  game.scene.start('EditorScene');
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
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    download(store.exportFileName(), store.exportCurrent());
    return;
  }
  if (mod) return;

  switch (e.key) {
    case 'Escape':
      store.tool = 'select';
      store.ruler = null;
      store.pendingJointBodyA = null;
      store.touch();
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
    store.tool = found.id;
    store.pendingJointBodyA = null;
    store.touch();
  }
}

/** 供外部（main）查询是否处于测试模式 */
export function isTesting(): boolean {
  return testing;
}
