import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon } from '../combat/WeaponFormat';
import type { PlayerProfile } from '../config/playerProfiles';
import { getFakeProfiles } from '../config/playerProfiles';
import { getRenderScale, TEXT_RESOLUTION } from '../config/display';

/** 单个玩家的状态面板（容器 + 自己的 Graphics + 文本 + 圆形头像） */
interface Slot {
  root: Phaser.GameObjects.Container;
  g: Phaser.GameObjects.Graphics;
  avatar?: Phaser.GameObjects.Image;
  nameText: Phaser.GameObjects.Text;
  killText: Phaser.GameObjects.Text;
  weaponText: Phaser.GameObjects.Text;
}

/**
 * 游戏内 HUD：左上角并列展示所有玩家的状态面板（紧凑版）。
 *
 * 每个面板包含：圆形头像 + 昵称 + 击杀数 + 血条 + 护盾条 + 武器/弹药。
 * 头像优先用聊天室头像（圆形贴图），没有时退回程序化火柴人头像。
 */
export class Hud {
  private readonly scene: Phaser.Scene;
  private readonly root: Phaser.GameObjects.Container;
  private slots: Slot[] = [];
  private players: Player[] = [];
  private profiles: PlayerProfile[] = [];
  private kills: Map<number, number> | null = null;

