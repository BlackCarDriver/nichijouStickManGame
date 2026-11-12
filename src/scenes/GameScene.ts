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
import { PickupSystem } from '../world/PickupSystem';
import { DropSystem } from '../world/DropSystem';
import { FragmentSystem } from '../world/FragmentSystem';
import { DamageSystem } from '../combat/DamageSystem';
import { ProjectileSystem } from '../combat/ProjectileSystem';
import { WeaponSystem } from '../combat/WeaponSystem';
import { ExplosionSystem } from '../combat/ExplosionSystem';
import { FxSystem } from '../fx/FxSystem';
import { Hud } from '../ui/Hud';

const PLAYER_COLORS = [0xe74c3c, 0x3498db];
/** 镜头缩放（固定，聚焦单角色时画面清晰） */
const CAMERA_ZOOM = 0.9;

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
 *
 * 系统接线（单向依赖，便于独立演进）：
 *   FxSystem → DestructionSystem → DamageSystem
 *   DamageSystem + WorldRegistry + ExplosionSystem → ProjectileSystem → WeaponSystem
 *   PickupSystem ← DropSystem（天降武器） / WeaponSystem（弹匣打空掉落）
 *   FragmentSystem ← object-destroyed 事件（破坏碎片）
 */
export class GameScene extends Phaser.Scene {
  private inputManager!: InputManager;
  private players: Player[] = [];
  private cameraTarget: Player | null = null;
  private cameraRig!: CameraRig;
  private gameFeel!: GameFeel;
  private mapObjects: MapObjectRuntime[] = [];
  private oneWayBodies: MatterJS.BodyType[] = [];
  private mapData!: MapData;
  private prefabTable!: Record<string, PrefabData>;
  private onExit?: () => void;

  // ---- 伤害 / 破坏 / 表现 ----
  private worldRegistry!: WorldRegistry;
  private destruction!: DestructionSystem;
  private damageSystem!: DamageSystem;
  private explosion!: ExplosionSystem;
  private fx!: FxSystem;
  private hud!: Hud;
  private readonly bodyToPlayer = new Map<number, Player>();
  private aimOwner: 0 | 1 = 0;

  // ---- 武器 / 掉落 / 碎片 ----
  private weaponSystem!: WeaponSystem;
  private projectileSystem!: ProjectileSystem;
  private pickups!: PickupSystem;
  private drops!: DropSystem;
  private fragments!: FragmentSystem;

  constructor() {
    super('GameScene');
  }

  init(data: GameSceneData = {}): void {
    this.mapData = data.map ?? getDefaultMap();
    this.prefabTable = data.prefabs ?? getPrefabTable();
    this.onExit = data.onExit;
    this.players = [];
    this.mapObjects = [];
    this.oneWayBodies = [];
    this.bodyToPlayer.clear();
  }

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
    for (const player of this.players) {
      this.bodyToPlayer.set(player.body.id, player);
    }

    // ---- 表现层 ----
    this.fx = new FxSystem(this);

    // ---- 破坏 / 伤害 ----
    this.worldRegistry = new WorldRegistry();
    this.worldRegistry.rebuild(this.mapObjects);
    this.destruction = new DestructionSystem(this, this.worldRegistry, this.fx);
    this.damageSystem = new DamageSystem(this.fx, this.destruction);
    this.explosion = new ExplosionSystem(
      this,
      this.damageSystem,
      this.worldRegistry,
      this.bodyToPlayer,
      this.fx,
    );

    // ---- 武器 / 弹道 ----
    this.projectileSystem = new ProjectileSystem(
      this,
      this.damageSystem,
      this.worldRegistry,
      this.bodyToPlayer,
      this.fx,
      (req) => this.explosion.explode(req),
    );
    this.weaponSystem = new WeaponSystem(
      this,
      this.projectileSystem,
      this.damageSystem,
      this.worldRegistry,
      this.bodyToPlayer,
      this.fx,
    );

    // ---- 掉落 / 碎片 ----
    this.pickups = new PickupSystem(this, this.bodyToPlayer, this.fx);
    this.drops = new DropSystem(this, this.pickups, this.mapData);
    this.fragments = new FragmentSystem(this);

    this.hud = new Hud(this);
    this.hud.bind(this.players);
    // 出生空手：所有武器一律靠捡（天降武器 + 场上掉落物）

    const cam = this.cameras.main;
    cam.setBackgroundColor('#1a1a2e');
    cam.setBounds(0, 0, this.mapData.width, this.mapData.height);
    this.cameraRig = new CameraRig(cam, this.mapData.width, this.mapData.height, CAMERA_ZOOM);
    this.gameFeel = new GameFeel();

