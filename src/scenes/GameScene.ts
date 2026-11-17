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
import { buildMap, collectMapWeapons, syncCompoundVisuals } from '../map/MapLoader';
import { syncVisualMasks } from '../map/ShapeTexture';
import { updateMaterialGlows } from '../map/MaterialGlow';
import { updateObjectLabels } from '../map/ObjectLabel';
import type { MapObjectRuntime } from '../map/MapLoader';
import type { DamageInfo } from '../combat/DamageInfo';
import { buildThrownBullet } from '../combat/WeaponSystem';
import type { ShotWire } from '../net/protocol';
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
import { HazardSystem } from '../world/HazardSystem';
import { DamageSystem } from '../combat/DamageSystem';
import { ProjectileSystem } from '../combat/ProjectileSystem';
import { WeaponSystem } from '../combat/WeaponSystem';
import { ExplosionSystem } from '../combat/ExplosionSystem';
import { AimSightSystem } from '../combat/AimSightSystem';
import { GrenadeSystem } from '../combat/GrenadeSystem';
import { FxSystem } from '../fx/FxSystem';
import { CasingSystem } from '../fx/CasingSystem';
import { Hud } from '../ui/Hud';
import { DeathNotice } from '../ui/DeathNotice';
import { getFakeProfiles } from '../config/playerProfiles';
import { DamageNumbers } from '../ui/DamageNumbers';
import { SlashTrail } from '../fx/SlashTrail';
import { OnlineMatch } from '../net/OnlineMatch';
import type { MatchContext, MatchMode, MatchPlayer } from '../net/protocol';
import { emptyInput } from '../core/InputCommand';
import type { PlayerProfile } from '../config/playerProfiles';
import { OffscreenIndicators } from '../ui/OffscreenIndicators';
import { startGate } from '../net/startGate';
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  getRenderScale,
  RENDER_SCALE_EXPLICIT,
  setRenderScale,
  viewScaleOf,
} from '../config/display';

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
/**
 * 默认镜头缩放（设计单位；比原来更近）。
 * 具体武器可在 data/weapons.json 用 cameraZoom 覆盖。
 * 实际相机 zoom = 设计值 × RENDER_SCALE（内部渲染分辨率放大后保持同一视野）。
 */
const CAMERA_ZOOM = 1.12;