  // ---- 布局常量（屏幕像素，紧凑尺寸）----
  private static readonly PANEL_W = 186;
  private static readonly PANEL_H = 52;
  private static readonly GAP = 6;
  private static readonly MARGIN = 10;
  private static readonly AVATAR = 34;
  private static readonly AVATAR_PAD = 8;
  private static readonly TEXT_X = 50;
  private static readonly BAR_H = 7;
  private static readonly SHIELD_H = 3;
  private static readonly DEPTH = 1000;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.root = scene.add.container(0, 0);
    this.root.setScrollFactor(0);
    this.root.setDepth(Hud.DEPTH);
  }

  bindKills(kills: Map<number, number>): void {
    this.kills = kills;
  }

  /** 绑定玩家列表并（重新）构建面板 */
  bind(players: Player[], profiles?: PlayerProfile[]): void {
    this.players = players;
    this.profiles = profiles ?? getFakeProfiles(players.length);
    this.rebuild();
  }

  private rebuild(): void {
    for (const slot of this.slots) slot.root.destroy(true);
    this.slots = [];

    // scale.width 是内部渲染像素（已乘 RENDER_SCALE），面板常量是设计像素
    const usable = this.scene.scale.width / getRenderScale() - Hud.MARGIN * 2;
    const perRow = Math.max(1, Math.floor((usable + Hud.GAP) / (Hud.PANEL_W + Hud.GAP)));

    this.players.forEach((player, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const slotRoot = this.scene.add.container(
        col * (Hud.PANEL_W + Hud.GAP),
        row * (Hud.PANEL_H + Hud.GAP),
      );
      this.root.add(slotRoot);

      const g = this.scene.add.graphics();
      slotRoot.add(g);

      const profile = this.profiles[i];
      const nickname = profile?.nickname ?? `P${i + 1}`;

      const nameText = this.scene.add.text(Hud.TEXT_X, 8, nickname, {
        fontFamily: 'PingFang SC, Microsoft YaHei, monospace',
        fontSize: '11px',
        fontStyle: 'bold',
        color: '#f0f2f8',
      }).setResolution(TEXT_RESOLUTION);
      const killText = this.scene.add.text(Hud.PANEL_W - 8, 9, '', {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#b9c4d0',
      }).setOrigin(1, 0).setResolution(TEXT_RESOLUTION);
      const weaponText = this.scene.add.text(Hud.TEXT_X, 39, '', {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#c8d0dc',
      }).setResolution(TEXT_RESOLUTION);
      slotRoot.add([nameText, killText, weaponText]);

      // 头像：优先聊天室圆形头像，其次 profile 贴图，最后程序化火柴人
      let avatar: Phaser.GameObjects.Image | undefined;
      const key = player.avatarCircleKey ?? profile?.avatarKey;
      if (key && this.scene.textures.exists(key)) {
        avatar = this.scene.add.image(
          Hud.AVATAR_PAD + Hud.AVATAR / 2,
          Hud.PANEL_H / 2,
          key,
        ).setDisplaySize(Hud.AVATAR, Hud.AVATAR);
        slotRoot.add(avatar);
      }

      this.slots.push({ root: slotRoot, g, avatar, nameText, killText, weaponText });
    });
  }

  update(): void {
    this.syncRootToScreen();

    this.players.forEach((player, i) => {
      const slot = this.slots[i];
      if (!slot) return;

      const k = this.kills?.get(player.id) ?? 0;
      slot.killText.setText(`${k} 杀`);

      const held = player.heldWeapon;
      if (!held) {
        slot.weaponText.setText('空手');
      } else {
        const weapon = getWeapon(held.id);
        if (weapon) {
          const ammo = held.ammo < 0 ? '∞' : `${held.ammo}/${weapon.ammo}`;
          slot.weaponText.setText(`${weapon.name} ${ammo}`);
        }
      }

      this.drawSlot(slot, player);
    });
  }

  /** 单个面板的绘制：底板 / 头像 / 血条 / 护盾条 */
  private drawSlot(slot: Slot, player: Player): void {
    const g = slot.g;
    g.clear();

    const dead = player.health.isDead;
    slot.root.setAlpha(dead ? 0.5 : 1);

    g.fillStyle(0x0b0b16, 0.68);
    g.fillRoundedRect(0, 0, Hud.PANEL_W, Hud.PANEL_H, 7);
    g.lineStyle(1.2, player.color, dead ? 0.22 : 0.5);
    g.strokeRoundedRect(0, 0, Hud.PANEL_W, Hud.PANEL_H, 7);

    // 圆形头像框
    const ax = Hud.AVATAR_PAD;
    const ay = (Hud.PANEL_H - Hud.AVATAR) / 2;
    g.fillStyle(0x161628, 1);
    g.fillCircle(ax + Hud.AVATAR / 2, ay + Hud.AVATAR / 2, Hud.AVATAR / 2);
    g.lineStyle(1.6, player.color, dead ? 0.28 : 0.85);
    g.strokeCircle(ax + Hud.AVATAR / 2, ay + Hud.AVATAR / 2, Hud.AVATAR / 2);
    if (!slot.avatar) {
      this.drawStickmanAvatar(g, ax + Hud.AVATAR / 2, ay + Hud.AVATAR / 2, player.color);
    }

    // 血条
    const barX = Hud.TEXT_X;
    const barW = Hud.PANEL_W - Hud.TEXT_X - 10;
    const barY = 24;
    const ratio = Phaser.Math.Clamp(player.health.ratio, 0, 1);

    g.fillStyle(0x000000, 0.5);
    g.fillRoundedRect(barX - 1, barY - 1, barW + 2, Hud.BAR_H + 2, 2);
    // 血条颜色 = 该火柴人的配色（低血量不再变红，避免"所有人都是红条"）
    g.fillStyle(player.color, 1);
    if (ratio > 0) {
      g.fillRoundedRect(barX, barY, barW * ratio, Hud.BAR_H, 1.5);
    }

    // 护盾条
    const shY = barY + Hud.BAR_H + 3;
    const shield = player.health.shield;
    if (shield > 0) {
      const sRatio = Phaser.Math.Clamp(player.health.shieldRatio, 0, 1);
      g.fillStyle(0x000000, 0.5);
      g.fillRoundedRect(barX - 1, shY - 1, barW + 2, Hud.SHIELD_H + 2, 2);
      g.fillStyle(player.isSuperMode ? 0xf2e6a8 : 0x9aa5b1, 1);
      g.fillRoundedRect(barX, shY, barW * sRatio, Hud.SHIELD_H, 1.5);
    }
  }

  /** 程序化火柴人头像（无头像时用玩家颜色区分） */
  private drawStickmanAvatar(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    color: number,
  ): void {
    const lw = 1.6;
    const s = 0.72;
    g.lineStyle(lw, color, 1);
    g.fillStyle(color, 1);
    g.fillCircle(cx, cy - 11 * s, 5.5 * s);
    g.lineBetween(cx, cy - 5 * s, cx, cy + 7 * s);
    g.lineBetween(cx, cy - 1 * s, cx - 8 * s, cy + 4 * s);
    g.lineBetween(cx, cy - 1 * s, cx + 8 * s, cy - 5 * s);
    g.lineBetween(cx, cy + 7 * s, cx - 7 * s, cy + 16 * s);
    g.lineBetween(cx, cy + 7 * s, cx + 7 * s, cy + 16 * s);
  }

  /**
   * 把 HUD 根容器补偿到"设计像素坐标"。
   *
   * 相机 zoom = 设计缩放 × RENDER_SCALE，画布也放大 RENDER_SCALE 倍，
   * 所以这里用 RENDER_SCALE/zoom 让 HUD 的物理尺寸/位置保持不变、像素密度跟着提高。
   */
  private syncRootToScreen(): void {
    const cam = this.scene.cameras.main;
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const k = getRenderScale();
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    this.root.setScale(k / zoom);
    this.root.setPosition(cx - cx / zoom, cy - cy / zoom);
  }

  destroy(): void {
    for (const slot of this.slots) slot.root.destroy(true);
    this.slots = [];
    this.root.destroy(true);
  }
}
