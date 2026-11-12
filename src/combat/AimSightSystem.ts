import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon } from './WeaponFormat';
import { raycast, getWorldBodies } from './Raycast';
import { parseColor } from '../config/materials';

/**
 * 瞄准辅助线（狙击枪的红外线）。
 *
 * 逐帧重画（而不是用带寿命的特效粒子），所以线是稳定常驻的；
 * 遇到障碍物会终止在命中点，玩家能直观看到"这一枪会不会被挡"。
 *
 * 纯视觉，不产生任何伤害。
 */
export class AimSightSystem {
  private readonly scene: Phaser.Scene;
  private readonly g: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.g = scene.add.graphics();
    // 在角色之上、子弹之下
    this.g.setDepth(830);
  }

  /** 每帧调用：为所有手持带 sight 配置的武器的玩家画瞄准线 */
  update(players: Player[]): void {
    this.g.clear();

    for (const player of players) {
      if (player.health.isDead) continue;
      const held = player.heldWeapon;
      if (!held) continue;

      const sight = getWeapon(held.id)?.sight;
      if (!sight) continue;

      const from = player.muzzle;
      const aim = player.aim;
      const dir = { x: Math.cos(aim), y: Math.sin(aim) };

      // 打到第一个障碍为止
      const hits = raycast(getWorldBodies(this.scene), from, dir, sight.range, {
        ignore: [player.body],
        maxHits: 1,
      });
      const end = hits[0]
        ? hits[0].point
        : { x: from.x + dir.x * sight.range, y: from.y + dir.y * sight.range };

      const color = parseColor(sight.color, 0xff9b9b);

      // 主光束（半透明淡红）
      this.g.lineStyle(sight.width, color, sight.alpha);
      this.g.lineBetween(from.x, from.y, end.x, end.y);

      // 内侧更淡的核心，让线看起来细一点
      this.g.lineStyle(Math.max(0.6, sight.width * 0.4), 0xffffff, sight.alpha * 0.35);
      this.g.lineBetween(from.x, from.y, end.x, end.y);

      // 命中点标记
      this.g.fillStyle(color, Math.min(1, sight.alpha * 2.2));
      this.g.fillCircle(end.x, end.y, 2.6);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
