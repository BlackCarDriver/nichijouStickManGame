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
import type { Issue } from '../map/MapValidator';
import type { MapObject } from '../map/MapFormat';
import { setStatus, setStatusSink } from './status';
import { textureUrl } from '../map/TextureLoader';
import type { EditorScene } from './EditorScene';
import { actionStore } from './ActionStore';
import type { ActionPose } from './ActionFormat';

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
let actionTimelineRange: HTMLInputElement | null = null;
let actionTimelineLabel: HTMLElement | null = null;

const TOOLS: Array<{ id: ToolKind; label: string; key: string }> = [
  { id: 'select', label: '选择', key: 'V' },
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'circle', label: '圆形', key: 'C' },
  { id: 'polygon', label: '多边形', key: 'P' },
  { id: 'spawn', label: '出生点', key: 'S' },
  { id: 'prefab', label: '放预制件', key: 'F' },
  { id: 'weapon', label: '放武器', key: 'B' },
  { id: 'joint', label: '关节', key: 'J' },
  { id: 'ruler', label: '尺子', key: 'M' },
];

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
  actionStore.subscribe(render);
  actionStore.subscribeTime((timeMs, durationMs) => {
    if (actionTimelineRange) {
      actionTimelineRange.max = String(durationMs);
      actionTimelineRange.value = String(Math.round(timeMs));
    }
    if (actionTimelineLabel) actionTimelineLabel.textContent = `${Math.round(timeMs)} / ${durationMs} ms`;
  });
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

/**
 * 渲染调度：给每个面板算一个"内容签名"，只有签名变了才重建 DOM。
 * 拖动过程中数据在连续变化但 UI 无需每帧重建（松手 commit 时 revision 变化 → 重建一次）。
 */
function render(): void {
  const store = editorStore;
  const issues = store.validateCurrent();
  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.length - errors;

  const hSig = `${store.tab}|${errors}|${warns}|${store.map.name}|${listMaps().length}|${testing}|${actionStore.revision}`;
  if (hSig !== headerSig) {
    headerSig = hSig;
    renderHeader();
  }

  const selection = store.selection.join(',');
  const lSig = `${store.tab}|${store.revision}|${selection}|${store.activePrefabId}|${store.activeMaterialId}|${store.tool}|${store.gridSize}|${store.snapToGrid}|${store.showGrid}|${(store.prefabDraft.parts ?? []).length}|${materialIds().length}|${(store.map.objects ?? []).length}|${(store.map.prefabs ?? []).length}|${actionStore.revision}|${actionStore.activeId}|${actionStore.timeMs}`;
  if (lSig !== leftSig && !isEditingPanel(leftEl)) {
    leftSig = lSig;
    renderLeft();
  }

  const rSig = `${store.tab}|${store.revision}|${selection}|${store.activeMaterialId}|${actionStore.revision}|${actionStore.activeId}|${actionStore.timeMs}|${actionStore.selectedKeyframe}`;
  if (rSig !== rightSig && !isEditingPanel(rightEl)) {
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
      store.tool = 'select';
      store.ruler = null;
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
      (['map', 'prefab', 'material', 'action'] as EditorTab[]).map((tab) =>
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
          [tab === 'map' ? '地图' : tab === 'prefab' ? '预制件' : tab === 'material' ? '材质' : '动作'],
        ),
      ),
    ),
    h('div', { class: 'ed-actions' }, [
      openMapSelect,
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
      button('导入', () => {
        if (store.tab === 'action') {
          store.message = '动作第一版采用导出工作流，暂不支持导入';
          store.touch();
          return;
        }
        openJsonModal('导入（粘贴 JSON）', '', 'import');
      }),
      button('导出', () => openJsonModal(
        store.tab === 'action' ? `导出 ${actionStore.exportFileName()}` : `导出 ${store.exportFileName()}`,
        store.tab === 'action' ? actionStore.exportCurrent() : store.exportCurrent(),
        'export',
      )),
      button('复制', () => {
        void navigator.clipboard.writeText(store.tab === 'action' ? actionStore.exportCurrent() : store.exportCurrent());
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

  if (store.tab === 'action') {
    leftEl.append(actionLeftPanel());
    return;
  }

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
      h('h3', { class: 'ed-h3' }, ['武器投放（点击画布放置）']),
      selectInput(
        listWeaponIds().map((id) => ({ value: id, label: `${getWeapon(id)?.name ?? id} (${id})` })),
        store.activeWeaponId ?? '',
        (v) => {
          store.activeWeaponId = v || null;
          if (v) {
            store.tool = 'weapon';
            store.message = '已选择武器，点击画布投放';
          }
          store.touch();
        },
        '选择武器…',
      ),
      h('h3', { class: 'ed-h3' }, [`对象列表（${(store.map.objects ?? []).length})`]),
      buildObjectList(),
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
      field(
        '物理形态',
        selectInput(
          [
            { value: 'loose', label: '松件 loose（部件各自独立）' },
            { value: 'compound', label: '焊接 compound（整体一个刚体）' },
          ],
          store.prefabDraft.bodyMode ?? 'loose',
          (v) => store.updatePrefabMeta({ bodyMode: v as 'loose' | 'compound' }),
        ),
      ),
      h('p', { class: 'ed-help' }, [
        store.prefabDraft.bodyMode === 'compound'
          ? '焊接：所有部件合并成一个刚体，整体被推/踢飞，整体掉耐久；物理属性取「面积最大部件」的材质。'
          : '松件：每个部件独立刚体，可逐块破坏；动态时整体受力可能散架。',
      ]),
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
      h('p', { class: 'ed-help' }, [
        '画布操作：点部件=选中 · 拖动=移动 · 右下角绿点=改大小 · 上方蓝点=旋转（Shift 吸附 15°）。',
        '拖动/缩放时按住 Shift = 临时取消网格吸附，可做精细调整。',
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
            h('span', { class: 'ed-list-main' }, [MATERIALS[id].name]),
            h('span', { class: 'ed-list-sub' }, [id]),
          ],
        ),
      ),
    ),
    h('div', { class: 'ed-row' }, [button('+ 新增材质', () => openNewMaterialModal())]),
    h('p', { class: 'ed-help' }, ['导出 materials.json 后，把贴图文件放到 public/textures/ 下即可在游戏中使用。']),
  );
}

