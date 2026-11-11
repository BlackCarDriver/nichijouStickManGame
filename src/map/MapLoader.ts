import Phaser from 'phaser';
import { MATERIALS } from '../config/materials';
import { COLLISION_CATEGORY } from '../core/CollisionCategories';
import type { MapData, MapObject } from './MapFormat';

/** 地图物体的运行时记录（M2 破坏系统需要：body 与视觉一一对应） */
export interface MapObjectRuntime {
  body: MatterJS.BodyType;
  /** 视觉游戏对象（与物理绑定，自动跟随） */
  visual: Phaser.GameObjects.GameObject;
  material: string;
  /** 剩余耐受度（-1 表示不可破坏） */
  durability: number;
  /** 是否单向平台 */
  oneWay: boolean;
}

/** Matter body 与游戏对象绑定的返回形态 */
interface MatterBound {
  body: MatterJS.BodyType;
}

/**
 * 将 MapData 解析为物理世界 + 渲染对象。
 * 支持形状：rect（矩形）/ circle（圆形）/ polygon（任意凸多边形，含三角形）。
 * 视觉与物理绑定（matter.add.gameObject），动态物体移动时视觉自动跟随。
 */
export function buildMap(scene: Phaser.Scene, map: MapData): MapObjectRuntime[] {
  const runtime: MapObjectRuntime[] = [];

  for (const obj of map.objects) {
    const mat = MATERIALS[obj.material];
    if (!mat) {
      console.warn(`[MapLoader] 未知材质: ${obj.material}`);
      continue;
    }
    // 允许地图对象覆盖材质默认的 fixed 属性
    const isStatic = obj.fixed ?? mat.fixed;
    const oneWay = obj.oneWay === true;
    // 角度（度 → 弧度）
    const angleRad = obj.angle ? Phaser.Math.DegToRad(obj.angle) : 0;

    // 单向平台使用独立碰撞分类，便于玩家动态忽略
    const category = oneWay ? COLLISION_CATEGORY.oneWayPlatform : COLLISION_CATEGORY.default;

    const commonBodyOptions = {
      isStatic,
      friction: mat.friction,
      frictionStatic: mat.frictionStatic,
      restitution: mat.bounce,
      density: mat.density,
      angle: angleRad,
      label: obj.material,
      collisionFilter: { category, mask: 0xffff },
    };

    let visual: Phaser.GameObjects.GameObject;
    let body: MatterJS.BodyType;

    /** 兜底：确保 isStatic 生效（angle 与 isStatic 同时使用时可能被重置），
     *  并**无条件**重新应用材质参数。
     *  Matter 的 Body.setStatic()（无论由 options.isStatic 还是显式调用触发）
     *  会把 friction 强制改为 1、frictionStatic 改为 0，必须手动恢复。 */
    const ensureStatic = (b: MatterJS.BodyType): void => {
      if (isStatic && !b.isStatic) {
        scene.matter.body.setStatic(b, true);
      }
      // 无条件重应用材质摩擦/反弹（setStatic 会重置它们）
      b.friction = mat.friction;
      b.frictionStatic = mat.frictionStatic;
      b.restitution = mat.bounce;
    };

    switch (obj.type) {
      case 'circle': {
        const go = scene.add.circle(obj.x, obj.y, obj.radius, mat.color, 1);
        go.setStrokeStyle(2, 0x000000, 0.5);
        body = (scene.matter.add.gameObject(go, {
          ...commonBodyOptions,
          shape: { type: 'circle', radius: obj.radius },
        }) as unknown as MatterBound).body;
        ensureStatic(body);
        visual = go;
        break;
      }

      case 'polygon': {
        const verts = resolvePolygonVertices(obj);
        if (!verts || verts.length < 3) {
          console.warn(`[MapLoader] polygon 顶点无效（至少 3 个）: ${JSON.stringify(obj)}`);
          continue;
        }
        // 关键：Matter 的 fromVertices 会把形状的**质心**对齐到传入的 (x,y)，
        // 即 body 顶点 = P + v - centroid(v)。若直接用 (obj.x, obj.y) 作 P，
        // 形状会整体偏移 -centroid（三角形偏 20px 右 / 13px 下，底部脱离地面）。
        // 因此把容器（= body.position）补偿为 (obj.x + c.x, obj.y + c.y)。
        const c = polygonCentroid(verts);
        const container = scene.add.container(obj.x + c.x, obj.y + c.y);
        const g = scene.add.graphics();
        container.add(g);
        const vertexSets = [verts.map((v) => ({ x: v.x, y: v.y }))];
        body = (scene.matter.add.gameObject(container, {
          ...commonBodyOptions,
          shape: { type: 'fromVertices', verts: vertexSets },
        }) as unknown as MatterBound).body;
        ensureStatic(body);
        // 用真实顶点绘制（相对 body.position），保证视觉与碰撞形状 100% 重合
        container.setPosition(body.position.x, body.position.y);
        if (angleRad !== 0) container.setRotation(angleRad);
        const localPts = (body.vertices ?? []).map((v) => new Phaser.Geom.Point(v.x - body.position.x, v.y - body.position.y));
        g.fillStyle(mat.color, 1);
        g.lineStyle(2, 0x000000, 0.5);
        g.fillPoints(localPts, true);
        g.strokePoints(localPts, true);
        visual = container;
        break;
      }

      case 'rect':
      default: {
        const rect = obj as Extract<MapObject, { type: 'rect' }>;
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const go = scene.add.rectangle(cx, cy, rect.w, rect.h, mat.color, 1);
        go.setStrokeStyle(2, 0x000000, 0.5);
        body = (scene.matter.add.gameObject(go, {
          ...commonBodyOptions,
          shape: { type: 'rectangle', width: rect.w, height: rect.h },
        }) as unknown as MatterBound).body;
        ensureStatic(body);
        visual = go;
        break;
      }
    }

    runtime.push({
      body,
      visual,
      material: obj.material,
      durability: mat.destructible ? mat.durability : -1,
      oneWay,
    });
  }

  return runtime;
}

/** 多边形面积质心（与 Matter 的 Vertices.centre 一致） */
function polygonCentroid(verts: Array<{ x: number; y: number }>): { x: number; y: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-6) {
    // 退化多边形：用顶点平均
    const n = verts.length;
    return { x: verts.reduce((s, v) => s + v.x, 0) / n, y: verts.reduce((s, v) => s + v.y, 0) / n };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/** 解析 polygon 的顶点（相对中心）：支持 vertices 数组或 sides+radius 正多边形简写 */
function resolvePolygonVertices(
  obj: Extract<MapObject, { type: 'polygon' }>,
): Array<{ x: number; y: number }> | null {
  if (obj.vertices && obj.vertices.length >= 3) {
    return obj.vertices;
  }
  if (obj.sides && obj.sides >= 3) {
    const radius = obj.radius ?? 40;
    const result: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < obj.sides; i++) {
      // 从正上方开始（-90°），便于直观理解
      const a = (Math.PI * 2 * i) / obj.sides - Math.PI / 2;
      result.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    }
    return result;
  }
  return null;
}
