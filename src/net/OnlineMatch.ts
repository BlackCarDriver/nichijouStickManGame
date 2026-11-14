import type Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { PickupSystem } from '../world/PickupSystem';
import type { DestructionSystem } from '../world/DestructionSystem';
import type { DamageSystem } from '../combat/DamageSystem';
import type { DamageInfo } from '../combat/DamageInfo';
import type { MapObjectRuntime } from '../map/MapLoader';
import { emptyInput, type InputCommand } from '../core/InputCommand';
import {
  EDGE,
  type ClientMsg,
  type DropWire,
  type InputSnapshot,
  type MatchContext,
  type MatchPlayer,
  type PlayerStat,
  type PosSnapshot,
  type ServerMsg,
  type SnapDrop,
  type SnapMsg,
  type SnapObj,
} from './protocol';

export interface OnlineMatchDeps {
  scene: Phaser.Scene;
  ctx: MatchContext;
  /** netId → Player（由 GameScene 按 roster 创建） */
  players: Map<number, Player>;
  pickups: PickupSystem;
  destruction: DestructionSystem;
  damage: DamageSystem;
  /** 地图物体（用于动态刚体的权威快照与插值） */
  mapObjects: MapObjectRuntime[];
  /** 地图尺寸（房主用它清理掉出世界的刚体/掉落物） */
  worldSize: { width: number; height: number };
  /** player.id（实体 id）→ 击杀数，HUD 共享同一个 Map */
  kills: Map<number, number>;
  /** 玩家退出/加入后重建 HUD 面板 */
  onRosterChanged: () => void;
  /** 对局中途加入的新玩家：由 GameScene 创建火柴人并返回 */
  spawnPlayer?: (entry: MatchPlayer, stat: PlayerStat) => void;
  /** 聊天消息（用于头顶气泡） */
  onChat?: (nick: string, text: string, fromRoom: boolean) => void;
  /** 本地看到命中/被命中时的即时反馈（数字/硬直/音效），不等权威 hp */
  onHitPreview?: (target: Player, info: DamageInfo) => void;
}

interface RemoteInput {
  seq: number;
  mx: number;
  jh: boolean;
  cr: boolean;
  ah: boolean;
  kh: boolean;
  sw: boolean;
  aim: number;
  /** 尚未被消费的边沿位 */
  pending: number;
}

/** 位置上报间隔（ms）：20Hz */
const POS_INTERVAL = 50;
/**
 * 远端玩家渲染延迟的**自适应范围**（ms）。
 *
 * 为什么自适应：这个延迟的物理含义是"必须盖住对方的单程延迟 + 抖动"。
 * 固定 100ms 时，网络好（单程 10ms）的人被白白多拖 90ms（对手动作不跟手），
 * 网络差（单程 150ms）的人又盖不住（会退化成外推、轻微抖动）。
 *
 * 目标值 = 单程延迟 × 1.15 + 25ms（再夹到 [60, 140]）。
 * 单程延迟来自 ping/pong 的平滑 RTT。
 *
 * 注意：不能用"样本到达时间"来推断延迟 —— 到达时间只能说明"距离上次收包多久"，
 * 跟链路延迟无关（这一点踩过坑：旧规则会永远收敛到同一个值）。
 * 所以用 RTT 推目标，再用"渲染时刻已经越过最新样本 = 饿死了"作为兜底紧急上调。
 */
const POS_DELAY_MIN = 60;
const POS_DELAY_MAX = 140;
const POS_DELAY_INIT = 100;
/** 目标延迟 = 单程 × 这个系数 + 余量（覆盖抖动与 50ms 的采样间隔） */
const POS_DELAY_FACTOR = 1.15;
const POS_DELAY_MARGIN = 25;
/** RTT 还没测出来时的保守单程估计 */
const POS_DELAY_FALLBACK_ONE_WAY = 60;
/** 位置中断时最多向前外推多久 */
const POS_EXTRAPOLATE = 200;
/** 位置缓冲保留时长 */
const POS_KEEP = 1500;
/** Matter 的 1 秒 = 60 步（速度单位是 px/step） */
const STEPS_PER_SEC = 60;

/** 房主广播世界（动态刚体/掉落物）的频率 */
const SNAP_INTERVAL = 1000 / 20;
/** 全量关键帧间隔 */
const KEYFRAME_INTERVAL = 1000;
/** 快照缓冲保留时长 */
const SAMPLE_KEEP = 1500;
/** 动态物体的变化阈值 */
const OBJ_EPS_POS = 0.6;
const OBJ_EPS_ANG = 0.02;
/** 掉落物的变化阈值 */
const DROP_EPS = 1;
/** 掉落物位置上报间隔 */
const DROP_INTERVAL = 100;

interface PosSample {
  at: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: boolean;
}

/** 一个远端玩家的位置流（样本 + 自适应插值延迟） */
interface PosStream {
  samples: PosSample[];
  delay: number;
}

interface SnapSample {
  at: number;
  objects: Map<string, SnapObj>;
  drops: Map<number, SnapDrop>;
}