    this.bindEvents();
  }

  /** 事件接线（场景重启时必须解除，避免重复触发/泄漏） */
  private bindEvents(): void {
    const onPlayerHit = (): void => this.gameFeel.addTrauma(0.35);
    const onExplosion = (_x: number, _y: number, radius: number): void => {
      this.gameFeel.addTrauma(Math.min(0.85, 0.35 + radius / 400));
    };
    // 物体被破坏 → 炸出碎片
    const onObjectDestroyed = (runtime: MapObjectRuntime, center: { x: number; y: number }): void => {
      const colorHex = MATERIALS[runtime.material]?.colorHex ?? '#ffffff';
      const pieces = runtime.material === 'cardboard' ? 4 : 6;
      this.fragments.burst(center.x, center.y, colorHex, pieces);
    };
    // 弹药耗尽 / 耐久耗尽 → 武器直接消失（不掉落在地上）。
    // 武器补给完全交给天降武器（DropSystem）。
    const onWeaponLost = (
      _player: Player,
      _weaponId: string,
      _reason: 'empty' | 'broken' | 'thrown',
      _snapshot?: { ammo: number; durability: number },
    ): void => {
      // 目前只做表现层反馈（在 WeaponSystem 里已播放特效）
    };

    this.events.on('player-hit', onPlayerHit);
    this.events.on('explosion', onExplosion);
    this.events.on('object-destroyed', onObjectDestroyed);
    this.events.on('weapon-lost', onWeaponLost);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off('player-hit', onPlayerHit);
      this.events.off('explosion', onExplosion);
      this.events.off('object-destroyed', onObjectDestroyed);
      this.events.off('weapon-lost', onWeaponLost);
      this.projectileSystem.destroy();
      this.pickups.destroy();
      this.fragments.destroy();
      this.fx.destroy();
      this.hud.destroy();
    });

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

    this.weaponSystem.update(delta);
    // 连续光束（激光）：按住持续输出、持续伤害
    this.players.forEach((player, i) => {
      this.weaponSystem.updateContinuous(player, cmds[i].attackHeld, delta);
    });
    this.handleAttacks(cmds);
    this.handleSecondary(cmds);
    this.projectileSystem.update(delta);
    this.pickups.update(delta);
    this.drops.update(delta);
    this.fragments.update(delta);
    this.updateOneWayCollisions();
    syncCompoundVisuals(this.mapObjects);
    this.updateCameraTarget(cmd1, cmd2);
    if (this.cameraTarget && this.cameraRig) {
      this.cameraRig.update(this.cameraTarget, delta);
    }
    this.gameFeel.update(this.cameras.main, this.cameraRig.shakeOffset, delta);
    this.fx.update(delta);
    this.hud.update();
  }

  /**
   * 瞄准归属：跟随"当前正在操作的玩家"；两人同时操作时 P1 拿鼠标、P2 用身体朝向。
   * 与镜头跟随保持同一套归属规则，避免"镜头看 A、鼠标瞄 B"。
   */
  private updateAim(cmds: InputCommand[]): void {
    const has1 = this.hasInput(cmds[0]);
    const has2 = this.hasInput(cmds[1]);
    if (has1 && has2) {
      this.aimOwner = 0;
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
        cmds[i].aimAngle = null;
      }
    });
  }

  /** 主攻击：开火 / 刺击 / 投掷（全自动武器支持长按连射） */
  private handleAttacks(cmds: InputCommand[]): void {
    this.players.forEach((player, i) => {
      if (!cmds[i].attack && !cmds[i].attackHeld) return;
      this.weaponSystem.tryAttack(player, {
        attack: cmds[i].attack,
        attackHeld: cmds[i].attackHeld,
      });
    });
  }

  /**
   * 副攻击（右键 / Shift / E）：先尝试"替换地上的武器"，
   * 没替换成功才执行踢 / 投掷。
   */
  private handleSecondary(cmds: InputCommand[]): void {
    const intent = new Set<number>();
    this.players.forEach((player, i) => {
      if (cmds[i].kick || cmds[i].swap) intent.add(player.id);
    });
    if (intent.size === 0) return;

    const consumed = this.pickups.tryPickup(intent);
    for (const player of this.players) {
      if (!intent.has(player.id) || consumed.has(player.id)) continue;
      this.weaponSystem.trySecondary(player);
    }
  }

  /** 单向平台：玩家在平台下方或上升中时忽略碰撞（可穿过） */
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

        if (Math.abs(feetY - platformTop) <= 8 && !rising) {
          standing = true;
        }
        if (feetY > platformTop + 12 || rising) {
          ignore = true;
        }
      }

      if (standing) ignore = false;
      player.setOneWayState(ignore, standing);
    }
  }

  /** 镜头跟随最后有输入的玩家 */
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
  }

  private switchCameraTarget(target: Player): void {
    if (this.cameraTarget === target) return;
    this.cameraTarget = target;
    this.cameraRig.snapTo(target.container.x, target.container.y);
  }

  private hasInput(cmd: InputCommand): boolean {
    return (
      cmd.moveX !== 0 ||
      cmd.jump ||
      cmd.attack ||
      cmd.attackHeld ||
      cmd.kick ||
      cmd.swap
    );
  }
}
