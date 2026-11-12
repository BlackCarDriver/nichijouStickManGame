import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon } from '../combat/WeaponFormat';

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
  /** 武器信息文本（名称 / 弹药 / 耐久） */
  private readonly weaponLabels: Phaser.GameObjects.Text[] = [];
  private players: Player[] = [];
  /** playerId → 击杀数（与 GameScene 共享同一个 Map） */
  private kills: Map<number, number> | null = null;

  private static readonly BAR_W = 220;
  private static readonly BAR_H = 14;
  private static readonly MARGIN = 24;
  private static readonly TOP = 24;
  /** 护盾条高度（血条下方的小进度条） */
  private static readonly SHIELD_H = 5;
  /** 护盾条与血条的间距 */
  private static readonly SHIELD_GAP = 3;
  /** 武器信息行相对血条底部的偏移 */
  private static readonly WEAPON_ROW_GAP = 32;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.g = scene.add.graphics();
    this.g.setScrollFactor(0);
    this.g.setDepth(1000);
  }

  /** 绑定玩家列表（场景创建玩家后调用） */
  bindKills(kills: Map<number, number>): void {
    this.kills = kills;
  }

  bind(players: Player[]): void {
    this.players = players;
    for (const label of this.labels) label.destroy();
    for (const label of this.weaponLabels) label.destroy();
    this.labels.length = 0;
    this.weaponLabels.length = 0;

    const names = ['P1', 'P2'];
    players.forEach((_, i) => {
      const x = i === 0 ? Hud.MARGIN : this.scene.scale.width - Hud.MARGIN - Hud.BAR_W;
      const nameText = this.scene.add.text(x, Hud.TOP - 18, names[i] ?? `P${i + 1}`, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#e8e8f0',
      });
      nameText.setScrollFactor(0);
      nameText.setDepth(1001);
      this.labels.push(nameText);

      const weaponText = this.scene.add.text(x, Hud.TOP + Hud.WEAPON_ROW_GAP - 4, '', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#c8d0dc',
      });
      weaponText.setScrollFactor(0);
      weaponText.setDepth(1001);
      this.weaponLabels.push(weaponText);
    });
  }

  update(): void {
    this.g.clear();
    this.players.forEach((player, i) => {
      const label = this.labels[i];
      if (label) {
        const k = this.kills?.get(player.id) ?? 0;
        label.setText(`P${i + 1}  击杀 ${k}`);
      }

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

      // ---- 护盾条（血条下方的灰色小进度条）----
      this.drawShieldBar(player, x, y + Hud.BAR_H + Hud.SHIELD_GAP);

      // ---- 武器信息 ----
      this.drawWeaponInfo(player, x, y + Hud.WEAPON_ROW_GAP - 4);
    });
  }

  /** 护盾条：灰色小进度条，有护盾时才显示 */
  private drawShieldBar(player: Player, x: number, y: number): void {
    const shield = player.health.shield;
    if (shield <= 0) return;
    const ratio = Phaser.Math.Clamp(player.health.shieldRatio, 0, 1);

    // 底槽
    this.g.fillStyle(0x000000, 0.55);
    this.g.fillRoundedRect(x - 2, y - 1, Hud.BAR_W + 4, Hud.SHIELD_H + 2, 3);
    // 护盾本体（灰色；超级战士的护盾更亮一点）
    const color = player.isSuperMode ? 0xf2e6a8 : 0x9aa5b1;
    this.g.fillStyle(color, 1);
    if (ratio > 0) {
      this.g.fillRoundedRect(x, y, Hud.BAR_W * ratio, Hud.SHIELD_H, 2);
    }
  }

  /** 武器行：名称 / 弹药（武器没有耐久度，不画耐久条） */
  private drawWeaponInfo(player: Player, _x: number, _y: number): void {
    const held = player.heldWeapon;
    const label = this.weaponLabels[this.players.indexOf(player)];
    if (!held) {
      if (label) label.setText('空手');
      return;
    }
    const weapon = getWeapon(held.id);
    if (!weapon) return;

    const ammoText = held.ammo < 0 ? '∞' : `${held.ammo}/${weapon.ammo}`;
    if (label) {
      label.setText(`${weapon.name}  ${ammoText}`);
    }
  }

  destroy(): void {
    this.g.destroy();
    for (const label of this.labels) label.destroy();
    for (const label of this.weaponLabels) label.destroy();
    this.labels.length = 0;
    this.weaponLabels.length = 0;
  }
}
