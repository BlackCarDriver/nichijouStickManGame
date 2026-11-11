import type { Vec2 } from './DamageInfo';

/**
 * 射线查询（逻辑弹道的基础设施）。
 *
 * 为什么不用 Matter 的 `query.ray`：
 * 它内部造一个临时矩形 body 去做碰撞，返回的 collision.body 是**按 body id 排序后
 * 的较小者**，无法可靠区分"射线本体"和"被击中体"，也拿不到精确命中点。
 * 这里改为直接对 body 的凸多边形顶点做线段求交：
 *   - 命中点、距离、法线都精确可控
 *   - 不创建任何临时物理体
 *   - 天然支持"取最近命中"和"穿透后继续取下一个"
 */

export interface RayHit {
  /** 根 body（复合体已解析到 parent，可直接用于注册表查询） */
  body: MatterJS.BodyType;
  /** 实际命中的 part（复合体时是零件） */
  part: MatterJS.BodyType;
  /** 命中点（世界坐标） */
  point: Vec2;
  /** 表面法线（单位向量，朝向射线来向） */
  normal: Vec2;
  /** 沿射线的距离 */
  distance: number;
}

export interface RaycastOptions {
  /** 需要忽略的 body（通常是射手自己、以及已穿透过的目标） */
  ignore?: Array<MatterJS.BodyType | undefined | null>;
  /** 最多返回几个命中（按距离升序） */
  maxHits?: number;
  /** 是否包含 isSensor 的 body（默认 false） */
  includeSensors?: boolean;
}

/**
 * 从 from 沿 dir（单位向量）投射射线，返回沿途命中的物体（按距离升序）。
 */
export function raycast(
  bodies: MatterJS.BodyType[],
  from: Vec2,
  dir: Vec2,
  maxDistance: number,
  options: RaycastOptions = {},
): RayHit[] {
  const ignore = options.ignore ?? [];
  const maxHits = options.maxHits ?? 8;
  const includeSensors = options.includeSensors ?? false;
  const end = { x: from.x + dir.x * maxDistance, y: from.y + dir.y * maxDistance };

  const hits: RayHit[] = [];

  for (const body of bodies) {
    if (!includeSensors && body.isSensor) continue;
    if (ignore.includes(body)) continue;
    const bodyBounds = asBounds(body);
    if (!bodyBounds || !segmentOverlapsBounds(from, end, bodyBounds)) continue;

    // 复合体：parts[0] 是根（整体凸包），真正的零件从下标 1 开始
    const parts = body.parts.length > 1 ? body.parts.slice(1) : [body];

    for (const part of parts) {
      if (ignore.includes(part)) continue;
      const partBounds = asBounds(part);
      if (!partBounds || !segmentOverlapsBounds(from, end, partBounds)) continue;
      const verts = part.vertices;
      if (!verts || verts.length < 3) continue;
      const hit = rayVsPolygon(from, dir, maxDistance, verts);
      if (!hit) continue;
      hits.push({
        body,
        part,
        point: { x: from.x + dir.x * hit.distance, y: from.y + dir.y * hit.distance },
        normal: hit.normal,
        distance: hit.distance,
      });
    }
  }

  hits.sort((a, b) => a.distance - b.distance);
  return hits.slice(0, maxHits);
}

/**
 * Phaser 的类型声明把 body.bounds 标成了 MatterJS.Bounds（那是个工具类），
 * 运行时实际是可用的 AABB 对象（min/max）。这里统一收敛成一个访问点。
 */
export function asBounds(body: MatterJS.BodyType): MatterJS.IBound | undefined {
  return body.bounds as unknown as MatterJS.IBound | undefined;
}

/** 射线 AABB 与 bounds 的粗筛（拒绝掉绝大多数不相交的 body） */
function segmentOverlapsBounds(
  from: Vec2,
  to: Vec2,
  bounds: MatterJS.IBound,
): boolean {
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);
  return !(maxX < bounds.min.x || minX > bounds.max.x || maxY < bounds.min.y || minY > bounds.max.y);
}

interface PolygonHit {
  distance: number;
  normal: Vec2;
}

/**
 * 射线与凸多边形求交，返回最近交点。
 * 射线：p = from + t * dir（dir 为单位向量，t 即距离）
 * 边：  q = v1 + u * (v2 - v1)，要求 0 <= u <= 1
 */
function rayVsPolygon(
  from: Vec2,
  dir: Vec2,
  maxDistance: number,
  vertices: MatterJS.Vector[],
): PolygonHit | null {
  let best: PolygonHit | null = null;
  const n = vertices.length;

  for (let i = 0; i < n; i++) {
    const v1 = vertices[i];
    const v2 = vertices[(i + 1) % n];

    const sx = v2.x - v1.x;
    const sy = v2.y - v1.y;
    const denom = dir.x * sy - dir.y * sx;
    // 射线与边平行：无交点（或共线，忽略）
    if (Math.abs(denom) < 1e-9) continue;

    const qpx = v1.x - from.x;
    const qpy = v1.y - from.y;

    const t = (qpx * sy - qpy * sx) / denom;
    if (t < 0 || t > maxDistance) continue;

    const u = (qpx * dir.y - qpy * dir.x) / denom;
    if (u < 0 || u > 1) continue;

    if (best && t >= best.distance) continue;

    // 边法线（垂直于边），统一校正为"朝向射线来向"（与入射方向反向）
    let nx = sy;
    let ny = -sx;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * dir.x + ny * dir.y > 0) {
      nx = -nx;
      ny = -ny;
    }

    best = { distance: t, normal: { x: nx, y: ny } };
  }

  return best;
}

/** 从场景物理世界取全部 body 列表 */
export function getWorldBodies(scene: Phaser.Scene): MatterJS.BodyType[] {
  const world = scene.matter.world.localWorld as unknown as { bodies: MatterJS.BodyType[] };
  return world.bodies;
}
