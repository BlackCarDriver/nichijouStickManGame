import Phaser from 'phaser';
import { InputManager } from '../core/InputManager';
import type { InputCommand } from '../core/InputCommand';
import { Player } from '../entities/Player';
import { ARENA } from '../map/ArenaData';
import { buildMap } from '../map/MapLoader';

const PLAYER_COLORS = [0xe74c3c, 0x3498db];
/** 镜头缩放（固定，聚焦单角色时画面清晰） */
const CAMERA_ZOOM = 0.9;

/**
 * 主游戏场景。
 * - 构建竞技场（物理 + 渲染）
 * - 创建两个本地玩家（单机双人，为联机铺路的输入抽象已就绪）
 * - 镜头跟随"最后有输入的玩家"（你操作哪个角色，镜头就跟随谁）
 */
export class GameScene extends Phaser.Scene {
  private inputManager!: InputManager;
  private players: Player[] = [];
  /** 镜头跟随目标（最后活跃输入的玩家） */
  private cameraTarget: Player | null = null;

  constructor() {
    super('GameScene');
  }

  create(): void {
    this.inputManager = new InputManager(this);
    buildMap(this, ARENA);

    const spawn = ARENA.spawnPoints;
    this.players = spawn.map((p, i) => new Player(this, p.x, p.y, PLAYER_COLORS[i]));
    this.cameraTarget = this.players[0];

    const cam = this.cameras.main;
    cam.setBackgroundColor('#1a1a2e');
    cam.setBounds(0, 0, ARENA.width, ARENA.height);
  }

  update(_time: number, delta: number): void {
    const cmd1 = this.inputManager.readP1();
    const cmd2 = this.inputManager.readP2();
    this.players[0]?.update(cmd1, delta);
    this.players[1]?.update(cmd2, delta);
    this.updateCameraTarget(cmd1, cmd2);
    this.updateFollowCamera();
  }

  /** 镜头跟随最后有输入的玩家（输入优先：移动/跳跃/攻击等） */
  private updateCameraTarget(cmd1: InputCommand, cmd2: InputCommand): void {
    const p1 = this.players[0];
    const p2 = this.players[1];
    if (!p1 || !p2) return;

    const hasInput1 = this.hasInput(cmd1);
    const hasInput2 = this.hasInput(cmd2);
    if (hasInput1 && !hasInput2) {
      this.cameraTarget = p1;
    } else if (hasInput2 && !hasInput1) {
      this.cameraTarget = p2;
    }
    // 两人同时输入时保持当前跟随目标（不来回切换）
  }

  private hasInput(cmd: InputCommand): boolean {
    return cmd.moveX !== 0 || cmd.jump || cmd.attack || cmd.kick || cmd.swap;
  }

  /** 镜头跟随目标玩家，固定在视野中心，限制不出地图边界 */
  private updateFollowCamera(): void {
    if (!this.cameraTarget) return;
    const cam = this.cameras.main;
    cam.setZoom(CAMERA_ZOOM);
    cam.centerOn(this.cameraTarget.container.x, this.cameraTarget.container.y);

    const viewW = cam.width / CAMERA_ZOOM;
    const viewH = cam.height / CAMERA_ZOOM;
    cam.scrollX = Phaser.Math.Clamp(cam.scrollX, 0, ARENA.width - viewW);
    cam.scrollY = Phaser.Math.Clamp(cam.scrollY, 0, ARENA.height - viewH);
  }
}
