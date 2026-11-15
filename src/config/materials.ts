/**
 * 材质表加载（数据源：data/materials.json）。
 *
 * JSON 是唯一真源：游戏、编辑器、校验脚本共用同一份数据。
 * color 在 JSON 里是 hex 字符串（"#8b5a2b"，人和 AI 都读得懂），
 * 加载时解析成 Phaser 需要的 number，同时保留 colorHex 供编辑器使用。
 *
 * MATERIALS 是**可变单例**：编辑器调参/增删材质时就地修改，
 * 因此所有消费方都应通过 getMaterial() / MATERIALS 读取，不要缓存副本。
 */
import rawMaterials from '../../data/materials.json';

/** 贴图模式：stretch = 拉伸铺满；tile = 平铺（TileSprite） */
export type TextureMode = 'stretch' | 'tile';

/** 发光方式 */
export type GlowMode = 'constant' | 'pulse' | 'flicker';

/** materials.json 里的爆炸配置（也是导出的格式） */
export interface MaterialExplosiveJson {
  /** 中心伤害（按距离线性衰减到 0） */
  damage?: number;
  /** 爆炸半径（px） */
  radius?: number;
  /** 击退强度（不填 = 按半径自动给一个手感合适的值） */
  knockback?: number;
}

/** 运行时爆炸配置 */
export interface MaterialExplosive {
  damage: number;
  radius: number;
  knockback: number;
}

/** materials.json 里的发光配置（也是导出的格式） */
export interface MaterialGlowJson {
  /** 光晕颜色（hex 字符串）。不填 = 用材质自身的颜色 */
  color?: string;
  /** 亮度 0~3（1 = 默认；叠加混合，>1 会明显更亮） */
  brightness?: number;
  /** 范围（px）：光晕向外扩散多远 */
  radius?: number;
  /** 发光方式：常亮 / 呼吸 / 闪烁 */
  mode?: GlowMode;
}

/** 运行时发光配置（解析后） */
export interface MaterialGlow {
  color: number;
  colorHex: string;
  brightness: number;
  radius: number;
  mode: GlowMode;
}

/** materials.json 中的单条材质（也是导出的格式） */
export interface MaterialJson {
  name: string;
  /** 颜色（hex 字符串）。无贴图时作为填充色；有贴图时作为编辑器色板/兜底色 */
  color: string;
  /** 不透明度 0~1（1 = 完全不透明）。影响渲染，不影响物理 */
  opacity?: number;
  /** 贴图：public 下的相对路径（如 "textures/wood.png"）或 data: 内联图像 */
  texture?: string;
  textureMode?: TextureMode;
  // ---- 物理 ----
  fixed: boolean;
  density: number;
  friction: number;
  frictionStatic: number;
  /** 物理反弹系数（物体/玩家碰撞） */
  bounce: number;
  // ---- 破坏 ----
  destructible: boolean;
  /** 耐受度（HP，0 表示不可破坏） */
  durability: number;
  /** 受到伤害的倍率（1 = 正常，>1 更脆） */
  damageMultiplier?: number;
  /**
   * 硬度：**抵扣伤害**（伤害 - 硬度，最小值 0）。
   * 若某次伤害 <= 硬度，则该次攻击完全无法破坏它
   * （低于硬度的武器打不动；投掷的近战武器也插不进去，会掉在地上）。
   */
  hardness?: number;
  /**
   * 投掷武器（匕首/长矛）能否钉进这种材质：
   * - `true`  → 总能钉进去（忽略硬度）—— 地面属于这种
   * - `false` → 永远钉不进去（砖墙）—— 墙属于这种
   * - 不填   → 按"投掷伤害 > 硬度"判定
   *
   * 为什么不复用耐受度/免伤：那两个是"抗伤害"，而"能不能钉进去"是穿透问题，
   * 混在同一个数值里会互相干扰（地面不可破坏，但匕首显然应该能插在土里）。
   */
  stickable?: boolean;
  // ---- 子弹交互 ----
  /** 子弹击中是否反弹（金属） */
  bulletBounce?: boolean;
  /** 子弹是否可穿透（纸箱） */
  bulletPierce?: boolean;
  /** 发光（不填 = 不发光） */
  glow?: MaterialGlowJson;
  /**
   * 爆炸（不填 = 不炸）。
   * 物体被破坏时在原地爆炸：范围伤害 + 击退 + 视觉，**不产生弹片**。
   */
  explosive?: MaterialExplosiveJson;
  /**
   * 接触伤害（每秒）：火柴人碰到这种材质的物体时，每秒钟掉多少血（0/不填 = 无伤害）。
   *
   * 典型用途：岩浆、尖刺、毒液池、电击地板。
   * 伤害按固定节流逐次结算（不是"碰一下掉一次"），所以数值就是"每秒"。
   */
  damagePerSecond?: number;
}

