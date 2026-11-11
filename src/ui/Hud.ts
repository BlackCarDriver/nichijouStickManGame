import Phaser from 'phaser';
import type { Player } from '../entities/Player';

/**
 * 最小 HUD：两个玩家的血条 + 标签（固定在屏幕上，不随镜头移动）。
 *
 * 用 Graphics 每帧重绘（两个血条的开销可忽略），避免维护一堆 GameObject。
 * 后续弹药/武器图标/击杀数都加在这里。
 */
export class Hud {
  private readonly scene: Phaser.Scene;
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly labels: Phaser.GameObjects.Text[] = [];
  private players: Player[] = [];

  private static readonly BAR_W = 220;
  private static readonly BAR_H = 14;
  private static readonly MARGIN = 24;
  private static readonly TOP = 24;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.g = scene.add.graphics();
    this.g.setScrollFactor(0);
    this.g.setDepth(1000);
  }

  /** 绑定玩家列表（场景创建玩家后调用） */
  bind(players: Player[]): void {
    this.players = players;
    for (const label of this.labels) label.destroy();
    this.labels.length = 0;
    const names = ['P1', 'P2'];
    players.forEach((_, i) => {
      const x = i === 0 ? Hud.MARGIN : this.scene.scale.width - Hud.MARGIN - Hud.BAR_W;
      const text = this.scene.add.text(x, Hud.TOP - 18, names[i] ?? `P${i + 1}`, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#e8e8f0',
      });
      text.setScrollFactor(0);
      text.setDepth(1001);
      this.labels.push(text);
    });
  }

  update(): void {
    this.g.clear();
    this.players.forEach((player, i) => {
      const x = i === 0 ? Hud.MARGIN : this.scene.scale.width - Hud.MARGIN - Hud.BAR_W;
      const y = Hud.TOP;
      const ratio = Phaser.Math.Clamp(player.health.ratio, 0, 1);

      // 底槽
      this.g.fillStyle(0x000000, 0.55);
      this.g.fillRoundedRect(x - 2, y - 2, Hud.BAR_W + 4, Hud.BAR_H + 4, 4);

      // 血条：玩家自身颜色 → 低血变红
      const barColor = ratio > 0.35 ? player.color : 0xff4444;
      this.g.fillStyle(barColor, 1);
      if (ratio > 0) {
        this.g.fillRoundedRect(x, y, Hud.BAR_W * ratio, Hud.BAR_H, 3);
      }

      // 死亡时整体压暗
      if (player.health.isDead) {
        this.g.fillStyle(0x000000, 0.5);
        this.g.fillRoundedRect(x - 2, y - 2, Hud.BAR_W + 4, Hud.BAR_H + 4, 4);
      }
    });
  }

  destroy(): void {
    this.g.destroy();
    for (const label of this.labels) label.destroy();
    this.labels.length = 0;
  }
}
