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
  type ServerMsg,
  type SnapDrop,
  type SnapMsg,
  type SnapObj,
  type SnapPlayer,
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

/** 房主广播权威快照的频率 */
const SNAP_INTERVAL = 1000 / 20;
/** 全量关键帧间隔（其它客户端据此兜底恢复，掉包/新加入也不怕） */
const KEYFRAME_INTERVAL = 1000;
/** 远端玩家渲染延迟：用这段时间的缓冲做插值，换取"永不瞬移" */
const INTERP_DELAY = 100;
/** 快照中断时最多向前外推多久 */
const MAX_EXTRAPOLATE = 220;
/** 快照缓冲保留时长 */
const SAMPLE_KEEP = 1500;
/** Matter 的 1 秒 = 60 步（速度单位是 px/step） */
const STEPS_PER_SEC = 60;

/** 本地玩家纠偏：误差小于它就不管（避免和预测对着干） */
const LOCAL_DEADBAND = 10;
/** 本地玩家纠偏：每帧最多修正多少像素（平滑，不产生硬瞬移） */
const LOCAL_MAX_STEP = 9;
/** 本地玩家纠偏：超过它说明真的脱同步了，直接对齐 */
const LOCAL_HARD_SNAP = 240;
/** 动态物体的变化阈值（低于它不重复发送） */
const OBJ_EPS_POS = 0.6;
const OBJ_EPS_ANG = 0.02;
/** 掉落物的变化阈值 */
const DROP_EPS = 1;
/** 掉落物位置上报间隔（掉落物只有几个，独立节流即可） */
const DROP_INTERVAL = 100;

interface SnapSample {
  /** 本地接收时间（ms） */
  at: number;
  players: Map<number, SnapPlayer>;
  objects: Map<string, SnapObj>;
  drops: Map<number, SnapDrop>;
}

/**
 * 一局联机对战的客户端同步层（v2：房主权威 + 本地预测 + 远端插值）。
 *
 * 为什么改成这样：
 * 旧版是"各端全量模拟 + 100ms 过期坐标 + 140px 硬阈值"，物理不是跨端确定性的，
 * 两端位置必然漂移；一旦漂移超过阈值就硬拉，于是出现"跳上二楼又闪回一楼"，
 * 以及"我看 5 个箱子、你看 4 个箱子"。
 *
 * 新版把世界权威收敛到**一台客户端（房主）**：
 * - 房主模拟所有人 + 整张地图，20Hz 广播 `snap`（玩家变换 / 动态刚体 / 掉落物坐标）；
 * - 非房主客户端：自己的角色本地预测（零输入延迟），远端玩家与箱子按 100ms 缓冲插值回放；
 * - 自己的角色收到房主快照后做**平滑纠偏**（小误差慢慢收，大误差才硬对齐）；
 * - 破坏、拾取、伤害、投掷掉落全部由房主结算，服务端只做记录与广播；
 * - 房主掉线时服务端顺延给下一位玩家，新宿主从当前世界状态接管。
 */
export class OnlineMatch {
  readonly localNetId: number;
  private readonly deps: OnlineMatchDeps;
  private readonly remote = new Map<number, RemoteInput>();
  private readonly unsubscribe: () => void;
  private readonly entityToNet = new Map<number, number>();
  /** 动态地图物体：id → runtime（只有非静态刚体需要同步） */
  private readonly objectById = new Map<string, MapObjectRuntime>();
  private dynamicObjects: MapObjectRuntime[] = [];

  /** 世界权威座位号（-1 = 暂无） */
  private hostSeat: number;
  /** 本端角色 */
  private role: 'authority' | 'client';

  private localCmd: InputCommand = emptyInput();
  private localEdges = 0;
  private seq = 0;

  private lastPosAt = 0;
  private lastShieldSent = 0;
  private disposed = false;

  // ---- 房主侧：快照发送 ----
  private snapAccum = 0;
  private keyAccum = KEYFRAME_INTERVAL;
  private snapSeq = 0;
  private dropAccum = 0;
  /** 越界清理计时（房主） */
  private cleanAccum = 0;
  private readonly lastObjSent = new Map<string, { x: number; y: number; a: number }>();
  private readonly lastDropSent = new Map<number, { x: number; y: number; f: boolean }>();