export interface MaterialsFile {
  version: number;
  materials: Record<string, MaterialJson>;
}

/** 运行时材质（解析后的形态） */
export interface MaterialConfig
  extends Omit<
    MaterialJson,
    | 'color'
    | 'textureMode'
    | 'damageMultiplier'
    | 'bulletBounce'
    | 'bulletPierce'
    | 'hardness'
    | 'stickable'
    | 'damagePerSecond'
    | 'glow'
    | 'explosive'
  > {
  id: string;
  opacity: number;
  /** 解析后的颜色（Phaser number） */
  color: number;
  /** 原始 hex 字符串（编辑器显示/导出用） */
  colorHex: string;
  textureMode: TextureMode;
  damageMultiplier: number;
  hardness: number;
  stickable: boolean | undefined;
  bulletBounce: boolean;
  bulletPierce: boolean;
  /** 接触伤害（每秒），0 = 无伤害 */
  damagePerSecond: number;
  /** 发光配置（null = 不发光） */
  glow: MaterialGlow | null;
  /** 爆炸配置（null = 不炸） */
  explosive: MaterialExplosive | null;
}

/** 当前生效的材质表（就地可变） */
export const MATERIALS: Record<string, MaterialConfig> = {};

/** "#8b5a2b" → 0x8b5a2b */
export function parseColor(hex: string, fallback = 0xffffff): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!m) return fallback;
  return parseInt(m[1], 16);
}

/** 0x8b5a2b → "#8b5a2b" */
export function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** 默认材质模板（新增材质时用） */
export function defaultMaterialJson(id: string, base: Partial<MaterialJson> = {}): MaterialJson {
  return {
    name: id,
    color: '#8b5a2b',
    opacity: 1,
    textureMode: 'tile',
    fixed: false,
    density: 0.002,
    friction: 0.4,
    frictionStatic: 0.8,
    bounce: 0.1,
    destructible: true,
    durability: 40,
    damageMultiplier: 1,
    bulletBounce: false,
    bulletPierce: false,
    ...base,
  };
}

/** JSON 形态 → 运行时形态 */
export function toMaterialConfig(id: string, def: MaterialJson): MaterialConfig {
  return {
    id,
    name: def.name ?? id,
    color: parseColor(def.color),
    colorHex: def.color ?? '#ffffff',
    opacity: def.opacity ?? 1,
    texture: def.texture,
    textureMode: def.textureMode === 'stretch' ? 'stretch' : 'tile',
    fixed: def.fixed ?? false,
    density: def.density ?? 0.002,
    friction: def.friction ?? 0.4,
    frictionStatic: def.frictionStatic ?? 0.8,
    bounce: def.bounce ?? 0.1,
    destructible: def.destructible ?? false,
    durability: def.durability ?? 0,
    damageMultiplier: def.damageMultiplier ?? 1,
    hardness: def.hardness ?? 0,
    stickable: def.stickable,
    bulletBounce: def.bulletBounce ?? false,
    bulletPierce: def.bulletPierce ?? false,
    damagePerSecond: Math.max(0, def.damagePerSecond ?? 0),
    glow: parseGlow(def.glow, def.color ?? '#ffffff'),
    explosive: parseExplosive(def.explosive),
  };
}

/** 解析爆炸配置（不填/非法 → null，表示不爆炸） */
export function parseExplosive(def: MaterialExplosiveJson | undefined): MaterialExplosive | null {
  if (!def) return null;
  const damage = Number.isFinite(def.damage) ? Math.max(0, def.damage as number) : 40;
  const radius = Number.isFinite(def.radius) ? Math.max(1, Math.min(1200, def.radius as number)) : 120;
  const knockback = Number.isFinite(def.knockback)
    ? Math.max(0, Math.min(80, def.knockback as number))
    : Math.max(8, radius / 10);
  if (damage <= 0 || radius <= 0) return null;
  return { damage, radius, knockback };
}

/** 解析发光配置（不填/非法 → null，表示不发光） */
export function parseGlow(def: MaterialGlowJson | undefined, fallbackColor: string): MaterialGlow | null {
  if (!def) return null;
  const colorHex = typeof def.color === 'string' && def.color.trim() ? def.color.trim() : fallbackColor;
  const mode: GlowMode = def.mode === 'pulse' || def.mode === 'flicker' ? def.mode : 'constant';
  const brightness = Number.isFinite(def.brightness) ? Math.max(0, Math.min(3, def.brightness as number)) : 1;
  const radius = Number.isFinite(def.radius) ? Math.max(1, Math.min(400, def.radius as number)) : 18;
  if (brightness <= 0 || radius <= 0) return null;
  return { color: parseColor(colorHex), colorHex, brightness, radius, mode };
}

