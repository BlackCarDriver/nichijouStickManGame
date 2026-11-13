/**
 * 地图加载器：MapData → 物理世界 + 渲染对象。
 *
 * 支持：
 * - 形状：rect / circle / polygon（含正多边形简写）
 * - 图层：solid（物理）/ decor（纯视觉）
 * - 预制件实例（PrefabInstance → 展开为若干形状）
 * - 关节（revolute 铰链，用于跷跷板等）
 *
 * 视觉与物理绑定（matter.add.gameObject），动态物体移动时视觉自动跟随。
 */
import Phaser from 'phaser';
import { getMaterial } from '../config/materials';
import type { MaterialConfig } from '../config/materials';
import { COLLISION_CATEGORY } from '../core/CollisionCategories';
import type { MapData, MapJoint, MapObject, PrefabInstance } from './MapFormat';
import type { PrefabData } from './PrefabFormat';
import { expandPrefab } from './PrefabExpand';
import { centroidOf, currentVertices, signedArea } from './PolygonUtil';
import { hasMaterialTexture, matTextureKey } from './TextureLoader';

/** 地图物体的运行时记录（破坏系统 / 编辑器重建 需要） */
export interface MapObjectRuntime {
  id: string;
  /** decor 图层没有物理体 */
  body?: MatterJS.BodyType;
  /** 视觉游戏对象（与物理绑定，自动跟随） */
  visual: Phaser.GameObjects.GameObject;
  material: string;
  /** 剩余耐受度（-1 表示不可破坏） */
  durability: number;
  /** 是否单向平台 */
  oneWay: boolean;
  layer: 'solid' | 'decor';
  /** 关节锚点体（isSensor，无碰撞），重建时一并销毁 */
  extraBodies?: MatterJS.BodyType[];
  /** 是否焊接体（一个刚体 + 一个 Container 视觉，需要每帧同步） */
  compound?: boolean;
}

/** Matter body 与游戏对象绑定的返回形态 */
interface MatterBound {
  body: MatterJS.BodyType;
}

let autoIdSeq = 0;

/**
 * 构建整张地图。
 * @param prefabs 预制件表（id → PrefabData），用于解析 map.prefabs
 */
export function buildMap(
  scene: Phaser.Scene,
  map: MapData,
  prefabs: Record<string, PrefabData> = {},
): MapObjectRuntime[] {
  const runtime: MapObjectRuntime[] = [];
  const bodiesById = new Map<string, MatterJS.BodyType>();

  // 每次构建都从 0 开始编号：未显式写 id 的物体/预制件会得到稳定 id
  // （联机时各客户端靠这个 id 对齐"哪个物体被摧毁了"）
  autoIdSeq = 0;

  // 1) 收集所有形状：地图内联物体 + 展开的预制件部件
  interface PendingObject {
    obj: MapObject;
    id: string;
  }
  const pending: PendingObject[] = [];

  map.objects.forEach((obj) => {
    pending.push({ obj, id: obj.id ?? `obj_${autoIdSeq++}` });
  });

  (map.prefabs ?? []).forEach((inst) => {
    const prefab = prefabs[inst.ref];
    if (!prefab) {
      console.warn(`[MapLoader] 未知预制件: ${inst.ref}`);
      return;
    }
    const instId = inst.id ?? `prefab_${autoIdSeq++}`;

    // 焊接：整体一个复合刚体
    if ((prefab.bodyMode ?? 'loose') === 'compound') {
      const welded = buildCompoundPrefab(scene, prefab, { ...inst, id: instId }, instId);
      if (welded) {
        runtime.push(welded);
        if (welded.body) bodiesById.set(instId, welded.body);
      }
      return;
    }

    // 松件：每个部件独立刚体
    expandPrefab(prefab, { ...inst, id: instId }).forEach((part, j) => {
      pending.push({ obj: part, id: part.id ?? `${instId}#${j}` });
    });
  });

  // 2) 逐个创建物理体 + 视觉
  for (const { obj, id } of pending) {
    const mat = getMaterial(obj.material);
    if (!mat) {
      console.warn(`[MapLoader] 未知材质: ${obj.material}`);
      continue;
    }
    const result = createObject(scene, obj, mat, id);
    if (!result) continue;
    runtime.push(result);
    if (result.body) bodiesById.set(id, result.body);
  }

  // 3) 关节（需要 body 已创建）
  for (const joint of map.joints ?? []) {
    const created = createJoint(scene, joint, bodiesById, runtime);
    if (created) {
      const host = runtime.find((r) => r.id === joint.bodyA);
      if (host) {
        host.extraBodies = [...(host.extraBodies ?? []), ...created];
      }
    }
  }

  return runtime;
}

