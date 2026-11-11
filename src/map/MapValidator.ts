/**
 * 数据校验器（纯逻辑，不依赖 Phaser / Vite / DOM）。
 *
 * 三个消费方共用：
 * 1. 游戏启动时（可选）快速自检
 * 2. 编辑器保存前实时提示
 * 3. CLI：`npm run validate`（AI Agent 改完地图后的护栏）
 *
 * 设计原则：错误尽量精确到「哪个字段」+「为什么」，方便人和 AI 直接修复。
 */
import type { MapData, MapObject } from './MapFormat';
import { MAP_FORMAT_VERSION } from './MapFormat';
import type { PrefabData } from './PrefabFormat';
import { PREFAB_FORMAT_VERSION } from './PrefabFormat';
import { expandPrefab } from './PrefabExpand';
import type { MaterialsFile } from '../config/materials';

export interface Issue {
  level: 'error' | 'warn';
  /** 数据路径，如 "objects[3].material" */
  path: string;
  message: string;
}

export interface ValidateContext {
  materialIds: string[];
  prefabs: Record<string, PrefabData>;
}

/** 单张地图的物理体数量超过该值时给出警告（Matter 性能考虑） */
const BODY_COUNT_WARN = 200;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function err(path: string, message: string): Issue {
  return { level: 'error', path, message };
}
function warn(path: string, message: string): Issue {
  return { level: 'warn', path, message };
}

export function issueSummary(issues: Issue[]): { errors: number; warns: number } {
  let errors = 0;
  let warns = 0;
  for (const i of issues) i.level === 'error' ? errors++ : warns++;
  return { errors, warns };
}

/** 校验单个地图物体（也用于预制件部件） */
function validateObject(obj: unknown, path: string, ctx: ValidateContext, issues: Issue[]): void {
  if (!obj || typeof obj !== 'object') {
    issues.push(err(path, '不是对象'));
    return;
  }
  const o = obj as Record<string, unknown>;
  const type = o.type;
  if (type !== 'rect' && type !== 'circle' && type !== 'polygon') {
    issues.push(err(`${path}.type`, `未知形状类型 "${String(type)}"（应为 rect / circle / polygon）`));
    return;
  }

  if (typeof o.material !== 'string' || !ctx.materialIds.includes(o.material)) {
    issues.push(
      err(
        `${path}.material`,
        `未知材质 "${String(o.material)}"（可用：${ctx.materialIds.join(', ')}）`,
      ),
    );
  }

  for (const key of ['x', 'y'] as const) {
    if (!isFiniteNumber(o[key])) issues.push(err(`${path}.${key}`, '必须是有限数字'));
  }
  if (o.angle !== undefined && !isFiniteNumber(o.angle)) {
    issues.push(err(`${path}.angle`, '必须是有限数字（度）'));
  }
  if (o.layer !== undefined && o.layer !== 'solid' && o.layer !== 'decor') {
    issues.push(err(`${path}.layer`, `必须是 "solid" 或 "decor"`));
  }
  if (o.color !== undefined && (typeof o.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(o.color))) {
    issues.push(err(`${path}.color`, '颜色必须是 hex 字符串，如 "#8b5a2b"'));
  }
  if (o.oneWay === true && o.layer === 'decor') {
    issues.push(warn(`${path}.oneWay`, 'decor 图层没有物理体，oneWay 不会生效'));
  }

  if (type === 'rect') {
    if (!isFiniteNumber(o.w) || o.w <= 0) issues.push(err(`${path}.w`, '矩形宽度必须 > 0'));
    if (!isFiniteNumber(o.h) || o.h <= 0) issues.push(err(`${path}.h`, '矩形高度必须 > 0'));
  } else if (type === 'circle') {
    if (!isFiniteNumber(o.radius) || o.radius <= 0) issues.push(err(`${path}.radius`, '半径必须 > 0'));
  } else {
    const verts = o.vertices as Array<{ x: number; y: number }> | undefined;
    const sides = o.sides as number | undefined;
    if (verts) {
      if (!Array.isArray(verts) || verts.length < 3) {
        issues.push(err(`${path}.vertices`, '多边形至少需要 3 个顶点'));
      } else if (verts.some((v) => !isFiniteNumber(v?.x) || !isFiniteNumber(v?.y))) {
        issues.push(err(`${path}.vertices`, '顶点必须是有限数字'));
      } else if (Math.abs(polygonArea(verts)) < 1) {
        issues.push(err(`${path}.vertices`, '多边形面积接近 0（顶点退化/共线）'));
      }
    } else if (sides !== undefined) {
      if (!isFiniteNumber(sides) || sides < 3 || !Number.isInteger(sides)) {
        issues.push(err(`${path}.sides`, '正多边形边数必须是 >= 3 的整数'));
      }
      if (!isFiniteNumber(o.radius) || (o.radius as number) <= 0) {
        issues.push(err(`${path}.radius`, '正多边形半径必须 > 0'));
      }
    } else {
      issues.push(err(`${path}`, 'polygon 需要 vertices 或 sides+radius'));
    }
  }
}