/** 运行时形态 → JSON 形态（导出用） */
export function materialToJson(m: MaterialConfig): MaterialJson {
  return {
    name: m.name,
    color: m.colorHex,
    opacity: m.opacity,
    texture: m.texture,
    textureMode: m.textureMode,
    fixed: m.fixed,
    density: m.density,
    friction: m.friction,
    frictionStatic: m.frictionStatic,
    bounce: m.bounce,
    destructible: m.destructible,
    durability: m.durability,
    damageMultiplier: m.damageMultiplier,
    hardness: m.hardness,
    stickable: m.stickable,
    bulletBounce: m.bulletBounce,
    bulletPierce: m.bulletPierce,
    // 0 不写进 JSON：避免给所有已有材质塞一堆无意义的 0
    ...(m.damagePerSecond > 0 ? { damagePerSecond: m.damagePerSecond } : {}),
    ...(m.glow
      ? {
          glow: {
            color: m.glow.colorHex,
            brightness: m.glow.brightness,
            radius: m.glow.radius,
            mode: m.glow.mode,
          },
        }
      : {}),
    ...(m.explosive
      ? {
          explosive: {
            damage: m.explosive.damage,
            radius: m.explosive.radius,
            knockback: m.explosive.knockback,
          },
        }
      : {}),
  };
}

/** 用给定数据整体替换当前材质表（清空后就地写入，保持对象引用不变） */
export function replaceMaterials(file: MaterialsFile): void {
  for (const key of Object.keys(MATERIALS)) delete MATERIALS[key];
  for (const [id, def] of Object.entries(file.materials ?? {})) {
    MATERIALS[id] = toMaterialConfig(id, def);
  }
}

/** 新增材质（id 已存在则返回 null） */
export function addMaterial(id: string, def: MaterialJson): MaterialConfig | null {
  if (MATERIALS[id]) return null;
  MATERIALS[id] = toMaterialConfig(id, def);
  return MATERIALS[id];
}

/** 删除材质（调用方负责先检查引用） */
export function removeMaterial(id: string): boolean {
  if (!MATERIALS[id]) return false;
  delete MATERIALS[id];
  return true;
}

/** 更新材质属性（就地修改，保持 MATERIALS 引用不变） */
export function patchMaterial(id: string, patch: Partial<MaterialJson>): MaterialConfig | null {
  const current = MATERIALS[id];
  if (!current) return null;
  const merged = { ...materialToJson(current), ...patch } as MaterialJson;
  // color 同步：允许只传 color 或只传 colorHex
  MATERIALS[id] = toMaterialConfig(id, merged);
  return MATERIALS[id];
}

export function getMaterial(id: string): MaterialConfig | undefined {
  return MATERIALS[id];
}

export function materialIds(): string[] {
  return Object.keys(MATERIALS);
}

/** 校验通过的材质 id 列表（供下拉框） */
export function listMaterialOptions(): Array<{ value: string; label: string }> {
  return materialIds().map((id) => ({ value: id, label: `${MATERIALS[id].name} (${id})` }));
}

/** 导出当前材质表为 JSON 结构（编辑器保存用） */
export function serializeMaterials(): MaterialsFile {
  const materials: Record<string, MaterialJson> = {};
  for (const [id, m] of Object.entries(MATERIALS)) {
    materials[id] = materialToJson(m);
  }
  return { version: rawMaterialsJson().version, materials };
}

function rawMaterialsJson(): MaterialsFile {
  return rawMaterials as MaterialsFile;
}

/**
 * `data/materials.json` 本次构建的指纹（内容哈希）。
 *
 * 用途：编辑器会把材质草稿存进 localStorage（崩溃不丢稿），但恢复时必须先确认
 * "文件从那时到现在没被改过"——否则外部（人/AI/git pull）新增或修改的材质会被
 * 旧快照静默抹掉（曾经的真实 bug：新加的 plank 在编辑器里报"未知材质"）。
 */
export const MATERIALS_FILE_HASH: string = hashString(JSON.stringify(rawMaterialsJson().materials ?? {}));

/** 简单 djb2 字符串哈希（只用于变更检测，不用于安全场景） */
function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// 初始化（模块加载即生效）
replaceMaterials(rawMaterialsJson());
