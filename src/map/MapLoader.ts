import Phaser from 'phaser';
import { MATERIALS } from '../config/materials';
import type { MapData } from './MapFormat';

/** 地图物体的运行时记录（M2 破坏系统需要：body 与视觉一一对应） */
export interface MapObjectRuntime {
  body: MatterJS.BodyType;
  /** 视觉游戏对象（matter.add.gameObject 绑定，自动跟随物理位置） */
  visual: Phaser.GameObjects.Rectangle;
  material: string;
  /** 剩余耐受度（-1 表示不可破坏） */
  durability: number;
}

/**
 * 将 MapData 解析为物理世界 + 渲染对象。
 * 视觉用 Rectangle 游戏对象并通过 matter.add.gameObject 绑定物理，
 * 这样动态物体（箱子、跷跷板）移动时视觉自动跟随，不会出现"透明障碍"。
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
    // 允许地图对象覆盖材质默认的 fixed 属性
    const isStatic = obj.fixed ?? mat.fixed;

    // Rectangle 游戏对象同时作为视觉与物理载体（Phaser 自动同步位置）
    const rect = scene.add.rectangle(cx, cy, obj.w, obj.h, mat.color, 1);
    rect.setStrokeStyle(2, 0x000000, 0.5);
    const body = (scene.matter.add.gameObject(rect, {
      isStatic,
      friction: 0.4,
      frictionStatic: 0.8,
      restitution: mat.bounce,
      density: mat.density,
      label: obj.material,
    }) as unknown as { body: MatterJS.BodyType }).body;

    runtime.push({
      body,
      visual: rect,
      material: obj.material,
      durability: mat.destructible ? mat.durability : -1,
    });
  }

  return runtime;
}
