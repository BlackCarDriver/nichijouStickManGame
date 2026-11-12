import Phaser from 'phaser';
import { InputManager } from '../core/InputManager';
import type { InputCommand } from '../core/InputCommand';
import { Player } from '../entities/Player';
import { CameraRig } from '../camera/CameraRig';
import { GameFeel } from '../feel/GameFeel';
import { HitStop } from '../feel/HitStop';
import { AudioSystem } from '../audio/AudioSystem';
import { getDefaultMap, getPrefabTable, getMapByName } from '../map/MapRegistry';
import type { PrefabData } from '../map/PrefabFormat';
import type { MapData } from '../map/MapFormat';
import type { ActionClip } from '../editor/ActionFormat';
import { buildMap, syncCompoundVisuals } from '../map/MapLoader';
import type { MapObjectRuntime } from '../map/MapLoader';
import { MATERIALS } from '../config/materials';
import { preloadMaterialTextures } from '../map/TextureLoader';
import { WorldRegistry } from '../world/WorldRegistry';
import { DestructionSystem } from '../world/DestructionSystem';
import { PickupSystem } from '../world/PickupSystem';
import { DropSystem } from '../world/DropSystem';
import { ItemDropSystem } from '../world/ItemDropSystem';
import { getWeapon } from '../combat/WeaponFormat';
import { FragmentSystem } from '../world/FragmentSystem';
import { ShrapnelSystem } from '../world/ShrapnelSystem';
import { WeaponSpawnerSystem } from '../world/WeaponSpawnerSystem';
import { ImpactDamageSystem } from '../world/ImpactDamageSystem';
import { DamageSystem } from '../combat/DamageSystem';
import { ProjectileSystem } from '../combat/ProjectileSystem';
import { WeaponSystem } from '../combat/WeaponSystem';
import { ExplosionSystem } from '../combat/ExplosionSystem';
import { AimSightSystem } from '../combat/AimSightSystem';
import { GrenadeSystem } from '../combat/GrenadeSystem';
import { FxSystem } from '../fx/FxSystem';
import { Hud } from '../ui/Hud';
import { getFakeProfiles } from '../config/playerProfiles';
import { DamageNumbers } from '../ui/DamageNumbers';
import { SlashTrail } from '../fx/SlashTrail';

/**
 * 玩家配色（按出生点顺序取用）。
 * 目前本地双人只用到前两个，但**配色不限于两种**：
 * 联机 4~8 人时按顺序取色，HUD / 骨骼 / 光刀颜色都会自动跟随该值。
 */
const PLAYER_COLORS = [
  0xe74c3c, // 红
  0x3498db, // 蓝
  0x2ecc71, // 绿
  0xf1c40f, // 黄
  0x9b59b6, // 紫
  0xe67e22, // 橙
  0x1abc9c, // 青
  0xecf0f1, // 白
];

