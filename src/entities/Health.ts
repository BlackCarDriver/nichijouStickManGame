/**
 * 生命值组件（玩家/可破坏实体通用）。
 *
 * 只负责数值：HP、护盾、无敌帧、死亡标记。
 * 表现（受击姿态、屏幕震动、闪白）由持有者与 DamageSystem 负责。
 *
 * 护盾规则（防弹衣 / 超级战士）：
 *   伤害**先扣护盾**，护盾未打空时生命值不掉（全身免伤）；
 *   护盾打空后护盾消失（数值归 0），之后的伤害才进生命值。
 *   溢出的伤害会继续打生命值（100 护盾挨 150 伤害 → 护盾清空 + 扣 50 血）。
 */
export interface HealthOptions {
  maxHp: number;
  /** 受击后的默认无敌时长（ms），防止连发一帧内打空血量 */
  invulnMs?: number;
  /** 护盾上限（0 / 不填 = 该实体没有护盾能力） */
  maxShield?: number;
}

/** 一次伤害结算的结果 */
export interface DamageOutcome {
  /** 实际扣除的生命值 */
  hp: number;
  /** 被护盾吸收的量 */
  shield: number;
}

const NO_DAMAGE: DamageOutcome = { hp: 0, shield: 0 };

export class Health {
  readonly maxHp: number;
  readonly maxShield: number;
  private readonly defaultInvulnMs: number;
  private hpValue: number;
  private shieldValue = 0;
  private invulnTimer = 0;
  private dead = false;

  constructor(options: HealthOptions) {
    this.maxHp = options.maxHp;
    this.maxShield = options.maxShield ?? 0;
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

  get shield(): number {
    return this.shieldValue;
  }

  /** 护盾比例 0~1（HUD 用；无护盾能力时恒为 0） */
  get shieldRatio(): number {
    return this.maxShield > 0 ? Math.max(0, Math.min(1, this.shieldValue / this.maxShield)) : 0;
  }

  get hasShield(): boolean {
    return this.shieldValue > 0;
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
   * 扣血：**先扣护盾**，护盾打空后溢出部分扣生命值。
   * @param ignoreInvuln 爆炸/环境伤害可无视无敌帧（按需）
   */
  applyDamage(amount: number, ignoreInvuln = false): DamageOutcome {
    if (this.dead || amount <= 0) return NO_DAMAGE;
    if (!ignoreInvuln && this.invulnTimer > 0) return NO_DAMAGE;

    let remaining = amount;
    let absorbed = 0;

    // 1) 护盾先承受（全身免伤）
    if (this.shieldValue > 0) {
      absorbed = Math.min(this.shieldValue, remaining);
      this.shieldValue -= absorbed;
      remaining -= absorbed;
      if (this.shieldValue <= 0) this.shieldValue = 0; // 护盾值清零 → 护盾消失
    }

    // 2) 剩余伤害进生命值
    let hpApplied = 0;
    if (remaining > 0) {
      hpApplied = Math.min(this.hpValue, remaining);
      this.hpValue -= hpApplied;
      if (this.hpValue <= 0) {
        this.hpValue = 0;
        this.dead = true;
      }
    }

    // 挨打（无论打在护盾还是血量上）都给无敌帧，避免连发一帧打穿
    if (!this.dead && !ignoreInvuln && this.defaultInvulnMs > 0) {
      this.invulnTimer = this.defaultInvulnMs;
    }

    return { hp: hpApplied, shield: absorbed };
  }

  /** 增加护盾（防弹衣 / 超级战士），返回实际增加量（受 maxShield 限制） */
  addShield(amount: number): number {
    if (this.dead || amount <= 0 || this.maxShield <= 0) return 0;
    const before = this.shieldValue;
    this.shieldValue = Math.min(this.maxShield, this.shieldValue + amount);
    return this.shieldValue - before;
  }

  /** 清空护盾（不影响生命值） */
  clearShield(): void {
    this.shieldValue = 0;
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

  /** 复活/重置：满血、清空护盾与无敌、复活死亡状态 */
  reset(): void {
    this.hpValue = this.maxHp;
    this.shieldValue = 0;
    this.invulnTimer = 0;
    this.dead = false;
  }
}