/**
 * 创建矩形的视觉：材质有贴图且已加载时用贴图（tile=平铺 / stretch=拉伸），否则用纯色。
 * 注：贴图目前只应用于矩形（圆/多边形仍用颜色，避免蒙版与旋转的复杂度）。
 */
function createRectVisual(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  w: number,
  h: number,
  mat: MaterialConfig,
  color: number,
  strokeAlpha: number,
  /** 对象级覆盖（优先于材质） */
  textureRef?: string,
  textureModeOverride?: 'tile' | 'stretch',
): Phaser.GameObjects.GameObject {
  const tex = textureRef ?? mat.texture;
  const mode = textureModeOverride ?? mat.textureMode;
  if (tex && hasMaterialTexture(scene, tex)) {
    const key = matTextureKey(tex);
    if (mode === 'stretch') {
      return scene.add.image(cx, cy, key).setDisplaySize(w, h);
    }
    return scene.add.tileSprite(cx, cy, w, h, key);
  }
  const go = scene.add.rectangle(cx, cy, w, h, color, 1);
  go.setStrokeStyle(2, 0x000000, strokeAlpha);
  return go;
}

/** 创建一个地图物体（物理 + 视觉），decor 图层只创建视觉 */
function createObject(
  scene: Phaser.Scene,
  obj: MapObject,
  mat: MaterialConfig,
  id: string,
): MapObjectRuntime | null {
  const layer = obj.layer ?? 'solid';
  const color = obj.color ? parseHex(obj.color, mat.color) : mat.color;
  /** 材质不透明度（<1 时半透明显示） */
  const alpha = mat.opacity ?? 1;
  const angleRad = obj.angle ? Phaser.Math.DegToRad(obj.angle) : 0;
  const oneWay = obj.oneWay === true;

  // ---- 纯视觉装饰 ----
  if (layer === 'decor') {
    let visual: Phaser.GameObjects.GameObject;
    if (obj.type === 'rect') {
      visual = createRectVisual(scene, obj.x + obj.w / 2, obj.y + obj.h / 2, obj.w, obj.h, mat, color, 0.4, obj.type === 'rect' ? obj.texture : undefined, obj.type === 'rect' ? obj.textureMode : undefined);
      // decor 没有物理体，旋转需手动应用
      if (angleRad !== 0) (visual as unknown as Phaser.GameObjects.Components.Transform).setRotation(angleRad);
      applyAlpha(visual, alpha);
    } else if (obj.type === 'circle') {
      const go = scene.add.circle(obj.x, obj.y, obj.radius, color, 1);
      go.setStrokeStyle(2, 0x000000, 0.4);
      applyAlpha(go, alpha);
      visual = go;
    } else {
      const verts = resolvePolygonVertices(obj);
      if (!verts) {
        console.warn(`[MapLoader] polygon 顶点无效: ${JSON.stringify(obj)}`);
        return null;
      }
      const container = scene.add.container(obj.x, obj.y);
      const g = scene.add.graphics();
      container.add(g);
      if (angleRad !== 0) container.setRotation(angleRad);
      g.fillStyle(color, 1);
      g.lineStyle(2, 0x000000, 0.4);
      g.fillPoints(verts.map((v) => new Phaser.Geom.Point(v.x, v.y)), true);
      g.strokePoints(verts.map((v) => new Phaser.Geom.Point(v.x, v.y)), true);
      applyAlpha(container, alpha);
      visual = container;
    }
    return { id, visual, material: obj.material, durability: -1, oneWay: false, layer: 'decor' };
  }

  // ---- 物理物体 ----
  const isStatic = obj.fixed ?? mat.fixed;
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

  /** 兜底：确保 isStatic 生效，并**无条件**重新应用材质参数。
   *  Matter 的 Body.setStatic() 会把 friction 强制改为 1、frictionStatic 改为 0，必须手动恢复。 */
  const ensureStatic = (b: MatterJS.BodyType): void => {
    if (isStatic && !b.isStatic) {
      scene.matter.body.setStatic(b, true);
    }
    b.friction = mat.friction;
    b.frictionStatic = mat.frictionStatic;
    b.restitution = mat.bounce;
  };

  switch (obj.type) {
    case 'circle': {
      const go = scene.add.circle(obj.x, obj.y, obj.radius, color, 1);
      go.setStrokeStyle(2, 0x000000, 0.5);
      applyAlpha(go, alpha);
      body = (
        scene.matter.add.gameObject(go, {
          ...commonBodyOptions,
          shape: { type: 'circle', radius: obj.radius },
        }) as unknown as MatterBound
      ).body;
      ensureStatic(body);
      visual = go;
      break;
    }

    case 'polygon': {
      const verts = resolvePolygonVertices(obj);
      if (!verts || verts.length < 3) {
        console.warn(`[MapLoader] polygon 顶点无效（至少 3 个）: ${JSON.stringify(obj)}`);
        return null;
      }
      // Matter 的 fromVertices 会把形状**质心**对齐到传入的 (x,y)，
      // 因此把容器（= body.position）补偿为 (obj.x + c.x, obj.y + c.y)。
      const c = polygonCentroid(verts);
      const container = scene.add.container(obj.x + c.x, obj.y + c.y);
      const g = scene.add.graphics();
      container.add(g);
      const vertexSets = [verts.map((v) => ({ x: v.x, y: v.y }))];
      body = (
        scene.matter.add.gameObject(container, {
          ...commonBodyOptions,
          shape: { type: 'fromVertices', verts: vertexSets },
        }) as unknown as MatterBound
      ).body;
      ensureStatic(body);
      // 用真实顶点绘制（相对 body.position），保证视觉与碰撞形状 100% 重合
      container.setPosition(body.position.x, body.position.y);
      if (angleRad !== 0) container.setRotation(angleRad);
      const localPts = (body.vertices ?? []).map(
        (v) => new Phaser.Geom.Point(v.x - body.position.x, v.y - body.position.y),
      );
      g.fillStyle(color, 1);
      g.lineStyle(2, 0x000000, 0.5);
      g.fillPoints(localPts, true);
      g.strokePoints(localPts, true);
      applyAlpha(container, alpha);
      visual = container;
      break;
    }

    case 'rect':
    default: {
      const rect = obj as Extract<MapObject, { type: 'rect' }>;
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const go = createRectVisual(scene, cx, cy, rect.w, rect.h, mat, color, 0.5, rect.texture, rect.textureMode);
      applyAlpha(go, alpha);
      body = (
        scene.matter.add.gameObject(go, {
          ...commonBodyOptions,
          shape: { type: 'rectangle', width: rect.w, height: rect.h },
        }) as unknown as MatterBound
      ).body;
      ensureStatic(body);
      visual = go;
      break;
    }
  }

  return {
    id,
    body,
    visual,
    material: obj.material,
    durability: mat.destructible ? mat.durability : -1,
    oneWay,
    layer: 'solid',
  };
}