function polygonArea(verts: Array<{ x: number; y: number }>): number {
  let area = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** 校验一张地图 */
export function validateMap(map: unknown, ctx: ValidateContext): Issue[] {
  const issues: Issue[] = [];
  if (!map || typeof map !== 'object') {
    return [err('map', '不是对象')];
  }
  const m = map as Record<string, unknown>;

  if (m.version !== MAP_FORMAT_VERSION) {
    issues.push(
      err('version', `地图版本 ${String(m.version)} 与当前支持版本 ${MAP_FORMAT_VERSION} 不一致`),
    );
  }
  if (typeof m.name !== 'string' || m.name.trim() === '') {
    issues.push(err('name', '地图名不能为空'));
  }
  if (!isFiniteNumber(m.width) || m.width <= 0) issues.push(err('width', '地图宽度必须 > 0'));
  if (!isFiniteNumber(m.height) || m.height <= 0) issues.push(err('height', '地图高度必须 > 0'));

  // ---- 出生点 ----
  const spawns = m.spawnPoints;
  if (!Array.isArray(spawns) || spawns.length === 0) {
    issues.push(err('spawnPoints', '至少需要 1 个出生点'));
  } else {
    spawns.forEach((s, i) => {
      if (!isFiniteNumber(s?.x) || !isFiniteNumber(s?.y)) {
        issues.push(err(`spawnPoints[${i}]`, '出生点坐标必须是有限数字'));
      }
    });
    if (spawns.length < 2) {
      issues.push(warn('spawnPoints', '双人对战建议至少 2 个出生点'));
    }
  }

  // ---- 物体 ----
  const ids = new Set<string>();
  let solidCount = 0;
  const objects = m.objects;
  if (!Array.isArray(objects)) {
    issues.push(err('objects', 'objects 必须是数组'));
  } else {
    objects.forEach((obj, i) => {
      const path = `objects[${i}]`;
      validateObject(obj, path, ctx, issues);
      const o = obj as Record<string, unknown>;
      if (typeof o.id === 'string') {
        if (ids.has(o.id)) issues.push(err(`${path}.id`, `id 重复: "${o.id}"`));
        ids.add(o.id);
      }
      if ((o.layer ?? 'solid') === 'solid') solidCount++;
    });
  }

  // ---- 预制件实例 ----
  const prefabs = m.prefabs;
  if (prefabs !== undefined) {
    if (!Array.isArray(prefabs)) {
      issues.push(err('prefabs', 'prefabs 必须是数组'));
    } else {
      prefabs.forEach((inst, i) => {
        const path = `prefabs[${i}]`;
        const it = inst as Record<string, unknown>;
        if (typeof it.ref !== 'string' || !ctx.prefabs[it.ref]) {
          issues.push(
            err(`${path}.ref`, `未知预制件 "${String(it.ref)}"（可用：${Object.keys(ctx.prefabs).join(', ') || '无'}）`),
          );
          return;
        }
        if (!isFiniteNumber(it.x) || !isFiniteNumber(it.y)) {
          issues.push(err(path, '预制件实例坐标必须是有限数字'));
        }
        if (typeof it.id === 'string') {
          if (ids.has(it.id)) issues.push(err(`${path}.id`, `id 重复: "${it.id}"`));
          ids.add(it.id);
        }
        const prefab = ctx.prefabs[it.ref];
        solidCount += expandPrefab(prefab, { ref: it.ref, x: it.x as number, y: it.y as number }).length;
      });
    }
  }

  // ---- 关节 ----
  const joints = m.joints;
  if (joints !== undefined) {
    if (!Array.isArray(joints)) {
      issues.push(err('joints', 'joints 必须是数组'));
    } else {
      joints.forEach((joint, i) => {
        const path = `joints[${i}]`;
        const j = joint as Record<string, unknown>;
        if (j.type !== 'revolute') {
          issues.push(err(`${path}.type`, '目前只支持 revolute（铰链）关节'));
        }
        const bodyA = j.bodyA;
        if (typeof bodyA !== 'string' || !ids.has(bodyA)) {
          issues.push(err(`${path}.bodyA`, `找不到物体 id "${String(bodyA)}"`));
        }
        if (j.bodyB !== undefined && j.bodyB !== 'world') {
          if (typeof j.bodyB !== 'string' || !ids.has(j.bodyB)) {
            issues.push(err(`${path}.bodyB`, `找不到物体 id "${String(j.bodyB)}"`));
          }
        }
        const anchor = j.anchor as Record<string, unknown> | undefined;
        if (!anchor || !isFiniteNumber(anchor.x) || !isFiniteNumber(anchor.y)) {
          issues.push(err(`${path}.anchor`, '锚点必须是 { x, y } 有限数字'));
        }
      });
    }
  }

  // ---- 预留字段 ----
  if (m.weaponDropZones !== undefined) {
    if (!Array.isArray(m.weaponDropZones)) {
      issues.push(err('weaponDropZones', '必须是数组'));
    } else {
      m.weaponDropZones.forEach((z, i) => {
        const zz = z as Record<string, unknown>;
        if (!isFiniteNumber(zz?.x) || !isFiniteNumber(zz?.y) || !isFiniteNumber(zz?.w) || !isFiniteNumber(zz?.h)) {
          issues.push(err(`weaponDropZones[${i}]`, '需要 x/y/w/h 有限数字'));
        }
      });
    }
  }
  if (m.items !== undefined) {
    if (!Array.isArray(m.items)) {
      issues.push(err('items', '必须是数组'));
    } else {
      m.items.forEach((it, i) => {
        const o = it as Record<string, unknown>;
        if (typeof o?.type !== 'string') issues.push(err(`items[${i}].type`, '缺少物品类型'));
        if (!isFiniteNumber(o?.x) || !isFiniteNumber(o?.y)) {
          issues.push(err(`items[${i}]`, '坐标必须是有限数字'));
        }
      });
    }
  }

  if (solidCount > BODY_COUNT_WARN) {
    issues.push(warn('objects', `物理体数量 ${solidCount} 较多（>${BODY_COUNT_WARN}），可能影响性能`));
  }

  return issues;
}

/** 校验一个预制件 */
export function validatePrefab(prefab: unknown, ctx: ValidateContext): Issue[] {
  const issues: Issue[] = [];
  if (!prefab || typeof prefab !== 'object') return [err('prefab', '不是对象')];
  const p = prefab as Record<string, unknown>;

  if (p.version !== PREFAB_FORMAT_VERSION) {
    issues.push(err('version', `预制件版本 ${String(p.version)} 与当前支持版本 ${PREFAB_FORMAT_VERSION} 不一致`));
  }
  if (typeof p.id !== 'string' || p.id.trim() === '') issues.push(err('id', '预制件 id 不能为空'));
  if (typeof p.name !== 'string' || p.name.trim() === '') issues.push(warn('name', '建议填写可读名称'));
  if (p.bodyMode !== undefined && p.bodyMode !== 'loose' && p.bodyMode !== 'compound') {
    issues.push(err('bodyMode', `bodyMode 只能是 "loose" 或 "compound"（当前 "${String(p.bodyMode)}"）`));
  }

  const parts = p.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    issues.push(err('parts', '预制件至少需要 1 个部件'));
  } else {
    parts.forEach((part, i) => validateObject(part, `parts[${i}]`, ctx, issues));

    if (p.bodyMode === 'compound') {
      // 焊接体只能有一套物理属性 → 取面积最大部件的材质
      const materials = new Set(parts.map((part) => (part as Record<string, unknown>)?.material).filter(Boolean));
      if (materials.size > 1) {
        issues.push(
          warn(
            'parts',
            `焊接体包含 ${materials.size} 种材质（${[...materials].join(', ')}），物理属性只会取「面积最大部件」的材质；如需逐块材质差异请改用 loose`,
          ),
        );
      }
    }
  }
  return issues;
}