/** 取第 i 个玩家的颜色（玩家数超过配色表时循环） */
function playerColor(i: number): number {
  return PLAYER_COLORS[i % PLAYER_COLORS.length];
}
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
  /** 编辑器 Play Test 传入的动作资源 */
  actions?: ActionClip[];
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
  private actionClips: ActionClip[] = [];
  private onExit?: () => void;

  // ---- 伤害 / 破坏 / 表现 ----
  private worldRegistry!: WorldRegistry;
  private destruction!: DestructionSystem;
  private damageSystem!: DamageSystem;
  private explosion!: ExplosionSystem;
  private fx!: FxSystem;
  private hud!: Hud;
  private damageNumbers!: DamageNumbers;
  private slashTrail!: SlashTrail;
  private readonly bodyToPlayer = new Map<number, Player>();
  private aimOwner: 0 | 1 = 0;

  // ---- 武器 / 掉落 / 碎片 ----
  private weaponSystem!: WeaponSystem;
  private projectileSystem!: ProjectileSystem;
  private sights!: AimSightSystem;
  private grenades!: GrenadeSystem;
  private pickups!: PickupSystem;
  private drops!: DropSystem;
  private itemDrops!: ItemDropSystem;
  private fragments!: FragmentSystem;
  private shrapnel!: ShrapnelSystem;
  private weaponSpawner!: WeaponSpawnerSystem;
  private impactDamage!: ImpactDamageSystem;

  /** 首次用户手势时启动 AudioContext（浏览器自动播放策略） */
  private readonly unlockAudio = (): void => {
    this.audio.unlock();
  };

  constructor() {
    super('GameScene');
  }

  /**
   * 支持 `?map=<地图名>` 直接进指定地图（试玩/调试用）。
   * 例：http://localhost:5173/?map=rustworks
   */
  private static mapFromUrl(): MapData | undefined {
    if (typeof window === 'undefined') return undefined;
    const name = new URLSearchParams(window.location.search).get('map');
    if (!name) return undefined;
    const found = getMapByName(name);
    if (!found) {
      console.warn(`[GameScene] ?map=${name} 不存在，回退默认地图`);
    }
    return found;
  }

  init(data: GameSceneData = {}): void {
    this.mapData = data.map ?? GameScene.mapFromUrl() ?? getDefaultMap();
    this.prefabTable = data.prefabs ?? getPrefabTable();
    this.actionClips = data.actions ?? [];
    this.onExit = data.onExit;
    this.players = [];
    this.mapObjects = [];
    this.oneWayBodies = [];
    this.bodyToPlayer.clear();
  }

  preload(): void {
    // 材质贴图 + 地图物体自带的对象级贴图
    const objectTextures = (this.mapData.objects ?? [])
      .map((o) => (o.type === 'rect' ? o.texture : undefined))
      .filter((t): t is string => !!t);
    preloadMaterialTextures(this, [
      ...Object.values(MATERIALS).map((m) => m.texture),
      ...objectTextures,
    ]);
  }

  create(): void {
    // 屏蔽浏览器右键菜单（否则右键踢/投掷会弹出系统菜单）
    this.input.mouse?.disableContextMenu();

    this.inputManager = new InputManager(this);
    this.mapObjects = buildMap(this, this.mapData, this.prefabTable);
    this.oneWayBodies = this.mapObjects.filter((o) => o.oneWay && o.body).map((o) => o.body!);

    const spawn = this.mapData.spawnPoints;
    this.players = spawn.map((p, i) => new Player(this, p.x, p.y, playerColor(i), this.actionClips));
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
    // 补给道具（医疗包/防弹衣）：地图固定点 + 维持数量
    this.itemDrops = new ItemDropSystem(this, this.pickups, this.mapData);
    // 武器掉落点（固定/随机武器，可配刷新）
    this.weaponSpawner = new WeaponSpawnerSystem(this, this.pickups, this.mapData);
    this.fragments = new FragmentSystem(this);
    // 爆炸破片（手榴弹/火箭炮）：真刚体 + 命中伤害
    this.shrapnel = new ShrapnelSystem(
      this,
      this.damageSystem,
      this.worldRegistry,
      this.bodyToPlayer,
      this.fx,
    );
    this.explosion.attachShrapnel(this.shrapnel);
    this.impactDamage = new ImpactDamageSystem(this, this.damageSystem, this.worldRegistry);

    this.damageNumbers = new DamageNumbers(this);
    this.slashTrail = new SlashTrail(this);
    this.hud = new Hud(this);
    // 昵称/头像：现阶段用假资料占位，接联机后换成房间玩家列表
    this.hud.bind(this.players, getFakeProfiles(this.players.length));
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
      _reason: 'empty' | 'thrown' | 'death',
      _snapshot?: { ammo: number },
    ): void => {
      // 目前只做表现层反馈（在 WeaponSystem 里已播放特效）
    };

    // 投掷武器插不进去（目标硬度 >= 投掷伤害）→ 掉到地上变成可拾取物
    const onThrownBlocked = (weaponId: string, x: number, y: number): void => {
      this.pickups.spawn(weaponId, x, y, { falling: true });
    };

    // 腰上手榴弹被子弹击中 → 消耗这一发并在腰部爆炸（击杀归属算开枪者）
    const onCarriedGrenadeHit = (
      player: Player,
      point: { x: number; y: number },
      shooterId?: number,
    ): void => {
      if (!this.grenades.detonate(player)) return;
      const explosion = getWeapon('grenade')?.explosion;
      if (!explosion) return;
      this.explosion.explode({
        x: point.x,
        y: point.y,
        radius: explosion.radius,
        damage: explosion.damage,
        // 身上的榴弹炸了 → 自己肯定要受伤害
        selfDamage: true,
        knockback: explosion.knockback,
        ownerId: player.id,
        sourceId: shooterId ?? player.id,
        // 子弹刚造成受击无敌，这里必须穿透，否则爆炸会被自己这一发子弹免疫掉
        ignoreInvuln: true,
      });
    };

    // 拾取武器：如果这个武器带 super 配置（光刀）→ 自动进入超级战士
    const onWeaponPicked = (player: Player, weaponId: string): void => {
      const superCfg = getWeapon(weaponId)?.super;
      if (superCfg) player.enterSuperMode(superCfg);
    };

    // 道具生效（医疗包回血 / 防弹衣加护盾）→ 头顶气泡（绿 +40 / 灰 +100）
    const onItemUsed = (player: Player, itemId: string, amount: number): void => {
      this.damageNumbers.show(player, amount, {
        kind: itemId === 'medkit' ? 'heal' : 'shield',
      });
    };

    // 护盾吸收伤害 → 火花 + 轻微顿帧 + 音效（不弹伤害数字，避免误读成掉血）
    const onPlayerShielded = (player: Player, absorbed: number, _kind: string): void => {
      this.hitStop.trigger(HitStop.durationForDamage(absorbed) * 0.6);
      this.audio.play('hit');
      this.fx.hitSpark(
        { x: player.container.x, y: player.container.y - 20 },
        { x: 0, y: -1 },
        player.isSuperMode ? 0xffe066 : 0xc8d0dc,
      );
    };

    // 超级战士开/关 → 光环特效 + 音效 + 镜头冲击
    const onSuperMode = (player: Player, active: boolean): void => {
      const cx = player.container.x;
      const cy = player.container.y - 20;
      this.fx.burst({ x: cx, y: cy }, 0xffe066);
      this.fx.ring(cx, cy, 70, 0xffe066, 420);
      this.audio.play('pickup');
      if (active) this.gameFeel.addTrauma(0.25);
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
    this.events.on('weapon-picked', onWeaponPicked);
    this.events.on('item-used', onItemUsed);
    this.events.on('player-shielded', onPlayerShielded);
    this.events.on('super-mode', onSuperMode);
    this.events.on('carried-grenade-hit', onCarriedGrenadeHit);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off('player-hit', onPlayerHit);
      this.events.off('weapon-recoil', onWeaponRecoil);
      this.events.off('player-damaged', onPlayerDamaged);
      this.events.off('player-died', onPlayerDied);
      this.events.off('sfx', onSfx);
      this.input.off('pointerdown', this.unlockAudio);
      this.input.keyboard?.off('keydown', this.unlockAudio);
      if (this.physicsFrozen) {
        this.matter.world?.resume();
        this.physicsFrozen = false;
      }
      this.events.off('explosion', onExplosion);
      this.events.off('object-destroyed', onObjectDestroyed);
      this.events.off('weapon-lost', onWeaponLost);
      this.events.off('thrown-blocked', onThrownBlocked);
      this.events.off('weapon-picked', onWeaponPicked);
      this.events.off('item-used', onItemUsed);
      this.events.off('player-shielded', onPlayerShielded);
      this.events.off('super-mode', onSuperMode);
      this.events.off('carried-grenade-hit', onCarriedGrenadeHit);
      this.teardownSystems();
    });

    if (this.onExit) {
      this.input.keyboard?.once('keydown-ESC', () => this.onExit?.());
    }
  }

  /**
   * 逐个子系统清理。
   *
   * 为什么每个都包 try/catch：这段代码跑在 Phaser 的 SHUTDOWN 事件里，
   * 而物理插件此时**已经被关闭**（`this.matter.world` 变成 null）。
   * 只要有一个 destroy() 抛异常，后面的 destroy() 与「返回编辑器」就全都不执行，
   * 表现为编辑器点测试后返回不了、画面冻结（真实踩过的坑）。
   * 宁可某个系统清理失败并打日志，也不能让整个场景收尾中断。
   */
  private teardownSystems(): void {
    const systems: Array<[string, () => void]> = [
      ['projectile', () => this.projectileSystem.destroy()],
      ['sights', () => this.sights.destroy()],
      ['grenades', () => this.grenades.destroy()],
      ['pickups', () => this.pickups.destroy()],
      ['fragments', () => this.fragments.destroy()],
      ['shrapnel', () => this.shrapnel.destroy()],
      ['weaponSpawner', () => this.weaponSpawner.destroy()],
      ['impactDamage', () => this.impactDamage.destroy()],
      ['weapon', () => this.weaponSystem.destroy()],
      ['fx', () => this.fx.destroy()],
      ['damageNumbers', () => this.damageNumbers.destroy()],
      ['slashTrail', () => this.slashTrail.destroy()],
      ['hud', () => this.hud.destroy()],
    ];
    for (const [name, destroy] of systems) {
      try {
        destroy();
      } catch (err) {
        console.error(`[GameScene] ${name} 清理失败（已跳过，不影响场景退出）:`, err);
      }
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
    this.itemDrops.update(delta);
    this.fragments.update(delta);
    this.shrapnel.update(delta);
    this.weaponSpawner.update(delta);
    this.updateOneWayCollisions();
    syncCompoundVisuals(this.mapObjects);
    this.updateCameraTarget(cmd1, cmd2);
    if (this.cameraTarget && this.cameraRig) {
      this.cameraRig.update(this.cameraTarget, delta);
    }
    this.gameFeel.update(this.cameras.main, this.cameraRig.shakeOffset, delta);
    this.fx.update(delta);
    this.slashTrail.update(delta, this.players);
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