  // ---- 客户端侧：快照缓冲 ----
  private samples: SnapSample[] = [];
  /** 本地玩家最近一次权威样本（用于纠偏） */
  private latestOwn: SnapPlayer | null = null;
  private ownSampleAt = 0;

  // ---- 延迟估计（用于把"过期样本"外推到"现在"） ----
  private pingTimer = 0;
  private pingSentAt = 0;
  private oneWay = 45;

  /**
   * 运行时可观测指标（调试面板 / E2E 断言用）。
   * 这些数字就是"瞬移有没有被消掉"的直接证据：
   * - hardSnaps：本地角色被硬对齐的次数（正常应为 0）
   * - remoteMaxStep：远端玩家单帧最大位移（跳跃极限约 20px/帧；瞬移会是 100+）
   */
  readonly stats = {
    role: 'client' as 'authority' | 'client',
    hardSnaps: 0,
    lastSnapSeq: 0,
    samples: 0,
    oneWay: 45,
    remoteMaxStep: 0,
    snapshotsSent: 0,
    /** 本地预测与房主权威状态的位置误差（px，越小说明预测越准） */
    localErr: 0,
  };
  /** 上一帧远端玩家的位置（统计单帧位移用） */
  private readonly lastRemoteAt = new Map<number, { x: number; y: number }>();

  constructor(deps: OnlineMatchDeps) {
    this.deps = deps;
    this.localNetId = deps.ctx.you;
    this.hostSeat = deps.ctx.host ?? -1;
    this.role = this.hostSeat === this.localNetId ? 'authority' : 'client';

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
    // 中途加入/重连：用服务端缓存的全量快照把动态世界还原到"此刻"
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

  /** 联机：把投掷后插不进去的武器交给服务端生成掉落物 */
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

  /** 每帧收尾：房主发快照 / 客户端做插值与纠偏。 */
  update(dtMs: number): void {
    if (this.disposed) return;
    if (this.role === 'authority') this.authorityTick(dtMs);
    else this.clientTick(dtMs);
    this.sendPosAndShield(dtMs);
  }

  // ---------- 房主：权威快照 ----------

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

    // 掉落物坐标：变化时才带（房主是唯一知道落点的人，也是服务端保存进快照的来源）
    const withDrops = key || this.dropAccum >= DROP_INTERVAL;
    if (withDrops) this.dropAccum = 0;

    this.send(this.buildSnapshot(key, withDrops));
  }

