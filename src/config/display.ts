/**
 * 显示与像素密度配置。
 *
 * 背景：游戏设计分辨率是 1280×720，但画布会被 iframe 拉伸到全屏（尤其是 Retina /
 * 手机 2~3 倍屏），把 1280×720 的位图放大后就会发虚（火柴人线条、头像、文字都糊）。
 *
 * 做法：按设备像素比把**内部渲染分辨率**放大（默认最多 2 倍），
 * 同时把相机 zoom 与屏幕空间 UI 同比放大，保证"看到的世界范围/UI 物理尺寸"不变，
 * 只是每一帧用更多像素来画，从而变清晰。
 *
 * 可用 `?pixel=1` / `?pixel=2` 手动覆盖（低端设备或调试性能时可固定）。
 */
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
const pixelParam = params?.get('pixel') ?? null;

function resolveRenderScale(): number {
  const override = Number(pixelParam ?? '');
  if (pixelParam !== null && pixelParam !== '' && Number.isFinite(override) && override >= 1 && override <= 3) {
    return Math.round(override);
  }
  const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  // 触屏设备（手机/平板）GPU 通常更弱：上限 1.5 倍；桌面最多 2 倍
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
  const cap = coarse ? 1.5 : 2;
  return Math.min(cap, Math.max(1, Math.round(dpr)));
}

/** 内部渲染倍数（1 = 1280×720，2 = 2560×1440）。可在运行时降级，见 getRenderScale/setRenderScale */
let renderScale = resolveRenderScale();

/** 是否存在显式覆盖（?pixel=N）。显式指定时不再自动降级 */
export const RENDER_SCALE_EXPLICIT =
  pixelParam !== null && pixelParam !== '' && Number.isFinite(Number(pixelParam));

export function getRenderScale(): number {
  return renderScale;
}

export function setRenderScale(next: number): void {
  // 允许 1 / 1.5 / 2 / 3 档，便于"分级降级"
  renderScale = Math.max(1, Math.min(3, Math.round(next * 2) / 2));
}

/** 启动时的倍数（用于游戏初始化与文本纹理分辨率，之后保持不变） */
export const RENDER_SCALE = renderScale;

/** 设计分辨率（世界坐标与 UI 常量都按这个尺寸写） */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

/**
 * "画布像素 ÷ 设计像素"比例 —— 相机 zoom 与屏幕空间 UI（HUD/箭头/播报）都按它推导。
 *
 * 正式游戏画布 = DESIGN × RENDER_SCALE，所以它恰好等于 RENDER_SCALE，行为不变；
 * 编辑器用 Phaser.Scale.RESIZE（画布跟着窗口/面板走），它就是"实际画布宽 ÷ 1280"。
 * 这样两边看到的世界范围一致（视野宽 = DESIGN_WIDTH ÷ 镜头设计缩放），
 * 编辑器里点「测试」不会再出现镜头贴脸（原来 zoom 乘的是 RENDER_SCALE，比画布比例大）。
 */
export function viewScaleOf(cameraWidth?: number): number {
  if (cameraWidth && Number.isFinite(cameraWidth) && cameraWidth > 0) {
    return cameraWidth / DESIGN_WIDTH;
  }
  return getRenderScale();
}

/** Phaser 文本纹理的分辨率倍数（让世界/屏幕文字不虚；取整即可） */
export const TEXT_RESOLUTION = Math.max(1, Math.ceil(RENDER_SCALE));
