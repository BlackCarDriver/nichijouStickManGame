import Phaser from 'phaser';
import { InputManager } from '../core/InputManager';
import { Player } from '../entities/Player';
import { ARENA } from '../map/ArenaData';
import { buildMap } from '../map/MapLoader';

const PLAYER_COLORS = [0xe74c3c, 0x3498db];

/**
 * 主游戏场景。
 * - 构建竞技场（物理 + 渲染）
 * - 创建两个本地玩家（单机双人，为联机铺路的输入抽象已就绪）
 * - 自适应镜头：追踪双人中点 + 缩放保证两人都在屏幕内
 */
export class GameScene extends Phaser.Scene {
  private inputManager!: InputManager;
  private players: Player[] = [];

  constructor() {
    super('GameScene');
  }

  create(): void {
    this.inputManager = new InputManager(this);
    buildMap(this, ARENA);

    const spawn = ARENA.spawnPoints;
    this.players = spawn.map((p, i) => new Player(this, p.x, p.y, PLAYER_COLORS[i]));

    const cam = this.cameras.main;
    cam.setBackgroundColor('#1a1a2e');
    cam.setBounds(0, 0, ARENA.width, ARENA.height);
  }

  update(_time: number, delta: number): void {
    const cmd1 = this.inputManager.readP1();
    const cmd2 = this.inputManager.readP2();
    this.players[0]?.update(cmd1, delta);
    this.players[1]?.update(cmd2, delta);
    this.updateAdaptiveCamera();
  }

  /** 自适应镜头：镜头中心 = 双人中点，缩放保证两玩家 + 边距都在屏幕内 */
  private updateAdaptiveCamera(): void {
    if (this.players.length < 2) return;
    const [p1, p2] = this.players;
    const cam = this.cameras.main;

    const midX = (p1.container.x + p2.container.x) / 2;
    const midY = (p1.container.y + p2.container.y) / 2;
    const dist = Phaser.Math.Distance.Between(
      p1.container.x,
      p1.container.y,
      p2.container.x,
      p2.container.y,
    );

    // 目标缩放：保证两人距离 + 边距能放入较短屏幕边
    const margin = 260;
    const base = Math.min(this.scale.width, this.scale.height) - margin;
    const zoom = Phaser.Math.Clamp(base / Math.max(dist + margin, 300), 0.35, 1.2);

    cam.setZoom(zoom);
    cam.centerOn(midX, midY);

    // 限制镜头不越出地图边界
    const viewW = cam.width / zoom;
    const viewH = cam.height / zoom;
    cam.scrollX = Phaser.Math.Clamp(cam.scrollX, 0, ARENA.width - viewW);
    cam.scrollY = Phaser.Math.Clamp(cam.scrollY, 0, ARENA.height - viewH);
  }
}