  /**
   * 房主：清理掉出地图的刚体与掉落物。
   *
   * 不清理的后果：一个掉出世界的箱子会永远自由落体（y 涨到几万），
   * 既浪费物理计算，又会污染快照（其它端要为它插值/同步）。
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
    const players: SnapPlayer[] = [];
    for (const [netId, player] of this.deps.players) {
      const body = player.body;
      players.push({
        id: netId,
        x: round2(body.position.x),
        y: round2(body.position.y),
        vx: round2(body.velocity.x),
        vy: round2(body.velocity.y),
        g: player.isGrounded,
      });
    }

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
      p: players,
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

  // ---------- 客户端：插值回放 + 本地纠偏 ----------

  private clientTick(dtMs: number): void {
    this.tickPing(dtMs);

    const now = performance.now();
    const renderAt = now - INTERP_DELAY;
    const view = this.sampleAt(renderAt);
    if (view) {
      for (const [id, s] of view.players) {
        if (id === this.localNetId) continue;
        const player = this.deps.players.get(id);
        if (!player) continue;
        const prev = this.lastRemoteAt.get(id);
        if (prev) {
          const step = Math.hypot(s.x - prev.x, s.y - prev.y);
          if (step > this.stats.remoteMaxStep) this.stats.remoteMaxStep = step;
        }
        this.lastRemoteAt.set(id, { x: s.x, y: s.y });
        player.driveRemoteState(s.x, s.y, s.vx, s.vy, s.g);
      }
      for (const [id, o] of view.objects) {
        const runtime = this.objectById.get(id);
        if (runtime?.body) this.driveObject(runtime.body, o.x, o.y, o.a);
      }
    }

    // 自己的角色：房主的权威状态才是真的，本地只是预测 → 平滑纠偏
    const local = this.localPlayer;
    if (local) this.reconcileLocal(local);
  }

  private reconcileLocal(local: Player): void {
    const s = this.latestOwn;
    if (!s || local.health.isDead) return;

    // 样本年龄 = 收到后过去的时间 + 单程延迟（样本描述的是"房主当时"的状态）
    const ageMs = Math.min(600, performance.now() - this.ownSampleAt + this.oneWay);
    const steps = (ageMs / 1000) * STEPS_PER_SEC;
    const targetX = s.x + s.vx * steps;
    const targetY = s.y + s.vy * steps;
    const dx = targetX - local.container.x;
    const dy = targetY - local.container.y;
    const dist = Math.hypot(dx, dy);
    this.stats.localErr = Math.round(dist * 10) / 10;
    if (dist <= LOCAL_DEADBAND) return;

    if (dist > LOCAL_HARD_SNAP) {
      // 真脱同步（掉包/长时间卡顿）：直接对齐，否则会一直漂移
      this.stats.hardSnaps++;
      local.container.setPosition(targetX, targetY);
      local.container.setVelocity(s.vx, s.vy);
      return;
    }

    const k = Math.min(0.5, LOCAL_MAX_STEP / dist);
    local.container.setPosition(
      local.container.x + dx * k,
      local.container.y + dy * k,
    );
  }

  private driveObject(body: MatterJS.BodyType, x: number, y: number, a: number): void {
    const matter = this.deps.scene.matter;
    matter.body.setPosition(body, { x, y });
    matter.body.setAngle(body, a);
    matter.body.setVelocity(body, { x: 0, y: 0 });
    matter.body.setAngularVelocity(body, 0);
  }

  /** 把快照合并进缓冲（累积式：省略的字段沿用上一帧） */
  private ingestSnapshot(msg: SnapMsg, immediate = false): void {
    const at = performance.now();
    const prev = this.samples[this.samples.length - 1];
    const players = prev ? new Map(prev.players) : new Map<number, SnapPlayer>();
    const objects = prev ? new Map(prev.objects) : new Map<string, SnapObj>();
    const drops = prev ? new Map(prev.drops) : new Map<number, SnapDrop>();

    for (const s of msg.p) {
      players.set(s.id, s);
      if (s.id === this.localNetId) {
        this.latestOwn = s;
        this.ownSampleAt = at;
      }
    }
    for (const o of msg.o ?? []) objects.set(o.id, o);
    for (const d of msg.d ?? []) drops.set(d.id, d);

    this.samples.push({ at, players, objects, drops });
    this.stats.lastSnapSeq = msg.seq;
    this.stats.samples = this.samples.length;
    // 只保留 1.5s
    while (this.samples.length > 2 && at - this.samples[0].at > SAMPLE_KEEP) this.samples.shift();

    // 掉落物坐标是权威的，直接落到本地表现上
    for (const d of msg.d ?? []) this.deps.pickups.applyNetPosition(d.id, d.x, d.y, d.f);

    if (immediate) {
      for (const [id, s] of players) {
        if (id === this.localNetId) continue;
        this.deps.players.get(id)?.driveRemoteState(s.x, s.y, s.vx, s.vy, s.g);
      }
      for (const [id, o] of objects) {
        const runtime = this.objectById.get(id);
        if (runtime?.body) this.driveObject(runtime.body, o.x, o.y, o.a);
      }
    }
  }

