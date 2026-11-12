import Phaser from 'phaser';
import { InputManager } from '../core/InputManager';
import type { InputCommand } from '../core/InputCommand';
import { Player } from '../entities/Player';
import { CameraRig } from '../camera/CameraRig';
import { GameFeel } from '../feel/GameFeel';
import { getDefaultMap, getPrefabTable } from '../map/MapRegistry';
import type { PrefabData } from '../map/PrefabFormat';
import type { MapData } from '../map/MapFormat';
import { buildMap, syncCompoundVisuals } from '../map/MapLoader';
import type { MapObjectRuntime } from '../map/MapLoader';
import { MATERIALS } from '../config/materials';
import { preloadMaterialTextures } from '../map/TextureLoader';
import { WorldRegistry } from '../world/WorldRegistry';
import { DestructionSystem } from '../world/DestructionSystem';
import { DamageSystem } from '../combat/DamageSystem';
import { ProjectileSystem } from '../combat/ProjectileSystem';
import { WeaponSystem } from '../combat/WeaponSystem';
import { FxSystem } from '../fx/FxSystem';
import { Hud } from '../ui/Hud';

const PLAYER_COLORS = [0xe74c3c, 0x3498db];
/** 镜头缩放（固定，聚焦单角色时画面清晰） */
const CAMERA_ZOOM = 0.9;
/** 出生时默认装备的武器 */
const STARTING_WEAPON = 'pistol';

/** 启动场景时可传入的数据（编辑器 Play test 用） */
export interface GameSceneData {
  /** 要加载的地图；不传则用默认地图 */
  map?: MapData;
  /** 预制件表；编辑器测试时传入"含未保存草稿"的表，不传则读 data/prefabs */
  prefabs?: Record<string, PrefabData>;
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
  /** 预制件表（编辑器测试时含草稿） */
  private prefabTable!: Record<string, PrefabData>;
  /** 外部退出回调（编辑器 Play test → Esc 返回） */
  private onExit?: () => void;

  // ---- 伤害 / 破坏 / 表现 ----
  /** 物理体 → 地图物体索引（射线命中反查用） */
  private worldRegistry!: WorldRegistry;
  private destruction!: DestructionSystem;
  private damageSystem!: DamageSystem;
  private fx!: FxSystem;
  private hud!: Hud;
  /** body.id → 玩家（射线命中反查用） */
  private readonly bodyToPlayer = new Map<number, Player>();
  /** 谁持有鼠标（瞄准归属）：0=P1 1=P2 */
  private aimOwner: 0 | 1 = 0;
  /** 武器系统（装备/开火/弹药耐久） */
  private weaponSystem!: WeaponSystem;
  /** 逻辑弹道子弹系统 */
  private projectileSystem!: ProjectileSystem;

  constructor() {
    super('GameScene');
  }

  /** 每次 start 都会调用：地图可由外部传入（编辑器测试），否则用默认地图 */
  init(data: GameSceneData = {}): void {
    this.mapData = data.map ?? getDefaultMap();
    this.prefabTable = data.prefabs ?? getPrefabTable();
    this.onExit = data.onExit;
    // 场景可能被重复 start，清空上一轮的引用
    this.players = [];
    this.mapObjects = [];
    this.oneWayBodies = [];
    this.bodyToPlayer.clear();
  }

  /** 预加载材质贴图（纹理跨场景共享，因此每个场景启动时排一次队即可） */
  preload(): void {
    preloadMaterialTextures(
      this,
      Object.values(MATERIALS).map((m) => m.texture),
    );
  }

