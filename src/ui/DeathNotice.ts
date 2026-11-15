import Phaser from 'phaser';
import { TEXT_RESOLUTION, viewScaleOf } from '../config/display';

/**
 * 死亡提示（屏幕中上方）：被谁、用什么击败；以及观战跟随目标。
 *
 * 为什么画在游戏内而不是 DOM：
 * - 移动端竖屏时整个画布会被旋转（见 ui/orientation.ts），画在画布里的 UI 会跟着转，
 *   不用再为两套坐标系各写一遍布局；
 * - 与 HUD 用同一套"设计像素 + 像素比补偿"，缩放/性能降级时不会错位。
 */
export class DeathNotice {
  private readonly scene: Phaser.Scene;
  private readonly root: Phaser.GameObjects.Container;
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly title: Phaser.GameObjects.Text;
  private readonly sub: Phaser.GameObjects.Text;
  private visible = false;

  private static readonly DEPTH = 1500;
  private static readonly PANEL_W = 470;
  private static readonly PANEL_H = 76;
  /** 纵向位置：设计高度的 27%（不挡角色） */
  private static readonly Y_RATIO = 0.27;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.root = scene.add.container(0, 0);
    this.root.setScrollFactor(0);
    this.root.setDepth(DeathNotice.DEPTH);

    this.g = scene.add.graphics();
    this.title = scene.add.text(0, -11, '', {
      fontFamily: 'PingFang SC, Microsoft YaHei, monospace',
      fontSize: '22px',
      color: '#ffffff',
      align: 'center',
    });
    this.title.setOrigin(0.5, 0.5);
    this.title.setResolution(TEXT_RESOLUTION);

    this.sub = scene.add.text(0, 19, '', {
      fontFamily: 'PingFang SC, Microsoft YaHei, monospace',
      fontSize: '14px',
      color: '#c3cad6',
      align: 'center',
    });
    this.sub.setOrigin(0.5, 0.5);
    this.sub.setResolution(TEXT_RESOLUTION);

    this.root.add([this.g, this.title, this.sub]);
    this.root.setVisible(false);
  }

  /** 展示死亡结果（重复调用会覆盖上一次的内容） */
  show(title: string, sub: string): void {
    this.title.setText(title);
    this.sub.setText(sub);
    this.sub.setVisible(sub.trim() !== '');
    this.drawPanel();
    this.visible = true;
    this.root.setVisible(true);
    this.syncToScreen();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.setVisible(false);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** 相机 zoom / 画布尺寸变化时重新贴合屏幕（与 HUD 同款补偿） */
  update(): void {
    if (this.visible) this.syncToScreen();
  }

  private drawPanel(): void {
    const w = DeathNotice.PANEL_W;
    const h = DeathNotice.PANEL_H;
    this.g.clear();
    this.g.fillStyle(0x0b0f18, 0.84);
    this.g.lineStyle(2, 0xff6b6b, 0.6);
    this.g.fillRoundedRect(-w / 2, -h / 2, w, h, 10);
    this.g.strokeRoundedRect(-w / 2, -h / 2, w, h, 10);
  }

  /**
   * 与 Hud.syncRootToScreen 同一套补偿：
   * 相机 zoom = 设计缩放 × 画布比例（见 viewScaleOf），
   * 用 scale/position 把根容器换算回"设计像素坐标"。
   */
  private syncToScreen(): void {
    const cam = this.scene.cameras.main;
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const k = viewScaleOf(cam.width);
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    this.root.setScale(k / zoom);
    this.root.setPosition(cx - cx / zoom, cy - cy / zoom);

    // 面板中心：横向居中，纵向按设计高度比例
    const designW = cam.width / k;
    const designH = cam.height / k;
    const panelX = designW / 2;
    const panelY = designH * DeathNotice.Y_RATIO;
    this.root.setPosition(
      this.root.x + (panelX - designW / 2) * (k / zoom),
      this.root.y + (panelY - designH / 2) * (k / zoom),
    );
  }

  destroy(): void {
    this.root.destroy(true);
  }
}
