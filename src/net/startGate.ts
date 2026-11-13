/**
 * 开局闸门（加载进度 + "点击 W 开始"）。
 *
 * 流程：连接服务器 → 收到 match_start → 场景/贴图/头像加载 → 就绪 → 玩家按 W（或点按钮）
 * → 真正开始操作。移动端无法操作时可选择"观战"。
 *
 * 为什么独立成模块：加载进度来自 Phaser 的 loader（GameScene），
 * 而界面在 DOM（Overlay / RoomController），中间用一个小的状态机解耦最省事。
 */
export type GatePhase = 'connecting' | 'loading' | 'ready' | 'playing' | 'spectating';

class StartGate {
  phase: GatePhase = 'connecting';
  /** 0~1 */
  progress = 0;
  label = '连接服务器…';
  /** 本局是否以旁观身份进入（服务端 you<0，或玩家点了观战） */
  spectator = false;
  /** 玩家主动请求过观战（跨重启保持） */
  private requestedSpectate = false;
  /** 是否已经按过"开始"：按过之后每局/每次重开都直接进游戏，不再弹 W */
  startedOnce = false;
  /** 是否已经请求过"入局"（enter）。未请求前 you<0 只是"还没开始"，不算旁观 */
  enterRequested = false;
  /** 本局是否是首次进入（需要显示"点击 W"） */
  firstEntry = false;
  /** 弹出过多少次"点击 W"（正常应该只有第一次 = 1） */
  readyCount = 0;
  private listeners = new Set<(gate: StartGate) => void>();

  subscribe(fn: (gate: StartGate) => void): () => void {
    this.listeners.add(fn);
    fn(this);
    return () => this.listeners.delete(fn);
  }

  /** 玩家输入是否被冻结（还没按 W / 还在加载） */
  get blocked(): boolean {
    return this.phase !== 'playing' && this.phase !== 'spectating';
  }

  /**
   * 进入对局时重置。
   * you < 0 表示服务端还没把玩家放进对局（未按"开始" / 座位已满 / 主动观战）。
   */
  resetForMatch(you: number): void {
    // 注意：首次连接时所有玩家都还没有座位（you=-1），
    // 只有"主动点观战"或"已经请求入局但没抢到座位"才算真正的旁观。
    this.spectator = this.requestedSpectate || (this.enterRequested && you < 0);
    this.firstEntry = !this.startedOnce;
    this.phase = 'loading';
    this.progress = Math.min(this.progress, 0.3);
    this.label = '加载地图与资源…';
    this.emit();
  }

  setProgress(value: number, label?: string): void {
    if (this.phase === 'ready' || this.phase === 'playing' || this.phase === 'spectating') return;
    const next = Math.max(0, Math.min(1, value));
    if (next <= this.progress && !label) return;
    this.progress = Math.max(this.progress, next);
    if (label) this.label = label;
    this.emit();
  }

  /** 场景与资源都就绪 */
  markReady(): void {
    if (this.phase !== 'loading' && this.phase !== 'connecting') return;
    this.progress = 1;
    if (this.spectator) this.phase = 'spectating';
    // 已经按过一次"开始"：后续每局直接进入，不再要求交互
    else if (this.startedOnce) this.phase = 'playing';
    else {
      this.phase = 'ready';
      this.readyCount++;
    }
    this.label = this.phase === 'ready' ? '一切就绪' : this.phase === 'playing' ? '已开始' : '观战中';
    this.emit();
  }

  startPlaying(): void {
    if (this.phase !== 'ready') return;
    this.startedOnce = true;
    this.enterRequested = true;
    this.phase = 'playing';
    this.emit();
  }

  /** 玩家点了"观战"：之后的重开也不再上场 */
  requestSpectate(): void {
    this.requestedSpectate = true;
    this.spectator = true;
    if (this.phase === 'ready' || this.phase === 'loading' || this.phase === 'connecting') {
      if (this.progress >= 1) this.phase = 'spectating';
      this.emit();
    }
  }

  reset(): void {
    this.phase = 'connecting';
    this.progress = 0;
    this.label = '连接服务器…';
    this.spectator = false;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this);
  }
}

export const startGate = new StartGate();
