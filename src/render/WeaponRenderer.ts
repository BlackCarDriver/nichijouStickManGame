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
}

export function drawHeldWeapon(g: Phaser.GameObjects.Graphics, o: WeaponDrawOptions): void {
  const { visual, facing, aim, hand } = o;
  // 局部方向：把世界瞄准角转成 visual 局部（x 乘 facing）
  const dx = facing * Math.cos(aim);
  const dy = Math.sin(aim);
  // 局部垂直方向（用于弹匣/握把）
  const px = -dy;
  const py = dx;

  const color = parseColor(visual.color, 0x2b2b36);
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
