import type { MapObjectRuntime } from '../map/MapLoader';

/**
 * 物理体 → 地图物体的运行时索引。
 *
 * 为什么必须有它：射线/碰撞只会给你一个 Matter body，而"扣耐久、销毁视觉、
 * 掉落内容"都发生在 MapObjectRuntime 上。没有这张表就无法从"打中了什么"
 * 反查到"该扣谁的耐久"。
 *
 * 复合体（焊接预制件）的坑：射线命中时拿到的是**零件 part**，
 * Matter 里 part.parent 指向根 body，所以索引时把根与所有 part 都登记进去。
 */
export class WorldRegistry {
  private readonly byBodyId = new Map<number, MapObjectRuntime>();
  private readonly byObjectId = new Map<string, MapObjectRuntime>();
  private all: MapObjectRuntime[] = [];

  /** 重新建立索引（地图重建时调用） */
  rebuild(runtimes: MapObjectRuntime[]): void {
    this.byBodyId.clear();
    this.byObjectId.clear();
    this.all = runtimes;

    for (const runtime of runtimes) {
      this.byObjectId.set(runtime.id, runtime);
      const bodies: Array<MatterJS.BodyType | undefined> = [runtime.body, ...(runtime.extraBodies ?? [])];
      for (const body of bodies) {
        if (!body) continue;
        this.byBodyId.set(body.id, runtime);
        // 复合体：把每个零件也映射到同一个 runtime
        for (const part of body.parts) {
          this.byBodyId.set(part.id, runtime);
        }
      }
    }
  }

  /** 由任意 body（含零件、含关节锚点）反查地图物体 */
  resolve(body: MatterJS.BodyType | undefined | null): MapObjectRuntime | undefined {
    if (!body) return undefined;
    return this.byBodyId.get(body.id) ?? this.byBodyId.get(body.parent.id);
  }

  getById(id: string): MapObjectRuntime | undefined {
    return this.byObjectId.get(id);
  }

  get objects(): readonly MapObjectRuntime[] {
    return this.all;
  }

  /** 物体被销毁后从索引里摘掉（避免再次被命中） */
  unregister(runtime: MapObjectRuntime): void {
    this.byObjectId.delete(runtime.id);
    const bodies: Array<MatterJS.BodyType | undefined> = [runtime.body, ...(runtime.extraBodies ?? [])];
    for (const body of bodies) {
      if (!body) continue;
      this.byBodyId.delete(body.id);
      for (const part of body.parts) {
        this.byBodyId.delete(part.id);
      }
    }
    const idx = this.all.indexOf(runtime);
    if (idx >= 0) this.all.splice(idx, 1);
  }
}
