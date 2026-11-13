import Phaser from 'phaser';
import { MATERIALS } from '../config/materials';
import type { MapObjectRuntime } from '../map/MapLoader';
import type { WorldRegistry } from './WorldRegistry';
import type { FxSystem } from '../fx/FxSystem';
import type { DamageInfo } from '../combat/DamageInfo';

export interface DestructionResult {
  /** 实际生效的伤害（0 = 不可破坏 / 已销毁） */
  applied: number;
  /** 是否被摧毁 */
  destroyed: boolean;
  /** 剩余耐久（不可破坏时为 -1） */
  remaining: number;
}

/**
 * 破坏系统：负责"物体耐久的增减 → 摧毁 → 反馈"。
 *
 * 只关心地图物体（MapObjectRuntime），不关心伤害从哪来（子弹/爆炸/近战都由
 * DamageSystem 转成 DamageInfo 后调进来）。
 *
 * W1 的破坏表现：纯消失（FX 爆散 + 事件）。
 * W5 会在此处挂"碎片生成"，调用方无需改动。
 */
export class DestructionSystem {
  private readonly scene: Phaser.Scene;
  private readonly registry: WorldRegistry;
  private readonly fx: FxSystem;
  /**
   * 是否拥有破坏权威。
   *
   * 联机时只有"房主"有：其它客户端只播受击表现（火花/闪白），
   * 耐久与摧毁结果一律以房主广播的 `obj` 为准。
   * 否则各端各自扣耐久 → 每端何时打爆箱子都不一样，画面必然不同步。
   */
  private authority = true;

  constructor(scene: Phaser.Scene, registry: WorldRegistry, fx: FxSystem) {
    this.scene = scene;
    this.registry = registry;
    this.fx = fx;
  }

  /** 联机：设置本端是否拥有破坏权威（房主 = true，其它 = false） */
  setAuthority(authority: boolean): void {
    this.authority = authority;
  }

  /**
   * 对地图物体造成伤害。
   * 伤害会乘以材质的 damageMultiplier（例如纸箱更脆）。
   */
  damage(runtime: MapObjectRuntime, info: DamageInfo): DestructionResult {
    // decor 图层 / 不可破坏材质：耐久为 -1
    if (!runtime.body || runtime.durability < 0) {
      return { applied: 0, destroyed: false, remaining: -1 };
    }

    // 非权威端：只做受击表现，不动耐久、不摧毁（结果等房主广播）
    if (!this.authority) {
      this.fx.flashShape(runtime.body.vertices, 0xffffff);
      if (info.point) {
        this.fx.hitSpark(info.point, info.normal, MATERIALS[runtime.material]?.color ?? 0xffffff);
      }
      return { applied: 0, destroyed: false, remaining: runtime.durability };
    }

    const material = MATERIALS[runtime.material];
    const multiplier = material?.damageMultiplier ?? 1;
    const hardness = material?.hardness ?? 0;

    // 硬度抵扣：先按倍率缩放，再减去硬度（最低 0）
    const raw = Math.max(0, info.amount) * multiplier;
    const amount = raw - hardness;
    if (amount <= 0) {
      // 打不动：只给"叮"一下的火花反馈，不掉耐久
      if (info.point) {
        this.fx.hitSpark(info.point, info.normal, 0xdfe7f0);
      }
      return { applied: 0, destroyed: false, remaining: runtime.durability };
    }

    const applied = Math.min(runtime.durability, amount);
    runtime.durability -= applied;

    // 受击反馈：闪白 + 火花
    if (runtime.body) {
      // 用真实顶点闪白（倾斜方块/三角形不会溢出轮廓）
      this.fx.flashShape(runtime.body.vertices, 0xffffff);
    }
    if (info.point) {
      this.fx.hitSpark(info.point, info.normal, material?.color ?? 0xffffff);
    }

    const destroyed = runtime.durability <= 0;
    if (destroyed) {
      this.destroyObject(runtime);
    }
    return { applied, destroyed, remaining: runtime.durability };
  }

  /** 联机：按地图物体 id 强制摧毁（其它客户端上报的销毁事件）。幂等。 */
  forceDestroyById(id: string): boolean {
    const runtime = this.registry.getById(id);
    if (!runtime) return false;
    this.destroyObject(runtime);
    return true;
  }

  /** 摧毁物体：从物理世界、注册表、渲染层移除，并广播事件 */
  private destroyObject(runtime: MapObjectRuntime): void {
    if (!runtime.body) return;
    const center = {
      x: runtime.body.position.x,
      y: runtime.body.position.y,
    };
    const color = MATERIALS[runtime.material]?.color ?? 0xffffff;

    // 物理 & 索引
    for (const extra of runtime.extraBodies ?? []) {
      this.scene.matter.world.remove(extra);
    }
    this.scene.matter.world.remove(runtime.body);
    this.registry.unregister(runtime);

    // 视觉
    runtime.visual.destroy();

    // 反馈
    this.fx.burst(center, color);

    // 广播（音效/计分/掉落 W5 挂这里）
    this.scene.events.emit('object-destroyed', runtime, center);
  }
}