function actionLeftPanel(): HTMLElement {
  const action = actionStore.current;
  const range = h('input', {
    class: 'ed-slider',
    type: 'range',
    min: '0',
    max: String(action.durationMs),
    step: '1',
    value: String(actionStore.timeMs),
  }) as HTMLInputElement;
  actionTimelineRange = range;
  range.addEventListener('input', () => actionStore.setTime(Number(range.value)));

  const timeLabel = h('span', { class: 'ed-help', style: 'margin:0' }, [`${actionStore.timeMs} / ${action.durationMs} ms`]);
  actionTimelineLabel = timeLabel;

  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, ['动作库']),
    h('div', { class: 'ed-list ed-list-scroll' }, actionStore.actions.map((item) =>
      h('button', { class: `ed-list-row ${item.id === actionStore.activeId ? 'active' : ''}`, onclick: () => actionStore.select(item.id) }, [
        h('span', { class: 'ed-list-main' }, [item.name]),
        h('span', { class: 'ed-list-sub' }, [`${item.weapon === 'spear' ? '长矛' : '无武器'} · ${item.id}`]),
      ]),
    )),
    h('div', { class: 'ed-row' }, [
      button('+ 新动作', () => actionStore.createAction()),
      button('删除动作', () => actionStore.deleteCurrent(), 'danger'),
    ]),
    h('h3', { class: 'ed-h3' }, ['动作属性']),
    field('id', textInput(action.id, (v) => actionStore.updateMeta({ id: v.trim() || action.id }))),
    field('名称', textInput(action.name, (v) => actionStore.updateMeta({ name: v }))),
    field('类型', selectInput(
      [
        { value: 'none', label: '无武器' },
        { value: 'spear', label: '长矛' },
      ],
      action.weapon,
      (v) => actionStore.updateMeta({ weapon: v as 'none' | 'spear' }),
    )),
    field('时长（毫秒）', numberInput(action.durationMs, (v) => actionStore.updateMeta({ durationMs: v }), 10)),
    h('label', { class: 'ed-check' }, [checkbox(action.loop, (v) => actionStore.updateMeta({ loop: v })), '循环播放']),
    h('h3', { class: 'ed-h3' }, ['时间轴']),
    h('div', { class: 'ed-row ed-row-between' }, [
      timeLabel,
      button(actionStore.playing ? '暂停' : '播放', () => actionStore.togglePlaying(), 'primary'),
    ]),
    range,
    h('div', { class: 'ed-row' }, [
      button('添加/更新关键帧', () => actionStore.addOrUpdateKeyframe(), 'primary'),
      button('删除当前帧', () => actionStore.deleteSelectedKeyframe(), 'danger'),
    ]),
    h('div', { class: 'ed-list ed-list-scroll' }, action.keyframes.map((frame, index) =>
      h('button', {
        class: `ed-list-row ${index === actionStore.selectedKeyframe ? 'active' : ''}`,
        onclick: () => actionStore.selectKeyframe(index),
      }, [
        h('span', { class: 'ed-list-main' }, [`关键帧 ${index + 1}`]),
        h('span', { class: 'ed-list-sub' }, [`${frame.timeMs} ms`]),
      ]),
    )),
    h('p', { class: 'ed-help' }, [
      '画布中拖动蓝色关节控制点：手腕/肘部使用手臂 IK，脚部使用腿部 IK，髋部和肩部调整身体重心。',
      '拖动会自动在当前时间创建关键帧；动作数据通过顶部“导出”下载。',
    ]),
  ]);
}