/** 校验 materials.json */
export function validateMaterialsFile(
  file: unknown,
  opts: { textureExists?: (path: string) => boolean } = {},
): Issue[] {
  const issues: Issue[] = [];
  if (!file || typeof file !== 'object') return [err('materials', '不是对象')];
  const f = file as Partial<MaterialsFile>;
  if (f.version !== 1) issues.push(err('version', '材质表版本应为 1'));

  const table = f.materials;
  if (!table || typeof table !== 'object') {
    issues.push(err('materials', '缺少 materials 对象'));
    return issues;
  }

  for (const [id, def] of Object.entries(table)) {
    const path = `materials.${id}`;
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(id)) {
      issues.push(err(path, 'id 只能包含字母、数字、下划线，且以字母开头'));
    }
    if (!def || typeof def !== 'object') {
      issues.push(err(path, '不是对象'));
      continue;
    }
    if (typeof def.name !== 'string' || def.name.trim() === '') {
      issues.push(warn(`${path}.name`, '建议填写中文名称'));
    }
    for (const key of ['durability', 'bounce', 'density', 'friction', 'frictionStatic'] as const) {
      if (!isFiniteNumber(def[key])) issues.push(err(`${path}.${key}`, '必须是有限数字'));
    }
    if (isFiniteNumber(def.durability) && def.durability < 0) {
      issues.push(err(`${path}.durability`, '耐受度不能为负'));
    }
    for (const key of ['friction', 'frictionStatic', 'bounce'] as const) {
      const v = def[key];
      if (isFiniteNumber(v) && (v < 0 || v > 1)) {
        issues.push(warn(`${path}.${key}`, `${v} 超出常规范围 0~1`));
      }
    }
    if (isFiniteNumber(def.density) && def.density <= 0) {
      issues.push(err(`${path}.density`, '密度必须 > 0'));
    }
    if (typeof def.color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(def.color)) {
      issues.push(err(`${path}.color`, '颜色必须是 hex 字符串，如 "#8b5a2b"'));
    }

    // ---- 贴图 ----
    if (def.texture !== undefined) {
      if (typeof def.texture !== 'string' || def.texture.trim() === '') {
        issues.push(err(`${path}.texture`, '贴图必须是非空字符串（路径或 data: URL）'));
      } else if (def.texture.startsWith('data:')) {
        if (def.texture.length > 200_000) {
          issues.push(warn(`${path}.texture`, `内联贴图约 ${Math.round(def.texture.length / 1024)}KB，会明显撑大 JSON，建议改用文件路径`));
        }
      } else if (opts.textureExists && !opts.textureExists(def.texture)) {
        issues.push(err(`${path}.texture`, `贴图文件不存在于 public/ 下：${def.texture}`));
      }
    }
    if (def.opacity !== undefined) {
      if (!isFiniteNumber(def.opacity)) {
        issues.push(err(`${path}.opacity`, '透明度必须是数字'));
      } else if (def.opacity < 0 || def.opacity > 1) {
        issues.push(warn(`${path}.opacity`, `${def.opacity} 超出范围 0~1`));
      }
    }
    if (def.textureMode !== undefined && def.textureMode !== 'tile' && def.textureMode !== 'stretch') {
      issues.push(err(`${path}.textureMode`, '只能是 "tile" 或 "stretch"'));
    }
    if (def.damageMultiplier !== undefined) {
      if (!isFiniteNumber(def.damageMultiplier) || def.damageMultiplier < 0) {
        issues.push(err(`${path}.damageMultiplier`, '受伤倍率必须 >= 0 的数字'));
      }
    }
    for (const key of ['bulletBounce', 'bulletPierce', 'destructible', 'fixed'] as const) {
      const v = def[key];
      if (v !== undefined && typeof v !== 'boolean') {
        issues.push(err(`${path}.${key}`, '必须是 true / false'));
      }
    }
  }
  return issues;
}

/** 便捷入口：把材料表 + 预制件表打包成上下文 */
export function makeContext(materialIds: string[], prefabs: PrefabData[]): ValidateContext {
  const table: Record<string, PrefabData> = {};
  for (const p of prefabs) table[p.id] = p;
  return { materialIds, prefabs: table };
}

/** 类型收窄辅助：把 unknown 当 MapData 使用（调用前应先 validateMap） */
export function asMapData(map: unknown): MapData {
  return map as MapData;
}

export function asMapObjects(map: MapData): MapObject[] {
  return map.objects ?? [];
}
