/**
 * 材质贴图加载。
 *
 * 贴图引用（MaterialConfig.texture）支持三种写法：
 * 1. public 下的相对路径：`textures/wood.png` → 运行时 `<BASE_URL>textures/wood.png`
 * 2. 站点根/绝对 URL：`/textures/wood.png`、`https://...`（根路径也走 BASE_URL，兼容子路径部署）
 * 3. data: 内联图像（编辑器"内嵌到 JSON"时使用，自包含但会撑大 JSON）
 *
 * BASE_URL：vite 开发态为 `/`，打包为 `./`（子路径部署如 `/stickmanGame/` 时不写死站点根）。
 *
 * 纹理以 `mattex:<path>` 为 key 存在全局 TextureManager 里（跨场景共享）。
 */
import Phaser from 'phaser';

let inlineSeq = 0;
const inlineKeys = new Map<string, string>();
/** 加载失败的引用（避免 404 时无限重试） */
const failed = new Set<string>();

/** 贴图引用 → Phaser 纹理 key */
export function matTextureKey(ref: string): string {
  if (ref.startsWith('data:')) {
    let key = inlineKeys.get(ref);
    if (!key) {
      key = `mattex-inline:${inlineSeq++}`;
      inlineKeys.set(ref, key);
    }
    return key;
  }
  return `mattex:${ref}`;
}

/** 贴图引用 → 可加载的 URL（按构建 BASE_URL 解析，兼容根路径与子路径部署） */
export function textureUrl(ref: string): string {
  if (/^(data:|blob:|https?:\/\/)/.test(ref)) return ref;
  return `${import.meta.env.BASE_URL}${ref.replace(/^\/+/, '')}`;
}

/** 该引用是否已加载就绪 */
export function hasMaterialTexture(scene: Phaser.Scene, ref?: string): boolean {
  return !!ref && scene.textures.exists(matTextureKey(ref));
}

/** 是否加载失败过（404 / 解码失败） */
export function isTextureFailed(ref: string): boolean {
  return failed.has(matTextureKey(ref));
}

/** 清除失败记录（材质被修改后调用，允许重试） */
export function forgetTextureFailures(): void {
  failed.clear();
}

const guarded = new WeakSet<Phaser.Scene>();

function guardErrors(scene: Phaser.Scene): void {
  if (guarded.has(scene)) return;
  guarded.add(scene);
  scene.load.on('loaderror', (file: Phaser.Loader.File) => {
    failed.add(file.key);
    console.warn(`[TextureLoader] 贴图加载失败: ${file.key}（将回退为纯色）`);
  });
}

/** preload 阶段排队加载（Phaser 会在 preload 结束时统一启动） */
export function preloadMaterialTextures(scene: Phaser.Scene, refs: Array<string | undefined>): void {
  guardErrors(scene);
  for (const ref of refs) {
    if (!ref) continue;
    const key = matTextureKey(ref);
    if (scene.textures.exists(key) || failed.has(key)) continue;
    scene.load.image(key, textureUrl(ref));
  }
}

/**
 * 运行时按需加载（编辑器新增/更换贴图后调用）。
 * @param entries ref = 贴图引用；override = 临时覆盖的 URL（编辑器里用 data: 预览未落盘的文件）
 * @param onLoaded 全部加载完成后回调（通常触发一次重建）
 */
export function ensureMaterialTextures(
  scene: Phaser.Scene,
  entries: Array<{ ref?: string; override?: string }>,
  onLoaded: () => void,
): void {
  guardErrors(scene);
  let queued = 0;
  for (const e of entries) {
    if (!e.ref) continue;
    const key = matTextureKey(e.ref);
    if (scene.textures.exists(key) || failed.has(key)) continue;
    scene.load.image(key, e.override || textureUrl(e.ref));
    queued++;
  }
  if (queued === 0) return;
  scene.load.once('complete', onLoaded);
  scene.load.start();
}