/** 形状在世界坐标下的中心（rect=中心 / circle=圆心 / polygon=中心+质心） */
function shapeCenterWorld(obj: MapObject): { x: number; y: number } {
  if (obj.type === 'rect') return { x: obj.x + obj.w / 2, y: obj.y + obj.h / 2 };
  if (obj.type === 'circle') return { x: obj.x, y: obj.y };
  const cen = centroidOf(currentVertices(obj));
  return { x: obj.x + cen.x, y: obj.y + cen.y };
}

/** 形状面积（用于挑"主材质"） */
function shapeArea(obj: MapObject): number {
  if (obj.type === 'rect') return obj.w * obj.h;
  if (obj.type === 'circle') return Math.PI * obj.radius * obj.radius;
  return Math.abs(signedArea(currentVertices(obj)));
}

/** 多边形绘制（世界/局部顶点均可，顶点需自带偏移） */
function paintPolygon(
  g: Phaser.GameObjects.Graphics,
  verts: Array<{ x: number; y: number }>,
  color: number,
  alpha: number,
  strokeAlpha = 0.5,
): void {
  const pts = verts.map((v) => new Phaser.Geom.Point(v.x, v.y));
  g.fillStyle(color, 1);
  g.lineStyle(2, 0x000000, strokeAlpha);
  g.fillPoints(pts, true);
  g.strokePoints(pts, true);
  if (alpha < 1) g.setAlpha(alpha);
}

