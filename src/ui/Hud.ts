import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getWeapon } from '../combat/WeaponFormat';
import type { PlayerProfile } from '../config/playerProfiles';
import { getFakeProfiles } from '../config/playerProfiles';
import { DESIGN_HEIGHT, DESIGN_WIDTH, TEXT_RESOLUTION, viewScaleOf } from '../config/display';
import { isTeamMode, teamColor, teamName } from '../config/teams';
import type { MatchMode } from '../net/protocol';

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
  /** playerId → 剩余生命数 / 剩余复活次数（团队战/带命数的对局才会用） */
  private lives: Map<number, number> | null = null;
  private revives: Map<number, number> | null = null;

  // ---- 团队战：顶部/底部队伍比分 ----
  private teamMode = false;
  private teamOf: ((player: Player) => number) | null = null;
  private scoreRoot?: Phaser.GameObjects.Container;
  private scoreG?: Phaser.GameObjects.Graphics;
  private scoreLeft?: Phaser.GameObjects.Text;
  private scoreRight?: Phaser.GameObjects.Text;
  private static readonly SCORE_W = 208;
  private static readonly SCORE_H = 26;

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

  /** 绑定命数（剩余生命 / 剩余复活次数）；显示为面板右上角的“复活 ×N” / “出局” */
  bindLives(lives: Map<number, number>, revives?: Map<number, number>): void {
    this.lives = lives;
    this.revives = revives ?? null;
  }

  /**
   * 绑定本局模式（团队战时在屏幕底部中间画队伍比分）。
   *
   * 为什么放底部：6 人以上时左上角面板会排成两行，顶部整条都被占用，
   * 底部中间永远是空的（屏幕外敌人箭头贴在四边，不会冲突）。
   */
  setTeams(mode: MatchMode, teamOf?: (player: Player) => number): void {
    this.teamMode = isTeamMode(mode);
    this.teamOf = teamOf ?? null;
    if (this.teamMode) {
      this.ensureScoreRoot();
    } else {
      this.scoreRoot?.destroy(true);
      this.scoreRoot = undefined;
      this.scoreG = undefined;
      this.scoreLeft = undefined;
      this.scoreRight = undefined;
    }
  }

  private ensureScoreRoot(): void {
    if (this.scoreRoot) return;
    const root = this.scene.add.container(
      DESIGN_WIDTH / 2 - Hud.SCORE_W / 2,
      DESIGN_HEIGHT - Hud.SCORE_H - 10,
    );
    this.root.add(root);
    const g = this.scene.add.graphics();
    root.add(g);
    const base = {
      fontFamily: 'PingFang SC, Microsoft YaHei, monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#f0f2f8',
    };
    const left = this.scene.add
      .text(10, Hud.SCORE_H / 2, '', base)
      .setOrigin(0, 0.5)
      .setResolution(TEXT_RESOLUTION);
    const right = this.scene.add
      .text(Hud.SCORE_W - 10, Hud.SCORE_H / 2, '', base)
      .setOrigin(1, 0.5)
      .setResolution(TEXT_RESOLUTION);
    root.add([left, right]);
    this.scoreRoot = root;
    this.scoreG = g;
    this.scoreLeft = left;
    this.scoreRight = right;
  }

  /** 画队伍比分（击杀数汇总；两侧用队伍色区分） */
  private drawScore(): void {
    const g = this.scoreG;
    if (!g || !this.scoreLeft || !this.scoreRight) return;
    const byTeam = [0, 0];
    for (const player of this.players) {
      const team = this.teamOf?.(player) ?? -1;
      if (team < 0 || team > 1) continue;
      byTeam[team] += this.kills?.get(player.id) ?? 0;
    }
    const W = Hud.SCORE_W;
    const H = Hud.SCORE_H;
    const half = W / 2;
    g.clear();
    g.fillStyle(0x0b0b16, 0.72);
    g.fillRoundedRect(0, 0, W, H, 7);
    g.fillStyle(teamColor(0), 0.18);
    g.fillRoundedRect(0, 0, half, H, { tl: 7, bl: 7, tr: 0, br: 0 });
    g.fillStyle(teamColor(1), 0.18);
    g.fillRoundedRect(half, 0, half, H, { tl: 0, bl: 0, tr: 7, br: 7 });
    g.lineStyle(1.4, teamColor(0), 0.7);
    g.lineBetween(half - 0.5, 2, half - 0.5, H - 2);
    g.lineStyle(1.2, teamColor(0), 0.55);
    g.strokeRoundedRect(0, 0, W, H, 7);

    this.scoreLeft.setText(`${teamName(0)} ${byTeam[0]}`);
    this.scoreLeft.setColor(`#${teamColor(0).toString(16).padStart(6, '0')}`);
    this.scoreRight.setText(`${byTeam[1]} ${teamName(1)}`);
    this.scoreRight.setColor(`#${teamColor(1).toString(16).padStart(6, '0')}`);
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

    // 面板常量是设计像素，布局宽度按设计宽算（正式游戏画布 = 设计宽 × RENDER_SCALE）
    const usable = DESIGN_WIDTH - Hud.MARGIN * 2;
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
      slot.killText.setText(this.killLabel(player.id, k));

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

    if (this.teamMode) this.drawScore();
  }

  /** 右上角文案：击杀数 + 命数（没命就标“出局”） */
  private killLabel(playerId: number, kills: number): string {
    const lives = this.lives?.get(playerId);
    if (kills <= 0 && lives === undefined) return '';
    const parts = [kills > 0 ? `${kills} 杀` : '0 杀'];
    if (lives !== undefined) {
      const revives = this.revives?.get(playerId) ?? Math.max(0, lives - 1);
      parts.push(lives <= 0 ? '出局' : revives > 0 ? `复活 ×${revives}` : '最后一条命');
    }
    return parts.join(' · ');
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
   * 相机 zoom = 设计缩放 × 画布比例（见 viewScaleOf），所以这里用
   * 画布比例/zoom 抵消相机 zoom，让 HUD 尺寸/位置固定在屏幕空间。
   */
  private syncRootToScreen(): void {
    const cam = this.scene.cameras.main;
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const k = viewScaleOf(cam.width);
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    this.root.setScale(k / zoom);
    this.root.setPosition(cx - cx / zoom, cy - cy / zoom);
  }

  destroy(): void {
    for (const slot of this.slots) slot.root.destroy(true);
    this.slots = [];
    this.scoreRoot?.destroy(true);
    this.scoreRoot = undefined;
    this.root.destroy(true);
  }
}
