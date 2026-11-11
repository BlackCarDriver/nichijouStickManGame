import Phaser from 'phaser';
import { InputManager } from '../core/InputManager';
import type { InputCommand } from '../core/InputCommand';
import { Player } from '../entities/Player';
import { CameraRig } from '../camera/CameraRig';
import { GameFeel } from '../feel/GameFeel';
import { getDefaultMap, getPrefabTable } from '../map/MapRegistry';
import type { MapData } from '../map/MapFormat';
import { buildMap } from '../map/MapLoader';
import type { MapObjectRuntime } from '../map/MapLoader';

const PLAYER_COLORS = [0xe74c3c, 0x3498db];
/** 镜头缩放（固定，聚焦单角色时画面清晰） */
const CAMERA_ZOOM = 0.9;

/** 启动场景时可传入的数据（编辑器 Play test 用） */
export interface GameSceneData {
  /** 要加载的地图；不传则用默认地图 */
  map?: MapData;
  /** 返回编辑器等外部回调（Esc 键触发） */
  onExit?: () => void;
}

/**
 * 主游戏场景。
 * - 构建竞技场（物理 + 渲染）
 * - 创建两个本地玩家（单机双人，为联机铺路的输入抽象已就绪）
 * - 镜头通过 CameraRig 平滑跟随"最后有输入的玩家"
 */
export class GameScene extends Phaser.Scene {
  private inputManager!: InputManager;
  private players: Player[] = [];
  /** 镜头跟随目标（最后活跃输入的玩家） */
  private cameraTarget: Player | null = null;
  /** 镜头刚体：平滑跟随 + 预判 + 边界 clamp（camera-systems 技能） */
  private cameraRig!: CameraRig;
  /** 游戏手感：屏幕震动（game-feel 技能） */
  private gameFeel!: GameFeel;
  /** 地图物体运行时列表（单向平台处理/后续破坏系统使用） */
  private mapObjects: MapObjectRuntime[] = [];
  /** 单向平台 body 缓存（每帧判断穿越用） */
  private oneWayBodies: MatterJS.BodyType[] = [];
  /** 当前地图数据 */
  private mapData!: MapData;
  /** 外部退出回调（编辑器 Play test → Esc 返回） */
  private onExit?: () => void;

  constructor() {
    super('GameScene');
  }

  /** 每次 start 都会调用：地图可由外部传入（编辑器测试），否则用默认地图 */
  init(data: GameSceneData = {}): void {
    this.mapData = data.map ?? getDefaultMap();
    this.onExit = data.onExit;
    // 场景可能被重复 start，清空上一轮的引用
    this.players = [];
    this.mapObjects = [];
    this.oneWayBodies = [];
  }

  create(): void {
    this.inputManager = new InputManager(this);
    this.mapObjects = buildMap(this, this.mapData, getPrefabTable());
    this.oneWayBodies = this.mapObjects.filter((o) => o.oneWay && o.body).map((o) => o.body!);

    const spawn = this.mapData.spawnPoints;
    this.players = spawn.map((p, i) => new Player(this, p.x, p.y, PLAYER_COLORS[i]));
    this.cameraTarget = this.players[0];

    const cam = this.cameras.main;
    cam.setBackgroundColor('#1a1a2e');
    cam.setBounds(0, 0, this.mapData.width, this.mapData.height);

    this.cameraRig = new CameraRig(cam, this.mapData.width, this.mapData.height, CAMERA_ZOOM);
    this.gameFeel = new GameFeel();

    // 受击反馈：屏幕震动
    this.events.on('player-hit', () => {
      this.gameFeel.addTrauma(0.35);
    });

    // 编辑器测试模式：Esc 返回
    if (this.onExit) {
      this.input.keyboard?.once('keydown-ESC', () => this.onExit?.());
    }
  }

  update(_time: number, delta: number): void {
    const cmd1 = this.inputManager.readP1();
    const cmd2 = this.inputManager.readP2();
    this.players[0]?.update(cmd1, delta);
    this.players[1]?.update(cmd2, delta);
    this.updateOneWayCollisions();
    this.updateCameraTarget(cmd1, cmd2);
    if (this.cameraTarget && this.cameraRig) {
      this.cameraRig.update(this.cameraTarget, delta);
    }
    // 屏幕震动（在跟随之后叠加，避免跟随与震动打架）
    this.gameFeel.update(this.cameras.main, this.cameraRig.shakeOffset, delta);
  }

  /**
   * 单向平台：玩家在平台下方或上升中时忽略碰撞（可穿过）；
   * 脚底贴着平台顶部时视为站立（可站立、可跳）。
   */
  private updateOneWayCollisions(): void {
    if (this.oneWayBodies.length === 0) return;
    for (const player of this.players) {
      let ignore = false;
      let standing = false;
      const feetY = player.feetY;
      const rising = player.body.velocity.y < -0.5;

      for (const body of this.oneWayBodies) {
        const platformTop = body.bounds.min.y;
        const dx = player.container.x;
        const withinX = dx >= body.bounds.min.x - 6 && dx <= body.bounds.max.x + 6;

        if (!withinX) continue;

        // 脚底贴着平台顶部（±8px 容差）且未上升 → 站在平台上
        if (Math.abs(feetY - platformTop) <= 8 && !rising) {
          standing = true;
        }
        // 只有"明确在平台下方"（脚底深于平台顶部一个身位）或"上升中"才忽略碰撞；
        // 下落时脚底接近平台顶部不忽略 → 平台能挡住玩家
        if (feetY > platformTop + 12 || rising) {
          ignore = true;
        }
      }

      // 站立时不能忽略碰撞（否则会掉下去）
      if (standing) {
        ignore = false;
      }
      player.setOneWayState(ignore, standing);
    }
  }

  /** 镜头跟随最后有输入的玩家（输入优先：移动/跳跃/攻击等） */
  private updateCameraTarget(cmd1: InputCommand, cmd2: InputCommand): void {
    const p1 = this.players[0];
    const p2 = this.players[1];
    if (!p1 || !p2) return;

    const hasInput1 = this.hasInput(cmd1);
    const hasInput2 = this.hasInput(cmd2);
    if (hasInput1 && !hasInput2) {
      this.switchCameraTarget(p1);
    } else if (hasInput2 && !hasInput1) {
      this.switchCameraTarget(p2);
    }
    // 两人同时输入时保持当前跟随目标（不来回切换）
  }

  /** 切换镜头目标时立即复位焦点，避免镜头横穿地图 */
  private switchCameraTarget(target: Player): void {
    if (this.cameraTarget === target) return;
    this.cameraTarget = target;
    this.cameraRig.snapTo(target.container.x, target.container.y);
  }

  private hasInput(cmd: InputCommand): boolean {
    return cmd.moveX !== 0 || cmd.jump || cmd.attack || cmd.kick || cmd.swap;
  }
}
