/**
 * 伤害数据结构 —— 全局唯一的伤害"语言"。
 *
 * 子弹、近战、踢、爆炸、环境伤害全部产生 DamageInfo，
 * 由 DamageSystem 统一分发到 玩家血量 / 物体耐久 / 特效。
 * 武器侧不需要知道"物体有耐久"，破坏侧不需要知道"子弹怎么飞"。
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** 伤害来源类型（用于反馈强度、后续音效/统计区分） */
export type DamageKind = 'bullet' | 'melee' | 'explosion' | 'kick' | 'env';

export interface DamageInfo {
  /** 伤害量（正数） */
  amount: number;
  kind: DamageKind;
  /** 来源实体 id（玩家/投掷物），用于自伤判定与击杀归属 */
  sourceId?: number;
  /**
   * 造成这次伤害的武器 id（'fist'/'kick'/'grenade' 等特殊值也用它）。
   * 用于"被谁用什么击败"的死亡回放；环境伤害不带。
   */
  weaponId?: string;
  /** 命中点（世界坐标），用于火花/碎片方向 */
  point?: Vec2;
  /** 表面法线（朝向来袭方向），用于火花方向 */
  normal?: Vec2;
  /** 击退冲量（px/step，仅对玩家生效） */
  knockback?: Vec2;
  /**
   * 无视玩家的受击无敌帧。
   * 用于高频低伤的持续伤害（激光光束每 55ms 一跳），
   * 否则 180ms 的受击无敌会把绝大多数 tick 全部挡掉。
   */
  ignoreInvuln?: boolean;
  /**
   * 攻击批次 id：**同一次扣扳机**产生的所有伤害共用一个 id。
   * 霰弹枪的 7 颗弹丸属于同一次攻击，因此它们都能命中同一个目标，
   * 不会被第一颗弹丸造成的受击无敌帧挡掉。
   */
  attackId?: number;
  /** 是否暴击（命中头部）—— 由 DamageSystem 判定后回填，用于表现层 */
  critical?: boolean;
}

/** 伤害结算结果 */
export interface DamageResult {
  /** 实际生效的伤害（0 = 未生效：无敌/已死/不可破坏） */
  applied: number;
  /** 是否因此被摧毁（物体）或死亡（玩家） */
  killed: boolean;
}
