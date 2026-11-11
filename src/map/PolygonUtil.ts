/**
 * 多边形几何工具（纯函数，无 Phaser 依赖）。
 * 地图加载（复合体/面积计算）与编辑器顶点编辑共用。
 */
import type { MapObjectPolygon } from './MapFormat';

export interface Vec {
  x: number;
  y: number;
}

/** 正多边形简写 → 顶点（相对中心，从正上方开始） */
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

/** 当前顶点（自定义顶点 或 正多边形简写） */
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

/** 有向面积（正负表示绕序） */
export function signedArea(vs: Vec[]): number {
  let area = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % vs.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** 是否凸多边形 */
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

/** 凸包（Andrew monotone chain） */
export function convexHull(points: Vec[]): Vec[] {
  const pts = points.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.x - b.x || a.y - b.y);
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
