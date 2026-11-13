import type Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { PickupSystem } from '../world/PickupSystem';
import type { DestructionSystem } from '../world/DestructionSystem';
import type { DamageSystem } from '../combat/DamageSystem';
import type { DamageInfo } from '../combat/DamageInfo';
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
} from './protocol';

export interface OnlineMatchDeps {
  scene: Phaser.Scene;
  ctx: MatchContext;
  /** netId → Player（由 GameScene 按 roster 创建） */
  players: Map<number, Player>;
  pickups: PickupSystem;
  destruction: DestructionSystem;
  damage: DamageSystem;
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

/** 位置上报间隔（ms） */
const POS_INTERVAL = 100;
/** 位置纠正阈值（px）：小误差不管，大误差瞬移 */
const SNAP_DIST = 140;
const NUDGE_DIST = 45;

/**
 * 一局联机对战的客户端同步层。
 *
 * 同步模型（A 方案：输入中继 + 双端全量模拟 + 服务器仲裁）：
 * - 本机把 InputCommand 以 60Hz 上报，服务端合并到 30Hz 广播给所有人；
 * - 每个客户端用"本地输入 + 远端输入"驱动同一套 GameScene，物理与手感与单机完全一致；
 * - 血量/击杀/拾取/空投/物体摧毁由服务端仲裁，本地只负责表现；
 * - 每个玩家每 100ms 上报一次权威位置，远端在误差过大时纠正，防止物理长期漂移。
 */
export class OnlineMatch {
  readonly localNetId: number;
  private readonly deps: OnlineMatchDeps;
  private readonly remote = new Map<number, RemoteInput>();
  private readonly unsubscribe: () => void;
  private readonly entityToNet = new Map<number, number>();

  private localCmd: InputCommand = emptyInput();
  private localEdges = 0;
  private seq = 0;
  private lastPosAt = 0;
  private lastShieldSent = 0;
  private disposed = false;

  constructor(deps: OnlineMatchDeps) {
    this.deps = deps;
    this.localNetId = deps.ctx.you;

    for (const [netId, player] of deps.players) {
      this.entityToNet.set(player.id, netId);
      this.remote.set(netId, {
        seq: 0, mx: 0, jh: false, cr: false, ah: false, kh: false, sw: false, aim: 0, pending: 0,
      });
      // 所有玩家都改为网络驱动：本地不结算伤害，复活由服务端 respawn 事件决定
      player.netControlled = true;
      player.autoRespawn = false;
    }

    const local = this.localPlayer;
    if (local) {
      local.envDamageReporter = (amount) => this.reportEnvDamage(amount);
      // 本地玩家的护盾由超级战士/护甲带来，同步给服务端
      this.lastShieldSent = local.health.shield;
    }

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

    deps.damage.setNetSink({
      playerDamage: (target, info) => this.reportDamage(target, info),
      objectDestroyed: (id) => this.send({ t: 'obj', id }),
    });
    deps.pickups.setNet(
      {
        request: (item, player, swap) => this.requestPickup(item, player, swap),
      },
      local ?? null,
    );

    this.unsubscribe = deps.ctx.link.subscribe((msg) => this.handleMessage(msg));
  }

  get localPlayer(): Player | null {
    if (this.localNetId < 0) return null;
    return this.deps.players.get(this.localNetId) ?? null;
  }

  /** 联机：把投掷后插不进去的武器交给服务端生成掉落物 */
  requestDrop(weaponId: string, ammo: number, x: number, y: number): void {
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
    // jump/attack/kick 的"下降沿"已在 InputManager 里区分，这里只转发
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

  /** 每帧收尾：位置上报 + 本地护盾同步。 */
  update(dtMs: number): void {
    const local = this.localPlayer;
    if (!local) return;

    if (dtMs > 0) {
      this.lastPosAt += dtMs;
      if (this.lastPosAt >= POS_INTERVAL) {
        this.lastPosAt = 0;
        this.send({
          t: 'pos',
          x: round2(local.container.x),
          y: round2(local.container.y),
          vx: round2(local.body.velocity.x),
          vy: round2(local.body.velocity.y),
        });
      }
    }

    // 超级战士等本地增益带来的护盾：本地变化后补报给服务端
    const shield = local.health.shield;
    if (shield > this.lastShieldSent) {
      this.send({ t: 'shield', amount: shield - this.lastShieldSent });
      this.lastShieldSent = shield;
    } else if (shield < this.lastShieldSent) {
      // 服务端已经扣过护盾（hp 事件），跟随即可
      this.lastShieldSent = shield;
    }
  }

  // ---------- 上行 ----------

  private send(msg: ClientMsg): void {
    this.deps.ctx.link.send(msg);
  }

  /** 联机：摔落等环境伤害由本地检测后上报 */
  reportEnvDamage(amount: number): void {
    if (amount <= 0 || this.localNetId < 0) return;
    this.send({
      t: 'dmg',
      target: this.localNetId,
      amount,
      kind: 'env',
      crit: false,
      attack: 0,
      ignoreInvuln: true,
    });
  }

  private reportDamage(target: Player, info: DamageInfo): void {
    if (this.localNetId < 0) return;
    if (this.netIdOf(target) < 0) return;
    // 只有"自己的攻击"才上报，避免 N 个客户端重复结算同一发子弹
    if (info.sourceId !== undefined && info.sourceId !== this.localPlayer?.id) return;
    const targetNet = this.netIdOf(target);
    this.send({
      t: 'dmg',
      target: targetNet,
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

  // ---------- 下行 ----------

  private handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'in':
        this.applyInputs(msg.p);
        break;
      case 'pos':
        this.applyPositions(msg.p);
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

  private applyPositions(list: { id: number; x: number; y: number; vx: number; vy: number }[]): void {
    for (const s of list) {
      if (s.id === this.localNetId) continue;
      const p = this.deps.players.get(s.id);
      if (!p) continue;
      const dx = s.x - p.container.x;
      const dy = s.y - p.container.y;
      const dist = Math.hypot(dx, dy);
      if (dist > SNAP_DIST) {
        // 误差过大（卡墙/长延迟）：直接对齐权威位置
        p.container.setPosition(s.x, s.y);
        p.container.setVelocity(s.vx, s.vy);
      } else if (dist > NUDGE_DIST) {
        // 小误差：轻微收敛，避免肉眼可见的拉扯
        p.container.setPosition(p.container.x + dx * 0.12, p.container.y + dy * 0.12);
      }
    }
  }

  private applyHp(msg: ServerMsg & { t: 'hp' }): void {
    const p = this.deps.players.get(msg.id);
    if (!p) return;
    if (msg.id !== this.localNetId) {
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
    } else {
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
      this.lastShieldSent = msg.shield;
    }

    for (const [seat, kills] of Object.entries(msg.kills ?? {})) {
      const player = this.deps.players.get(Number(seat));
      if (player) this.deps.kills.set(player.id, kills);
    }
  }

  private spawnDrop(drop: DropWire): void {
    this.deps.pickups.spawnNet(drop);
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
    this.deps.onRosterChanged();
  }

  private removePlayer(netId: number): void {
    const player = this.deps.players.get(netId);
    if (!player) return;
    this.deps.players.delete(netId);
    this.remote.delete(netId);
    this.entityToNet.delete(player.id);
    this.deps.kills.delete(player.id);
    player.destroy();
    this.deps.onRosterChanged();
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
