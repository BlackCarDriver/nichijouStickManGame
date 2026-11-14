import type { Player } from '../entities/Player';
import type { MapObjectRuntime } from '../map/MapLoader';
import type { DestructionSystem } from '../world/DestructionSystem';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageInfo, DamageResult } from './DamageInfo';

/**
 * 联机仲裁钩子：伤害不再本地结算，而是上报服务端，等权威 hp 事件回来再表现。
 * 单机模式下为 null（走原来的本地结算）。
 */
export interface DamageNetSink {
  /** 上报对玩家的伤害（只有"自己的攻击"会被网络层真正发出） */
  playerDamage(target: Player, info: DamageInfo): void;
  /** 地图物体被摧毁 → 广播给所有人（服务端按 id 去重） */
  objectDestroyed(runtimeId: string): void;
  /**
   * 联机：本地已经看到"命中了/被打中了"，先把打击反馈播出来（不改血量）。
   *
   * 为什么要它：血量必须等权威 `hp` 回来，但"手感"不能等。
   * 攻击方本地立刻看到伤害数字/受击硬直，受击方本地立刻进入受击姿态，
   * 等 `hp` 到达时只补数值（按攻击批次 id 去重，不会重复播）。
   */
  hitPreview?(target: Player, info: DamageInfo): void;
}

/**
 * 统一伤害入口。
 *
 * 所有伤害来源（子弹 / 近战 / 踢 / 爆炸 / 环境）都调用这里，
 * 由它决定"打的是玩家还是物体"，并统一触发表现（火花/闪白）。
 *
 * 这样做的好处：
 * - 武器系统只关心"打出多少伤害、打到谁"，不关心耐久/血量实现
 * - 破坏系统只关心耐久，不关心伤害来源
 * - 以后加"伤害统计 / 击杀奖励 / 护甲"只需改这一处
 */
export class DamageSystem {
  /** 暴击倍率（命中头部） */
  static readonly CRIT_MULTIPLIER = 2;

  private readonly fx: FxSystem;
  private readonly destruction: DestructionSystem;
  private netSink: DamageNetSink | null = null;

  constructor(fx: FxSystem, destruction: DestructionSystem) {
    this.fx = fx;
    this.destruction = destruction;
  }

  setNetSink(sink: DamageNetSink | null): void {
    this.netSink = sink;
  }

  /**
   * 对玩家造成伤害。
   *
   * **命中头部 = 暴击**：伤害 ×2。判定统一放在这里，
   * 这样所有伤害来源（子弹/光束/刺击/挥砍/出拳）都自动支持，不用各自实现一遍。
   * 爆炸与摔落不参与暴击：它们的 point 是爆炸中心/缺失，不对应"打到头"。
   */
  damagePlayer(player: Player, info: DamageInfo): DamageResult {
    const canCrit = (info.kind === 'bullet' || info.kind === 'melee') && info.point !== undefined;
    const crit = canCrit && player.isHeadHit(info.point!.y);

    const effective: DamageInfo = crit
      ? { ...info, amount: info.amount * DamageSystem.CRIT_MULTIPLIER, critical: true }
      : info;

    // 联机：火花表现本地照常播（各端都能看到命中），生命值以上报为准
    if (this.netSink) {
      if (effective.point) {
        this.fx.hitSpark(effective.point, effective.normal, crit ? 0xffd166 : 0xff6b6b);
      }
      // 先播本地打击反馈（伤害数字/受击硬直/音效），血条等权威 hp
      this.netSink.hitPreview?.(player, effective);
      this.netSink.playerDamage(player, effective);
      return { applied: 0, killed: false };
    }

    const applied = player.applyDamage(effective);
    if (applied <= 0) {
      return { applied: 0, killed: false };
    }
    if (effective.point) {
      // 暴击用金色火花，普通命中用红色
      this.fx.hitSpark(effective.point, effective.normal, crit ? 0xffd166 : 0xff6b6b);
    }
    return { applied, killed: player.health.isDead };
  }

  /** 对地图物体造成伤害 */
  damageObject(runtime: MapObjectRuntime, info: DamageInfo): DamageResult {
    const result = this.destruction.damage(runtime, info);
    if (result.destroyed && this.netSink) {
      this.netSink.objectDestroyed(runtime.id);
    }
    return { applied: result.applied, killed: result.destroyed };
  }
}