/** 创建"纯视觉"形状（不绑定物理，供焊接体作为 Container 子对象使用） */
function createShapeVisual(
  scene: Phaser.Scene,
  obj: MapObject,
  mat: MaterialConfig,
): Phaser.GameObjects.GameObject | null {
  const color = obj.color ? parseHex(obj.color, mat.color) : mat.color;
  const alpha = mat.opacity ?? 1;
  const angleRad = Phaser.Math.DegToRad(obj.angle ?? 0);

  if (obj.type === 'rect') {
    const go = createRectVisual(scene, obj.x + obj.w / 2, obj.y + obj.h / 2, obj.w, obj.h, mat, color, 0.5, obj.type === 'rect' ? obj.texture : undefined, obj.type === 'rect' ? obj.textureMode : undefined);
    (go as unknown as Phaser.GameObjects.Components.Transform).setRotation(angleRad);
    applyAlpha(go, alpha);
    return go;
  }
  if (obj.type === 'circle') {
    const go = scene.add.circle(obj.x, obj.y, obj.radius, color, 1);
    go.setStrokeStyle(2, 0x000000, 0.5);
    applyAlpha(go, alpha);
    return go;
  }
  const verts = currentVertices(obj);
  const cen = centroidOf(verts);
  const container = scene.add.container(obj.x + cen.x, obj.y + cen.y);
  const g = scene.add.graphics();
  container.add(g);
  paintPolygon(g, verts, color, alpha, 0.5);
  container.setRotation(angleRad);
  applyAlpha(container, alpha);
  return container;
}

/** 创建一个"离线"刚体（不加入世界），用于拼复合体 */
function createOfflineBody(
  scene: Phaser.Scene,
  obj: MapObject,
  density: number,
): MatterJS.BodyType | null {
  const angle = Phaser.Math.DegToRad(obj.angle ?? 0);
  const center = shapeCenterWorld(obj);
  const base = { angle, density, isStatic: false };

  if (obj.type === 'rect') {
    return scene.matter.bodies.rectangle(center.x, center.y, obj.w, obj.h, base);
  }
  if (obj.type === 'circle') {
    return scene.matter.bodies.circle(center.x, center.y, obj.radius, base);
  }
  const verts = currentVertices(obj);
  if (verts.length < 3) return null;
  // 与 MapLoader 的 polygon 约定一致：fromVertices 会把质心对齐到传入的 (x,y)
  return scene.matter.bodies.fromVertices(center.x, center.y, [verts.map((v) => ({ x: v.x, y: v.y }))], base);
}

/**
 * 焊接的预制件实例：把各部件拼成一个复合刚体 + 一个 Container 视觉。
 *
 * - 物理属性统一取自**面积最大的部件**的材质（复合体只能有一套属性）
 * - 视觉上所有部件是 Container 的**子对象**（本地坐标），
 *   每帧只需把 Container 同步到刚体位置/角度，无需逐部件同步
 */
function buildCompoundPrefab(
  scene: Phaser.Scene,
  prefab: PrefabData,
  inst: PrefabInstance,
  instId: string,
): MapObjectRuntime | null {
  const parts = expandPrefab(prefab, inst);
  if (parts.length === 0) return null;

  // 主材质：面积最大的部件
  let primary = parts[0];
  let primaryArea = -1;
  for (const p of parts) {
    const area = shapeArea(p);
    if (area > primaryArea) {
      primaryArea = area;
      primary = p;
    }
  }
  const mat = getMaterial(primary.material);
  if (!mat) {
    console.warn(`[MapLoader] 焊接体主材质未知: ${primary.material}`);
    return null;
  }

  const isStatic = inst.fixed ?? mat.fixed;

  const partBodies: MatterJS.BodyType[] = [];
  for (const p of parts) {
    const body = createOfflineBody(scene, p, mat.density);
    if (body) partBodies.push(body);
  }
  if (partBodies.length === 0) return null;

  // 合成复合体并加入世界
  const compound = scene.matter.body.create({
    parts: partBodies,
    friction: mat.friction,
    frictionStatic: mat.frictionStatic,
    restitution: mat.bounce,
    isStatic,
    label: `weld:${instId}`,
    collisionFilter: { group: 0, category: COLLISION_CATEGORY.default, mask: 0xffff },
  });
  scene.matter.world.add(compound);

  // setStatic 会把摩擦力重置，必须重新应用材质参数
  if (isStatic && !compound.isStatic) scene.matter.body.setStatic(compound, true);
  compound.friction = mat.friction;
  compound.frictionStatic = mat.frictionStatic;
  compound.restitution = mat.bounce;

  // 视觉：Container（位于刚体中心）+ 子视觉（本地坐标）
  const bx = compound.position.x;
  const by = compound.position.y;
  const ba = compound.angle;
  const ca = Math.cos(-ba);
  const sa = Math.sin(-ba);
  const container = scene.add.container(bx, by);

  for (const p of parts) {
    const visual = createShapeVisual(scene, p, mat);
    if (!visual) continue;
    const center = shapeCenterWorld(p);
    const dx = center.x - bx;
    const dy = center.y - by;
    const t = visual as unknown as Phaser.GameObjects.Components.Transform;
    t.setPosition(dx * ca - dy * sa, dx * sa + dy * ca);
    t.setRotation(Phaser.Math.DegToRad(p.angle ?? 0) - ba);
    container.add(visual);
  }

  return {
    id: instId,
    body: compound,
    visual: container,
    material: primary.material,
    durability: mat.destructible ? mat.durability : -1,
    oneWay: false,
    layer: 'solid',
    compound: true,
  };
}