  create(): void {
    this.inputManager = new InputManager(this);
    this.mapObjects = buildMap(this, this.mapData, this.prefabTable);
    this.oneWayBodies = this.mapObjects.filter((o) => o.oneWay && o.body).map((o) => o.body!);

    const spawn = this.mapData.spawnPoints;
    this.players = spawn.map((p, i) => new Player(this, p.x, p.y, PLAYER_COLORS[i]));
    this.cameraTarget = this.players[0];

    // ---- 伤害 / 破坏 / 表现 接线 ----
    this.worldRegistry = new WorldRegistry();
    this.worldRegistry.rebuild(this.mapObjects);
    this.fx = new FxSystem(this);
    this.destruction = new DestructionSystem(this, this.worldRegistry, this.fx);
    this.damageSystem = new DamageSystem(this.fx, this.destruction);
    this.projectileSystem = new ProjectileSystem(
      this,
      this.damageSystem,
      this.worldRegistry,
      this.bodyToPlayer,
      this.fx,
    );
    this.weaponSystem = new WeaponSystem(
      this,
      this.projectileSystem,
      this.damageSystem,
      this.worldRegistry,
      this.bodyToPlayer,
      this.fx,
    );
    this.hud = new Hud(this);
    this.hud.bind(this.players);
    for (const player of this.players) {
      this.bodyToPlayer.set(player.body.id, player);
      this.weaponSystem.equip(player, STARTING_WEAPON);
    }

    const cam = this.cameras.main;
    cam.setBackgroundColor('#1a1a2e');
    cam.setBounds(0, 0, this.mapData.width, this.mapData.height);

    this.cameraRig = new CameraRig(cam, this.mapData.width, this.mapData.height, CAMERA_ZOOM);
    this.gameFeel = new GameFeel();

    // 受击反馈：屏幕震动
    const onPlayerHit = (): void => this.gameFeel.addTrauma(0.35);
    this.events.on('player-hit', onPlayerHit);

    // 场景重启（编辑器 Play test 反复进入）时必须摘掉监听、销毁 HUD，否则会累积泄漏
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off('player-hit', onPlayerHit);
      this.projectileSystem.destroy();
      this.fx.destroy();
      this.hud.destroy();
    });

    // 编辑器测试模式：Esc 返回
    if (this.onExit) {
      this.input.keyboard?.once('keydown-ESC', () => this.onExit?.());
    }
  }

  update(_time: number, delta: number): void {
    const cmd1 = this.inputManager.readP1();
    const cmd2 = this.inputManager.readP2();
    const cmds = [cmd1, cmd2];

    // 瞄准归属必须在玩家 update 之前确定（input 里的 aimAngle 是本帧要消费的）
    this.updateAim(cmds);

    this.players[0]?.update(cmd1, delta);
    this.players[1]?.update(cmd2, delta);

    // 武器切换（数字键 → 当前操作中的玩家）
    const switchTo = this.inputManager.readWeaponSwitch();
    if (switchTo !== undefined) {
      const owner = this.players[this.aimOwner];
      if (owner) this.weaponSystem.equip(owner, switchTo);
    }

    this.weaponSystem.update(delta);
    this.fireWeapons(cmds);
    this.projectileSystem.update(delta);
    this.updateOneWayCollisions();
    // 焊接体：把一个刚体同步到它的 Container 视觉上
    syncCompoundVisuals(this.mapObjects);
    this.updateCameraTarget(cmd1, cmd2);
    if (this.cameraTarget && this.cameraRig) {
      this.cameraRig.update(this.cameraTarget, delta);
    }
    // 屏幕震动（在跟随之后叠加，避免跟随与震动打架）
    this.gameFeel.update(this.cameras.main, this.cameraRig.shakeOffset, delta);
    this.fx.update(delta);
    this.hud.update();
  }

  /**
   * 瞄准归属：跟随“当前正在操作的玩家”；两人同时操作时 P1 拿鼠标、P2 用身体朝向。
   * 与镜头跟随保持同一套归属规则，避免“镜头看 A、鼠标瞄 B”。
   */
  private updateAim(cmds: InputCommand[]): void {
    const has1 = this.hasInput(cmds[0]);
    const has2 = this.hasInput(cmds[1]);
    if (has1 && has2) {
      this.aimOwner = 0; // 两人同时操作 → P1 拿鼠标
    } else if (has1) {
      this.aimOwner = 0;
    } else if (has2) {
      this.aimOwner = 1;
    }

    const pointer = this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.players.forEach((player, i) => {
      if (i === this.aimOwner) {
        const shoulder = player.shoulderWorld;
        cmds[i].aimAngle = Math.atan2(world.y - shoulder.y, world.x - shoulder.x);
      } else {
        cmds[i].aimAngle = null; // 无鼠标玩家：用身体朝向
      }
    });
  }

  /** 按攻击键开火（走 WeaponSystem：射速/弹药/耐久都在那里管） */
  private fireWeapons(cmds: InputCommand[]): void {
    this.players.forEach((player, i) => {
      if (!cmds[i].attack) return;
      this.weaponSystem.tryFire(player);
    });
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
