/**
 * 生命值组件（玩家/可破坏实体通用）。
 *
 * 只负责数值：HP、无敌帧、死亡标记。
 * 表现（受击姿态、屏幕震动、闪白）由持有者与 DamageSystem 负责。
 */
export interface HealthOptions {
  maxHp: number;
  /** 受击后的默认无敌时长（ms），防止连发一帧内打空血量 */
  invulnMs?: number;
}

export class Health {
  readonly maxHp: number;
  private readonly defaultInvulnMs: number;
  private hpValue: number;
  private invulnTimer = 0;
  private dead = false;

  constructor(options: HealthOptions) {
    this.maxHp = options.maxHp;
    this.defaultInvulnMs = options.invulnMs ?? 0;
    this.hpValue = options.maxHp;
  }

  get hp(): number {
    return this.hpValue;
  }

  /** 血量比例 0~1（HUD 用） */
  get ratio(): number {
    return this.maxHp > 0 ? Math.max(0, this.hpValue / this.maxHp) : 0;
  }

  get isDead(): boolean {
    return this.dead;
  }

  get isInvulnerable(): boolean {
    return this.invulnTimer > 0;
  }

  update(deltaMs: number): void {
    if (this.invulnTimer > 0) {
      this.invulnTimer = Math.max(0, this.invulnTimer - deltaMs);
    }
  }

  /**
   * 扣血。返回实际生效的伤害（0 = 被无敌帧或死亡状态挡掉）。
   * @param ignoreInvuln 爆炸/环境伤害可无视无敌帧（按需）
   */
  applyDamage(amount: number, ignoreInvuln = false): number {
    if (this.dead || amount <= 0) return 0;
    if (!ignoreInvuln && this.invulnTimer > 0) return 0;

    const applied = Math.min(this.hpValue, amount);
    this.hpValue -= applied;

    if (this.hpValue <= 0) {
      this.hpValue = 0;
      this.dead = true;
    } else if (!ignoreInvuln && this.defaultInvulnMs > 0) {
      this.invulnTimer = this.defaultInvulnMs;
    }
    return applied;
  }

  /** 治疗，返回实际恢复量 */
  heal(amount: number): number {
    if (this.dead || amount <= 0) return 0;
    const before = this.hpValue;
    this.hpValue = Math.min(this.maxHp, this.hpValue + amount);
    return this.hpValue - before;
  }

  setInvulnerable(ms: number): void {
    this.invulnTimer = Math.max(this.invulnTimer, ms);
  }

  /** 复活/重置：满血、清空无敌与死亡状态 */
  reset(): void {
    this.hpValue = this.maxHp;
    this.invulnTimer = 0;
    this.dead = false;
  }
}