/** 把焊接体的 Container 视觉同步到刚体（每帧调用；编辑器暂停物理时无副作用） */
export function syncCompoundVisuals(runtime: MapObjectRuntime[]): void {
  for (const item of runtime) {
    if (!item.compound || !item.body) continue;
    const c = item.visual as unknown as Phaser.GameObjects.Components.Transform;
    const b = item.body;
    if (c.x !== b.position.x || c.y !== b.position.y || c.rotation !== b.angle) {
      c.setPosition(b.position.x, b.position.y);
      c.setRotation(b.angle);
    }
  }
}

/**
 * 创建 revolute 关节。
 * - bodyB 省略/"world"：在世界 anchor 处放置一个静态传感器锚点体（mask=0 不与任何东西碰撞），
 *   再把它与 bodyA 用长度 0 的刚性约束连起来 → 销轴铰链（跷跷板支点）。
 * - bodyB 指定：直接把两个 body 在 anchor 处铰接。
 *
 * 注意：Matter 的 constraint.pointA/pointB 是**世界方向**的偏移（不随 body 旋转），
 * 所以锚点应放在 body 的中心附近（跷跷板支点即中心）。MapValidator 会对此给出警告。
 */
function createJoint(
  scene: Phaser.Scene,
  joint: MapJoint,
  bodiesById: Map<string, MatterJS.BodyType>,
  runtime: MapObjectRuntime[],
): MatterJS.BodyType[] | null {
  const bodyA = bodiesById.get(joint.bodyA);
  if (!bodyA) {
    console.warn(`[MapLoader] 关节 ${joint.id ?? ''} 找不到 bodyA: ${joint.bodyA}`);
    return null;
  }

  const extra: MatterJS.BodyType[] = [];
  const pointA = { x: joint.anchor.x - bodyA.position.x, y: joint.anchor.y - bodyA.position.y };

  const target = joint.bodyB && joint.bodyB !== 'world' ? bodiesById.get(joint.bodyB) : undefined;
  if (joint.bodyB && joint.bodyB !== 'world' && !target) {
    console.warn(`[MapLoader] 关节 ${joint.id ?? ''} 找不到 bodyB: ${joint.bodyB}`);
    return null;
  }

  if (target) {
    const pointB = { x: joint.anchor.x - target.position.x, y: joint.anchor.y - target.position.y };
    scene.matter.add.constraint(bodyA, target, 0, 1, { pointA, pointB });
    return extra;
  }

  // 世界锚点：静态传感器小方块
  const anchorBody = scene.matter.add.rectangle(joint.anchor.x, joint.anchor.y, 4, 4, {
    isStatic: true,
    isSensor: true,
    label: 'joint-anchor',
    collisionFilter: { category: COLLISION_CATEGORY.jointAnchor, mask: 0 },
  });
  scene.matter.add.constraint(bodyA, anchorBody, 0, 1, { pointA, pointB: { x: 0, y: 0 } });
  extra.push(anchorBody);
  void runtime;
  return extra;
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
      const a = (Math.PI * 2 * i) / obj.sides - Math.PI / 2;
      result.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    }
    return result;
  }
  return null;
}

/** 应用材质不透明度（Graphics/Container/Image/TileSprite 都有 alpha） */
function applyAlpha(go: Phaser.GameObjects.GameObject, alpha: number): void {
  if (alpha >= 1) return;
  (go as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(alpha);
}

function parseHex(hex: string, fallback: number): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return m ? parseInt(m[1], 16) : fallback;
}

/** 销毁一次 buildMap 产生的所有对象（编辑器重建时用） */
export function destroyMapRuntime(scene: Phaser.Scene, runtime: MapObjectRuntime[]): void {
  for (const item of runtime) {
    for (const extra of item.extraBodies ?? []) {
      scene.matter.world.remove(extra);
    }
    if (item.body) scene.matter.world.remove(item.body);
    item.visual.destroy();
  }
  runtime.length = 0;
}