/** 启动场景时可传入的数据（编辑器 Play test 用） */
export interface GameSceneData {
  /** 要加载的地图；不传则用默认地图 */
  map?: MapData;
  /** 预制件表；编辑器测试时传入"含未保存草稿"的表，不传则读 data/prefabs */
  prefabs?: Record<string, PrefabData>;
  /** 返回编辑器等外部回调（Esc 键触发） */
  onExit?: () => void;
  /** 联机对局：由 RoomController 在 match_start 时传入 */
  online?: MatchContext;
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
  private deathNotice!: DeathNotice;
  /** 联机：死亡后观战跟随的目标（默认跟随击败自己的人） */
  private spectateTarget: Player | null = null;
  /** 联机：本地已经提前播过伤害数字的攻击批次（hp 到达时不再重复播） */
  private previewedHits = new Set<number>();
  /** 预览批次只保留最近 N 个，避免无限增长 */
  private previewedHitOrder: number[] = [];
  private audio!: AudioSystem;
  /** 顿帧期间物理是否已被暂停（避免重复 pause/resume） */
  private physicsFrozen = false;
  /** 联机同步异常是否已经打过日志（避免每帧刷屏） */
  private netErrorLogged = false;
  /** playerId → 击杀数 */
  private readonly kills = new Map<number, number>();
  /** playerId → 剩余生命数（含当前这条；0 = 已出局） */
  private readonly lives = new Map<number, number>();
  /** playerId → 剩余复活次数 */
  private readonly revives = new Map<number, number>();
  /** playerId → 复活截止时刻（performance.now 毫秒；不在等复活则不存在） */
  private readonly respawnAt = new Map<number, number>();
  /** 本地死亡提示的倒计时刷新节流 */
  private respawnTextAt = 0;
  private mapObjects: MapObjectRuntime[] = [];
  // ---- 联机 ----
  private onlineData: MatchContext | null = null;
  private online: OnlineMatch | null = null;
  /** netId → Player（联机时玩家来自 roster，而非地图出生点数量） */
  private onlinePlayers = new Map<number, Player>();
  private onlineNicks = new Map<number, string>();
  /** netId → 队伍编号（团队战 0/1；混战为空） */
  private onlineTeams = new Map<number, number>();
  /** 本局模式（团队战用于友伤/比分/结算文案） */
  private matchMode: MatchMode = 'ffa';
  private offscreen: OffscreenIndicators | null = null;
  /** netId → 聊天室头像地址 / 已生成的圆形头像贴图 key */
  /** netId → 头像 URL（初始 roster + 中途加入的玩家） */
  private avatarSources = new Map<number, string>();
  private avatarUrls = new Map<number, string>();
  /** 性能看门狗：连续低帧率时降低内部渲染分辨率（每局只降一次） */
  private perfTimer = 0;
  private perfLowStreak = 0;
  private perfDowngraded = false;
  /** 头像贴图还在异步加载（决定什么时候算"开局就绪"） */
  private avatarLoading = false;
  private avatarCircleKeys = new Map<number, string>();
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
  /** 抛壳特效（纯视觉，仅实弹枪） */
  private casings!: CasingSystem;
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
  // 联机时掉落/空投由服务端仲裁，这三个本地系统不创建
  private drops: DropSystem | null = null;
  private itemDrops: ItemDropSystem | null = null;
  private weaponSpawner: WeaponSpawnerSystem | null = null;
  private fragments!: FragmentSystem;
  private shrapnel!: ShrapnelSystem;
  private impactDamage!: ImpactDamageSystem;
  /** 接触伤害（材质 damagePerSecond：岩浆/尖刺等） */
  private hazard!: HazardSystem;
  /** 材质爆炸：待处理队列（用迭代而不是递归，避免长连锁爆栈） */
  private readonly pendingExplosions: Array<{
    id: string;
    x: number;
    y: number;
    damage: number;
    radius: number;
    knockback: number;
  }> = [];
  /** 已经爆过的物体 id（每个只爆一次，防止连锁循环） */
  private readonly explodedObjects = new Set<string>();
  /** 正在冲洗爆炸队列（防重入） */
  private flushingExplosions = false;

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
    this.onlineData = data.online ?? null;
    this.matchMode = data.online?.mode ?? 'ffa';
    this.onlinePlayers = new Map();
    this.onlineNicks = new Map();
    this.onlineTeams = new Map();
    this.avatarSources = new Map();
    this.avatarUrls = new Map();
    this.avatarCircleKeys = new Map();
    this.mapData = data.online
      ? getMapByName(data.online.map) ?? getDefaultMap()
      : data.map ?? GameScene.mapFromUrl() ?? getDefaultMap();
    this.prefabTable = data.prefabs ?? getPrefabTable();
    this.onExit = data.onExit;
    this.players = [];
    this.mapObjects = [];
    this.oneWayBodies = [];
    this.lives.clear();
    this.revives.clear();
    this.respawnAt.clear();
    this.bodyToPlayer.clear();
  }

  preload(): void {
    if (this.onlineData) {
      startGate.setProgress(0.3, '加载地图与贴图…');
      this.load.on(Phaser.Loader.Events.PROGRESS, (p: number) => {
        startGate.setProgress(0.3 + Math.max(0, Math.min(1, p)) * 0.5, '加载地图与贴图…');
      });
    }
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
    if (this.onlineData) {
      // 联机：玩家列表来自服务端 roster（顺序、颜色、出生点都由服务端分配）
      const roster = [...this.onlineData.players].sort((a, b) => a.netId - b.netId);
      this.players = roster.map((entry) => {
        const point = spawn[entry.spawn % spawn.length];
        const player = new Player(this, point.x, point.y, playerColor(entry.color));
        this.onlinePlayers.set(entry.netId, player);
        this.onlineNicks.set(entry.netId, entry.nick);
        if (entry.team >= 0) this.onlineTeams.set(entry.netId, entry.team);
        return player;
      });
    } else {
      // 单机双人沙盒：只取前两个出生点（地图现在为多人乱斗准备了更多出生点）
      this.players = spawn
        .slice(0, 2)
        .map((p, i) => new Player(this, p.x, p.y, playerColor(i)));
    }
    const localPlayer =
      this.onlineData && this.onlineData.you >= 0 ? this.onlinePlayers.get(this.onlineData.you) : undefined;
    this.cameraTarget = localPlayer ?? this.players[0];
    for (const player of this.players) {
      this.bodyToPlayer.set(player.body.id, player);
    }

    // ---- 表现层 ----
    this.fx = new FxSystem(this);
    this.casings = new CasingSystem(this);

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
      this.casings,
    );

    // ---- 瞄准辅助线（狙击枪红外线）----
    this.sights = new AimSightSystem(this);
    // ---- 手榴弹（背包道具）----
    this.grenades = new GrenadeSystem(this, this.projectileSystem);
    // ---- 团队战规则（友军无伤害 + 子弹/近战穿过队友）----
    this.applyTeamRules();

    // ---- 掉落 / 碎片 ----
    this.pickups = new PickupSystem(this, this.bodyToPlayer, this.fx);
    if (!this.onlineData) {
      this.drops = new DropSystem(this, this.pickups, this.mapData);
      // 补给道具（医疗包/防弹衣）：地图固定点 + 维持数量
      this.itemDrops = new ItemDropSystem(this, this.pickups, this.mapData);
      // 武器掉落点（固定/随机武器，可配刷新）
      // 武器掉落点 = 地图自带 + 预制件自带（预制件里的坐标已按实例旋转/翻转展开）
      this.weaponSpawner = new WeaponSpawnerSystem(this, this.pickups, collectMapWeapons(this.mapData, this.prefabTable));
    }
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
    this.hazard = new HazardSystem(this, this.bodyToPlayer, this.worldRegistry);

    this.damageNumbers = new DamageNumbers(this);
    this.slashTrail = new SlashTrail(this);
    this.hud = new Hud(this);
    this.deathNotice = new DeathNotice(this);
    // 单机用假资料占位；联机用服务端下发的房间玩家昵称
    this.hud.bind(this.players, this.profiles());
    this.hud.bindKills(this.kills);
    // 命数（可复活次数）：HUD 面板显示"复活 ×N"
    this.hud.bindLives(this.lives, this.revives);
    // 团队战：底部队伍比分（玩家 → 队伍 由 roster 决定）
    this.hud.setTeams(this.matchMode, (player) => this.teamOfNetId(this.netIdOfEntity(player)));
    // 出生空手：所有武器一律靠捡（天降武器 + 场上掉落物）

    const cam = this.cameras.main;
    cam.setBackgroundColor('#1a1a2e');
    cam.setBounds(0, 0, this.mapData.width, this.mapData.height);
    this.cameraRig = new CameraRig(
      cam,
      this.mapData.width,
      this.mapData.height,
      CAMERA_ZOOM * viewScaleOf(cam.width),
    );
    this.gameFeel = new GameFeel();
    this.hitStop = new HitStop();
    this.audio = new AudioSystem();
    this.kills.clear();
    this.physicsFrozen = false;
    this.pendingExplosions.length = 0;
    this.explodedObjects.clear();
    this.flushingExplosions = false;

    // AudioContext 必须在用户手势后才能启动
    this.input.on('pointerdown', this.unlockAudio);
    this.input.keyboard?.on('keydown', this.unlockAudio);
    // M 键静音切换
    this.input.keyboard?.on('keydown-M', () => this.audio.toggleMute());

    if (this.onlineData) {
      this.offscreen = new OffscreenIndicators(this);
      this.online = new OnlineMatch({
        scene: this,
        ctx: this.onlineData,
        players: this.onlinePlayers,
        pickups: this.pickups,
        destruction: this.destruction,
        damage: this.damageSystem,
        mapObjects: this.mapObjects,
        worldSize: { width: this.mapData.width, height: this.mapData.height },
        kills: this.kills,
        lives: this.lives,
        revives: this.revives,
        respawnAt: this.respawnAt,
        onRosterChanged: () => this.onRosterChanged(),
        spawnPlayer: (entry, stat) => this.spawnNetPlayer(entry, stat),
        onChat: (nick, text) => this.showChatBubble(nick, text),
        onHitPreview: (target, info) => this.showHitPreview(target, info),
        onRemoteShot: (shooter, shots) => this.spawnRemoteShots(shooter, shots),
      });
      // 投掷物出生拦截：自己的广播出去，别人的等中继事件（见 spawnRemoteShots）
      this.projectileSystem.onSpawn = (opts) => this.online?.interceptSpawn(opts) ?? true;
      // 昵称先就位；头像贴图异步加载完后再补
      for (const entry of this.onlineData.players) {
        if (entry.avatar) this.avatarSources.set(entry.netId, entry.avatar);
      }
      for (const [netId, player] of this.onlinePlayers) this.applyIdentity(netId, player);
      this.loadAvatars();
      startGate.setProgress(0.92, '准备战场…');
      // 头像来自聊天室 CDN，可能很慢甚至挂住：**绝不能**让它挡住开局闸门。
      // 先把"可以开始"放出来，头像晚到时会由 finishAvatars() 再补一次身份展示。
      this.time.delayedCall(0, () => startGate.markReady());
    }

    this.bindEvents();
  }

  /** 玩家展示资料：联机取 roster 昵称，单机取假数据占位 */
  private profiles(): PlayerProfile[] {
    if (!this.onlineData) return getFakeProfiles(this.players.length);
    return this.players.map((player) => ({
      nickname: this.onlineNicks.get(this.netIdOfEntity(player)) ?? '玩家',
    }));
  }

  /** 给玩家套上聊天室昵称与（已加载好的）圆形头像 */
  private applyIdentity(netId: number, player: Player): void {
    const nick = this.onlineNicks.get(netId) ?? '';
    const circleKey = this.avatarCircleKeys.get(netId);
    player.setIdentity(nick, circleKey);
  }

  /** 联机：加载聊天室头像（跨域头像加载失败时自动退回程序化火柴人头像） */
  private loadAvatars(): void {
    this.load.crossOrigin = 'anonymous';
    let pending = 0;
    for (const [netId, url] of this.avatarSources) {
      if (!url) continue;
      const key = avatarRawKey(netId, url);
      this.avatarUrls.set(netId, key);
      if (this.textures.exists(key) || this.textures.exists(`${key}_c`)) continue;
      this.load.image(key, url);
      pending++;
    }
    if (pending === 0) {
      this.finishAvatars();
      return;
    }
    if (this.avatarLoading) return;
    this.avatarLoading = true;
    // 加载完成 → 应用头像（晚到的头像也会在这里补上，不影响开局）
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.finishAvatars());
    this.load.start();
    // 兜底：CDN 卡住时先解除"加载中"标记（头像真到了仍会由 COMPLETE 补上）
    this.time.delayedCall(3000, () => {
      this.avatarLoading = false;
    });
  }

  /** 头像加载完成：做成圆形贴图 → 应用到玩家头顶 + HUD。可重复调用（只应用已就绪的）。 */
  private finishAvatars(): void {
    for (const [netId, rawKey] of this.avatarUrls) {
      if (!this.textures.exists(rawKey)) continue;
      const circleKey = `${rawKey}_c`;
      if (!this.textures.exists(circleKey) && !makeCircleAvatar(this, rawKey, circleKey)) continue;
      this.avatarCircleKeys.set(netId, circleKey);
      const player = this.onlinePlayers.get(netId);
      if (player) this.applyIdentity(netId, player);
    }
    this.hud.bind(this.players, this.profiles());
    this.avatarLoading = false;
    startGate.markReady();
  }

  /** 对局中途加入的新玩家（服务端 player_join） */
  private spawnNetPlayer(entry: MatchPlayer, stat: { hp: number; shield: number; dead: boolean; kills: number }): void {
    if (this.onlinePlayers.has(entry.netId)) return;
    const spawn = this.mapData.spawnPoints[entry.spawn % this.mapData.spawnPoints.length];
    const player = new Player(this, spawn.x, spawn.y, playerColor(entry.color));
    player.netControlled = true;
    player.autoRespawn = false;
    // 摔落伤害由"自己"检测（房主不再替别人算）
    player.envDamageReporter =
      entry.netId === this.onlineData?.you ? (amount) => this.online?.reportEnvDamage(amount) : undefined;
    this.players.push(player);
    this.onlinePlayers.set(entry.netId, player);
    this.onlineNicks.set(entry.netId, entry.nick);
    if (entry.team >= 0) this.onlineTeams.set(entry.netId, entry.team);
    if (entry.avatar) {
      this.avatarSources.set(entry.netId, entry.avatar);
      this.loadAvatars();
    }
    this.bodyToPlayer.set(player.body.id, player);
    this.kills.set(player.id, stat.kills ?? 0);
    player.applyNetSnapshot({ hp: stat.hp, shield: stat.shield, dead: stat.dead });
    this.applyIdentity(entry.netId, player);
    this.hud.bind(this.players, this.profiles());
  }

  /** 聊天室消息 → 对应火柴人头顶气泡 */
  private showChatBubble(nick: string, text: string): void {
    for (const [netId, name] of this.onlineNicks) {
      if (name !== nick) continue;
      this.onlinePlayers.get(netId)?.showChat(text);
      return;
    }
  }

  /** 实体 → 网络座位号（不依赖 OnlineMatch 是否已创建） */
  private netIdOfEntity(player: Player): number {
    for (const [netId, p] of this.onlinePlayers) {
      if (p === player) return netId;
    }
    return -1;
  }

  /** 某个座位的队伍编号（团队战 0/1；混战/未知 -1） */
  private teamOfNetId(netId: number): number {
    return this.onlineTeams.get(netId) ?? -1;
  }

  /**
   * 团队战规则注入：友军完全无伤害，且子弹/出拳/刺击/光束穿过友军。
   *
   * 服务端 `handleDamage` 会做同样的仲裁（防作弊 / 防备客户端漏判），
   * 这里只是让本地表现与服务端一致：不飘伤害数字、不挡队友的枪线。
   */
  private applyTeamRules(): void {
    if (!this.onlineData || this.matchMode !== 'tdm') return;
    // 伤害里的 sourceId 是**实体 id**（player.id），不是物理 body id，所以按实体 id 反查座位号
    const netIdOfEntityId = (entityId: number): number => {
      for (const [netId, p] of this.onlinePlayers) {
        if (p.id === entityId) return netId;
      }
      return -1;
    };
    const friendly = (sourceNet: number, targetNet: number): boolean => {
      if (sourceNet < 0 || targetNet < 0 || sourceNet === targetNet) return false;
      const team = this.teamOfNetId(sourceNet);
      return team >= 0 && team === this.teamOfNetId(targetNet);
    };
    this.damageSystem.setAllyFilter((sourceId, target) =>
      friendly(netIdOfEntityId(sourceId), this.netIdOfEntity(target)),
    );
    this.projectileSystem.passThroughTarget = (ownerId, target) =>
      friendly(netIdOfEntityId(ownerId), this.netIdOfEntity(target));
    this.weaponSystem.friendlyOf = (ownerId, target) =>
      friendly(netIdOfEntityId(ownerId), this.netIdOfEntity(target));
  }

  /** 有玩家退出后重建 HUD（OnlineMatch 已销毁对应 Player） */
  private onRosterChanged(): void {
    const entries = [...this.onlinePlayers.entries()].sort((a, b) => a[0] - b[0]);
    for (const player of this.players) {
      if (!entries.some(([, p]) => p === player)) {
        this.bodyToPlayer.delete(player.body.id);
        this.kills.delete(player.id);
      }
    }
    this.players = entries.map(([, p]) => p);
    // 清掉已离场玩家的队伍信息（否则比分/友伤判定会拿旧数据）
    const live = new Set(entries.map(([netId]) => netId));
    for (const netId of [...this.onlineTeams.keys()]) {
      if (!live.has(netId)) this.onlineTeams.delete(netId);
    }
    if (this.cameraTarget && !entries.some(([, p]) => p === this.cameraTarget)) {
      this.cameraTarget = this.players[0] ?? null;
      if (this.cameraTarget) this.cameraRig?.snapTo(this.cameraTarget.container.x, this.cameraTarget.container.y);
    }
    this.hud.bind(this.players, this.profiles());
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
      const mat = MATERIALS[runtime.material];
      const colorHex = mat?.colorHex ?? '#ffffff';
      this.spawnDestructionFragments(runtime, center, colorHex);
      // 爆炸材质：被破坏时原地爆炸（范围伤害 + 击退 + 视觉，无弹片）
      if (mat?.explosive) this.queueMaterialExplosion(runtime.id, center, mat.explosive);
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
      if (this.online) {
        // 联机：由服务端生成掉落并广播，否则这件武器只存在于本地
        this.online.requestDrop(weaponId, -1, x, y);
        return;
      }
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
        weaponId: 'grenade',
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
      // 护盾被消耗：灰色气泡（消耗量）
      this.damageNumbers.show(player, absorbed, { kind: 'shieldLoss' });
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
      player: Player,
      amount: number,
      kind: string,
      critical: boolean,
      incoming: number,
      attackId?: number,
    ): void => {
      // 联机：这次命中本地已经提前播过数字/音效 → 只补血量，不再重复播
      const seen = attackId !== undefined && this.previewedHits.has(attackId);
      if (seen) return;
      if (kind !== 'env') {
        this.hitStop.trigger(HitStop.durationForDamage(amount));
      }
      this.audio.play('hit');
      // 伤害气泡用"本次攻击的伤害值"（incoming），而不是被剩余血量截断后的 amount
      this.damageNumbers.show(player, incoming, { crit: critical });
    };
    // 接触伤害（岩浆/尖刺等）：每秒汇总一个数字，避免 4 次/秒刷屏
    const onHazardDamaged = (player: Player, amount: number): void => {
      this.damageNumbers.show(player, amount);
    };

    // 死亡 → 音效 + 击杀计数（记录凶手）+ 死亡回放（被谁/用什么击败 + 观战镜头）
    const onPlayerDied = (victim: Player, killerId?: number): void => {
      this.audio.play('death');
      // 联机：击杀数由服务端 hp 消息下发，本地不再累加
      if (!this.online && killerId !== undefined && killerId !== victim.id) {
        this.kills.set(killerId, (this.kills.get(killerId) ?? 0) + 1);
      }
      this.handlePlayerDeath(victim, killerId);
    };
    // 复活（单机倒计时结束 / 联机服务端 respawn）：收起死亡提示并交还镜头
    const onPlayerRespawn = (player: Player): void => {
      if (this.online && player !== this.online.localPlayer) return;
      this.deathNotice?.hide();
      this.spectateTarget = null;
      this.respawnTextAt = 0;
    };
    // 统一音效路由
    const onSfx = (name: string): void => {
      this.audio.playWeapon(name);
    };

    this.events.on('player-hit', onPlayerHit);
    this.events.on('weapon-recoil', onWeaponRecoil);
    this.events.on('player-damaged', onPlayerDamaged);
    this.events.on('hazard-damaged', onHazardDamaged);
    this.events.on('player-died', onPlayerDied);
    this.events.on('player-respawn', onPlayerRespawn);
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
      this.events.off('hazard-damaged', onHazardDamaged);
      this.events.off('player-died', onPlayerDied);
      this.events.off('player-respawn', onPlayerRespawn);
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
      try {
        this.online?.dispose();
      } catch (err) {
        console.error('[GameScene] 联机层清理失败:', err);
      }
      this.online = null;
      this.offscreen?.destroy();
      this.offscreen = null;
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
      ['weaponSpawner', () => this.weaponSpawner?.destroy()],
      ['impactDamage', () => this.impactDamage.destroy()],
      ['hazard', () => this.hazard.destroy()],
      ['weapon', () => this.weaponSystem.destroy()],
      ['fx', () => this.fx.destroy()],
      ['casings', () => this.casings.destroy()],
      ['damageNumbers', () => this.damageNumbers.destroy()],
      ['slashTrail', () => this.slashTrail.destroy()],
      ['hud', () => this.hud.destroy()],
      ['deathNotice', () => this.deathNotice?.destroy()],
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
    // ---- 命中顿帧：单机冻结世界（含物理步进）极短时间 ----
    // 联机绝对不能暂停物理：房主与各客户端一旦冻结时刻不同，
    // 同一个玩家的轨迹就会分叉（“跳上二楼又闪回一楼”的主要来源之一）。
    // 联机时把顿帧降级为纯表现（镜头/音效），物理与世界模拟照常推进。
    this.hitStop.update(delta);
    if (this.hitStop.active && !this.online) {
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

    this.updatePerformance(delta);

    if (this.online) {
      this.updateOnline(delta);
      return;
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
    this.hazard.update(delta);
    this.drops?.update(delta);
    this.itemDrops?.update(delta);
    this.fragments.update(delta);
    this.shrapnel.update(delta);
    this.weaponSpawner?.update(delta);
    this.updateOneWayCollisions();
    syncCompoundVisuals(this.mapObjects);
    syncVisualMasks(this.mapObjects);
    updateMaterialGlows(this.mapObjects, this.time.now);
    updateObjectLabels(this.mapObjects);
    this.updateCameraTarget(cmd1, cmd2);
    if (this.cameraTarget && this.cameraRig) {
      this.cameraRig.update(this.cameraTarget, delta);
    }
    this.updateCameraZoom(this.cameraTarget);
    this.gameFeel.update(this.cameras.main, this.cameraRig.shakeOffset, delta);
    this.fx.update(delta);
    this.casings.update(delta);
    this.slashTrail.update(delta, this.players);
    this.damageNumbers.update(delta);
    this.hud.update();
    this.deathNotice.update();
  }

  /**
   * 联机：按别人广播的出生状态重建投掷物（视觉同款）。
   *
   * 参数全部来自"开火的人"自己算的枪口/角度，所以两边看到的是同一发子弹：
   * 同一个起点、同一个方向、同一套弹道参数（用 `buildThrownBullet` 等公共构造函数）。
   */
  private spawnRemoteShots(shooter: Player, shots: ShotWire[]): void {
    for (const shot of shots) {
      const weapon = getWeapon(shot.w);
      if (!weapon) continue;

      let bullet = weapon.bullet;
      if (shot.k === 'throw' && weapon.throw) bullet = buildThrownBullet(weapon);
      else if (shot.k === 'grenade') {
        const g = getWeapon('grenade');
        if (!g?.throw) continue;
        bullet = { ...buildThrownBullet(g), kind: 'grenade', size: 5, trail: 0 };
      }
      if (!bullet) continue;

      const isGrenade = shot.k === 'grenade';
      this.projectileSystem.spawn({
        weaponId: shot.w,
        x: shot.x,
        y: shot.y,
        angle: shot.a,
        damage: weapon.damage,
        knockback: weapon.knockback,
        ownerId: shooter.id,
        ownerBody: shooter.body,
        bullet,
        explosion: weapon.explosion,
        fuseMs: isGrenade ? weapon.throw?.fuseMs : weapon.throw?.fuseMs,
        stickMs: weapon.throw?.stickMs,
        attackId: shot.at,
        relayed: true,
      });
    }
  }

  /**
   * 联机：本地看到命中时的即时打击反馈（不等服务端 `hp`）。
   *
   * - 攻击方：立刻出伤害数字 + 让对手进受击硬直 + 命中音效 → "我打中了"与画面同帧；
   * - 受击方：立刻进受击姿态（视觉）+ 屏幕震动 + 音效 → 不会"半天没反应后突然一顿"；
   * - 血量仍然只由服务端 `hp` 改；数值到达后按攻击批次 id 去重，不重复播。
   */
  private showHitPreview(target: Player, info: DamageInfo): void {
    const attackId = info.attackId;
    if (attackId !== undefined) this.markPreviewed(attackId);

    // 受击硬直/击退表现（不改血量）：攻击方与受击方都立刻播，反馈与命中同帧
    target.previewHit(info.knockback, attackId);

    const isVictim = this.online !== null && target === this.online.localPlayer;
    // 伤害数字立刻出现（第三方的互殴不做预览，见 OnlineMatch 的筛选）
    this.damageNumbers.show(target, info.amount, { crit: info.critical === true });
    this.audio.play('hit');
    if (isVictim) this.gameFeel.addTrauma(0.12);
  }

  /** 记录"这次命中的数字已经播过"（有界，避免长对局无限增长） */
  private markPreviewed(attackId: number): void {
    if (this.previewedHits.has(attackId)) return;
    this.previewedHits.add(attackId);
    this.previewedHitOrder.push(attackId);
    while (this.previewedHitOrder.length > 256) {
      const old = this.previewedHitOrder.shift();
      if (old !== undefined) this.previewedHits.delete(old);
    }
  }

  /**
   * 破坏碎片：数量/散布/大小都按**物体体积**缩放。
   *
   * 用 sqrt(面积) 当"线性尺寸"来算（而不是直接用量）：面积差 4 倍时碎块数只差 2 倍，
   * 否则一个 80×80 的箱子和 2400 宽的地面会差出几十倍。经验值：
   *   60×60   → 6 块
   *   120×120 → 12 块
   *   300×16  → 7 块
   *   大面积  → 封顶 16 块
   * 碎片尺寸也随线性尺寸放大一点，大物体的碎块不会像沙子。
   * 总量由 FragmentSystem 的 MAX_FRAGMENTS 兜底（连锁爆炸不会打崩帧率）。
   */
  private spawnDestructionFragments(
    runtime: MapObjectRuntime,
    center: { x: number; y: number },
    colorHex: string,
  ): void {
    // 面积优先取刚体（多边形/复合体都是真实面积），没有刚体时退回包围盒
    let area = runtime.body ? Math.abs(runtime.body.area) : 0;
    if (!Number.isFinite(area) || area <= 0) {
      const b = runtime.body?.bounds;
      area = b ? Math.max(1, (b.max.x - b.min.x) * (b.max.y - b.min.y)) : 2500;
    }
    const linear = Math.sqrt(Math.max(1, area));
    const pieces = Phaser.Math.Clamp(Math.round(linear / 10), 3, 16);
    const spread = Phaser.Math.Clamp(linear * 0.35, 18, 90);
    const sizeScale = Phaser.Math.Clamp(linear / 90, 0.7, 2.2);
    this.fragments.burst(center.x, center.y, colorHex, pieces, spread, sizeScale);
  }

  /**
   * 材质爆炸（物体被破坏时的自爆）。
   *
   * 设计要点：
   * - **无弹片**：只做范围伤害 + 击退 + 视觉（弹片是手榴弹/火箭筒专属）。
   * - **不递归**：连锁爆炸用队列迭代处理，每个物体只爆一次（`explodedObjects`）。
   * - **联机**：爆炸本身在所有客户端都会跑（破坏事件是广播的），地图物体伤害/击退
   *   各自本地模拟即可；但"玩家伤害"必须由**各自客户端为自己的角色上报**
   *   （材质爆炸没有攻击者，服务端只接受 env 自伤），所以联机时跳过 explode() 的玩家结算。
   */
  private queueMaterialExplosion(
    runtimeId: string,
    center: { x: number; y: number },
    cfg: { damage: number; radius: number; knockback: number },
  ): void {
    if (this.explodedObjects.has(runtimeId)) return;
    this.explodedObjects.add(runtimeId);
    this.pendingExplosions.push({
      id: runtimeId,
      x: center.x,
      y: center.y,
      damage: cfg.damage,
      radius: cfg.radius,
      knockback: cfg.knockback,
    });
    this.flushMaterialExplosions();
  }

  private flushMaterialExplosions(): void {
    if (this.flushingExplosions) return;
    this.flushingExplosions = true;
    try {
      // 上限只是兜底：单帧最多处理 64 次连锁（正常地图远达不到）
      let guard = 0;
      while (this.pendingExplosions.length > 0 && guard++ < 64) {
        const e = this.pendingExplosions.shift()!;
        this.explosion.explode({
          x: e.x,
          y: e.y,
          radius: e.radius,
          damage: e.damage,
          selfDamage: true,
          knockback: e.knockback,
          ownerId: -1,
          sourceId: -1,
          // 不传 shrapnel：材质爆炸没有破片
          skipPlayerDamage: this.online !== null,
        });

        // 联机：没有攻击者 → 每个客户端为自己的角色上报环境伤害
        if (this.online) {
          const local = this.online.localPlayer;
          if (local && !local.health.isDead) {
            const dist = Phaser.Math.Distance.Between(e.x, e.y, local.container.x, local.container.y);
            if (dist <= e.radius) {
              const falloff = 1 - dist / e.radius;
              local.envDamageReporter?.(e.damage * falloff, local);
            }
          }
        }
      }
    } finally {
      this.flushingExplosions = false;
    }
  }

  /**
   * 死亡回放：提示"被谁用什么击败"，并把镜头交给击败者（联机）。
   *
   * 联机里 `player-died` 的 killerId 已被 OnlineMatch 换算成实体 id，
   * 与单机使用同一套 id 体系，这里不需要区分模式。
   */
  private handlePlayerDeath(victim: Player, killerId?: number): void {
    const killer =
      killerId !== undefined && killerId !== victim.id
        ? this.players.find((p) => p.id === killerId)
        : undefined;
    const isLocal =
      this.online !== null ? victim === this.online.localPlayer : true;
    if (!isLocal) return;

    // 镜头：击败者还在场 → 跟着他；否则退到第一个存活玩家（resolveOnlineCamera 里兜底）
    if (this.online) {
      this.spectateTarget = killer ?? null;
      if (!killer) {
        this.spectateTarget = this.players.find((p) => !p.health.isDead) ?? null;
      }
    } else if (killer) {
      this.switchCameraTarget(killer);
    }

    const weapon = this.deathWeaponLabel(victim);
    const envDeath = !killer && victim.lastHitType === 'env';
    const title = envDeath
      ? '你摔落阵亡'
      : killer
        ? `你被 ${this.playerDisplayName(killer)} 用 ${weapon} 击败`
        : `你被${weapon}击败`;
    let sub = '';
    if (this.online) {
      const pending = this.respawnAt.get(victim.id) ?? 0;
      if (pending > 0) {
        // 还有命：显示复活倒计时（每帧刷新），而不是“观战中”
        sub = this.respawnText(victim.id);
      } else {
        sub = this.spectateTarget
          ? `已出局 · 跟随 ${this.playerDisplayName(this.spectateTarget)}`
          : '已出局 · 观战中';
      }
    }
    this.deathNotice?.show(title, sub);
  }

  /** 复活倒计时文案（“2 秒后复活 · 还剩 ×N 次”） */
  private respawnText(playerId: number): string {
    const deadline = this.respawnAt.get(playerId) ?? 0;
    const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    const revives = this.revives.get(playerId) ?? 0;
    return left > 0 ? `${left} 秒后复活 · 还剩 ${revives} 次` : '正在复活…';
  }

  /** 死亡提示里的倒计时定时刷新（只换副标题，不重建面板） */
  private updateRespawnText(): void {
    const local = this.online?.localPlayer;
    if (!local || !local.health.isDead || !this.deathNotice?.isVisible) {
      this.respawnTextAt = 0;
      return;
    }
    // 命尽/已出局：没有复活倒计时，保留“已出局 · 观战中”的文案
    const deadline = this.respawnAt.get(local.id) ?? 0;
    if (deadline <= 0) {
      this.respawnTextAt = 0;
      return;
    }
    const now = performance.now();
    if (now - this.respawnTextAt < 180) return;
    this.respawnTextAt = now;
    this.deathNotice.setSub(this.respawnText(local.id));
  }

  /** 致命伤害的武器名（'fist'/'kick' 等特殊值 + 环境伤害都有可读文案） */
  private deathWeaponLabel(victim: Player): string {
    const id = victim.lastHitWeapon;
    if (id === 'fist') return '拳脚';
    if (id === 'kick') return '踢击';
    if (id) {
      const name = getWeapon(id)?.name;
      if (name) return name;
    }
    switch (victim.lastHitType) {
      case 'explosion':
        return '爆炸';
      case 'melee':
        return '近战';
      case 'bullet':
        return '子弹';
      case 'kick':
        return '踢击';
      case 'env':
        return '坠落/环境伤害';
      default:
        return '未知手段';
    }
  }

  /** 玩家显示名（联机用房间昵称，单机用占位资料） */
  private playerDisplayName(player: Player): string {
    if (this.online) {
      return this.onlineNicks.get(this.netIdOfEntity(player)) ?? '玩家';
    }
    const idx = this.players.indexOf(player);
    return this.profiles()[idx]?.nickname ?? '玩家';
  }

  /**
   * 联机镜头目标：
   * - 活着：跟随自己；
   * - 阵亡/无本地角色（旁观）：优先跟随击败自己的人，其次第一个存活玩家。
   */
  private resolveOnlineCamera(local: Player | null): Player | null {
    if (local && !local.health.isDead) {
      this.spectateTarget = null;
      return local;
    }
    const preferred = this.spectateTarget;
    if (preferred && this.players.includes(preferred) && !preferred.health.isDead) {
      return preferred;
    }
    const alive = this.players.find((p) => !p.health.isDead);
    return alive ?? preferred ?? local ?? this.players[0] ?? null;
  }

  /**
   * 联机对局的主循环。
   *
   * 与单机的区别：
   * - 每个玩家一帧一个 InputCommand：本地玩家来自键鼠，远端玩家来自服务端中继的输入流；
   * - 镜头固定跟随本地玩家（旁观者跟随第一个玩家）；
   * - 瞄准只由本地玩家用鼠标决定，远端玩家的瞄准角来自网络。
   */
  private updateOnline(delta: number): void {
    const online = this.online!;
    const local = online.localPlayer;

    let localCmd = emptyInput();
    if (local) {
      // 开局闸门：还没按 W（或选择观战）时冻结本地输入，避免"没开始就能动"
      const blocked = startGate.blocked;
      localCmd = blocked ? emptyInput() : this.inputManager.readP1();
      if (!blocked) this.aimLocal(localCmd, local);
      const grenadeToggle = !blocked && this.inputManager.readGrenadeToggle();
      if (grenadeToggle) this.grenades.toggle(local);
      online.feedLocalInput(localCmd, grenadeToggle);
      online.sendLocalInput(localCmd);
    }

    // 逐玩家组装本帧指令（远端要先取"手榴弹切换"边沿，再消费其它边沿）
    const cmds: InputCommand[] = [];
    for (const player of this.players) {
      const netId = online.netIdOf(player);
      if (netId === online.localNetId) {
        cmds.push(localCmd);
        continue;
      }
      if (online.takeGrenadeToggle(netId)) this.grenades.toggle(player);
      cmds.push(online.commandFor(netId));
    }

    this.players.forEach((player, i) => player.update(cmds[i] ?? emptyInput(), delta));

    this.weaponSystem.update(delta);
    this.players.forEach((player, i) => {
      this.weaponSystem.updateContinuous(player, cmds[i]?.attackHeld ?? false, delta);
    });
    this.handleAttacks(cmds);
    this.handleSecondary(cmds);

    /**
     * ★ 联机同步必须**先**跑，而且包一层 try/catch。
     *
     * 踩过的坑：原来 `online.update()` 放在整个 updateOnline 的最后，
     * 一旦前面的表现层（镜头/特效/HUD/屏幕外指示器）在任何一帧抛异常，
     * 同步层就永远执行不到 —— 表现是：
     *   - 远端玩家不再被插值驱动（动作僵住/乱套）
     *   - 位置与开火事件不再上报（房主收不到别人的子弹 → 箱子打不坏）
     * 所以：同步先做（它只依赖物理与输入，不依赖表现层），
     * 表现层有错也不影响联机，错误记到 __netDiag().lastError 里便于定位。
     */
    this.syncOnline(delta);

    this.sights.update(this.players);
    this.updateRespawnText();
    this.grenades.update(delta, this.players);
    this.projectileSystem.update(delta);
    this.pickups.tryPickup(EMPTY_PRESSED);
    this.pickups.update(delta);
    this.hazard.update(delta);
    this.fragments.update(delta);
    this.shrapnel.update(delta);
    this.updateOneWayCollisions();
    syncCompoundVisuals(this.mapObjects);
    syncVisualMasks(this.mapObjects);
    updateMaterialGlows(this.mapObjects, this.time.now);
    updateObjectLabels(this.mapObjects);

    // 镜头：活着跟本地玩家；阵亡/旁观跟随击败自己的人，其次第一个存活玩家
    const target = this.resolveOnlineCamera(local);
    this.cameraTarget = target;
    if (target && this.cameraRig) this.cameraRig.update(target, delta);
    this.updateCameraZoom(target);

    // 表现层统一包一层：任一子系统出错都不能拖垮对局循环（网络已经在前面同步过了）
    this.runPresentation(delta, local, (p) => online.netIdOf(p));
  }

  /** 表现层更新（异常隔离：镜头/特效/HUD 出错不该中断对局） */
  private runPresentation(delta: number, local: Player | null, netIdOf: (p: Player) => number): void {
    try {
      this.gameFeel.update(this.cameras.main, this.cameraRig.shakeOffset, delta);
      this.fx.update(delta);
      this.casings.update(delta);
      this.slashTrail.update(delta, this.players);
      this.damageNumbers.update(delta);
      this.hud.update();
      this.deathNotice.update();
      this.offscreen?.update(this.players, local, this.onlineNicks, netIdOf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.online?.noteError(`presentation: ${msg}`);
      if (!this.netErrorLogged) {
        this.netErrorLogged = true;
        console.error('[GameScene] 表现层异常（已隔离）:', err);
      }
    }
  }

  /** 帧内的联机同步（隔离异常：表现层出错绝不能拖垮网络层） */
  private syncOnline(delta: number): void {
    const online = this.online;
    if (!online) return;
    try {
      online.update(delta);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      online.noteError(msg);
      if (!this.netErrorLogged) {
        this.netErrorLogged = true;
        console.error('[GameScene] 联机同步异常（已隔离，不影响其它玩家）:', err);
      }
    }
  }

  /**
   * 性能看门狗。
   *
   * 2 倍分辨率意味着 4 倍像素填充，低端集显/老手机会吃力。这里每秒采样一次
   * `game.loop.actualFps`：连续 3 秒低于 45fps 就把内部渲染倍数降一档（2→1），
   * 同时相机 zoom 与 UI 补偿同比缩放，玩家看到的画面范围不变。
   *
   * `?pixel=N` 显式指定分辨率时不自动降级（方便对照测试）。
   */
  private updatePerformance(deltaMs: number): void {
    if (this.perfDowngraded || RENDER_SCALE_EXPLICIT) return;
    const scale = getRenderScale();
    if (scale <= 1) return;

    this.perfTimer += deltaMs;
    if (this.perfTimer < 1000) return;
    this.perfTimer = 0;

    const fps = this.game.loop.actualFps;
    if (fps > 0 && fps < 45) this.perfLowStreak++;
    else this.perfLowStreak = Math.max(0, this.perfLowStreak - 1);

    if (this.perfLowStreak < 3) return;

    this.perfDowngraded = true;
    this.perfLowStreak = 0;
    try {
      // 分级降级：2 → 1.5 → 1（触屏设备从 1.5 起步）
      this.applyRenderScale(scale > 1.5 ? 1.5 : 1);
    } catch (err) {
      console.warn('[perf] 降级渲染分辨率失败:', err);
    }
    console.info(`[perf] 帧率偏低（${fps.toFixed(1)}fps），内部渲染分辨率降为 ${getRenderScale()}×`);
  }

  /**
   * 切换内部渲染倍数（性能降级用）：
   * 画布像素、相机 zoom、HUD/箭头补偿三者同比缩放，画面范围与 UI 尺寸保持不变。
   */
  applyRenderScale(next: number): void {
    const cur = getRenderScale();
    if (next === cur || next < 1) return;
    setRenderScale(next);
    const k = getRenderScale();
    // 只有"固定设计分辨率的画布"（正式游戏的 Scale.FIT）才需要改画布像素；
    // 编辑器等自适应画布（Scale.RESIZE）由窗口决定尺寸，相机 zoom/UI 都走 viewScaleOf 自动跟随。
    if (this.scale.scaleMode !== Phaser.Scale.FIT) return;
    this.scale.resize(DESIGN_WIDTH * k, DESIGN_HEIGHT * k);
    this.cameraRig?.rescale(k / cur);
    this.hud.bind(this.players, this.profiles());
  }

  /**
   * 镜头视觉范围跟着当前武器走：
   * - 狙击/激光/火箭 → 拉远（看清远处目标）
   * - 匕首/长矛/光刀 → 拉近（看清打击动作）
   * 手榴弹持握时按手榴弹的配置。
   */
  private updateCameraZoom(focus: Player | null): void {
    if (!this.cameraRig) return;
    let zoom = CAMERA_ZOOM;
    if (focus) {
      const weaponId = focus.grenadeMode ? 'grenade' : focus.heldWeapon?.id;
      const weapon = weaponId ? getWeapon(weaponId) : undefined;
      if (weapon?.cameraZoom && weapon.cameraZoom > 0) zoom = weapon.cameraZoom;
    }
    this.cameraRig.setZoomTarget(zoom * viewScaleOf(this.cameras.main.width));
  }

  /** 联机：本地玩家的瞄准只跟自己的鼠标 */
  private aimLocal(cmd: InputCommand, player: Player): void {
    const pointer = this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const shoulder = player.shoulderWorld;
    cmd.aimAngle = Math.atan2(world.y - shoulder.y, world.x - shoulder.x);
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

/** 头像贴图 key（同一 netId 换头像时会重新加载） */
function avatarRawKey(netId: number, url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return `avatar_${netId}_${(hash >>> 0).toString(36)}`;
}

/**
 * 把方形/任意比例头像裁成圆形贴图（用 canvas 一次性处理，避免运行时遮罩）。
 * 返回 false 表示拿不到源图（加载失败/跨域被拒），调用方退回程序化头像。
 */
function makeCircleAvatar(scene: Phaser.Scene, rawKey: string, outKey: string): boolean {
  const source = scene.textures.get(rawKey)?.getSourceImage() as HTMLImageElement | undefined;
  if (!source || !source.width) return false;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  // cover 裁切：保持比例填满圆形
  const scale = Math.max(size / source.width, size / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  ctx.drawImage(source, (size - w) / 2, (size - h) / 2, w, h);
  ctx.restore();
  try {
    scene.textures.addCanvas(outKey, canvas);
    return true;
  } catch {
    return false;
  }
}
