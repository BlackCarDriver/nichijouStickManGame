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
  // ---- 子弹交互 ----
  /** 子弹击中是否反弹（金属） */
  bulletBounce?: boolean;
  /** 子弹是否可穿透（纸箱） */
  bulletPierce?: boolean;
}

export interface MaterialsFile {
  version: number;
  materials: Record<string, MaterialJson>;
}

/** 运行时材质（解析后的形态） */
export interface MaterialConfig extends Omit<MaterialJson, 'color' | 'textureMode' | 'damageMultiplier' | 'bulletBounce' | 'bulletPierce'> {
  id: string;
  opacity: number;
  /** 解析后的颜色（Phaser number） */
  color: number;
  /** 原始 hex 字符串（编辑器显示/导出用） */
  colorHex: string;
  textureMode: TextureMode;
  damageMultiplier: number;
  bulletBounce: boolean;
  bulletPierce: boolean;
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
    bulletBounce: def.bulletBounce ?? false,
    bulletPierce: def.bulletPierce ?? false,
  };
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
    bulletBounce: m.bulletBounce,
    bulletPierce: m.bulletPierce,
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

// 初始化（模块加载即生效）
replaceMaterials(rawMaterialsJson());
