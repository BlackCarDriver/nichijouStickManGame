import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon } from '../combat/WeaponFormat';
import type { PlayerProfile } from '../config/playerProfiles';
import { getFakeProfiles } from '../config/playerProfiles';

/** 单个玩家的状态面板（容器 + 自己的 Graphics + 文本） */
interface Slot {
  root: Phaser.GameObjects.Container;
  g: Phaser.GameObjects.Graphics;
  avatar?: Phaser.GameObjects.Image;
  nameText: Phaser.GameObjects.Text;
  killText: Phaser.GameObjects.Text;
  weaponText: Phaser.GameObjects.Text;
}

/**
 * 游戏内 HUD（Heads-Up Display）：**左上角并列展示所有玩家的状态面板**。
 *
 * 每个面板包含：头像 + 昵称 + 击杀数 + 血条 + 护盾条 + 武器/弹药。
 *
 * 设计要点：
 * - **不假设玩家数量**：按屏幕宽度自动计算每行能放几个，超出自动换行
 *   （本地双人是 2 个，联机 4~8 人时自动排布）
 * - **不假设颜色**：所有强调色都取 `player.color`，火柴人扩到 8 种颜色也不用改这里
 * - 每帧重绘 Graphics（开销可忽略），文本只在内容变化时 setText
 * - HUD 应当在屏幕上像素级固定：相机有 zoom 时做反向补偿（否则会被缩放/内缩）
 */
export class Hud {
  private readonly scene: Phaser.Scene;
  /** HUD 根容器（用于整体抵消相机 zoom） */
  private readonly root: Phaser.GameObjects.Container;
  private slots: Slot[] = [];
  private players: Player[] = [];
  private profiles: PlayerProfile[] = [];
  /** playerId → 击杀数（与 GameScene 共享同一个 Map） */
  private kills: Map<number, number> | null = null;

