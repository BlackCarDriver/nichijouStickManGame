import Phaser from 'phaser';
import { hasMaterialTexture, matTextureKey } from './TextureLoader';

/**
 * 圆形 / 多边形的贴图视觉。
 *
 * 矩形可以直接用 Image/TileSprite（形状本来就方正），但圆和多边形需要把贴图
 * **裁剪成对应形状**，所以这里用「贴图对象 + 几何蒙版（GeometryMask）」：
 * - 贴图对象：stretch → Image（拉伸铺满包围盒）；tile → TileSprite（平铺）
 * - 蒙版：一个不进显示列表的 Graphics，画上圆形/多边形，作为 alpha 裁剪
 *
 * 蒙版是**世界坐标**的独立对象（不是贴图对象的子节点），所以物体移动/旋转后必须同步，
 * 见 `syncVisualMasks()`：用贴图对象的**世界变换矩阵**把蒙版摆到同一位置/角度/缩放，
 * 这样无论对象是独立体还是焊接预制件里的子部件都能贴住。
 */

export interface MaskedTexture {
  go: Phaser.GameObjects.GameObject;
  mask: Phaser.GameObjects.Graphics;
}

/** 贴图引用是否可用（不可用时调用方回退到纯色） */
function textureKey(ref: string | undefined, scene: Phaser.Scene): string | null {
  if (!ref || !hasMaterialTexture(scene, ref)) return null;
  return matTextureKey(ref);
}

/** 建一个不进显示列表的蒙版 Graphics */
function makeMaskGraphics(scene: Phaser.Scene): Phaser.GameObjects.Graphics {
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0xffffff, 1);
  return g;
}

/** 贴图对象销毁时顺手销毁蒙版（否则会一直留在显示列表外占内存） */
function bindMaskLifetime(go: Phaser.GameObjects.GameObject, mask: Phaser.GameObjects.Graphics): void {
  go.once(Phaser.GameObjects.Events.DESTROY, () => {
    if (mask.scene) mask.destroy();
  });
  (go as unknown as { setMask: (m: Phaser.Display.Masks.GeometryMask) => void }).setMask(
    mask.createGeometryMask(),
  );
}

/**
 * 圆形贴图视觉（蒙版裁成圆）。
 * @param cx/cy 圆心（世界坐标；作为子对象时传局部坐标）
 */
export function createCircleTexture(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  radius: number,
  textureRef: string | undefined,
  mode: 'tile' | 'stretch',
): MaskedTexture | null {
  const key = textureKey(textureRef, scene);
  if (!key) return null;
  const size = radius * 2;
  const go =
    mode === 'stretch'
      ? scene.add.image(cx, cy, key).setDisplaySize(size, size)
      : scene.add.tileSprite(cx, cy, size, size, key);

  const mask = makeMaskGraphics(scene);
  mask.fillCircle(0, 0, radius);
  bindMaskLifetime(go, mask);
  // 蒙版初始位置 = 圆心的世界坐标（后续由 syncVisualMasks 跟随）
  mask.setPosition(cx, cy);
  return { go, mask };
}

/**
 * 多边形贴图视觉（蒙版裁成多边形）。
 *
 * @param pts 相对包围盒中心的多边形顶点（与物理体视觉一致的那套坐标）
 * @returns container（已按 pts 的包围盒居中摆放贴图）+ 蒙版
 */
export function createPolygonTexture(
  scene: Phaser.Scene,
  pts: Array<{ x: number; y: number }>,
  textureRef: string | undefined,
  mode: 'tile' | 'stretch',
): MaskedTexture | null {
  const key = textureKey(textureRef, scene);
  if (!key || pts.length < 3) return null;

  const key2 = key;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const bxc = (minX + maxX) / 2;
  const byc = (minY + maxY) / 2;

  const container = scene.add.container(0, 0);
  const tex =
    mode === 'stretch'
      ? scene.add.image(bxc, byc, key2).setDisplaySize(w, h)
      : scene.add.tileSprite(bxc, byc, w, h, key2);
  container.add(tex);

  const mask = makeMaskGraphics(scene);
  // 顶点本身就是"相对物体中心"的坐标 → 直接以蒙版原点为基准画，
  // 位置/旋转交给 syncVisualMasks 跟随容器（与容器坐标系完全一致）
  mask.fillPoints(pts.map((p) => new Phaser.Geom.Point(p.x, p.y)), true);
  bindMaskLifetime(container, mask);
  return { go: container, mask };
}

/**
 * 同步所有蒙版的位置/旋转/缩放，让它们贴着各自的贴图对象（物体移动、旋转、焊接体偏移都靠它）。
 *
 * 只在有蒙版的对象上跑（数量很少），每帧调用开销可忽略。
 */
/** 一个"贴图 + 蒙版"配对（焊接体可能有多个部件，所以是数组） */
export interface MaskPair {
  go: Phaser.GameObjects.GameObject;
  mask: Phaser.GameObjects.Graphics;
}

export function syncVisualMasks(items: Array<{ maskPairs?: MaskPair[] }>): void {
  for (const item of items) {
    const pairs = item.maskPairs;
    if (!pairs || pairs.length === 0) continue;
    for (const { go, mask } of pairs) {
      if (!mask.scene) continue;
      const visual = go as unknown as {
        getWorldTransformMatrix?: () => { a: number; b: number; tx: number; ty: number };
      };
      if (!visual.getWorldTransformMatrix) continue;
      const m = visual.getWorldTransformMatrix();
      const scale = Math.hypot(m.a, m.b) || 1;
      mask.setPosition(m.tx, m.ty);
      mask.setRotation(Math.atan2(m.b, m.a));
      mask.setScale(scale);
    }
  }
}
