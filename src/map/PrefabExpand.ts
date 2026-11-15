/**
 * 预制件展开：把预制件的局部部件变换成世界坐标的地图物体。
 *
 * 纯函数（不依赖 Phaser），因此游戏、编辑器、校验脚本共用同一套变换逻辑。
 */
import type { MapJoint, MapObject, MapWeaponSpawn, PrefabInstance } from './MapFormat';
import type { PrefabData } from './PrefabFormat';

const DEG = Math.PI / 180;

/** 预制件局部点 → 世界点（与 expandPrefab 内部的变换完全一致） */
export function prefabPointToWorld(
  inst: PrefabInstance,
  pt: { x: number; y: number },
): { x: number; y: number } {
  const angRad = (inst.angle ?? 0) * DEG;
  const cos = Math.cos(angRad);
  const sin = Math.sin(angRad);
  const flip = inst.flipX ? -1 : 1;
  const fx = pt.x * flip;
  return { x: inst.x + fx * cos - pt.y * sin, y: inst.y + fx * sin + pt.y * cos };
}

/**
 * 展开预制件的**内部关节**为世界坐标 MapJoint。
 *
 * - 部件下标 → 实例级部件 id（`${instId}#${index}`，与 expandPrefab 一致）
 * - 锚点局部坐标 → 世界坐标（与部件同一套 flip/旋转/平移）
 * - 焊接体（compound）整体是一个刚体，内部关节无意义 → 返回空数组
 * - 下标越界（部件被删但关节没清）→ 跳过该条，由校验器报错
 */
export function expandPrefabJoints(prefab: PrefabData, inst: PrefabInstance): MapJoint[] {
  const joints = prefab.joints ?? [];
  if (joints.length === 0) return [];
  if ((prefab.bodyMode ?? 'loose') === 'compound') return [];

  const parts = expandPrefab(prefab, inst);
  const instId = inst.id ?? prefab.id;
  const out: MapJoint[] = [];

  joints.forEach((joint, k) => {
    const a = parts[joint.bodyA];
    if (!a) return;
    const wantsBody = joint.bodyB !== undefined && joint.bodyB !== 'world';
    const b = wantsBody ? parts[joint.bodyB as number] : undefined;
    if (wantsBody && !b) return;

    const world = prefabPointToWorld(inst, joint.anchor);
    const merged: MapJoint = {
      id: `${instId}#j${k}`,
      type: 'revolute',
      bodyA: a.id as string,
      anchor: { x: world.x, y: world.y },
    };
    if (b?.id) merged.bodyB = b.id;
    if (joint.noCollide) merged.noCollide = true;
    out.push(merged);
  });

  return out;
}

/**
 * 把预制件实例展开为世界坐标的形状列表。
 * - rect  : 局部 (x,y) 是左上角 → 先转中心，再应用 flip/旋转/平移
 * - circle: 局部 (x,y) 是圆心
 * - polygon: 局部 (x,y) 是中心，顶点相对中心（flipX 时对顶点 x 取反）
 * 旋转统一交给 body 的 angle（部件自身 angle 与实例 angle 相加）。
 */
export function expandPrefab(prefab: PrefabData, inst: PrefabInstance): MapObject[] {
  const angRad = (inst.angle ?? 0) * DEG;
  const cos = Math.cos(angRad);
  const sin = Math.sin(angRad);
  const flip = inst.flipX ? -1 : 1;

  /** 局部点 → 世界点 */
  const tf = (lx: number, ly: number): { x: number; y: number } => {
    const fx = lx * flip;
    return {
      x: inst.x + fx * cos - ly * sin,
      y: inst.y + fx * sin + ly * cos,
    };
  };

  return prefab.parts.map((part, index) => {
    const angle = (inst.angle ?? 0) + (part.angle ?? 0);
    const base = {
      ...part,
      id: part.id ?? `${inst.id ?? prefab.id}#${index}`,
      fixed: inst.fixed ?? part.fixed,
      angle: angle === 0 ? undefined : angle,
    };

    if (part.type === 'rect') {
      const c = tf(part.x + part.w / 2, part.y + part.h / 2);
      return { ...base, type: 'rect', x: c.x - part.w / 2, y: c.y - part.h / 2, w: part.w, h: part.h } as MapObject;
    }

    if (part.type === 'circle') {
      const c = tf(part.x, part.y);
      return { ...base, type: 'circle', x: c.x, y: c.y, radius: part.radius } as MapObject;
    }

    const c = tf(part.x, part.y);
    const vertices = part.vertices?.map((v) => ({ x: v.x * flip, y: v.y }));
    return {
      ...base,
      type: 'polygon',
      x: c.x,
      y: c.y,
      vertices,
      sides: part.sides,
      radius: part.radius,
    } as MapObject;
  });
}

/**
 * 展开预制件自带的**武器掉落点**为世界坐标。
 *
 * - 坐标用与部件同一套 flip/旋转/平移（`prefabPointToWorld`），所以"平平地放一个武器架"
 *   和"旋转 90° 放"出来的枪口朝向位置都对
 * - id 一律用 `${实例id}#w${序号}`（**忽略**预制件里手写的 id）：
 *   同一个预制件放多个实例时，写死 id 会跨实例重复，调试/日志分不清是哪个实例的
 */
export function expandPrefabWeapons(prefab: PrefabData, inst: PrefabInstance): MapWeaponSpawn[] {
  const list = prefab.weapons ?? [];
  if (list.length === 0) return [];
  const instId = inst.id ?? prefab.id;
  return list.map((cfg, k) => {
    const p = prefabPointToWorld(inst, { x: cfg.x, y: cfg.y });
    return { ...cfg, id: `${instId}#w${k}`, x: p.x, y: p.y };
  });
}

/** 计算预制件部件包围盒（编辑器显示尺寸/吸附用），返回相对锚点的范围 */
export function prefabBounds(prefab: PrefabData): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of prefab.parts) {
    if (p.type === 'rect') {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    } else if (p.type === 'circle') {
      minX = Math.min(minX, p.x - p.radius);
      minY = Math.min(minY, p.y - p.radius);
      maxX = Math.max(maxX, p.x + p.radius);
      maxY = Math.max(maxY, p.y + p.radius);
    } else {
      const r = p.radius ?? 40;
      minX = Math.min(minX, p.x - r);
      minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r);
      maxY = Math.max(maxY, p.y + r);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
