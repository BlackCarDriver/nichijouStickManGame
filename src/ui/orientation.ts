/**
 * 移动端竖屏适配：把整个游戏层旋转 90°，让 16:9 的画面吃满屏幕。
 *
 * 为什么这样做：游戏是 1280×720 的横屏游戏。手机竖屏时如果按常规等比缩放，
 * 画面只会占屏幕中间一条（≈高度 1/4），完全没法看。旋转 90° 后，
 * 手机竖屏的"高度"变成游戏宽度，可用面积直接翻 3 倍左右。
 *
 * 实现方式：创建一个 stage 容器，把画布与 DOM 覆盖层一起放进去，
 * 用 CSS transform 旋转它。这样：
 * - 画布与 UI 一起转，不需要两套坐标系；
 * - DOM 按钮的点击命中由浏览器按变换后的几何计算，天然正确；
 * - DOM 里 `position: fixed` 的覆盖层会以变换元素为包含块，跟着一起转。
 *
 * 注意（取舍）：
 * - Phaser 的指针坐标换算不支持"被 CSS 旋转过的画布"，所以旋转态下
 *   鼠标/触摸瞄准不可用。当前移动端只能观战，不影响（Web 端不旋转，瞄准正常）。
 * - 想反过来转（顺时针/逆时针），改 ROTATE_CLOCKWISE 即可。
 */

/** true = 顺时针 90°（手机左侧朝上）；false = 逆时针 90°（手机右侧朝上） */
const ROTATE_CLOCKWISE = true;

let rotatedNow = false;
/** 绑定后的 Phaser 实例（用于在旋转/尺寸变化后重新套用缩放） */
let boundGame: { scale: PhaserScaleLike } | null = null;

/** 只用到 ScaleManager 的这几个成员，避免让本文件依赖 Phaser 类型 */
interface PhaserScaleLike {
  parentSize: { width: number; height: number; setSize(w: number, h: number): void };
  getParentBounds(): boolean;
  refresh(): unknown;
}

/**
 * `?rotate=1` / `?rotate=0` 可强制开/关旋转（桌面预览、自动化测试用）。
 * 不带参数时按"触屏 + 竖屏"自动判断。
 */
function forcedRotation(): boolean | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('rotate');
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

/**
 * 绑定 Phaser 游戏实例。
 *
 * 关键坑：Phaser 的 ScaleManager 用 `parent.getBoundingClientRect()` 取父容器尺寸，
 * 而父容器被 CSS 旋转后，这个矩形是**旋转后的外接矩形**（宽高对调），
 * FIT 会把 16:9 塞进竖屏视口 → 画面又变回中间一条。
 * 所以这里把 `getParentBounds` 替换成"逻辑横屏尺寸"，让 FIT 正常铺满。
 */
export function bindGame(game: { scale: PhaserScaleLike }): void {
  boundGame = game;
  const scale = game.scale;
  const original = scale.getParentBounds.bind(scale);
  scale.getParentBounds = function patched(): boolean {
    if (!rotatedNow) return original();
    const w = window.innerHeight;
    const h = window.innerWidth;
    const ps = scale.parentSize;
    const changed = ps.width !== w || ps.height !== h;
    if (changed) ps.setSize(w, h);
    return changed;
  };
  rescaleToStage();
}

/** 让 Phaser 重新量一次父容器并套用 FIT */
function rescaleToStage(): void {
  if (!boundGame) return;
  boundGame.scale.getParentBounds();
  boundGame.scale.refresh();
}

/** 当前是否处于"旋转铺满"状态（调试 / 自动化测试用） */
export function isStageRotated(): boolean {
  return rotatedNow;
}

/**
 * 创建游戏舞台并接管屏幕：
 * - 竖屏 + 触屏：横向 90° 旋转铺满；
 * - 其它情况：常规全屏。
 *
 * 返回的 stage 就是游戏画布与 DOM 覆盖层的父节点（RoomController 的 root）。
 */
export function createStage(parent: HTMLElement): HTMLElement {
  const stage = document.createElement('div');
  stage.id = 'game-stage';
  parent.append(stage);

  // index.html 里的游戏容器移进舞台（必须在 new Phaser.Game 之前完成）
  const container = document.getElementById('game-container');
  if (container && container.parentElement !== stage) stage.append(container);

  const apply = (): void => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const portrait = vh > vw;
    const forced = forcedRotation();
    const want = forced === null ? isCoarsePointer() && portrait : forced;

    if (!want) {
      rotatedNow = false;
      stage.style.position = 'fixed';
      stage.style.inset = '0';
      stage.style.left = '0';
      stage.style.top = '0';
      stage.style.width = '100%';
      stage.style.height = '100%';
      stage.style.transform = '';
      stage.style.transformOrigin = '';
      rescaleToStage();
      return;
    }

    rotatedNow = true;
    // 逻辑尺寸 = 把视口宽高对调。
    //
    // 必须用 position: fixed：绝对定位（in-flow）的 844px 宽元素会把文档撑宽，
    // 移动端浏览器会因此触发"整页缩小适配"（innerWidth 变成 466 之类），画面又缩回去了。
    // fixed 元素不参与文档流，不产生可滚动溢出，就不会触发缩放。
    stage.style.position = 'fixed';
    stage.style.inset = 'auto';
    stage.style.left = '0';
    stage.style.top = '0';
    stage.style.overflow = 'hidden';
    stage.style.width = `${vh}px`;
    stage.style.height = `${vw}px`;
    stage.style.transformOrigin = '0 0';
    stage.style.transform = ROTATE_CLOCKWISE
      ? `translateX(${vw}px) rotate(90deg)`
      : `translateY(${vh}px) rotate(-90deg)`;
    rescaleToStage();
  };

  apply();
  window.addEventListener('resize', apply);
  // 移动端旋转/地址栏收起时，resize 有时晚一拍 → 再补一次
  window.addEventListener('orientationchange', () => window.setTimeout(apply, 120));
  window.visualViewport?.addEventListener('resize', apply);
  return stage;
}
