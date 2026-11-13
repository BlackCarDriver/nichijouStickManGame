import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import { getRenderScale, TEXT_RESOLUTION } from '../config/display';

/**
 * 屏幕边缘的"对手方向箭头"。
 *
 * 当某个对手在相机视野外时，在画面边缘画一个该玩家颜色的箭头指向他，
 * 回到视野内立刻消失。用于横版大乱斗里"不知道对手跑到哪去了"的场景。
 */
export class OffscreenIndicators {
  private readonly scene: Phaser.Scene;
  private readonly root: Phaser.GameObjects.Container;
  private readonly arrows: Phaser.GameObjects.Graphics;
  private readonly labels = new Map<number, Phaser.GameObjects.Text>();
  private readonly DEPTH = 998;

  /** 箭头离屏幕边缘的距离（px） */
  private static readonly MARGIN_X = 26;
  private static readonly MARGIN_Y = 34;
  /** 判定"已在画面内"的内缩量：贴边时不闪烁 */
  private static readonly INNER_PAD = 8;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.root = scene.add.container(0, 0);
    this.root.setScrollFactor(0);
    this.root.setDepth(this.DEPTH);
    this.arrows = scene.add.graphics();
    this.root.add(this.arrows);
  }

  /**
   * @param players 所有玩家
   * @param local 本地玩家（不给旁观者画自己的箭头）
   * @param nicks  netId → 昵称
   */
  update(
    players: Player[],
    local: Player | null,
    nicks: Map<number, string>,
    netIdOf: (player: Player) => number,
  ): void {
    const cam = this.scene.cameras.main;
    this.syncRootToScreen(cam);

    const g = this.arrows;
    g.clear();

    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const view = cam.worldView;
    // 设计像素坐标系下的屏幕中心
    const k0 = getRenderScale();
    const cx = cam.width / (2 * k0);
    const cy = cam.height / (2 * k0);

    const alive = new Set<number>();

    for (const player of players) {
      if (player === local || !player.isAlive) continue;
      if (player.health.isDead) continue;

      const netId = netIdOf(player);
      if (netId < 0) continue;
      alive.add(player.id);

      // 世界坐标 → 设计像素坐标（根容器会再乘 RENDER_SCALE）
      const k = getRenderScale();
      const sx = ((player.container.x - view.x) * zoom) / k;
      const sy = ((player.container.y - view.y) * zoom) / k;
      const designW = cam.width / k;
      const designH = cam.height / k;
      const onScreen =
        sx > OffscreenIndicators.INNER_PAD &&
        sx < designW - OffscreenIndicators.INNER_PAD &&
        sy > OffscreenIndicators.INNER_PAD &&
        sy < designH - OffscreenIndicators.INNER_PAD;

      const label = this.labelFor(player.id, nicks.get(netId) ?? '');
      label.setVisible(!onScreen);
      if (onScreen) continue;

      // 方向：屏幕中心 → 玩家（视野外时分量为大数，用单位向量即可）
      let dx = sx - cx;
      let dy = sy - cy;
      const len = Math.hypot(dx, dy);
      if (len < 1) {
        dx = 0;
        dy = -1;
      } else {
        dx /= len;
        dy /= len;
      }

      // 求射线与"内缩矩形"的交点
      const tx = dx !== 0 ? (cx - OffscreenIndicators.MARGIN_X) / Math.abs(dx) : Number.POSITIVE_INFINITY;
      const ty = dy !== 0 ? (cy - OffscreenIndicators.MARGIN_Y) / Math.abs(dy) : Number.POSITIVE_INFINITY;
      const t = Math.min(tx, ty);
      const ax = cx + dx * t;
      const ay = cy + dy * t;

      const color = player.color;
      const size = 9;
      const angle = Math.atan2(dy, dx) + Math.PI / 2; // 三角默认朝上
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // 箭头三角（朝外）
      const p1 = { x: ax + sin * size, y: ay - cos * size };
      const p2 = { x: ax - cos * size * 0.85 - sin * size * 0.55, y: ay - sin * size * 0.85 + cos * size * 0.55 };
      const p3 = { x: ax + cos * size * 0.85 - sin * size * 0.55, y: ay + sin * size * 0.85 + cos * size * 0.55 };

      g.fillStyle(0x000000, 0.38);
      g.fillCircle(ax, ay, size + 3);
      g.fillStyle(color, 0.95);
      g.fillTriangle(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
      g.lineStyle(1.4, 0xffffff, 0.55);
      g.strokeCircle(ax, ay, size + 3);

      // 昵称贴在箭头内侧
      label.setPosition(ax - dx * 26, ay - dy * 26);
      label.setColor(`#${color.toString(16).padStart(6, '0')}`);
    }

    // 清理已离场玩家的昵称
    for (const [playerId, label] of this.labels) {
      if (!alive.has(playerId)) {
        label.destroy();
        this.labels.delete(playerId);
      }
    }
  }

  private labelFor(playerId: number, nick: string): Phaser.GameObjects.Text {
    let label = this.labels.get(playerId);
    if (!label) {
      label = this.scene.add.text(0, 0, nick, {
        fontFamily: 'PingFang SC, Microsoft YaHei, monospace',
        fontSize: '10px',
        color: '#ffffff',
        stroke: '#0a0c12',
        strokeThickness: 3,
      });
      label.setOrigin(0.5, 0.5);
      label.setResolution(TEXT_RESOLUTION);
      this.root.add(label);
      this.labels.set(playerId, label);
    } else if (label.text !== nick) {
      label.setText(nick);
    }
    return label;
  }

  /** 与 HUD 相同的屏幕坐标补偿（相机 zoom 时反向抵消） */
  private syncRootToScreen(cam: Phaser.Cameras.Scene2D.Camera): void {
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    this.root.setScale(getRenderScale() / zoom);
    this.root.setPosition(cx - cx / zoom, cy - cy / zoom);
  }

  destroy(): void {
    for (const [, label] of this.labels) label.destroy();
    this.labels.clear();
    this.root.destroy(true);
  }
}
