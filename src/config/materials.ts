/**
 * 材质表加载（数据源：data/materials.json）。
 *
 * JSON 是唯一真源：游戏、编辑器、校验脚本共用同一份数据。
 * color 在 JSON 里是 hex 字符串（"#8b5a2b"，人和 AI 都读得懂），
 * 加载时解析成 Phaser 需要的 number，同时保留 colorHex 供编辑器使用。
 *
 * MATERIALS 是**可变单例**：编辑器调参时就地替换（replaceMaterials），
 * 因此所有消费方都应通过 getMaterial() / MATERIALS 读取，不要缓存副本。
 */
import rawMaterials from '../../data/materials.json';

export interface MaterialConfig {
  id: string;
  name: string;
  /** 耐受度（0 = 不可破坏） */
  durability: number;
  /** 是否可被破坏 */
  destructible: boolean;
  /** 是否固定位置（不掉落/不可推动） */
  fixed: boolean;
  /** 反弹系数（restitution） */
  bounce: number;
  /** 密度，影响重量 */
  density: number;
  /** 动摩擦力（0~1） */
  friction: number;
  /** 静摩擦力（0~1） */
  frictionStatic: number;
  /** 解析后的颜色（Phaser number） */
  color: number;
  /** 原始 hex 字符串（编辑器显示/导出用） */
  colorHex: string;
}

/** materials.json 中的单条材质 */
export interface MaterialJson {
  name: string;
  durability: number;
  destructible: boolean;
  fixed: boolean;
  bounce: number;
  density: number;
  friction: number;
  frictionStatic: number;
  color: string;
}

export interface MaterialsFile {
  version: number;
  materials: Record<string, MaterialJson>;
}

/** 当前生效的材质表（就地可变） */
export const MATERIALS: Record<string, MaterialConfig> = {};

/** "#8b5a2b" → 0x8b5a2b */
export function parseColor(hex: string, fallback = 0xffffff): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!m) return fallback;
  return parseInt(m[1], 16);
}

/** "0x8b5a2b"/9140779 → "#8b5a2b" */
export function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** 用给定数据整体替换当前材质表（清空后就地写入，保持对象引用不变） */
export function replaceMaterials(file: MaterialsFile): void {
  for (const key of Object.keys(MATERIALS)) delete MATERIALS[key];
  for (const [id, def] of Object.entries(file.materials ?? {})) {
    MATERIALS[id] = {
      id,
      name: def.name ?? id,
      durability: def.durability ?? 0,
      destructible: def.destructible ?? false,
      fixed: def.fixed ?? false,
      bounce: def.bounce ?? 0,
      density: def.density ?? 1,
      friction: def.friction ?? 0.4,
      frictionStatic: def.frictionStatic ?? 0.6,
      color: parseColor(def.color),
      colorHex: def.color ?? '#ffffff',
    };
  }
}

export function getMaterial(id: string): MaterialConfig | undefined {
  return MATERIALS[id];
}

export function materialIds(): string[] {
  return Object.keys(MATERIALS);
}

/** 导出当前材质表为 JSON 结构（编辑器保存用） */
export function serializeMaterials(): MaterialsFile {
  const materials: Record<string, MaterialJson> = {};
  for (const [id, m] of Object.entries(MATERIALS)) {
    materials[id] = {
      name: m.name,
      durability: m.durability,
      destructible: m.destructible,
      fixed: m.fixed,
      bounce: m.bounce,
      density: m.density,
      friction: m.friction,
      frictionStatic: m.frictionStatic,
      color: m.colorHex,
    };
  }
  return { version: rawMaterialsJson().version, materials };
}

function rawMaterialsJson(): MaterialsFile {
  return rawMaterials as MaterialsFile;
}

// 初始化（模块加载即生效）
replaceMaterials(rawMaterialsJson());