/** 世界快照流（动态刚体插值用，同样自适应） */
interface SnapStream {
  samples: SnapSample[];
  delay: number;
}

/**
 * 一局联机对战的客户端同步层（v3：位置自权威 + 世界房主权威）。
 *
 * 权威划分（这是"体验优先"的取舍，作弊不做防御）：
 * - **玩家位置**：每个客户端权威自己。服务端 20Hz 中继，其它端 100ms 缓冲插值。
 *   这样本地操作零延迟、不会被"权威回拉"，彻底没有橡皮筋；房主把收到的位置
 *   套到自己那份副本上，用于命中/拾取/摔落判定（判据就是"真实的你"）。
 * - **世界（动态刚体 / 掉落物落点 / 耐久 / 摧毁）**：房主唯一权威，
 *   20Hz 广播 `snap`；其它端插值 + `obj` 事件对齐。
 * - **伤害**：谁打的谁上报（自己的攻击），服务端宽松校验后广播 `hp`；
 *   摔落伤害由自己检测上报（`kind=env`，服务端只接受"自己伤自己"）。
 * - **拾取**：谁捡谁请求（带着自己真实的落点），服务端先到先得。
 * - **房主（世界权威）**：只负责世界物体；座位号由服务端在 30Hz 的 `in`
 *   广播里持续下发，客户端据此自愈（漏收一次 `host` 事件不会再永久失配）。
 */
export class OnlineMatch {
  readonly localNetId: number;
  private readonly deps: OnlineMatchDeps;
  private readonly remote = new Map<number, RemoteInput>();
  private readonly unsubscribe: () => void;
  private readonly entityToNet = new Map<number, number>();
  /** 动态地图物体：id → runtime */
  private readonly objectById = new Map<string, MapObjectRuntime>();
  private dynamicObjects: MapObjectRuntime[] = [];

  /** 世界权威座位号（-1 = 暂无） */
  private hostSeat: number;
  /** 本端角色（决定谁广播世界） */
  private role: 'authority' | 'client';

  private localCmd: InputCommand = emptyInput();
  private localEdges = 0;
  private seq = 0;

  private lastPosAt = 0;
  private lastShieldSent = 0;
  private disposed = false;

  // ---- 房主侧：世界快照 ----
  private snapAccum = 0;
  private keyAccum = KEYFRAME_INTERVAL;
  private snapSeq = 0;
  private dropAccum = 0;
  private cleanAccum = 0;
  private readonly lastObjSent = new Map<string, { x: number; y: number; a: number }>();
  private readonly lastDropSent = new Map<number, { x: number; y: number; f: boolean }>();

  // ---- 客户端：远端玩家位置缓冲（每人一份，各自自适应延迟）----
  private readonly posStreams = new Map<number, PosStream>();
  private readonly lastRemoteAt = new Map<number, { x: number; y: number }>();

  // ---- 世界快照插值缓冲 ----
  private readonly snapStream: SnapStream = { samples: [], delay: POS_DELAY_INIT };

  // ---- 延迟估计 / 诊断 ----
  private pingTimer = 0;
  private pingSentAt = 0;
  private rtt = 0;
  private posSent = 0;
  private posRecv = 0;
  private snapRecv = 0;
  private rateTimer = 0;
  private lastSnapSeq = 0;
  private snapGaps = 0;

  /**
   * 运行时可观测指标（调试面板 / E2E 断言用）。
   * - remoteMaxStep：远端玩家单帧最大位移（跳跃极限约 20px/帧；瞬移会是 100+）
   * - snapGaps：世界快照序号跳变次数（服务端拥塞丢帧的迹象）
   */
  readonly stats = {
    role: 'client' as 'authority' | 'client',
    hostSeat: -1,
    localNetId: -1,
    rtt: 0,
    oneWay: 0,
    posHz: 0,
    snapHz: 0,
    snapGaps: 0,
    remoteMaxStep: 0,
    snapshotsSent: 0,
    /** 当前自适应插值延迟（远端玩家，ms） */
    interpDelay: POS_DELAY_INIT,
    /** 本地提前播过打击反馈的次数（不等 hp） */
    hitPreviews: 0,
    drops: 0,
    players: 0,
    fps: 0,
  };

