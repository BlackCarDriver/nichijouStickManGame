/**
 * 多边形顶点编辑（纯几何，无 Phaser 依赖）。
 *
 * 关键不变量：可编辑多边形的**质心位于局部原点**。
 * 这样 shape 的 (x,y) 就是旋转枢轴，世界顶点 = (x,y) + R(angle) · v，
 * 拖动/插点/删点后统一做一次 renormalize 恢复该不变量（形状位置不变）。
 *
 * 说明：Matter 刚体要求凸多边形；凹形会被引擎内部取凸包。
 * 这里**不擅自改数据**，而是提供 isConvex/hull 让编辑器把"物理实际形状"画出来提示用户。
 */
import type { MapObjectPolygon } from '../map/MapFormat';
import { centroidOf, currentVertices } from '../map/PolygonUtil';
import type { Vec } from '../map/PolygonUtil';

export type { Vec } from '../map/PolygonUtil';
export { centroidOf, convexHull, currentVertices, isConvex, regularVertices, signedArea } from '../map/PolygonUtil';

const DEG = Math.PI / 180;

/** 世界坐标下的顶点（含旋转） */
export function worldVertices(poly: MapObjectPolygon, originWorld: Vec): Vec[] {
  const rot = (poly.angle ?? 0) * DEG;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return currentVertices(poly).map((v) => ({
    x: originWorld.x + v.x * cos - v.y * sin,
    y: originWorld.y + v.x * sin + v.y * cos,
  }));
}

/** 世界坐标 → 局部（未旋转）坐标 */
export function worldToLocal(poly: MapObjectPolygon, originWorld: Vec, world: Vec): Vec {
  const rot = (poly.angle ?? 0) * DEG;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const dx = world.x - originWorld.x;
  const dy = world.y - originWorld.y;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** 归一化：把质心移回原点，返回新顶点 + 原点该平移多少（保持世界形状不变） */
export function renormalize(
  vs: Vec[],
  angleDeg: number,
): { vertices: Vec[]; shift: Vec } {
  const c = centroidOf(vs);
  const rot = angleDeg * DEG;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return {
    vertices: vs.map((v) => ({ x: v.x - c.x, y: v.y - c.y })),
    shift: { x: c.x * cos - c.y * sin, y: c.x * sin + c.y * cos },
  };
}

/** 移动第 index 个顶点到世界坐标 world */
export function moveVertex(
  poly: MapObjectPolygon,
  index: number,
  world: Vec,
  originWorld: Vec,
): { vertices: Vec[]; shift: Vec } | null {
  const vs = currentVertices(poly).map((v) => ({ ...v }));
  if (index < 0 || index >= vs.length) return null;
  vs[index] = worldToLocal(poly, originWorld, world);
  return renormalize(vs, poly.angle ?? 0);
}

/** 在第 edgeIndex 条边（顶点 i → i+1）上插入一个顶点（取世界点在该边上的投影） */
export function insertVertex(
  poly: MapObjectPolygon,
  edgeIndex: number,
  world: Vec,
  originWorld: Vec,
): { vertices: Vec[]; shift: Vec } | null {
  const vs = currentVertices(poly).map((v) => ({ ...v }));
  const n = vs.length;
  if (edgeIndex < 0 || edgeIndex >= n) return null;
  const a = vs[edgeIndex];
  const b = vs[(edgeIndex + 1) % n];
  const p = worldToLocal(poly, originWorld, world);
  vs.splice(edgeIndex + 1, 0, projectOnSegment(p, a, b));
  return renormalize(vs, poly.angle ?? 0);
}

/** 删除第 index 个顶点（少于 3 个时拒绝） */
export function removeVertex(
  poly: MapObjectPolygon,
  index: number,
): { vertices: Vec[]; shift: Vec } | null {
  const vs = currentVertices(poly).map((v) => ({ ...v }));
  if (vs.length <= 3) return null;
  if (index < 0 || index >= vs.length) return null;
  vs.splice(index, 1);
  return renormalize(vs, poly.angle ?? 0);
}

function projectOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0.04, Math.min(0.96, t)); // 避免插入点与端点重合
  return { x: a.x + abx * t, y: a.y + aby * t };
}

/** 是否凸多边形（局部顶点） */

/** 凸包（Andrew monotone chain），返回按顺序的顶点 */

/** 点到线段的距离 */
export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** 找到离 p 最近的一条边（返回边起点索引，-1 表示超出阈值） */
export function nearestEdge(verts: Vec[], p: Vec, maxDist: number): number {
  let best = -1;
  let bestDist = maxDist;
  for (let i = 0; i < verts.length; i++) {
    const d = distanceToSegment(p, verts[i], verts[(i + 1) % verts.length]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
