/**
 * 武器表（数据源：data/weapons.json）。
 *
 * JSON 是唯一真源：游戏与（将来的）武器编辑器共用同一份数据。
 * 与 materials.json 一样，颜色用 hex 字符串（人和 AI 都读得懂）。
 *
 * 实现状态（W2）：
 *   - attackMode 'shoot'  → 逻辑弹道子弹（手枪/AK47/火箭炮）
 *   - attackMode 'beam'   → 瞬时光束 hitscan（激光枪）
 *   - attackMode 'melee'  → W3（刺击）
 *   - attackMode 'throw'  → W3/W4（投掷）
 */
import rawWeapons from '../../data/weapons.json';

/** 攻击方式 */
export type AttackMode = 'shoot' | 'beam' | 'melee' | 'throw';

/** 子弹外观类型（渲染用） */
export type BulletKind = 'dot' | 'streak' | 'rocket' | 'grenade' | 'thrown';

/** 手持武器的外形风格（渲染用） */
export type WeaponVisualStyle =
  | 'pistol'
  | 'rifle'
  | 'laser'
  | 'launcher'
  | 'dagger'
  | 'spear'
  | 'grenade'
  | 'lightsaber';

export interface BulletConfig {
  kind: BulletKind;
  /** 飞行速度（px/秒）—— 不同武器速度不同，直接决定"子弹飞行时间" */
  speed: number;
  /**
   * 重力覆盖（px/秒²）。一般**不要填**：所有子弹共用文件顶层的
   * `projectileGravity`，这样下坠距离只由速度和距离决定（物理上正确）。
   * 只有特殊表现（例如想做一个"无重力"的弹种）才在这里覆盖。
   */
  gravity?: number;
  /** 最大飞行距离（px） */
  range: number;
  /** 弹头大小（px） */
  size: number;
  /** 颜色（hex） */
  color: string;
  /** 拖尾长度（px），0 = 无拖尾 */
  trail: number;
  /** 最多反弹次数（材质需 bulletBounce 才会反弹） */
  maxBounces: number;
  /** 每次反弹后的伤害倍率 */
  bounceDamageMul: number;
  /** 每次穿透后的伤害倍率 */
  pierceDamageMul: number;
  /** 是否穿透玩家（激光类）；默认 false = 命中即停 */
  piercePlayers: boolean;
  /** 是否对任意材质反弹（手榴弹落地会弹跳） */
  bounceAny?: boolean;
  /** 反弹速度保留系数（0.45 = 弹跳衰减，1 = 完全弹性） */
  bounceRestitution?: number;
}

export interface BeamConfig {
  range: number;
  width: number;
  color: string;
  /** 光束视觉持续时间（ms） */
  duration: number;
}

export interface MeleeConfig {
  /** 攻击距离（px） */
  reach: number;
  /** 判定弧宽（半角，度）；slash 时按此角度扫描整段弧 */
  arc: number;
  /** 动作类型：stab = 直刺（匕首/长矛）；slash = 挥砍（光刀） */
  anim?: 'stab' | 'slash';
}

export interface ThrowConfig {
  speed: number;
  range: number;
  /** 重力（px/秒²），抛物线强度 */
  gravity?: number;
  /** 引信时间（ms）：到期自爆（手榴弹） */
  fuseMs?: number;
  /** 投掷物插在目标上的停留时间（ms）—— 匕首/长矛 */
  stickMs?: number;
  /** 投掷伤害（不填则用 weapon.damage） */
  damage?: number;
  /** 对任意材质反弹（手榴弹落地弹跳） */
  bounceAny?: boolean;
  /** 反弹速度保留系数 */
  bounceRestitution?: number;
}

export interface ExplosionConfig {
  /** 爆炸半径（px） */
  radius: number;
  /** 爆炸中心伤害（边缘按距离衰减到 0） */
  damage: number;
  /** 是否伤害投掷者自己 */
  selfDamage: boolean;
  /** 击退强度 */
  knockback: number;
}

export interface WeaponVisual {
  style: WeaponVisualStyle;
  /** 武器长度（px）：从手部沿瞄准方向延伸，决定枪口位置 */
  length: number;
  thickness: number;
  color: string;
  /** 发光色（光刀等发光武器用；不填则不发光） */
  glow?: string;
}

export interface WeaponJson {
  name: string;
  attackMode: AttackMode;
  /** 是否全自动（长按连射） */
  automatic: boolean;
  /** 射速（发/秒） */
  fireRate: number;
  /** 单次命中伤害 */
  damage: number;
  /** 命中玩家的击退强度 */
  knockback: number;
  /** 弹药数；-1 = 无限（近战武器靠耐久） */
  ammo: number;
  /** 武器耐久上限 */
  durability: number;
  /** 每次攻击消耗的耐久 */
  durabilityPerShot: number;
  bullet?: BulletConfig;
  beam?: BeamConfig;
  melee?: MeleeConfig;
  throw?: ThrowConfig;
  explosion?: ExplosionConfig;
  visual: WeaponVisual;
}

interface WeaponsFile {
  version: number;
  /** 所有子弹/投掷物共用的重力加速度（px/秒²） */
  projectileGravity?: number;
  weapons: Record<string, WeaponJson>;
}

const file = rawWeapons as WeaponsFile;

/**
 * 全局弹道重力（px/秒²）。所有子弹与投掷物共用同一个值 ——
 * 下坠距离 = ½ · g · (飞行距离 / 速度)²，因此只取决于速度与距离。
 * 想整体调"弹道弧得多厉害"只改这一个数（data/weapons.json 的 projectileGravity）。
 */
export const PROJECTILE_GRAVITY = file.projectileGravity ?? 520;

/** 解析某个弹种实际使用的重力：显式覆盖优先，否则用全局值 */
export function resolveGravity(override?: number): number {
  return override ?? PROJECTILE_GRAVITY;
}

/** 武器表（只读） */
export const WEAPONS: Readonly<Record<string, WeaponJson>> = file.weapons;

export function getWeapon(id: string): WeaponJson | undefined {
  return WEAPONS[id];
}

/** 武器 id 列表（按 json 顺序） */
export function listWeaponIds(): string[] {
  return Object.keys(WEAPONS);
}

/** 装备中的武器运行时状态（每名玩家一份） */
export interface HeldWeapon {
  id: string;
  /** 剩余弹药（-1 = 无限） */
  ammo: number;
  /** 剩余耐久 */
  durability: number;
}

export function createHeldWeapon(id: string): HeldWeapon | undefined {
  const w = getWeapon(id);
  if (!w) return undefined;
  return { id, ammo: w.ammo, durability: w.durability };
}
