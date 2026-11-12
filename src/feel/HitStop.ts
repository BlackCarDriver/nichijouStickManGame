/**
 * 命中停顿（hitstop / 顿帧）。
 *
 * 命中瞬间冻结整个世界极短时间（20~70ms），是"打击感"最有效的手段之一：
 * 视觉上像拳头/子弹"撞上了硬东西"，比单纯加特效更有力。
 *
 * 注意：本作是**同屏双人**，全局冻结会同时影响另一个玩家。
 * 因此时长按伤害量缩放并设上限（默认 ≤70ms），短到不会打断另一个人的操作节奏。
 * 将来联机时，这个类应该改成"只让受击方表现层变慢"，调用点不用改。
 */
export class HitStop {
  /** 剩余冻结时间（ms） */
  private remaining = 0;

  /** 当前是否处于冻结中 */
  get active(): boolean {
    return this.remaining > 0;
  }

  /**
   * 触发一次顿帧。
   * @param ms 时长（会被限制在 0~90ms）
   */
  trigger(ms: number): void {
    // 取较大值：连续命中时不会缩短已有的停顿
    this.remaining = Math.max(this.remaining, Math.min(90, Math.max(0, ms)));
  }

  /** 每帧调用：递减剩余冻结时间 */
  update(deltaMs: number): void {
    if (this.remaining > 0) {
      this.remaining = Math.max(0, this.remaining - deltaMs);
    }
  }

  /** 根据伤害量估算顿帧时长（越重打得越"实"） */
  static durationForDamage(damage: number): number {
    return Math.min(70, Math.max(22, damage * 1.1));
  }
}
