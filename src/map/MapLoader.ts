import Phaser from 'phaser';
import { MATERIALS } from '../config/materials';
import type { MapData } from './MapFormat';

/** 地图物体的运行时记录（M2 破坏系统需要：body 与视觉一一对应） */
export interface MapObjectRuntime {
  body: MatterJS.BodyType;
  graphics: Phaser.GameObjects.Graphics;
  material: string;
  /** 剩余耐受度（-1 表示不可破坏） */
  durability: number;
}

/**
 * 将 MapData 解析为物理世界 + 渲染对象。
 * M0：仅矩形物体（rect）。视觉用 Graphics 独立绘制（matter.add.rectangle 只创建纯 Body）。
 */
export function buildMap(scene: Phaser.Scene, map: MapData): MapObjectRuntime[] {
  const runtime: MapObjectRuntime[] = [];

  for (const obj of map.objects) {
    if (obj.type !== 'rect') {
      console.warn(`[MapLoader] 暂不支持的元素类型: ${obj.type}`);
      continue;
    }
    const mat = MATERIALS[obj.material];
    if (!mat) {
      console.warn(`[MapLoader] 未知材质: ${obj.material}`);
      continue;
    }

    const cx = obj.x + obj.w / 2;
    const cy = obj.y + obj.h / 2;
    const body = scene.matter.add.rectangle(cx, cy, obj.w, obj.h, {
      isStatic: mat.fixed,
      friction: 0.4,
      frictionStatic: 0.8,
      restitution: mat.bounce,
      density: mat.density,
      label: obj.material,
    });

    const g = scene.add.graphics();
    g.fillStyle(mat.color, 1);
    g.fillRect(obj.x, obj.y, obj.w, obj.h);
    g.lineStyle(2, 0x000000, 0.5);
    g.strokeRect(obj.x, obj.y, obj.w, obj.h);

    runtime.push({
      body,
      graphics: g,
      material: obj.material,
      durability: mat.destructible ? mat.durability : -1,
    });
  }

  return runtime;
}
