import Phaser from 'phaser';
import { parseColor } from '../config/materials';
import type { WeaponVisual } from '../combat/WeaponFormat';

/**
 * 手持武器渲染（在 Player 的 visual 局部坐标里绘制）。
 *
 * 约定：
 * - 局部 x 需要乘 facing（因为 visual.scaleX = facing 已完成世界翻转，
 *   但这里拿到的是"世界瞄准角"，所以局部方向是 (facing*cos, sin)）
 * - 起点 = 手部（由瞄准手臂末端给出），沿瞄准方向延伸 visual.length
 * - 枪口位置 = 起点 + 方向 * length（Player.muzzle 用同一套常量，保证子弹从枪口出）
 */
export interface WeaponDrawOptions {
  visual: WeaponVisual;
  facing: 1 | -1;
  /** 瞄准角（世界弧度） */
  aim: number;
  /** 手部位置（visual 局部坐标） */
  hand: { x: number; y: number };
  /**
   * 颜色覆盖（光刀用持有者的火柴人颜色）。
   * 不传则用 weapons.json 里的 visual.color。
   */
  colorOverride?: number;
  /** 辉光色覆盖（不传则由颜色自动推导更亮的版本） */
  glowOverride?: number;
}

/**
 * 光刀的**发光层**：只画光晕，不画刀柄/刃芯。
 *
 * 这一层要画到一个 **ADD 混合模式**的独立 Graphics 上：
 * 普通 alpha 叠加只是"半透明盖一层"，越叠越灰；ADD 是颜色相加，
 * 多层叠加会真的变亮 → 这才是"发光"的观感。
 */
export function drawWeaponGlow(g: Phaser.GameObjects.Graphics, o: WeaponDrawOptions): void {
  const { visual, facing, aim, hand } = o;
  const dx = facing * Math.cos(aim);
  const dy = Math.sin(aim);
  const color = o.colorOverride ?? parseColor(visual.color, 0x8ef7ff);
  const glow = o.glowOverride ?? lightenColor(color, 0.45);

  const b0 = { x: hand.x + dx * 6, y: hand.y + dy * 6 };
  const b1 = { x: hand.x + dx * visual.length, y: hand.y + dy * visual.length };

  // ADD 混合是"颜色相加"，所以每层要够亮才会真的发光
  // （之前按普通 alpha 叠加的思路把数值调低了，实测反而比原来更淡）
  g.lineStyle(40, glow, 0.16);
  g.lineBetween(b0.x, b0.y, b1.x, b1.y);
  g.lineStyle(26, glow, 0.24);
  g.lineBetween(b0.x, b0.y, b1.x, b1.y);
  g.lineStyle(15, glow, 0.42);
  g.lineBetween(b0.x, b0.y, b1.x, b1.y);
  g.lineStyle(8, glow, 0.62);
  g.lineBetween(b0.x, b0.y, b1.x, b1.y);

  // 刀尖光团（ADD 下形成明显亮斑）
  g.fillStyle(glow, 0.3);
  g.fillCircle(b1.x, b1.y, 20);
  g.fillStyle(glow, 0.5);
  g.fillCircle(b1.x, b1.y, 10);
  g.fillStyle(0xffffff, 0.65);
  g.fillCircle(b1.x, b1.y, 4.2);
}

