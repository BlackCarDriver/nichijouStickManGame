import Phaser from 'phaser';
import type { MaterialGlow, GlowMode } from '../config/materials';
import type { MapObjectRuntime } from './MapLoader';

/**
 * 材质发光（光晕）渲染。
 *
 * 做法：给每个"发光材质"的物体在其**背后**画一圈叠加（ADD 混合）的放大的形状，
 * 由内到外逐层降低不透明度 → 形成柔和的外发光。相比后处理 bloom，这种做法：
 * - 不需要额外 framebuffer / 自定义 shader，Canvas 渲染器也能跑；
 * - 光晕颜色/亮度/范围直接由材质数据驱动，编辑器里改完立刻能看到；
 * - 支持任意形状（矩形 / 圆形 / 多边形）。
 *
 * 发光方式（`mode`）：
 * - `constant` 常亮
 * - `pulse`    呼吸（缓慢明暗）
 * - `flicker`  闪烁（快速不规则，用固定相位错开、无随机数 → 各端一致）
 *
 * 光晕对象用负 depth（-10）放在所有地图物体之下、网格之上；
 * 复合体（焊接预制件）的部件光晕作为 Container 子对象，跟部件一起动。
 */

export type GlowShape =
  | { kind: 'rect'; w: number; h: number }
  | { kind: 'circle'; radius: number }
  | { kind: 'polygon'; pts: Array<{ x: number; y: number }> };

/** 光晕绘制层数：层数越多越柔和，10 层已经看不出台阶 */
const LAYERS = 10;
/** 光晕深度：压在所有地图物体之下（物体默认 0） */
const GLOW_DEPTH = -10;

/** 一个物体上的光晕运行时 */
export interface GlowVisual {
  gfx: Phaser.GameObjects.Graphics;
  glow: MaterialGlow;
  /** 需要跟随的视觉对象（世界坐标同步）；复合体子对象为 undefined（随容器动） */
  follow?: Phaser.GameObjects.GameObject;
  /** 相位偏移：让多个物体的呼吸/闪烁不同步（由 id 派生，各端一致） */
  phase: number;
}

function hashPhase(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000 * Math.PI * 2;
}

/** 按 d 像素向外扩张形状并填充（画在 local 原点） */
function fillExpanded(g: Phaser.GameObjects.Graphics, shape: GlowShape, d: number): void {
  if (shape.kind === 'rect') {
    const hw = shape.w / 2 + d;
    const hh = shape.h / 2 + d;
    g.fillRect(-hw, -hh, hw * 2, hh * 2);
    return;
  }
  if (shape.kind === 'circle') {
    g.fillCircle(0, 0, shape.radius + d);
    return;
  }
  const pts = shape.pts;
  if (pts.length < 3) return;
  // 多边形：以质心为参考向外推开顶点（简单的外扩，足够画光晕）
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  const out: Phaser.Geom.Point[] = [];
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    out.push(new Phaser.Geom.Point(p.x + (dx / len) * d, p.y + (dy / len) * d));
  }
  g.fillPoints(out, true);
}

/**
 * 创建一个形状的光晕（画在 local 原点，调用方负责摆放位置）。
 * @param seed 用于相位（同一物体各端表现一致）
 */
export function createShapeGlow(scene: Phaser.Scene, shape: GlowShape, glow: MaterialGlow, seed: string): GlowVisual {
  const gfx = scene.add.graphics();
  gfx.setBlendMode(Phaser.BlendModes.ADD);
  gfx.setDepth(GLOW_DEPTH);

  const radius = Math.max(1, glow.radius);
  for (let i = 0; i < LAYERS; i++) {
    const t = (i + 1) / LAYERS; // 0..1：由内到外
    // 柔和衰减：外圈几乎透明，靠近物体的几层叠出亮度
    const alpha = Math.min(1, glow.brightness * 0.09 * Math.pow(1 - t, 1.7));
    if (alpha < 0.004) continue;
    gfx.fillStyle(glow.color, alpha);
    fillExpanded(gfx, shape, t * radius);
  }

  return { gfx, glow, phase: hashPhase(seed) };
}

/** 发光方式的亮度系数（0~1，乘到 alpha 上） */
function modeFactor(mode: GlowMode, timeMs: number, phase: number): number {
  const t = timeMs / 1000;
  switch (mode) {
    case 'pulse':
      return 0.62 + 0.38 * Math.sin(t * 2.0 + phase);
    case 'flicker': {
      // 两个不同频率叠加 → 不规则的闪烁，但仍然确定（各端一致、可复现）
      const a = Math.sin(t * 13.7 + phase * 1.7);
      const b = Math.sin(t * 5.3 + phase * 3.1);
      return 0.55 + 0.45 * (0.5 + 0.5 * a) * (0.65 + 0.35 * b);
    }
    case 'constant':
    default:
      return 1;
  }
}

/**
 * 每帧更新光晕：跟随视觉变换 + 按发光方式调制亮度。
 *
 * 只在有光晕的物体上跑（数量很少），可以直接每帧调用。
 */
export function updateMaterialGlows(items: MapObjectRuntime[], timeMs: number): void {
  for (const item of items) {
    const glows = item.glows;
    if (!glows || glows.length === 0) continue;
    for (const g of glows) {
      if (!g.gfx.scene) continue;
      if (g.follow) {
        const v = g.follow as unknown as {
          getWorldTransformMatrix?: () => { a: number; b: number; tx: number; ty: number };
        };
        if (v.getWorldTransformMatrix) {
          const m = v.getWorldTransformMatrix();
          g.gfx.setPosition(m.tx, m.ty);
          g.gfx.setRotation(Math.atan2(m.b, m.a));
          const scale = Math.hypot(m.a, m.b) || 1;
          g.gfx.setScale(scale);
        }
      }
      g.gfx.setAlpha(Math.max(0, modeFactor(g.glow.mode, timeMs, g.phase)));
    }
  }
}

/** 销毁光晕对象（物体被破坏/地图重建时调用） */
export function destroyGlows(glows: GlowVisual[] | undefined): void {
  if (!glows) return;
  for (const g of glows) {
    if (g.gfx.scene) g.gfx.destroy();
  }
  glows.length = 0;
}
