let nextEntityId = 1;

/**
 * 实体基类。
 * - 全局唯一 ID：为联机状态同步提供引用依据（网络快照按 ID 对齐实体）。
 * - serialize/deserialize：联机预留的状态快照接口。
 */
export abstract class Entity {
  readonly id: number;
  protected alive = true;

  constructor() {
    this.id = nextEntityId++;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  destroy(): void {
    this.alive = false;
  }

  /** 联机预留：导出可传输的状态快照 */
  serialize(): Record<string, unknown> {
    return { id: this.id };
  }

  /** 联机预留：从状态快照恢复 */
  deserialize(_state: Record<string, unknown>): void {
    // 子类按需实现
  }
}