  constructor(deps: OnlineMatchDeps) {
    this.deps = deps;
    this.localNetId = deps.ctx.you;
    this.hostSeat = deps.ctx.host ?? -1;
    this.role = this.hostSeat === this.localNetId ? 'authority' : 'client';
    this.stats.localNetId = this.localNetId;

    for (const [netId, player] of deps.players) {
      this.entityToNet.set(player.id, netId);
      this.remote.set(netId, {
        seq: 0, mx: 0, jh: false, cr: false, ah: false, kh: false, sw: false, aim: 0, pending: 0,
      });
      // 所有玩家都改为网络驱动：本地不结算伤害，复活由服务端 respawn 事件决定
      player.netControlled = true;
      player.autoRespawn = false;
    }

    this.rebuildDynamicObjects();

    const local = this.localPlayer;
    if (local) this.lastShieldSent = local.health.shield;

    // 已有玩家状态（重连 / 中途观战：击杀数、血量、是否阵亡）
    for (const st of deps.ctx.stats ?? []) {
      const player = deps.players.get(st.id);
      if (!player) continue;
      deps.kills.set(player.id, st.kills);
      player.applyNetSnapshot({ hp: st.hp, shield: st.shield, dead: st.dead });
    }

    // 初始掉落物
    for (const drop of deps.ctx.drops) this.spawnDrop(drop);
    // 已经被摧毁的地图物体
    for (const id of deps.ctx.destroyed) deps.destruction.forceDestroyById(id);

    this.applyRole();
    // 中途加入/重连：用服务端缓存的全量世界快照还原动态物体与掉落物
    if (deps.ctx.world) this.ingestSnapshot(deps.ctx.world, true);

    this.unsubscribe = deps.ctx.link.subscribe((msg) => this.handleMessage(msg));
  }

  get localPlayer(): Player | null {
    if (this.localNetId < 0) return null;
    return this.deps.players.get(this.localNetId) ?? null;
  }

  /** 当前是否为世界权威（房主） */
  get isAuthority(): boolean {
    return this.role === 'authority';
  }

  /** 联机：把投掷后插不进去的武器交给服务端生成掉落物（世界权威统一播发） */
  requestDrop(weaponId: string, ammo: number, x: number, y: number): void {
    if (this.role !== 'authority') return;
    this.send({ t: 'drop', weaponId, ammo, x: round2(x), y: round2(y) });
  }

  netIdOf(player: Player): number {
    return this.entityToNet.get(player.id) ?? -1;
  }

  playerOf(netId: number): Player | undefined {
    return this.deps.players.get(netId);
  }

