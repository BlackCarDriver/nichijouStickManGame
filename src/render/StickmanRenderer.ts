import Phaser from 'phaser';

export interface StickmanDrawOptions {
  color: number;
  walkPhase: number;
  moving: boolean;
  grounded: boolean;
}

/**
 * 火柴人骨骼绘制。
 * 坐标系原点 = 碰撞体中心（脚底 y=+48，头顶 y≈-63，总高约 111）。
 * 面向（左右翻转）由外层 Container 的 scaleX 控制。
 */
export class StickmanRenderer {
  static draw(g: Phaser.GameObjects.Graphics, o: StickmanDrawOptions): void {
    g.clear();
    g.lineStyle(4, o.color, 1);

    const walking = o.moving && o.grounded;
    const legSwing = walking ? Math.sin(o.walkPhase) * 12 : 0;

    // 腿
    if (o.grounded) {
      g.lineBetween(0, -12, -8 + legSwing, 48);
      g.lineBetween(0, -12, 8 - legSwing, 48);
    } else {
      // 空中：并拢微弯
      g.lineBetween(0, -12, -4, 40);
      g.lineBetween(0, -12, 4, 40);
    }

    // 身体
    g.lineBetween(0, -42, 0, -12);

    // 手臂
    const armSwing = walking ? Math.sin(o.walkPhase) * 14 : 0;
    if (o.grounded) {
      g.lineBetween(0, -40, -14 - armSwing, -24);
      g.lineBetween(0, -40, 14 + armSwing, -24);
    } else {
      // 跳跃：双手上举
      g.lineBetween(0, -40, -18, -46);
      g.lineBetween(0, -40, 18, -46);
    }

    // 头
    g.fillStyle(o.color, 1);
    g.fillCircle(0, -52, 11);
  }
}