  /** 按渲染时间取样（两帧之间线性插值；过期则用速度外推） */
  private sampleAt(renderAt: number): SnapSample | null {
    const list = this.samples;
    if (list.length === 0) return null;
    if (list.length === 1 || renderAt <= list[0].at) return list[0];

    const last = list[list.length - 1];
    if (renderAt >= last.at) {
      const dt = Math.min(MAX_EXTRAPOLATE, renderAt - last.at) / 1000;
      const players = new Map<number, SnapPlayer>();
      for (const [id, s] of last.players) {
        players.set(id, {
          ...s,
          x: s.x + s.vx * dt * STEPS_PER_SEC,
          y: s.y + s.vy * dt * STEPS_PER_SEC,
        });
      }
      return { at: last.at, players, objects: last.objects, drops: last.drops };
    }

    for (let i = list.length - 2; i >= 0; i--) {
      const a = list[i];
      const b = list[i + 1];
      if (renderAt < a.at || renderAt > b.at) continue;
      const span = b.at - a.at;
      const t = span > 0 ? (renderAt - a.at) / span : 0;

      const players = new Map<number, SnapPlayer>();
      for (const [id, sb] of b.players) {
        const sa = a.players.get(id) ?? sb;
        players.set(id, {
          id,
          x: lerp(sa.x, sb.x, t),
          y: lerp(sa.y, sb.y, t),
          vx: lerp(sa.vx, sb.vx, t),
          vy: lerp(sa.vy, sb.vy, t),
          g: sb.g,
        });
      }
      const objects = new Map<string, SnapObj>();
      for (const [id, ob] of b.objects) {
        const oa = a.objects.get(id) ?? ob;
        objects.set(id, {
          id,
          x: lerp(oa.x, ob.x, t),
          y: lerp(oa.y, ob.y, t),
          a: lerpAngle(oa.a, ob.a, t),
        });
      }
      return { at: renderAt, players, objects, drops: b.drops };
    }
    return last;
  }

  private tickPing(dtMs: number): void {
    this.pingTimer += dtMs;
    if (this.pingTimer < 1000) return;
    // 上一个 ping 还没回（掉包）→ 丢弃重发，避免一直等
    if (this.pingSentAt !== 0 && performance.now() - this.pingSentAt < 2500) return;
    this.pingTimer = 0;
    this.pingSentAt = performance.now();
    this.send({ t: 'ping', ts: Math.round(this.pingSentAt) });
  }

  // ---------- 上行 ----------

  private send(msg: ClientMsg): void {
    this.deps.ctx.link.send(msg);
  }

