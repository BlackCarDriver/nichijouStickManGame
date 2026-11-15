import Phaser from 'phaser';
import type { MapObjectLabel, ObjectLabelAnchor } from './MapFormat';

/**
 * 物体文字（招牌/告示/按键提示）。
 *
 * 实现方式与"几何蒙版/材质光晕"一致：文字是**场景层的独立 Text 对象**，
 * 每帧用物体视觉的**世界变换矩阵**把自己摆到物体的锚点上 ——
 * 这样矩形/圆形/多边形、静态/动态、焊接预制件里的部件都是同一套代码，
 * 也不受"物体视觉是 Image / Container / Graphics"的类型差异影响。
 *
 * 文字永远带描边（自动按字号取），保证压在任意贴图上都读得清。
 */

export interface LabelVisual {
  text: Phaser.GameObjects.Text;
  /** 跟随的视觉对象（世界变换的来源） */
  follow: Phaser.GameObjects.GameObject;
  /** 锚点（视觉对象的局部坐标） */
  local: { x: number; y: number };
}

export interface LocalBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const FONT_FAMILY = '"PingFang SC","Microsoft YaHei",system-ui,sans-serif';
/**
 * 文字的层次**必须跟着它所在的物体走**，不能用一个固定值。
 *
 * 踩过的坑：原来写死 depth = 12，于是 `layer: "decor"`（纯视觉、本该在背景）的招牌
 * 反而画在火柴人上面，把人挡住了。现在由 MapLoader 传入"物体层次 + 0.5"：
 * 压在自己物体之上、但仍然和物体同一层（decor 仍在玩家之下）。
 */
const LABEL_DEPTH_OFFSET = 0.5;

/** 九宫格锚点 → （局部坐标 + 原点） */
function anchorOf(
  b: LocalBounds,
  anchor: ObjectLabelAnchor | undefined,
): { local: { x: number; y: number }; origin: { x: number; y: number } } {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  switch (anchor) {
    case 'top':
      return { local: { x: cx, y: b.minY }, origin: { x: 0.5, y: 1 } };
    case 'bottom':
      return { local: { x: cx, y: b.maxY }, origin: { x: 0.5, y: 0 } };
    case 'left':
      return { local: { x: b.minX, y: cy }, origin: { x: 1, y: 0.5 } };
    case 'right':
      return { local: { x: b.maxX, y: cy }, origin: { x: 0, y: 0.5 } };
    case 'topLeft':
      return { local: { x: b.minX, y: b.minY }, origin: { x: 0, y: 1 } };
    case 'topRight':
      return { local: { x: b.maxX, y: b.minY }, origin: { x: 1, y: 1 } };
    case 'bottomLeft':
      return { local: { x: b.minX, y: b.maxY }, origin: { x: 0, y: 0 } };
    case 'bottomRight':
      return { local: { x: b.maxX, y: b.maxY }, origin: { x: 1, y: 0 } };
    case 'center':
    default:
      return { local: { x: cx, y: cy }, origin: { x: 0.5, y: 0.5 } };
  }
}

/**
 * 创建一个物体的文字对象（不填/空文案 → null）。
 *
 * @param bounds 物体在**视觉对象局部坐标**下的包围盒
 * @param follow 要跟随的视觉对象
 */
export function createObjectLabel(
  scene: Phaser.Scene,
  label: MapObjectLabel | undefined,
  bounds: LocalBounds,
  follow: Phaser.GameObjects.GameObject,
  /** 所属物体的层次（文字的 depth = 它 + 0.5） */
  objectDepth = 0,
): LabelVisual | null {
  const text = (label?.text ?? '').trim();
  if (!text) return null;

  const size = Math.max(6, Math.min(400, label?.size ?? 20));
  const color = /^#?[0-9a-fA-F]{6}$/.test(label?.color ?? '') ? (label!.color as string) : '#ffffff';
  const { local, origin } = anchorOf(bounds, label?.anchor);

  const go = scene.add
    .text(0, 0, text, {
      fontFamily: FONT_FAMILY,
      fontSize: `${Math.round(size)}px`,
      color,
      align: 'center',
      // 描边：任意贴图/材质上都读得清（按字号取，太粗会糊）
      stroke: '#000000',
      strokeThickness: Math.max(1, Math.round(size * 0.16)),
    })
    .setDepth(objectDepth + LABEL_DEPTH_OFFSET)
    .setOrigin(origin.x, origin.y)
    .setResolution(2);

  return { text: go, follow, local };
}

/** 每帧把文字摆到物体锚点上（位置/旋转/缩放都跟物体的世界变换走） */
export function updateObjectLabels(items: Array<{ labels?: LabelVisual[] }>): void {
  for (const item of items) {
    const labels = item.labels;
    if (!labels || labels.length === 0) continue;
    for (const lv of labels) {
      if (!lv.text.scene) continue;
      const v = lv.follow as unknown as {
        getWorldTransformMatrix?: () => Phaser.GameObjects.Components.TransformMatrix;
      };
      if (!v.getWorldTransformMatrix) continue;
      const m = v.getWorldTransformMatrix();
      const p = m.transformPoint(lv.local.x, lv.local.y);
      lv.text.setPosition(p.x, p.y);
      lv.text.setRotation(Math.atan2(m.b, m.a));
      const scale = Math.hypot(m.a, m.b) || 1;
      lv.text.setScale(scale);
    }
  }
}

/** 销毁文字对象 */
export function destroyObjectLabels(labels: LabelVisual[] | undefined): void {
  if (!labels) return;
  for (const lv of labels) {
    if (lv.text.scene) lv.text.destroy();
  }
  labels.length = 0;
}