  /** 诊断快照（`window.__netDiag()` 用） */
  diag(): Record<string, unknown> {
    const local = this.localPlayer;
    return {
      role: this.stats.role,
      hostSeat: this.stats.hostSeat,
      netId: this.localNetId,
      rtt: this.stats.rtt,
      oneWay: this.stats.oneWay,
      posHz: this.stats.posHz,
      snapHz: this.stats.snapHz,
      snapGaps: this.stats.snapGaps,
      interpDelay: this.stats.interpDelay,
      hitPreviews: this.stats.hitPreviews,
      remoteMaxStep: this.stats.remoteMaxStep,
      // 每个远端位置流的自适应状态（延迟 / 样本数 / 缓冲里还剩多少"未来"样本）
      streams: [...this.posStreams.entries()]
        .filter(([id]) => id !== this.localNetId)
        .map(([id, st]) => {
          const newest = st.samples[st.samples.length - 1];
          return {
            id,
            delay: Math.round(st.delay),
            samples: st.samples.length,
            sinceLast: newest ? Math.round(performance.now() - newest.at) : null,
          };
        }),
      drops: this.deps.pickups.netSpawns().length,
      players: this.deps.players.size,
      fps: this.stats.fps,
      local: local
        ? {
            x: Math.round(local.container.x),
            y: Math.round(local.container.y),
            hp: local.health.hp,
            shield: local.health.shield,
            dead: local.health.isDead,
            weapon: local.heldWeapon?.id ?? '',
          }
        : null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.deps.damage.setNetSink(null);
    this.deps.pickups.setNet(null, null);
    this.deps.destruction.setAuthority(true);
  }

  // ---------- 每帧 ----------

  /** 由 GameScene 每帧调用：记录本地输入并上报（含边沿）。 */
  feedLocalInput(cmd: InputCommand, grenadeToggle: boolean): void {
    this.localCmd = cmd;
    let edges = 0;
    if (cmd.jump) edges |= EDGE.jump;
    if (cmd.attack) edges |= EDGE.attack;
    if (cmd.kick) edges |= EDGE.kick;
    if (cmd.swap) edges |= EDGE.swap;
    if (grenadeToggle) edges |= EDGE.grenade;
    this.localEdges = edges;
  }

  /** 把本地输入发给服务端。GameScene 每帧调用一次。 */
  sendLocalInput(cmd: InputCommand): void {
    if (this.localNetId < 0) return;
    let edges = this.localEdges;
    this.localEdges = 0;
    if (cmd.jump) edges |= EDGE.jump;
    if (cmd.attack) edges |= EDGE.attack;
    if (cmd.kick) edges |= EDGE.kick;
    if (cmd.swap) edges |= EDGE.swap;
    this.seq = (this.seq + 1) & 0xffffffff;
    this.send({
      t: 'in',
      seq: this.seq,
      mx: cmd.moveX,
      jh: cmd.jumpHeld,
      cr: cmd.crouch,
      ah: cmd.attackHeld,
      kh: cmd.kickHeld,
      sw: false,
      aim: cmd.aimAngle ?? 0,
      e: edges,
    });
  }

  /** 取某个玩家的本帧输入指令（local = 本地输入，远端 = 网络输入）。 */
  commandFor(netId: number): InputCommand {
    if (netId === this.localNetId) return this.localCmd;
    const r = this.remote.get(netId);
    const cmd = emptyInput();
    if (!r) return cmd;
    cmd.moveX = Math.max(-1, Math.min(1, r.mx));
    cmd.jumpHeld = r.jh;
    cmd.crouch = r.cr;
    cmd.attackHeld = r.ah;
    cmd.kickHeld = r.kh;
    cmd.aimAngle = r.aim;
    if (r.pending & EDGE.jump) cmd.jump = true;
    if (r.pending & EDGE.attack) cmd.attack = true;
    if (r.pending & EDGE.kick) cmd.kick = true;
    if (r.pending & EDGE.swap) cmd.swap = true;
    r.pending = 0;
    return cmd;
  }

  /** 取出并清空某远端玩家的"手榴弹切换"边沿。 */
  takeGrenadeToggle(netId: number): boolean {
    if (netId === this.localNetId) return false;
    const r = this.remote.get(netId);
    if (!r || !(r.pending & EDGE.grenade)) return false;
    r.pending &= ~EDGE.grenade;
    return true;
  }

  /** 每帧收尾：远端插值 + 本地上报 + 房主快照。 */
  update(dtMs: number): void {
    if (this.disposed) return;
    this.tickPing(dtMs);
    this.driveRemotePlayers();
    if (this.role === 'client') this.driveRemoteObjects();
    this.sendLocalState(dtMs);
    this.updateRates(dtMs);
    if (this.role === 'authority') this.authorityTick(dtMs);
  }

  // ---------- 远端玩家：位置插值 ----------

  /**
   * 用对端上报的位置驱动远端玩家（房主同样走这条路）。
   *
   * 为什么房主也走：房主要用"真实的对手位置"做命中/拾取判定，
   * 而不是自己那份会滞后一个来回的物理副本。
   */
  private driveRemotePlayers(): void {
    if (this.posStreams.size === 0) return;
    const now = performance.now();
    let delaySum = 0;
    let delayCount = 0;
    for (const [netId, stream] of this.posStreams) {
      if (netId === this.localNetId) continue;
      const newest = stream.samples[stream.samples.length - 1];
      this.tuneDelay(stream, !!newest && now - stream.delay > newest.at);
      delaySum += stream.delay;
      delayCount++;
      const player = this.deps.players.get(netId);
      if (!player) continue;
      const s = samplePos(stream.samples, now - stream.delay);
      if (!s) continue;
      const prev = this.lastRemoteAt.get(netId);
      if (prev) {
        const step = Math.hypot(s.x - prev.x, s.y - prev.y);
        if (step > this.stats.remoteMaxStep) this.stats.remoteMaxStep = step;
      }
      this.lastRemoteAt.set(netId, { x: s.x, y: s.y });
      player.driveRemoteState(s.x, s.y, s.vx, s.vy, s.g);
    }
    if (delayCount > 0) this.stats.interpDelay = Math.round(delaySum / delayCount);
  }

  /**
   * 自适应插值延迟：按实测单程延迟推目标值，并在"已经需要外推"时紧急上调。
   *
   * @param starved 渲染时刻是否已经越过最新样本（说明缓冲不够，正在外推）
   */
  private tuneDelay(stream: PosStream | SnapStream, starved: boolean): void {
    if (stream.samples.length === 0) return;
    if (starved) {
      // 紧急：正在外推 = 延迟不够，立刻加一档（会带来一点画面变慢，但先稳住）
      stream.delay = Math.min(POS_DELAY_MAX, stream.delay + 8);
      return;
    }
    const oneWay = this.rtt > 0 ? this.rtt / 2 : POS_DELAY_FALLBACK_ONE_WAY;
    const target = clamp(
      oneWay * POS_DELAY_FACTOR + POS_DELAY_MARGIN,
      POS_DELAY_MIN,
      POS_DELAY_MAX,
    );
    if (stream.delay < target) stream.delay = Math.min(target, stream.delay + 4);
    else if (stream.delay > target) stream.delay = Math.max(target, stream.delay - 2);
  }

  private ingestPos(list: PosSnapshot[]): void {
    const at = performance.now();
    for (const s of list) {
      if (s.id === this.localNetId) continue;
      let stream = this.posStreams.get(s.id);
      if (!stream) {
        stream = { samples: [], delay: POS_DELAY_INIT };
        this.posStreams.set(s.id, stream);
      }
      stream.samples.push({ at, x: s.x, y: s.y, vx: s.vx, vy: s.vy, g: s.g === true });
      while (stream.samples.length > 4 && at - stream.samples[0].at > POS_KEEP) stream.samples.shift();
      this.posRecv++;
    }
  }


  // ---------- 房主：世界快照（动态刚体 + 掉落物） ----------

  private authorityTick(dtMs: number): void {
    this.snapAccum += dtMs;
    this.keyAccum += dtMs;
    this.dropAccum += dtMs;
    this.cleanAccum += dtMs;
    if (this.cleanAccum >= 500) {
      this.cleanAccum = 0;
      this.cleanOutOfWorld();
    }

    const key = this.keyAccum >= KEYFRAME_INTERVAL;
    if (this.snapAccum < SNAP_INTERVAL) return;
    this.snapAccum = 0;
    if (key) this.keyAccum = 0;

    const withDrops = key || this.dropAccum >= DROP_INTERVAL;
    if (withDrops) this.dropAccum = 0;

    this.send(this.buildSnapshot(key, withDrops));
  }

  /**
   * 房主：清理掉出地图的刚体与掉落物。
   * 不清理的话，一个掉出世界的箱子会永远自由落体（y 涨到几万），白烧物理还污染快照。
   */
  private cleanOutOfWorld(): void {
    const limit = this.deps.worldSize.height + 400;

    for (const runtime of [...this.dynamicObjects]) {
      const body = runtime.body;
      if (!body || body.position.y <= limit) continue;
      this.objectById.delete(runtime.id);
      this.dynamicObjects = this.dynamicObjects.filter((r) => r !== runtime);
      this.lastObjSent.delete(runtime.id);
      this.deps.destruction.forceDestroyById(runtime.id);
      this.send({ t: 'obj', id: runtime.id });
    }

    for (const item of this.deps.pickups.netSpawns()) {
      if (item.y <= limit) continue;
      this.lastDropSent.delete(item.id);
      this.deps.pickups.removeByNetId(item.id);
      this.send({ t: 'drop_remove', id: item.id });
    }
  }

  private buildSnapshot(key: boolean, withDrops: boolean): ClientMsg {
    const objects: SnapObj[] = [];
    for (const runtime of this.dynamicObjects) {
      const body = runtime.body;
      if (!body) continue;
      const x = body.position.x;
      const y = body.position.y;
      const a = body.angle;
      const prev = this.lastObjSent.get(runtime.id);
      if (
        !key &&
        prev &&
        Math.abs(prev.x - x) <= OBJ_EPS_POS &&
        Math.abs(prev.y - y) <= OBJ_EPS_POS &&
        Math.abs(prev.a - a) <= OBJ_EPS_ANG
      ) {
        continue;
      }
      objects.push({ id: runtime.id, x: round2(x), y: round2(y), a: round3(a) });
      this.lastObjSent.set(runtime.id, { x, y, a });
    }

    let drops: SnapDrop[] | undefined;
    if (withDrops) {
      drops = [];
      for (const item of this.deps.pickups.netSpawns()) {
        const prev = this.lastDropSent.get(item.id);
        if (
          !key &&
          prev &&
          Math.abs(prev.x - item.x) <= DROP_EPS &&
          Math.abs(prev.y - item.y) <= DROP_EPS &&
          prev.f === item.falling
        ) {
          continue;
        }
        drops.push({ id: item.id, x: round2(item.x), y: round2(item.y), f: item.falling });
        this.lastDropSent.set(item.id, { x: item.x, y: item.y, f: item.falling });
      }
      if (drops.length === 0) drops = undefined;
    }

    this.stats.snapshotsSent++;
    return {
      t: 'snap',
      seq: ++this.snapSeq,
      key,
      o: objects.length > 0 ? objects : undefined,
      d: drops,
    };
  }

  /** 动态刚体清单（静态的地图结构不需要同步） */
  private rebuildDynamicObjects(): void {
    this.objectById.clear();
    this.dynamicObjects = [];
    for (const runtime of this.deps.mapObjects) {
      if (!runtime.body) continue;
      this.objectById.set(runtime.id, runtime);
      if (!runtime.body.isStatic) this.dynamicObjects.push(runtime);
    }
  }

  // ---------- 世界快照：插值回放 ----------

  private ingestSnapshot(msg: SnapMsg, immediate = false): void {
    const at = performance.now();
    const prev = this.snapStream.samples[this.snapStream.samples.length - 1];
    const objects = prev ? new Map(prev.objects) : new Map<string, SnapObj>();
    const drops = prev ? new Map(prev.drops) : new Map<number, SnapDrop>();

    for (const o of msg.o ?? []) objects.set(o.id, o);
    for (const d of msg.d ?? []) drops.set(d.id, d);

    this.snapStream.samples.push({ at, objects, drops });
    while (this.snapStream.samples.length > 2 && at - this.snapStream.samples[0].at > SAMPLE_KEEP) {
      this.snapStream.samples.shift();
    }

    this.snapRecv++;
    if (msg.seq > this.lastSnapSeq + 1) this.snapGaps += msg.seq - this.lastSnapSeq - 1;
    this.lastSnapSeq = Math.max(this.lastSnapSeq, msg.seq);

    // 掉落物坐标是权威的，直接落到本地表现上
    for (const d of msg.d ?? []) this.deps.pickups.applyNetPosition(d.id, d.x, d.y, d.f);

    if (immediate) {
      for (const [id, o] of objects) {
        const runtime = this.objectById.get(id);
        if (runtime?.body) this.driveObject(runtime.body, o.x, o.y, o.a);
      }
    }
  }

  /** 非房主：把动态刚体钉到插值目标上（视觉/碰撞都跟着走） */
  private driveRemoteObjects(): void {
    const now = performance.now();
    const newest = this.snapStream.samples[this.snapStream.samples.length - 1];
    this.tuneDelay(this.snapStream, !!newest && now - this.snapStream.delay > newest.at);
    const view = this.sampleObjects(now - this.snapStream.delay);
    if (!view) return;
    for (const [id, o] of view) {
      const runtime = this.objectById.get(id);
      if (runtime?.body) this.driveObject(runtime.body, o.x, o.y, o.a);
    }
  }

  /** 按渲染时间取样（两帧之间线性插值；过期则保持最后位置） */
  private sampleObjects(renderAt: number): Map<string, SnapObj> | null {
    const list = this.snapStream.samples;
    if (list.length === 0) return null;
    if (list.length === 1 || renderAt <= list[0].at) return list[0].objects;
    const last = list[list.length - 1];
    if (renderAt >= last.at) return last.objects;
    for (let i = list.length - 2; i >= 0; i--) {
      const a = list[i];
      const b = list[i + 1];
      if (renderAt < a.at || renderAt > b.at) continue;
      const span = b.at - a.at;
      const t = span > 0 ? (renderAt - a.at) / span : 0;
      const out = new Map<string, SnapObj>();
      for (const [id, ob] of b.objects) {
        const oa = a.objects.get(id) ?? ob;
        out.set(id, { id, x: lerp(oa.x, ob.x, t), y: lerp(oa.y, ob.y, t), a: lerpAngle(oa.a, ob.a, t) });
      }
      return out;
    }
    return last.objects;
  }

  private driveObject(body: MatterJS.BodyType, x: number, y: number, a: number): void {
    const matter = this.deps.scene.matter;
    matter.body.setPosition(body, { x, y });
    matter.body.setAngle(body, a);
    matter.body.setVelocity(body, { x: 0, y: 0 });
    matter.body.setAngularVelocity(body, 0);
  }

  // ---------- 角色 ----------

  private applyRole(): void {
    const authority = this.role === 'authority';
    this.stats.role = this.role;
    this.stats.hostSeat = this.hostSeat;
    this.deps.destruction.setAuthority(authority);
    this.deps.pickups.setNet(
      { request: (item, player, swap) => this.requestPickup(item, player, swap) },
      this.localPlayer,
      'online',
    );
    this.deps.pickups.setDropAuthority(authority);
    this.deps.damage.setNetSink({
      playerDamage: (target, info) => this.reportDamage(target, info),
      objectDestroyed: (id) => {
        if (this.role === 'authority') this.send({ t: 'obj', id });
      },
      hitPreview: (target, info) => {
        // 只有"自己参与的命中"才提前播：自己打的（攻击方）或打自己的（受击方）。
        // 旁观者/第三方的互殴不预览，避免和 hp 的正式反馈撞车。
        const local = this.localPlayer;
        if (!local) return;
        const mine = info.sourceId === local.id;
        const victim = target === local;
        if (!mine && !victim) return;
        this.stats.hitPreviews++;
        this.deps.onHitPreview?.(target, info);
      },
    });
    // 摔落伤害：**只有自己**检测自己（房主不再替别人算，避免用滞后副本判定）
    const local = this.localPlayer;
    for (const player of this.deps.players.values()) {
      player.envDamageReporter = player === local ? (amount) => this.reportEnvDamage(amount) : undefined;
    }
    if (authority) {
      this.lastObjSent.clear();
      this.lastDropSent.clear();
      this.keyAccum = KEYFRAME_INTERVAL;
    }
  }

  private onHostChanged(seat: number): void {
    if (seat === this.hostSeat) return;
    this.hostSeat = seat;
    const next = seat === this.localNetId ? 'authority' : 'client';
    if (next === this.role) {
      this.stats.hostSeat = seat;
      return;
    }
    this.role = next;
    this.applyRole();
  }

  // ---------- 下行 ----------

  private handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'in':
        this.applyInputs(msg.p);
        // 服务端每 33ms 下发一次权威座位号：漏收 host 事件也能在这一帧自愈
        if (typeof msg.h === 'number' && msg.h !== this.hostSeat) this.onHostChanged(msg.h);
        break;
      case 'pos':
        this.ingestPos(msg.p);
        break;
      case 'snap':
        if (typeof msg.h === 'number' && msg.h !== this.hostSeat) this.onHostChanged(msg.h);
        this.ingestSnapshot(msg);
        break;
      case 'host':
        this.onHostChanged(msg.id);
        break;
      case 'pong':
        this.onPong(msg.ts, msg.tag);
        break;
      case 'hp':
        this.applyHp(msg);
        break;
      case 'drop_add':
        this.spawnDrop(msg.item);
        break;
      case 'drop_remove':
        this.deps.pickups.removeByNetId(msg.id);
        this.lastDropSent.delete(msg.id);
        break;
      case 'pick':
        this.deps.pickups.applyGrant(msg.id, this.deps.players.get(msg.by) ?? null, msg.grant);
        if (msg.by === this.localNetId) this.lastShieldSent = msg.shield;
        break;
      case 'obj':
        this.deps.destruction.forceDestroyById(msg.id);
        this.lastObjSent.delete(msg.id);
        break;
      case 'player_left':
        this.removePlayer(msg.id);
        break;
      case 'player_join':
        this.addPlayer(msg.player, msg.stat);
        break;
      case 'chat':
        this.deps.onChat?.(msg.nick, msg.text, msg.room === true);
        break;
      default:
        break;
    }
  }

  private onPong(ts: number, tag?: string): void {
    // 只认自己发的 ping（UI 用 Date.now()，网络层用 performance.now()）
    if (tag !== 'net' || this.pingSentAt === 0) return;
    const rtt = performance.now() - ts;
    this.pingSentAt = 0;
    if (rtt <= 0 || rtt > 8000) return;
    this.rtt = this.rtt === 0 ? rtt : this.rtt * 0.7 + rtt * 0.3;
    this.stats.rtt = Math.round(this.rtt);
    this.stats.oneWay = Math.round(this.rtt / 2);
  }

  private applyInputs(list: InputSnapshot[]): void {
    for (const s of list) {
      if (s.id === this.localNetId) continue;
      const r = this.remote.get(s.id);
      if (!r) continue;
      r.seq = s.seq;
      r.mx = s.mx;
      r.jh = s.jh;
      r.cr = s.cr;
      r.ah = s.ah;
      r.kh = s.kh;
      r.sw = s.sw;
      r.aim = s.aim;
      r.pending |= s.e;
    }
  }

  private applyHp(msg: ServerMsg & { t: 'hp' }): void {
    const p = this.deps.players.get(msg.id);
    if (!p) return;
    // hp.src 是"座位号"，统一换算成实体 id（单机/联机共用同一套击杀归属逻辑）
    const killer = msg.src >= 0 ? this.deps.players.get(msg.src) : undefined;
    p.applyNetDamage({
      hp: msg.hp,
      shield: msg.shield,
      dead: msg.dead,
      amount: msg.amount,
      kind: msg.kind,
      crit: msg.crit,
      point: msg.point,
      knockback: msg.kb,
      sourceId: killer ? killer.id : undefined,
      weaponId: msg.weapon,
      attackId: msg.attack,
    });
    if (msg.id === this.localNetId) this.lastShieldSent = msg.shield;

    for (const [seat, kills] of Object.entries(msg.kills ?? {})) {
      const player = this.deps.players.get(Number(seat));
      if (player) this.deps.kills.set(player.id, kills);
    }
  }

  private spawnDrop(drop: DropWire): void {
    this.deps.pickups.spawnNet(drop);
    this.lastDropSent.delete(drop.id);
  }

  // ---------- 上行 ----------

  private send(msg: ClientMsg): void {
    this.deps.ctx.link.send(msg);
  }

  private tickPing(dtMs: number): void {
    this.pingTimer += dtMs;
    if (this.pingTimer < 1000) return;
    if (this.pingSentAt !== 0 && performance.now() - this.pingSentAt < 2500) return;
    this.pingTimer = 0;
    this.pingSentAt = performance.now();
    this.send({ t: 'ping', ts: Math.round(this.pingSentAt), tag: 'net' });
  }

  private updateRates(dtMs: number): void {
    this.rateTimer += dtMs;
    if (this.rateTimer < 1000) {
      this.stats.fps = Math.round(this.deps.scene.game.loop.actualFps);
      this.stats.players = this.deps.players.size;
      return;
    }
    const secs = this.rateTimer / 1000;
    this.stats.posHz = Math.round(this.posRecv / secs);
    this.stats.snapHz = Math.round(this.snapRecv / secs);
    this.stats.snapGaps = this.snapGaps;
    this.stats.drops = this.deps.pickups.netSpawns().length;
    this.stats.fps = Math.round(this.deps.scene.game.loop.actualFps);
    this.stats.players = this.deps.players.size;
    this.posRecv = 0;
    this.snapRecv = 0;
    this.rateTimer = 0;
  }

  /** 20Hz 上报自身位置（权威）+ 本地护盾增量 */
  private sendLocalState(dtMs: number): void {
    const local = this.localPlayer;
    if (!local || dtMs <= 0) return;

    this.lastPosAt += dtMs;
    if (this.lastPosAt >= POS_INTERVAL) {
      this.lastPosAt = 0;
      this.send({
        t: 'pos',
        x: round2(local.container.x),
        y: round2(local.container.y),
        vx: round2(local.body.velocity.x),
        vy: round2(local.body.velocity.y),
        g: local.isGrounded,
      });
      this.posSent++;
    }

    // 超级战士等本地增益带来的护盾：本地变化后补报给服务端
    const shield = local.health.shield;
    if (shield > this.lastShieldSent) {
      this.send({ t: 'shield', amount: shield - this.lastShieldSent });
      this.lastShieldSent = shield;
    } else if (shield < this.lastShieldSent) {
      this.lastShieldSent = shield;
    }
  }

  /** 摔落等环境伤害：只有自己检测自己（服务端校验"自己伤自己"） */
  reportEnvDamage(amount: number): void {
    if (amount <= 0 || this.localNetId < 0) return;
    this.send({
      t: 'dmg',
      target: this.localNetId,
      src: -1,
      amount,
      kind: 'env',
      crit: false,
      attack: 0,
      ignoreInvuln: true,
    });
  }

  /**
   * 伤害上报：**谁打的上报谁**（和 v1 一致）。
   *
   * 为什么不再由房主代报：房主看到的是"你 + 一个来回延迟"，命中判定必然错位
   * （实测 300ms 时平均偏差 83px）。改成射击者上报后，命中与玩家看到的完全一致。
   * 作弊不设防（纯休闲房），服务端仍保留频率/单次上限的宽松校验。
   */
  private reportDamage(target: Player, info: DamageInfo): void {
    const local = this.localPlayer;
    if (!local || this.localNetId < 0) return;
    if (info.sourceId !== local.id) return;
    const targetNet = this.netIdOf(target);
    if (targetNet < 0) return;
    // 武器：优先伤害来源自带的 id，否则退回当前手持武器
    const weapon = info.weaponId ?? local.heldWeapon?.id;
    this.send({
      t: 'dmg',
      target: targetNet,
      src: this.localNetId,
      weapon,
      amount: info.amount,
      kind: info.kind,
      crit: info.critical === true,
      point: info.point ? { x: round2(info.point.x), y: round2(info.point.y) } : undefined,
      kb: info.knockback ? { x: round2(info.knockback.x), y: round2(info.knockback.y) } : undefined,
      attack: info.attackId ?? 0,
      ignoreInvuln: info.ignoreInvuln === true,
    });
  }

  /** 拾取请求：只请求自己的拾取（带着自己真实的落点），服务端先到先得 */
  private requestPickup(
    item: { netId?: number; kind: 'weapon' | 'item'; weaponId?: string; itemId?: string; ammo?: number; x: number; y: number },
    player: Player,
    swap: boolean,
  ): void {
    if (this.localNetId < 0 || player !== this.localPlayer) return;
    if (item.netId === undefined) return;
    let swapPayload: { weaponId: string; ammo: number; x: number; y: number } | undefined;
    if (swap && player.heldWeapon) {
      swapPayload = {
        weaponId: player.heldWeapon.id,
        ammo: player.heldWeapon.ammo,
        x: round2(player.container.x),
        y: round2(player.container.y),
      };
    }
    this.send({ t: 'pick', id: item.netId, swap: swapPayload });
  }

  /** 对局中途加入的新玩家：GameScene 负责建 Player，这里补登记 */
  private addPlayer(entry: MatchPlayer, stat: PlayerStat): void {
    if (this.deps.players.has(entry.netId)) return;
    this.deps.spawnPlayer?.(entry, stat);
    const player = this.deps.players.get(entry.netId);
    if (!player) return;
    this.entityToNet.set(player.id, entry.netId);
    this.remote.set(entry.netId, {
      seq: 0, mx: 0, jh: false, cr: false, ah: false, kh: false, sw: false, aim: 0, pending: 0,
    });
    this.deps.kills.set(player.id, stat.kills ?? 0);
    player.applyNetSnapshot({ hp: stat.hp, shield: stat.shield, dead: stat.dead });
    player.envDamageReporter = undefined;
    this.deps.onRosterChanged();
  }

  private removePlayer(netId: number): void {
    const player = this.deps.players.get(netId);
    if (!player) return;
    this.deps.players.delete(netId);
    this.remote.delete(netId);
    this.posStreams.delete(netId);
    this.lastRemoteAt.delete(netId);
    this.entityToNet.delete(player.id);
    this.deps.kills.delete(player.id);
    player.destroy();
    this.deps.onRosterChanged();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 角度插值走最短弧（物体可能从 +π 跳到 -π） */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** 按渲染时间取样远端玩家位置（两帧之间插值；过期则用速度外推一小段） */
function samplePos(buffer: PosSample[], renderAt: number): PosSample | null {
  if (buffer.length === 0) return null;
  if (buffer.length === 1 || renderAt <= buffer[0].at) return buffer[0];
  const last = buffer[buffer.length - 1];
  if (renderAt >= last.at) {
    const dt = Math.min(POS_EXTRAPOLATE, renderAt - last.at) / 1000;
    return {
      at: last.at,
      x: last.x + last.vx * dt * STEPS_PER_SEC,
      y: last.y + last.vy * dt * STEPS_PER_SEC,
      vx: last.vx,
      vy: last.vy,
      g: last.g,
    };
  }
  for (let i = buffer.length - 2; i >= 0; i--) {
    const a = buffer[i];
    const b = buffer[i + 1];
    if (renderAt < a.at || renderAt > b.at) continue;
    const span = b.at - a.at;
    const t = span > 0 ? (renderAt - a.at) / span : 0;
    return {
      at: renderAt,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      vx: lerp(a.vx, b.vx, t),
      vy: lerp(a.vy, b.vy, t),
      g: b.g,
    };
  }
  return last;
}