const ACTION_POSE_RANGES: Record<keyof ActionPose, { min: number; max: number; step: number }> = {
  rootX: { min: -100, max: 100, step: 1 },
  rootY: { min: -80, max: 80, step: 1 },
  torsoTilt: { min: -60, max: 60, step: 1 },
  torsoTwist: { min: -60, max: 60, step: 1 },
  headTilt: { min: -60, max: 60, step: 1 },
  headOffsetY: { min: -30, max: 30, step: 1 },
  armFrontShoulder: { min: -180, max: 180, step: 1 },
  armFrontElbow: { min: -120, max: 120, step: 1 },
  armBackShoulder: { min: -180, max: 180, step: 1 },
  armBackElbow: { min: -120, max: 120, step: 1 },
  footLX: { min: -100, max: 100, step: 1 },
  footLY: { min: 0, max: 110, step: 1 },
  footRX: { min: -100, max: 100, step: 1 },
  footRY: { min: 0, max: 110, step: 1 },
  // 膝盖 IK 提示点偏移（px）：默认值约 ±3/±23，给 ±60 的调节范围
  kneeLHintX: { min: -60, max: 60, step: 1 },
  kneeLHintY: { min: -60, max: 60, step: 1 },
  kneeRHintX: { min: -60, max: 60, step: 1 },
  kneeRHintY: { min: -60, max: 60, step: 1 },
};

function actionPoseField(label: string, pose: ActionPose, key: keyof ActionPose): HTMLElement {
  const config = ACTION_POSE_RANGES[key];
  const value = pose[key];
  const slider = h('input', {
    class: 'ed-slider',
    type: 'range',
    min: String(Math.min(config.min, value)),
    max: String(Math.max(config.max, value)),
    step: String(config.step),
    value: String(value),
  }) as HTMLInputElement;
  const valueLabel = h('span', { class: 'ed-slider-val' }, [String(Math.round(value))]);
  slider.addEventListener('input', () => {
    const next = Number(slider.value);
    valueLabel.textContent = String(Math.round(next));
    actionStore.updateCurrentPoseLive({ [key]: next });
  });
  slider.addEventListener('change', () => actionStore.commit());
  return field(label, h('div', { class: 'ed-pose-slider' }, [slider, valueLabel]));
}

