import type { Player } from '../entities/Player';
import type { MapObjectRuntime } from '../map/MapLoader';
import type { DestructionSystem } from '../world/DestructionSystem';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageInfo, DamageResult } from './DamageInfo';

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
  private readonly fx: FxSystem;
  private readonly destruction: DestructionSystem;

  constructor(fx: FxSystem, destruction: DestructionSystem) {
    this.fx = fx;
    this.destruction = destruction;
  }

  /** 对玩家造成伤害 */
  damagePlayer(player: Player, info: DamageInfo): DamageResult {
    const applied = player.applyDamage(info);
    if (applied <= 0) {
      return { applied: 0, killed: false };
    }
    if (info.point) {
      this.fx.hitSpark(info.point, info.normal, 0xff6b6b);
    }
    return { applied, killed: player.health.isDead };
  }

  /** 对地图物体造成伤害 */
  damageObject(runtime: MapObjectRuntime, info: DamageInfo): DamageResult {
    const result = this.destruction.damage(runtime, info);
    return { applied: result.applied, killed: result.destroyed };
  }
}