/** 提亮颜色（与白色混合），用于从本体色推导辉光色 */
export function lightenColor(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const mix = (v: number): number => Math.round(v + (255 - v) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

export function drawHeldWeapon(g: Phaser.GameObjects.Graphics, o: WeaponDrawOptions): void {
  const { visual, facing, aim, hand } = o;
  // 局部方向：把世界瞄准角转成 visual 局部（x 乘 facing）
  const dx = facing * Math.cos(aim);
  const dy = Math.sin(aim);
  // 局部垂直方向（用于弹匣/握把）
  const px = -dy;
  const py = dx;

  const color = o.colorOverride ?? parseColor(visual.color, 0x2b2b36);
  const len = visual.length;
  const th = visual.thickness;

  const at = (t: number, lateral = 0) => ({
    x: hand.x + dx * t + px * lateral,
    y: hand.y + dy * t + py * lateral,
  });

  switch (visual.style) {
    case 'pistol': {
      const grip0 = at(2, 0);
      const grip1 = at(2 + th * 1.6, -th * 0.7);
      g.lineStyle(th, color, 1);
      g.lineBetween(grip0.x, grip0.y, grip1.x, grip1.y);
      const b0 = at(0);
      const b1 = at(len);
      g.lineStyle(th, color, 1);
      g.lineBetween(b0.x, b0.y, b1.x, b1.y);
      break;
    }

    case 'rifle': {
      // 枪身
      g.lineStyle(th, color, 1);
      const b0 = at(-th * 1.6);
      const b1 = at(len);
      g.lineBetween(b0.x, b0.y, b1.x, b1.y);
      // 弹匣（向下前倾）
      g.lineStyle(th * 0.8, color, 1);
      const m0 = at(len * 0.4, 0);
      const m1 = at(len * 0.4 + th * 0.6, -th * 1.5);
      g.lineBetween(m0.x, m0.y, m1.x, m1.y);
      // 枪管前端加粗一点点（细节）
      g.lineStyle(th * 0.55, 0x1f1f27, 1);
      const t0 = at(len * 0.72);
      const t1 = at(len);
      g.lineBetween(t0.x, t0.y, t1.x, t1.y);
      break;
    }

    case 'laser': {
      g.lineStyle(th, color, 1);
      const l0 = at(-th);
      const l1 = at(len * 0.82);
      g.lineBetween(l0.x, l0.y, l1.x, l1.y);
      // 发射口：亮环
      const tip = at(len * 0.9);
      g.lineStyle(2, 0x7ef9ff, 0.95);
      g.strokeCircle(tip.x, tip.y, th * 0.75);
      g.fillStyle(0x7ef9ff, 0.9);
      g.fillCircle(tip.x, tip.y, th * 0.3);
      break;
    }

    case 'launcher': {
      // 粗管
      g.lineStyle(th, color, 1);
      const r0 = at(-th * 2);
      const r1 = at(len * 0.9);
      g.lineBetween(r0.x, r0.y, r1.x, r1.y);
      // 炮口环
      const muzzle = at(len * 0.95);
      g.lineStyle(3, 0x2a2a33, 1);
      g.strokeCircle(muzzle.x, muzzle.y, th * 0.85);
      // 握把
      g.lineStyle(th * 0.7, 0x2a2a33, 1);
      const g0 = at(len * 0.35);
      const g1 = at(len * 0.35 + th * 0.5, -th * 1.3);
      g.lineBetween(g0.x, g0.y, g1.x, g1.y);
      break;
    }

    case 'dagger': {
      // 刀柄
      g.lineStyle(th * 0.9, 0x6b4a2f, 1);
      const h0 = at(-th * 1.2);
      const h1 = at(th * 1.4);
      g.lineBetween(h0.x, h0.y, h1.x, h1.y);
      // 护手
      g.lineStyle(2, 0xb9c4d0, 1);
      const guardA = at(th * 1.4, th * 0.9);
      const guardB = at(th * 1.4, -th * 0.9);
      g.lineBetween(guardA.x, guardA.y, guardB.x, guardB.y);
      // 刀身（细长）
      g.lineStyle(2.4, color, 1);
      const b0 = at(th * 1.4);
      const b1 = at(len);
      g.lineBetween(b0.x, b0.y, b1.x, b1.y);
      break;
    }

    case 'spear': {
      // 杆
      g.lineStyle(th, color, 1);
      const s0 = at(-len * 0.75);
      const s1 = at(len * 0.72);
      g.lineBetween(s0.x, s0.y, s1.x, s1.y);
      // 矛尖
      g.fillStyle(0xcfd8e3, 1);
      const tip = at(len);
      const a = at(len * 0.72, th * 1.4);
      const b = at(len * 0.72, -th * 1.4);
      g.fillTriangle(tip.x, tip.y, a.x, a.y, b.x, b.y);
      break;
    }

    case 'sniper': {
      // 细长枪管
      g.lineStyle(th * 0.75, color, 1);
      const b0 = at(-th * 2.2);
      const b1 = at(len);
      g.lineBetween(b0.x, b0.y, b1.x, b1.y);
      // 枪托（后下方）
      g.lineStyle(th * 1.1, 0x243026, 1);
      const s0 = at(-th * 2.2);
      const s1 = at(-th * 4.2, -th * 1.1);
      g.lineBetween(s0.x, s0.y, s1.x, s1.y);
      // 瞄准镜（枪身上方）
      const sc0 = at(len * 0.34, -th * 1.5);
      const sc1 = at(len * 0.62, -th * 1.5);
      g.lineStyle(th * 0.9, 0x1c2a20, 1);
      g.lineBetween(sc0.x, sc0.y, sc1.x, sc1.y);
      g.lineStyle(1, 0x8fd0e8, 0.9);
      g.lineBetween(sc0.x, sc0.y - 1, sc1.x, sc1.y - 1);
      break;
    }

    case 'shotgun': {
      // 双管
      g.lineStyle(th * 0.55, color, 1);
      const u0 = at(-th * 1.4, -th * 0.42);
      const u1 = at(len, -th * 0.42);
      g.lineBetween(u0.x, u0.y, u1.x, u1.y);
      const l0 = at(-th * 1.4, th * 0.42);
      const l1 = at(len, th * 0.42);
      g.lineBetween(l0.x, l0.y, l1.x, l1.y);
      // 护木
      g.lineStyle(th * 0.9, 0x6b4a2f, 1);
      const f0 = at(len * 0.28);
      const f1 = at(len * 0.6);
      g.lineBetween(f0.x, f0.y, f1.x, f1.y);
      // 枪托
      g.lineStyle(th * 1.2, 0x4a3324, 1);
      const t0 = at(-th * 1.4);
      const t1 = at(-th * 3.6, -th * 1.2);
      g.lineBetween(t0.x, t0.y, t1.x, t1.y);
      break;
    }

    case 'lightsaber': {
      // 刀柄（金属灰，与光刃形成对比）
      const hilt0 = at(-9);
      const hilt1 = at(6);
      g.lineStyle(th + 3, 0x8c97a6, 1);
      g.lineBetween(hilt0.x, hilt0.y, hilt1.x, hilt1.y);
      g.lineStyle(2, 0x2f3540, 1);
      g.lineBetween(hilt0.x, hilt0.y, hilt1.x, hilt1.y);

      // 刃体 + 白热核心（宽光晕由 drawWeaponGlow 用 ADD 混合另画，效果才真的像发光）
      const b0 = at(6);
      const b1 = at(len);
      g.lineStyle(6, color, 1);
      g.lineBetween(b0.x, b0.y, b1.x, b1.y);
      g.lineStyle(2.6, 0xffffff, 1);
      g.lineBetween(b0.x, b0.y, b1.x, b1.y);
      break;
    }

    case 'grenade':
    default: {
      g.fillStyle(color, 1);
      const c = at(len * 0.4);
      g.fillCircle(c.x, c.y, th * 0.55);
      // 顶部引信
      g.lineStyle(2, 0x9aa5b1, 1);
      const f0 = at(len * 0.4);
      const f1 = at(len * 0.4, -th * 0.9);
      g.lineBetween(f0.x, f0.y, f1.x, f1.y);
      break;
    }
  }
}