function actionRightPanel(): HTMLElement {
  const action = actionStore.current;
  const pose = actionStore.currentPose;
  return h('div', { class: 'ed-action-panel' }, [
    h('h3', { class: 'ed-h3' }, ['当前姿态']),
    h('p', { class: 'ed-help' }, [`${action.name} · ${actionStore.timeMs} ms · 拖动控制点可直接编辑`]),
    h('h3', { class: 'ed-h3' }, ['身体']),
    h('div', { class: 'ed-grid2' }, [
      actionPoseField('髋 X', pose, 'rootX'),
      actionPoseField('髋 Y', pose, 'rootY'),
      actionPoseField('躯干前倾', pose, 'torsoTilt'),
      actionPoseField('躯干扭转', pose, 'torsoTwist'),
      actionPoseField('头部倾角', pose, 'headTilt'),
      actionPoseField('头部偏移', pose, 'headOffsetY'),
    ]),
    h('h3', { class: 'ed-h3' }, ['前臂 / 武器手']),
    h('div', { class: 'ed-grid2' }, [
      actionPoseField('肩角', pose, 'armFrontShoulder'),
      actionPoseField('肘弯', pose, 'armFrontElbow'),
    ]),
    h('h3', { class: 'ed-h3' }, ['后臂 / 支撑手']),
    h('div', { class: 'ed-grid2' }, [
      actionPoseField('肩角', pose, 'armBackShoulder'),
      actionPoseField('肘弯', pose, 'armBackElbow'),
    ]),
    h('h3', { class: 'ed-h3' }, ['脚部目标（相对髋部）']),
    h('div', { class: 'ed-grid2' }, [
      actionPoseField('左脚 X', pose, 'footLX'),
      actionPoseField('左脚 Y', pose, 'footLY'),
      actionPoseField('右脚 X', pose, 'footRX'),
      actionPoseField('右脚 Y', pose, 'footRY'),
    ]),
    h('p', { class: 'ed-help' }, ['数值面板用于微调；骨骼长度固定，腿部会自动通过 IK 求解膝盖位置。']),
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

  if (store.tab === 'action') {
    rightEl.append(actionRightPanel());
    return;
  }

  if (store.tab === 'map') {
    const spawnIndex = store.selectedSpawnIndex();
    const weaponIndex = store.selectedWeaponIndex();
    const jointIndex = store.selectedJointIndex();
    const obj = store.firstSelectedObject();
    const inst = store.firstSelectedInstance();
    if (spawnIndex !== null) rightEl.append(spawnForm(spawnIndex));
    else if (weaponIndex !== null) rightEl.append(weaponSpawnForm(weaponIndex));
    else if (jointIndex !== null) rightEl.append(jointForm(jointIndex));
    else if (obj) rightEl.append(objectForm(obj));
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
          '左侧可载入已有预制件、增删部件；选中部件后可在此精确填写属性。',
          '画布左侧的灰色火柴人 ≈ 111px 高，用来对比预制件实际大小。',
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
    ...(obj.type === 'rect'
      ? [
          h('h3', { class: 'ed-h3' }, ['贴图（仅矩形）']),
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
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`关节 #${index + 1}（${j.type}）`]),
    h('p', { class: 'ed-help' }, [
      `主体 bodyA: ${j.bodyA} · 另一端: ${j.bodyB ?? 'world（固定在世界锚点）'}`,
      ' 画布上可直接拖动粉色锚点；也可在此精确填写。',
    ]),
    h('div', { class: 'ed-grid2' }, [
      field('锚点 x', numberInput(j.anchor.x, (v) => store.updateJoint(index, { anchor: { x: v, y: j.anchor.y } }))),
      field('锚点 y', numberInput(j.anchor.y, (v) => store.updateJoint(index, { anchor: { x: j.anchor.x, y: v } }))),
    ]),
    h('div', { class: 'ed-row' }, [
      button('删除该关节', () => store.removeJoint(index), 'danger'),
    ]),
  ]);
}

/** 武器投放点属性 */
function weaponSpawnForm(index: number): HTMLElement {
  const store = editorStore;
  const w = store.weaponSpawns()[index];
  if (!w) return h('div');
  return h('div', {}, [
    h('h3', { class: 'ed-h3' }, [`武器投放点 #${index + 1}`]),
    h('p', { class: 'ed-help' }, ['开局时该武器直接摆在地上（不走随机空投）。画布上可拖动。']),
    field('武器', selectInput(
      listWeaponIds().map((id) => ({ value: id, label: `${getWeapon(id)?.name ?? id} (${id})` })),
      w.type,
      (v) => store.updateWeaponSpawn(index, { type: v }),
    )),
    h('div', { class: 'ed-grid2' }, [
      field('x', numberInput(w.x, (v) => store.updateWeaponSpawn(index, { x: v }))),
      field('y', numberInput(w.y, (v) => store.updateWeaponSpawn(index, { y: v }))),
    ]),
    h('div', { class: 'ed-row' }, [
      button('删除该投放点', () => store.removeWeaponSpawn(index), 'danger'),
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
  const usage = store.materialUsage(mat.id);

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

    // ---- 物理 ----
    h('h3', { class: 'ed-h3' }, ['物理']),
    h('label', { class: 'ed-check' }, [checkbox(mat.fixed, (v) => upd({ fixed: v })), '默认固定（静态，不推不落）']),
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
  try {
    // Play Test 运行"当前 Tab 对应的场景"：
    //   地图 Tab → 当前地图草稿；预制件 Tab → 预制件工作台；材质 Tab → 材质工作台
    const map = JSON.parse(JSON.stringify(store.renderMap()));
    game.scene.stop('GameScene');
    game.scene.stop('EditorScene');
    game.scene.start('GameScene', {
      map,
      // 用编辑器内的预制件表（含未保存的焊接开关等改动）
      prefabs: JSON.parse(JSON.stringify(store.prefabTable())),
      actions: JSON.parse(JSON.stringify(actionStore.actions)),
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
