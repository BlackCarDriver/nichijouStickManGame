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

export interface Vec {
  x: number;
  y: number;
}

const DEG = Math.PI / 180;

/** 正多边形简写 → 顶点 */
export function regularVertices(poly: MapObjectPolygon): Vec[] {
  const sides = poly.sides ?? 3;
  const r = poly.radius ?? 40;
  const out: Vec[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (Math.PI * 2 * i) / sides - Math.PI / 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

/** 当前顶点（自定义顶点或正多边形简写） */
export function currentVertices(poly: MapObjectPolygon): Vec[] {
  if (poly.vertices && poly.vertices.length >= 3) return poly.vertices;
  return regularVertices(poly);
}

/** 面积质心 */
export function centroidOf(vs: Vec[]): Vec {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-6) {
    const n = vs.length;
    return { x: vs.reduce((s, v) => s + v.x, 0) / n, y: vs.reduce((s, v) => s + v.y, 0) / n };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/** 有向面积（判断绕序） */
export function signedArea(vs: Vec[]): number {
  let area = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

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
export function isConvex(vs: Vec[]): boolean {
  if (vs.length < 4) return true;
  let sign = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    const c = vs[(i + 2) % vs.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 凸包（Andrew monotone chain），返回按顺序的顶点 */
export function convexHull(points: Vec[]): Vec[] {
  const pts = points.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return pts;
  const cross = (o: Vec, a: Vec, b: Vec): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

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
