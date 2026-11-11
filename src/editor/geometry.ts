/**
 * 编辑器几何工具：包围盒、命中测试、旋转点变换。
 * 与 MapFormat 的锚点约定保持一致（rect=左上角，circle/polygon=中心，angle 绕中心）。
 */
import type { MapObject, PrefabInstance } from '../map/MapFormat';
import type { PrefabData } from '../map/PrefabFormat';
import { expandPrefab } from '../map/PrefabExpand';

export interface Vec {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const DEG = Math.PI / 180;

/** 图形中心（rect 由左上角换算） */
export function objectCenter(o: MapObject): Vec {
  if (o.type === 'rect') return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
  return { x: o.x, y: o.y };
}

/** 多边形顶点（相对中心）：vertices 或 sides+radius 两种写法 */
export function polygonVerts(o: Extract<MapObject, { type: 'polygon' }>): Vec[] {
  if (o.vertices && o.vertices.length >= 3) return o.vertices;
  const sides = o.sides ?? 3;
  const r = o.radius ?? 40;
  const out: Vec[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (Math.PI * 2 * i) / sides - Math.PI / 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

/** 世界坐标下的外轮廓点 */
export function objectCorners(o: MapObject): Vec[] {
  if (o.type === 'circle') {
    const r = o.radius;
    return [
      { x: o.x - r, y: o.y - r },
      { x: o.x + r, y: o.y - r },
      { x: o.x + r, y: o.y + r },
      { x: o.x - r, y: o.y + r },
    ];
  }
  const c = objectCenter(o);
  const local: Vec[] =
    o.type === 'rect'
      ? [
          { x: -o.w / 2, y: -o.h / 2 },
          { x: o.w / 2, y: -o.h / 2 },
          { x: o.w / 2, y: o.h / 2 },
          { x: -o.w / 2, y: o.h / 2 },
        ]
      : polygonVerts(o);
  const a = (o.angle ?? 0) * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return local.map((p) => ({ x: c.x + p.x * cos - p.y * sin, y: c.y + p.x * sin + p.y * cos }));
}

export function boundsOfPoints(pts: Vec[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function objectBounds(o: MapObject): Bounds {
  return boundsOfPoints(objectCorners(o));
}

export function unionBounds(list: Bounds[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** 点是否落在图形内（考虑旋转） */
export function pointInObject(o: MapObject, p: Vec): boolean {
  if (o.type === 'circle') {
    return (p.x - o.x) ** 2 + (p.y - o.y) ** 2 <= o.radius ** 2;
  }
  const c = objectCenter(o);
  const a = -(o.angle ?? 0) * DEG; // 反向旋转到局部坐标系
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;

  if (o.type === 'rect') {
    return Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.h / 2;
  }
  const verts = polygonVerts(o);
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const vi = verts[i];
    const vj = verts[j];
    if ((vi.y > ly) !== (vj.y > ly) && lx < ((vj.x - vi.x) * (ly - vi.y)) / (vj.y - vi.y) + vi.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 预制件实例的包围盒 */
export function instanceBounds(inst: PrefabInstance, prefab: PrefabData | undefined): Bounds {
  if (!prefab) return { minX: inst.x - 20, minY: inst.y - 20, maxX: inst.x + 20, maxY: inst.y + 20 };
  const parts = expandPrefab(prefab, inst);
  return unionBounds(parts.map((p) => objectBounds(p)));
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 玩家跳跃能力（用于编辑器可达性尺子） */
export function jumpMetrics(moveSpeed: number, jumpVelocity: number, gravity = 1): {
  height: number;
  distance: number;
  safeGap: number;
} {
  const v = Math.abs(jumpVelocity);
  const height = (v * v) / (2 * gravity);
  const airTime = (2 * v) / gravity;
  const distance = moveSpeed * airTime;
  return { height, distance, safeGap: distance * 0.7 };
}