  /** 10Hz 上报自身位置（服务端只用于抢拾距离粗校验，不再广播） + 本地护盾增量 */
  private sendPosAndShield(dtMs: number): void {
    const local = this.localPlayer;
    if (!local || dtMs <= 0) return;

    this.lastPosAt += dtMs;
    if (this.lastPosAt >= 100) {
      this.lastPosAt = 0;
      this.send({
        t: 'pos',
        x: round2(local.container.x),
        y: round2(local.container.y),
        vx: round2(local.body.velocity.x),
        vy: round2(local.body.velocity.y),
      });
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

  /** 联机：摔落等环境伤害由房主统一检测后上报 */
  reportEnvDamage(amount: number, player?: Player): void {
    if (this.role !== 'authority' || amount <= 0) return;
    const target = player ?? this.localPlayer;
    if (!target) return;
    const targetNet = this.netIdOf(target);
    if (targetNet < 0) return;
    this.send({
      t: 'dmg',
      target: targetNet,
      src: -1,
      amount,
      kind: 'env',
      crit: false,
      attack: 0,
      ignoreInvuln: true,
    });
  }

  private reportDamage(target: Player, info: DamageInfo): void {
    if (this.role !== 'authority') return;
    const targetNet = this.netIdOf(target);
    if (targetNet < 0) return;
    // 攻击者：用实体 id 反查座位号；拿不到就当作环境伤害
    const srcNet = info.sourceId !== undefined ? (this.entityToNet.get(info.sourceId) ?? -1) : -1;
    this.send({
      t: 'dmg',
      target: targetNet,
      src: srcNet,
      amount: info.amount,
      kind: info.kind,
      crit: info.critical === true,
      point: info.point ? { x: round2(info.point.x), y: round2(info.point.y) } : undefined,
      kb: info.knockback ? { x: round2(info.knockback.x), y: round2(info.knockback.y) } : undefined,
      attack: info.attackId ?? 0,
      ignoreInvuln: info.ignoreInvuln === true,
    });
  }

  private requestPickup(
    item: { netId?: number; kind: 'weapon' | 'item'; weaponId?: string; itemId?: string; ammo?: number; x: number; y: number },
    player: Player,
    swap: boolean,
  ): void {
    if (this.role !== 'authority') return;
    if (item.netId === undefined) return;
    const by = this.netIdOf(player);
    if (by < 0) return;
    let swapPayload: { weaponId: string; ammo: number; x: number; y: number } | undefined;
    if (swap && player.heldWeapon) {
      swapPayload = {
        weaponId: player.heldWeapon.id,
        ammo: player.heldWeapon.ammo,
        x: round2(player.container.x),
        y: round2(player.container.y),
      };
    }
    this.send({ t: 'pick', id: item.netId, by, swap: swapPayload });
  }

  // ---------- 角色 ----------

  private applyRole(): void {
    const authority = this.role === 'authority';
    this.stats.role = this.role;
    this.deps.destruction.setAuthority(authority);
    this.deps.pickups.setNet(
      { request: (item, player, swap) => this.requestPickup(item, player, swap) },
      authority ? null : this.localPlayer,
      authority ? 'authority' : 'client',
    );
    this.deps.damage.setNetSink({
      playerDamage: (target, info) => this.reportDamage(target, info),
      objectDestroyed: (id) => {
        if (this.role === 'authority') this.send({ t: 'obj', id });
      },
    });
    for (const player of this.deps.players.values()) {
      player.envDamageReporter = (amount, p) => this.reportEnvDamage(amount, p ?? player);
    }
    // 切到房主：清掉发送缓存，下一帧发全量
    if (authority) {
      this.lastObjSent.clear();
      this.lastDropSent.clear();
      this.keyAccum = KEYFRAME_INTERVAL;
    }
  }

  private onHostChanged(seat: number): void {
    const previous = this.role;
    this.hostSeat = seat;
    this.role = seat === this.localNetId ? 'authority' : 'client';
    const next = this.role;
    if (previous === next) return;

    if (next === 'authority') {
      // 接管世界：远端玩家从现在开始由本端物理模拟（停止用快照驱动）
      this.samples = [];
      this.latestOwn = null;
      this.lastRemoteAt.clear();
      for (const player of this.deps.players.values()) player.clearRemoteDrive();
    } else {
      this.snapSeq = 0;
    }
    this.applyRole();
  }

  // ---------- 下行 ----------

  private handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'in':
        this.applyInputs(msg.p);
        break;
      case 'snap':
        if (this.role === 'client') this.ingestSnapshot(msg);
        break;
      case 'host':
        this.onHostChanged(msg.id);
        break;
      case 'drop_remove':
        this.deps.pickups.removeByNetId(msg.id);
        this.lastDropSent.delete(msg.id);
        break;
      case 'pong':
        this.onPong(msg.ts);
        break;
      case 'hp':
        this.applyHp(msg);
        break;
      case 'drop_add':
        this.spawnDrop(msg.item);
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

  private onPong(ts: number): void {
    if (this.pingSentAt === 0) return;
    const rtt = performance.now() - ts;
    this.pingSentAt = 0;
    if (rtt <= 0 || rtt > 3000) return;
    // 单向延迟取平滑最小值的一半（估计"房主状态传播到本端"的时间）
    const half = rtt / 2;
    this.oneWay = this.oneWay * 0.7 + half * 0.3;
    this.stats.oneWay = Math.round(this.oneWay);
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
    // 本地玩家同样以服务端为准
    p.applyNetDamage({
      hp: msg.hp,
      shield: msg.shield,
      dead: msg.dead,
      amount: msg.amount,
      kind: msg.kind,
      crit: msg.crit,
      point: msg.point,
      knockback: msg.kb,
      sourceId: msg.src,
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
    player.envDamageReporter = (amount, p) => this.reportEnvDamage(amount, p ?? player);
    this.deps.onRosterChanged();
  }

  private removePlayer(netId: number): void {
    const player = this.deps.players.get(netId);
    if (!player) return;
    this.deps.players.delete(netId);
    this.remote.delete(netId);
    this.entityToNet.delete(player.id);
    this.deps.kills.delete(player.id);
    if (netId === this.localNetId) {
      this.latestOwn = null;
    }
    player.destroy();
    this.deps.onRosterChanged();
  }
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
