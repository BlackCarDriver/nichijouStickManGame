import Phaser from 'phaser';
import { InputManager } from '../core/InputManager';
import type { InputCommand } from '../core/InputCommand';
import { Player } from '../entities/Player';
import { CameraRig } from '../camera/CameraRig';
import { GameFeel } from '../feel/GameFeel';
import { HitStop } from '../feel/HitStop';
import { AudioSystem } from '../audio/AudioSystem';
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
import { ImpactDamageSystem } from '../world/ImpactDamageSystem';
import { DamageSystem } from '../combat/DamageSystem';
import { ProjectileSystem } from '../combat/ProjectileSystem';
import { WeaponSystem } from '../combat/WeaponSystem';
import { ExplosionSystem } from '../combat/ExplosionSystem';
import { AimSightSystem } from '../combat/AimSightSystem';
import { GrenadeSystem } from '../combat/GrenadeSystem';
import { FxSystem } from '../fx/FxSystem';
import { Hud } from '../ui/Hud';
import { DamageNumbers } from '../ui/DamageNumbers';

const PLAYER_COLORS = [0xe74c3c, 0x3498db];
/** 空的"按下集合"（自动拾取不需要按键） */
const EMPTY_PRESSED: ReadonlySet<number> = new Set<number>();
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
  private hitStop!: HitStop;
  private audio!: AudioSystem;
  /** 顿帧期间物理是否已被暂停（避免重复 pause/resume） */
  private physicsFrozen = false;
  /** playerId → 击杀数 */
  private readonly kills = new Map<number, number>();
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
  private damageNumbers!: DamageNumbers;
  private readonly bodyToPlayer = new Map<number, Player>();
  private aimOwner: 0 | 1 = 0;

  // ---- 武器 / 掉落 / 碎片 ----
  private weaponSystem!: WeaponSystem;
  private projectileSystem!: ProjectileSystem;
  private sights!: AimSightSystem;
  private grenades!: GrenadeSystem;
  private pickups!: PickupSystem;
  private drops!: DropSystem;
  private fragments!: FragmentSystem;
  private impactDamage!: ImpactDamageSystem;

  /** 首次用户手势时启动 AudioContext（浏览器自动播放策略） */
  private readonly unlockAudio = (): void => {
    this.audio.unlock();
  };

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
    // 屏蔽浏览器右键菜单（否则右键踢/投掷会弹出系统菜单）
    this.input.mouse?.disableContextMenu();

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

    // ---- 瞄准辅助线（狙击枪红外线）----
    this.sights = new AimSightSystem(this);
    // ---- 手榴弹（背包道具）----
    this.grenades = new GrenadeSystem(this, this.projectileSystem);

    // ---- 掉落 / 碎片 ----
    this.pickups = new PickupSystem(this, this.bodyToPlayer, this.fx);
    this.drops = new DropSystem(this, this.pickups, this.mapData);
    this.fragments = new FragmentSystem(this);
    this.impactDamage = new ImpactDamageSystem(this, this.damageSystem, this.worldRegistry);

    this.damageNumbers = new DamageNumbers(this);
    this.hud = new Hud(this);
    this.hud.bind(this.players);
    this.hud.bindKills(this.kills);
    // 出生空手：所有武器一律靠捡（天降武器 + 场上掉落物）

    const cam = this.cameras.main;
    cam.setBackgroundColor('#1a1a2e');
    cam.setBounds(0, 0, this.mapData.width, this.mapData.height);
    this.cameraRig = new CameraRig(cam, this.mapData.width, this.mapData.height, CAMERA_ZOOM);
    this.gameFeel = new GameFeel();
    this.hitStop = new HitStop();
    this.audio = new AudioSystem();
    this.kills.clear();
    this.physicsFrozen = false;

    // AudioContext 必须在用户手势后才能启动
    this.input.on('pointerdown', this.unlockAudio);
    this.input.keyboard?.on('keydown', this.unlockAudio);
    // M 键静音切换
    this.input.keyboard?.on('keydown-M', () => this.audio.toggleMute());

    this.bindEvents();
  }

  /** 事件接线（场景重启时必须解除，避免重复触发/泄漏） */
  private bindEvents(): void {
    // 受击镜头晃动（原来 0.35 太晃，降到 1/3）
    const onPlayerHit = (): void => this.gameFeel.addTrauma(0.12);
    const onExplosion = (_x: number, _y: number, radius: number): void => {
      this.gameFeel.addTrauma(Math.min(0.85, 0.35 + radius / 400));
    };
    // 物体被破坏 → 炸出碎片
    const onObjectDestroyed = (runtime: MapObjectRuntime, center: { x: number; y: number }): void => {
      const colorHex = MATERIALS[runtime.material]?.colorHex ?? '#ffffff';
      const pieces = runtime.material === 'cardboard' ? 4 : 6;
      this.fragments.burst(center.x, center.y, colorHex, pieces);
    };
    // 弹药耗尽 / 投掷出去 → 武器直接消失（不掉落在地上）。
    // 武器补给完全交给天降武器（DropSystem）。
    const onWeaponLost = (
      _player: Player,
      _weaponId: string,
      _reason: 'empty' | 'thrown',
      _snapshot?: { ammo: number },
    ): void => {
      // 目前只做表现层反馈（在 WeaponSystem 里已播放特效）
    };

    // 投掷武器插不进去（目标硬度 >= 投掷伤害）→ 掉到地上变成可拾取物
    const onThrownBlocked = (weaponId: string, x: number, y: number): void => {
      this.pickups.spawn(weaponId, x, y, { falling: true });
    };

    // 重武器后坐力 → 轻微镜头震动（火箭/霰弹/狙击手感更"重"）
    const onWeaponRecoil = (_player: Player, push: number): void => {
      if (push < 4) return;
      this.gameFeel.addTrauma(Math.min(0.3, push / 40));
    };

    // 受伤 → 顿帧（按伤害量缩放）+ 命中音效
    const onPlayerDamaged = (
      _player: Player,
      amount: number,
      kind: string,
      critical: boolean,
      incoming: number,
    ): void => {
      if (kind !== 'env') {
        this.hitStop.trigger(HitStop.durationForDamage(amount));
      }
      this.audio.play('hit');
      // 伤害气泡用"本次攻击的伤害值"（incoming），而不是被剩余血量截断后的 amount
      this.damageNumbers.show(_player, incoming, { crit: critical });
    };
    // 死亡 → 音效 + 击杀计数（记录凶手）
    const onPlayerDied = (victim: Player, killerId?: number): void => {
      this.audio.play('death');
      if (killerId !== undefined && killerId !== victim.id) {
        this.kills.set(killerId, (this.kills.get(killerId) ?? 0) + 1);
      }
    };
    // 统一音效路由
    const onSfx = (name: string): void => {
      this.audio.playWeapon(name);
    };

    this.events.on('player-hit', onPlayerHit);
    this.events.on('weapon-recoil', onWeaponRecoil);
    this.events.on('player-damaged', onPlayerDamaged);
    this.events.on('player-died', onPlayerDied);
    this.events.on('sfx', onSfx);
    this.events.on('explosion', () => this.audio.play('explosion'));
    this.events.on('explosion', onExplosion);
    this.events.on('object-destroyed', onObjectDestroyed);
    this.events.on('weapon-lost', onWeaponLost);
    this.events.on('thrown-blocked', onThrownBlocked);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off('player-hit', onPlayerHit);
      this.events.off('weapon-recoil', onWeaponRecoil);
      this.events.off('player-damaged', onPlayerDamaged);
      this.events.off('player-died', onPlayerDied);
      this.events.off('sfx', onSfx);
      this.input.off('pointerdown', this.unlockAudio);
      this.input.keyboard?.off('keydown', this.unlockAudio);
      if (this.physicsFrozen) {
        this.matter.world.resume();
        this.physicsFrozen = false;
      }
      this.events.off('explosion', onExplosion);
      this.events.off('object-destroyed', onObjectDestroyed);
      this.events.off('weapon-lost', onWeaponLost);
      this.events.off('thrown-blocked', onThrownBlocked);
      this.projectileSystem.destroy();
      this.sights.destroy();
      this.grenades.destroy();
      this.pickups.destroy();
      this.fragments.destroy();
      this.impactDamage.destroy();
      this.weaponSystem.destroy();
      this.fx.destroy();
      this.damageNumbers.destroy();
      this.hud.destroy();
    });

    if (this.onExit) {
      this.input.keyboard?.once('keydown-ESC', () => this.onExit?.());
    }
  }

  update(_time: number, delta: number): void {
    // ---- 命中顿帧：冻结世界（含物理步进）极短时间 ----
    this.hitStop.update(delta);
    if (this.hitStop.active) {
      if (!this.physicsFrozen) {
        this.matter.world.pause();
        this.physicsFrozen = true;
      }
      return;
    }
    if (this.physicsFrozen) {
      this.matter.world.resume();
      this.physicsFrozen = false;
    }

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
    // G 键：为"当前操作中的玩家"取出/收起手榴弹
    if (this.inputManager.readGrenadeToggle()) {
      const owner = this.players[this.aimOwner];
      if (owner) this.grenades.toggle(owner);
    }

    this.sights.update(this.players);
    this.grenades.update(delta, this.players);
    this.projectileSystem.update(delta);
    // 每帧检测自动拾取（空手路过武器 / 手榴弹进背包）
    this.pickups.tryPickup(EMPTY_PRESSED);
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
    this.damageNumbers.update(delta);
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

  /** 主攻击：手持手榴弹时投掷，否则开火 / 刺击 / 挥砍 */
  private handleAttacks(cmds: InputCommand[]): void {
    this.players.forEach((player, i) => {
      if (!cmds[i].attack && !cmds[i].attackHeld) return;

      if (player.grenadeMode) {
        if (cmds[i].attack) this.grenades.throwGrenade(player);
        return;
      }

      this.weaponSystem.tryAttack(player, {
        attack: cmds[i].attack,
        attackHeld: cmds[i].attackHeld,
      });
    });
  }

  /**
   * 副攻击（右键 / Shift / E）：
   *   按下 → 优先"替换地上的武器"；否则手持可投掷近战武器时**开始瞄准**（显示抛物线预览）；
   *          其余情况踢。
   *   按住 → 持续显示预览；**松开才真正投出**。
   */
  private handleSecondary(cmds: InputCommand[]): void {
    const pressed = new Set<number>();
    this.players.forEach((player, i) => {
      if (cmds[i].kick || cmds[i].swap) pressed.add(player.id);
    });

    const consumed = pressed.size > 0 ? this.pickups.tryPickup(pressed) : new Set<number>();

    this.players.forEach((player, i) => {
      const cmd = cmds[i];

      if (pressed.has(player.id) && !consumed.has(player.id)) {
        // 手持可投掷近战武器 + 按住副攻击键 → 进入瞄准（不立刻投出）
        const aiming = cmd.kickHeld && this.weaponSystem.beginThrowAim(player);
        if (!aiming) {
          this.weaponSystem.tryKick(player);
        }
      }

      // 每帧推进：按住画预览，松开则投出
      this.weaponSystem.updateThrowAim(player, cmd.kickHeld);
    });
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