  // ---- 布局常量（屏幕像素）----
  /** 面板宽度 */
  private static readonly PANEL_W = 252;
  /** 面板高度 */
  private static readonly PANEL_H = 72;
  /** 面板间距 */
  private static readonly GAP = 10;
  /** 距离屏幕左/上边距 */
  private static readonly MARGIN = 16;
  /** 头像边长 */
  private static readonly AVATAR = 52;
  /** 头像相对面板的内缩 */
  private static readonly AVATAR_PAD = 10;
  /** 文本/血条起始 x（头像右侧） */
  private static readonly TEXT_X = 72;
  /** 血条高度 */
  private static readonly BAR_H = 10;
  /** 护盾条高度 */
  private static readonly SHIELD_H = 5;
  private static readonly DEPTH = 1000;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.root = scene.add.container(0, 0);
    this.root.setScrollFactor(0);
    this.root.setDepth(Hud.DEPTH);
  }

  /** 绑定击杀数表（与场景共享同一个 Map） */
  bindKills(kills: Map<number, number>): void {
    this.kills = kills;
  }

  /**
   * 绑定玩家列表并（重新）构建面板。
   * @param profiles 玩家展示资料；不传则用假数据（占位）
   */
  bind(players: Player[], profiles?: PlayerProfile[]): void {
    this.players = players;
    this.profiles = profiles ?? getFakeProfiles(players.length);
    this.rebuild();
  }

  private rebuild(): void {
    for (const slot of this.slots) slot.root.destroy(true);
    this.slots = [];

    // 每行能放几个面板（按当前屏幕宽度自动计算，玩家多了自动换行）
    const usable = this.scene.scale.width - Hud.MARGIN * 2;
    const perRow = Math.max(1, Math.floor((usable + Hud.GAP) / (Hud.PANEL_W + Hud.GAP)));

    this.players.forEach((_player, i) => {
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

      const nameText = this.scene.add.text(Hud.TEXT_X, 9, nickname, {
        fontFamily: 'monospace',
        fontSize: '14px',
        fontStyle: 'bold',
        color: '#f0f2f8',
      });
      const killText = this.scene.add.text(Hud.PANEL_W - 12, 11, '', {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#b9c4d0',
      }).setOrigin(1, 0);
      const weaponText = this.scene.add.text(Hud.TEXT_X, 54, '', {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#c8d0dc',
      });
      slotRoot.add([nameText, killText, weaponText]);

      // 头像：有贴图用贴图，否则留空（在 update 里画程序化火柴人头像）
      let avatar: Phaser.GameObjects.Image | undefined;
      if (profile?.avatarKey && this.scene.textures.exists(profile.avatarKey)) {
        avatar = this.scene.add.image(
          Hud.AVATAR_PAD + Hud.AVATAR / 2,
          Hud.PANEL_H / 2,
          profile.avatarKey,
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

      // ---- 文本 ----
      const k = this.kills?.get(player.id) ?? 0;
      slot.killText.setText(`击杀 ${k}`);

      const held = player.heldWeapon;
      if (!held) {
        slot.weaponText.setText('空手');
      } else {
        const weapon = getWeapon(held.id);
        if (weapon) {
          const ammo = held.ammo < 0 ? '∞' : `${held.ammo}/${weapon.ammo}`;
          slot.weaponText.setText(`${weapon.name}  ${ammo}`);
        }
      }

      // ---- 图形 ----
      this.drawSlot(slot, player);
    });
  }

  /** 单个面板的绘制：底板 / 头像 / 血条 / 护盾条 */
  private drawSlot(slot: Slot, player: Player): void {
    const g = slot.g;
    g.clear();

    const dead = player.health.isDead;
    slot.root.setAlpha(dead ? 0.55 : 1);

    // 底板
    g.fillStyle(0x0b0b16, 0.74);
    g.fillRoundedRect(0, 0, Hud.PANEL_W, Hud.PANEL_H, 9);
    g.lineStyle(1.5, player.color, dead ? 0.25 : 0.55);
    g.strokeRoundedRect(0, 0, Hud.PANEL_W, Hud.PANEL_H, 9);

    // 头像框
    const ax = Hud.AVATAR_PAD;
    const ay = (Hud.PANEL_H - Hud.AVATAR) / 2;
    g.fillStyle(0x161628, 1);
    g.fillRoundedRect(ax, ay, Hud.AVATAR, Hud.AVATAR, 9);
    g.lineStyle(2, player.color, dead ? 0.3 : 0.9);
    g.strokeRoundedRect(ax, ay, Hud.AVATAR, Hud.AVATAR, 9);
    // 没有头像贴图时画程序化火柴人（用玩家颜色 → 天然区分不同玩家）
    if (!slot.avatar) {
      this.drawStickmanAvatar(g, ax + Hud.AVATAR / 2, ay + Hud.AVATAR / 2, player.color);
    }

    // ---- 血条 ----
    const barX = Hud.TEXT_X;
    const barW = Hud.PANEL_W - Hud.TEXT_X - 12;
    const barY = 34;
    const ratio = Phaser.Math.Clamp(player.health.ratio, 0, 1);

    g.fillStyle(0x000000, 0.55);
    g.fillRoundedRect(barX - 1, barY - 1, barW + 2, Hud.BAR_H + 2, 3);
    g.fillStyle(ratio > 0.35 ? player.color : 0xff4444, 1);
    if (ratio > 0) {
      g.fillRoundedRect(barX, barY, barW * ratio, Hud.BAR_H, 2);
    }

    // ---- 护盾条（灰色小条，有护盾时才画）----
    const shX = Hud.TEXT_X;
    const shY = barY + Hud.BAR_H + 4;
    const shield = player.health.shield;
    if (shield > 0) {
      const sRatio = Phaser.Math.Clamp(player.health.shieldRatio, 0, 1);
      g.fillStyle(0x000000, 0.55);
      g.fillRoundedRect(shX - 1, shY - 1, barW + 2, Hud.SHIELD_H + 2, 3);
      g.fillStyle(player.isSuperMode ? 0xf2e6a8 : 0x9aa5b1, 1);
      g.fillRoundedRect(shX, shY, barW * sRatio, Hud.SHIELD_H, 2);
    }
  }

  /** 程序化火柴人头像（头 + 躯干 + 四肢，颜色 = 玩家颜色） */
  private drawStickmanAvatar(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    color: number,
  ): void {
    const lw = 2;
    g.lineStyle(lw, color, 1);
    g.fillStyle(color, 1);
    // 头
    g.fillCircle(cx, cy - 11, 5.5);
    // 躯干
    g.lineBetween(cx, cy - 5, cx, cy + 7);
    // 手臂（略上扬，像举着武器）
    g.lineBetween(cx, cy - 1, cx - 8, cy + 4);
    g.lineBetween(cx, cy - 1, cx + 8, cy - 5);
    // 腿
    g.lineBetween(cx, cy + 7, cx - 7, cy + 16);
    g.lineBetween(cx, cy + 7, cx + 7, cy + 16);
  }

  /**
   * 把 HUD 根容器补偿到"屏幕像素坐标"。
   *
   * 相机有 zoom 时，`scrollFactor = 0` 的对象依然会被 zoom 绕屏幕中心缩放，
   * 导致 HUD 缩小并往内缩。这里用 scale = 1/zoom + 位置反向平移抵消：
   *   屏幕坐标 = C + (位置 - C) × zoom + 局部坐标
   * 取 位置 = C + (MARGIN - C)/zoom、scale = 1/zoom 时，局部坐标就等于屏幕坐标。
   */
  private syncRootToScreen(): void {
    const cam = this.scene.cameras.main;
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    this.root.setScale(1 / zoom);
    this.root.setPosition(
      cx + (Hud.MARGIN - cx) / zoom,
      cy + (Hud.MARGIN - cy) / zoom,
    );
  }

  destroy(): void {
    for (const slot of this.slots) slot.root.destroy(true);
    this.slots = [];
    this.root.destroy(true);
  }
}
