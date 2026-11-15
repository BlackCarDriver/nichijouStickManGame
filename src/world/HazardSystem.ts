import Phaser from 'phaser';
import type { Player } from '../entities/Player';
import type { WorldRegistry } from './WorldRegistry';
import { MATERIALS } from '../config/materials';

/**
 * 接触伤害（危险材质）。
 *
 * 材质里配了 `damagePerSecond` 之后，火柴人**贴着**这种物体就会持续掉血
 * （岩浆、尖刺、毒液、电地板……），而不是"撞一下掉一次"。
 *
 * 实现要点：
 * - 用 Matter 的 `collisionactive`：物体持续接触时**每帧**都会触发，正好是"贴着"的语义；
 *   不需要自己记 collisionstart/end 配对（漏事件也不会卡住）。
 * - 按固定节流（`TICK_MS`）结算，每次掉 `dps × 结算间隔` 的血 ——
 *   这样 dps 就是字面意义上的"每秒伤害"，和帧率无关。
 * - 联机：只有本地玩家上报（`envDamageReporter` → 服务端权威结算），
 *   远端玩家的血由他们自己上报；单机则本地直接结算。
 * - 伤害数字每 `NUMBER_INTERVAL_MS` 汇总弹一次，避免 4 次/秒刷屏。
 */
export class HazardSystem {
  /** 伤害结算间隔（ms）：4 次/秒，够平滑又不会把网络打满 */
  private static readonly TICK_MS = 250;
  /** 接触判定的"仍然贴着"有效期（ms）：略大于结算间隔，容忍一帧的抖动 */
  private static readonly CONTACT_TTL_MS = 260;
  /** 伤害数字汇总间隔（ms） */
  private static readonly NUMBER_INTERVAL_MS = 1000;

  private readonly scene: Phaser.Scene;
  private readonly bodyToPlayer: Map<number, Player>;
  private readonly registry: WorldRegistry;

  /**
   * 玩家 → 接触状态。
   * - dps：正在贴着的危险物的每秒伤害
   * - at：最近一次被 collisionactive 刷新的时间（用于判断"离开"）
   * - pendingMs：距离下一次结算累计的时间（每个玩家各自算，相位跟着"接触瞬间"走）
   */
  private readonly contacts = new Map<Player, { dps: number; at: number; pendingMs: number }>();
  /** 伤害数字的累积（每个玩家各自累计，每秒弹一次） */
  private readonly numberAcc = new Map<Player, number>();
  /** 汇总伤害数字的计时器 */
  private numberTimer = 0;

  constructor(scene: Phaser.Scene, bodyToPlayer: Map<number, Player>, registry: WorldRegistry) {
    this.scene = scene;
    this.bodyToPlayer = bodyToPlayer;
    this.registry = registry;
    this.scene.matter.world.on('collisionactive', this.handlePairs, this);
    this.scene.matter.world.on('collisionstart', this.handlePairs, this);
  }

  private handlePairs(event: Phaser.Physics.Matter.Events.CollisionActiveEvent): void {
    for (const pair of event.pairs) {
      const a = pair.bodyA as unknown as MatterJS.BodyType;
      const b = pair.bodyB as unknown as MatterJS.BodyType;
      this.noteContact(a, b);
      this.noteContact(b, a);
    }
  }

  /** a = 危险物，b = 可能是玩家 */
  private noteContact(a: MatterJS.BodyType, b: MatterJS.BodyType): void {
    if (!a || !b) return;
    const dps = this.hazardDps(a);
    if (dps <= 0) return;
    const player = this.playerOf(b);
    if (!player || player.health.isDead) return;

    const now = performance.now();
    const existing = this.contacts.get(player);
    if (existing && now - existing.at <= HazardSystem.CONTACT_TTL_MS) {
      // 已经在接触中：只刷新时间和伤害值（不重复吃"首次"那一下）
      existing.dps = Math.max(existing.dps, dps);
      existing.at = now;
      return;
    }

    // 触碰的**那一瞬间**先结算一次（否则要等下一个 250ms 结算点，手感像"没反应"）
    this.contacts.set(player, { dps, at: now, pendingMs: 0 });
    const first = this.tickAmount(dps);
    if (first > 0) {
      this.applyDamage(player, first);
      // 首次伤害立刻弹数字（后续按秒汇总）
      this.scene.events.emit('hazard-damaged', player, Math.max(1, Math.round(first)));
    }
  }

  /** 一次结算的伤害量（dps × 结算间隔） */
  private tickAmount(dps: number): number {
    return (dps * HazardSystem.TICK_MS) / 1000;
  }

  /** 统一出口：联机由本地玩家上报（服务端权威），单机直接结算 */
  private applyDamage(player: Player, amount: number): void {
    if (amount <= 0 || player.health.isDead) return;
    const reporter = player.envDamageReporter;
    if (reporter) reporter(amount, player);
    else if (!player.netControlled) player.applyHazardDamage(amount);
  }

  /** 这个 body 属于的材质每秒造成多少伤害（非地图物体 → 0） */
  private hazardDps(body: MatterJS.BodyType): number {
    const runtime = this.registry.resolve(body);
    if (!runtime) return 0;
    return MATERIALS[runtime.material]?.damagePerSecond ?? 0;
  }

  private playerOf(body: MatterJS.BodyType): Player | undefined {
    if (!body) return undefined;
    return this.bodyToPlayer.get(body.id) ?? this.bodyToPlayer.get(body.parent?.id ?? -1);
  }

  update(deltaMs: number): void {
    if (this.contacts.size === 0) {
      this.numberAcc.clear();
      this.numberTimer = 0;
      return;
    }

    const now = performance.now();
    for (const [player, contact] of [...this.contacts]) {
      if (now - contact.at > HazardSystem.CONTACT_TTL_MS) {
        this.contacts.delete(player);
        continue;
      }
      if (player.health.isDead) {
        this.contacts.delete(player);
        continue;
      }

      // 每个玩家自己累计：相位从"接触那一刻"开始，首次伤害已经在 noteContact 里给了
      contact.pendingMs += deltaMs;
      while (contact.pendingMs >= HazardSystem.TICK_MS) {
        contact.pendingMs -= HazardSystem.TICK_MS;
        const amount = this.tickAmount(contact.dps);
        if (amount <= 0) continue;
        this.applyDamage(player, amount);
        this.accumulateNumber(player, amount);
      }
    }

    // 每秒把累积的接触伤害汇总成一个数字弹出（不刷屏）
    this.numberTimer += deltaMs;
    if (this.numberTimer >= HazardSystem.NUMBER_INTERVAL_MS) {
      this.numberTimer = 0;
      for (const [player, total] of this.numberAcc) {
        if (total > 0.5 && !player.health.isDead) {
          this.scene.events.emit('hazard-damaged', player, Math.round(total));
        }
      }
      this.numberAcc.clear();
    }
  }

  private accumulateNumber(player: Player, amount: number): void {
    this.numberAcc.set(player, (this.numberAcc.get(player) ?? 0) + amount);
  }

  destroy(): void {
    this.scene.matter?.world?.off('collisionactive', this.handlePairs, this);
    this.scene.matter?.world?.off('collisionstart', this.handlePairs, this);
    this.contacts.clear();
    this.numberAcc.clear();
  }
}
