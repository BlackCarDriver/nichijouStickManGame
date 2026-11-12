import {
  clonePose,
  defaultActions,
  defaultPose,
  interpolatePose,
  makeAction,
  type ActionClip,
  type ActionKeyframe,
  type ActionPose,
} from './ActionFormat';

const STORAGE_KEY = 'stickman.actions.v1';

interface SavedActions {
  v: 1;
  actions: ActionClip[];
  activeId: string;
}

export class ActionStore {
  actions: ActionClip[] = defaultActions();
  activeId = this.actions[0]?.id ?? 'unarmed_idle';
  timeMs = 0;
  playing = false;
  selectedKeyframe = 0;
  revision = 0;
  private listeners = new Set<() => void>();

  constructor() {
    this.restore();
    this.select(this.activeId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    try {
      const payload: SavedActions = {
        v: 1,
        actions: this.actions,
        activeId: this.activeId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* localStorage 不可用时仍允许导出 */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedActions;
      if (saved?.v === 1 && Array.isArray(saved.actions) && saved.actions.length > 0) {
        this.actions = saved.actions;
        this.activeId = saved.activeId;
      }
    } catch {
      this.actions = defaultActions();
    }
  }

  get current(): ActionClip {
    return this.actions.find((action) => action.id === this.activeId) ?? this.actions[0];
  }

  get currentPose(): ActionPose {
    return this.poseAt(this.timeMs);
  }

  poseAt(timeMs: number): ActionPose {
    const action = this.current;
    const frames = action.keyframes;
    if (frames.length === 0) return defaultPose(action.weapon);
    let t = Math.max(0, Math.min(action.durationMs, timeMs));
    if (action.loop && action.durationMs > 0) t = t % action.durationMs;
    if (t <= frames[0].timeMs) return clonePose(frames[0].pose);
    const last = frames[frames.length - 1];
    if (t >= last.timeMs) return clonePose(last.pose);
    for (let i = 1; i < frames.length; i++) {
      const next = frames[i];
      if (t <= next.timeMs) {
        const prev = frames[i - 1];
        const span = Math.max(1, next.timeMs - prev.timeMs);
        return interpolatePose(prev.pose, next.pose, (t - prev.timeMs) / span);
      }
    }
    return clonePose(last.pose);
  }

  select(id: string): void {
    if (!this.actions.some((action) => action.id === id)) return;
    this.activeId = id;
    this.timeMs = 0;
    this.selectedKeyframe = 0;
    this.playing = false;
    this.notify();
  }

  setTime(timeMs: number): void {
    this.timeMs = Math.max(0, Math.min(this.current.durationMs, Math.round(timeMs)));
    this.syncSelectedKeyframe();
    this.notify();
  }

  tick(deltaMs: number): void {
    if (!this.playing) return;
    const duration = Math.max(1, this.current.durationMs);
    this.timeMs += deltaMs;
    if (this.current.loop) {
      this.timeMs %= duration;
    } else if (this.timeMs >= duration) {
      this.timeMs = duration;
      this.playing = false;
    }
    this.syncSelectedKeyframe();
    this.notify();
  }

  togglePlaying(): void {
    this.playing = !this.playing;
    this.notify();
  }

  updateMeta(patch: Partial<Pick<ActionClip, 'id' | 'name' | 'weapon' | 'durationMs' | 'loop'>>): void {
    const action = this.current;
    const previousId = action.id;
    Object.assign(action, patch);
    action.durationMs = Math.max(1, Math.round(action.durationMs));
    action.keyframes = action.keyframes
      .map((frame) => ({ ...frame, timeMs: Math.max(0, Math.min(action.durationMs, frame.timeMs)) }))
      .sort((a, b) => a.timeMs - b.timeMs);
    if (patch.id && patch.id !== previousId) {
      const duplicate = this.actions.some((item) => item !== action && item.id === patch.id);
      if (duplicate || !patch.id.trim()) action.id = previousId;
      else this.activeId = action.id;
    }
    this.save();
    this.notify();
  }

  createAction(): void {
    let i = 1;
    let id = `action_${i}`;
    while (this.actions.some((action) => action.id === id)) id = `action_${++i}`;
    const action = makeAction(id, '新动作', 'none', 500);
    this.actions.push(action);
    this.activeId = id;
    this.timeMs = 0;
    this.selectedKeyframe = 0;
    this.save();
    this.notify();
  }

  deleteCurrent(): void {
    if (this.actions.length <= 1) return;
    const index = this.actions.findIndex((action) => action.id === this.activeId);
    this.actions.splice(index, 1);
    this.activeId = this.actions[Math.max(0, index - 1)].id;
    this.timeMs = 0;
    this.selectedKeyframe = 0;
    this.save();
    this.notify();
  }

  addOrUpdateKeyframe(): void {
    const action = this.current;
    const timeMs = Math.max(0, Math.min(action.durationMs, Math.round(this.timeMs)));
    const existing = action.keyframes.findIndex((frame) => Math.abs(frame.timeMs - timeMs) <= 2);
    const pose = clonePose(this.currentPose);
    if (existing >= 0) {
      action.keyframes[existing] = { timeMs: action.keyframes[existing].timeMs, pose };
      this.selectedKeyframe = existing;
    } else {
      const frame: ActionKeyframe = { timeMs, pose };
      action.keyframes.push(frame);
      action.keyframes.sort((a, b) => a.timeMs - b.timeMs);
      this.selectedKeyframe = action.keyframes.indexOf(frame);
    }
    this.save();
    this.notify();
  }

  selectKeyframe(index: number): void {
    const frame = this.current.keyframes[index];
    if (!frame) return;
    this.selectedKeyframe = index;
    this.timeMs = frame.timeMs;
    this.notify();
  }

  deleteSelectedKeyframe(): void {
    const action = this.current;
    if (action.keyframes.length <= 1) return;
    action.keyframes.splice(this.selectedKeyframe, 1);
    this.selectedKeyframe = Math.max(0, Math.min(this.selectedKeyframe, action.keyframes.length - 1));
    this.timeMs = action.keyframes[this.selectedKeyframe].timeMs;
    this.save();
    this.notify();
  }

  ensureKeyframeAtTime(): void {
    const action = this.current;
    const timeMs = Math.round(this.timeMs);
    const existing = action.keyframes.findIndex((frame) => Math.abs(frame.timeMs - timeMs) <= 2);
    if (existing >= 0) {
      this.selectedKeyframe = existing;
      return;
    }
    const frame: ActionKeyframe = { timeMs, pose: clonePose(this.currentPose) };
    action.keyframes.push(frame);
    action.keyframes.sort((a, b) => a.timeMs - b.timeMs);
    this.selectedKeyframe = action.keyframes.indexOf(frame);
  }

  updateCurrentPose(patch: Partial<ActionPose>): void {
    this.ensureKeyframeAtTime();
    Object.assign(this.current.keyframes[this.selectedKeyframe].pose, patch);
    this.notify();
  }

  commit(): void {
    this.save();
    this.notify();
  }

  private syncSelectedKeyframe(): void {
    const frames = this.current.keyframes;
    let best = 0;
    let distance = Infinity;
    frames.forEach((frame, index) => {
      const d = Math.abs(frame.timeMs - this.timeMs);
      if (d < distance) {
        best = index;
        distance = d;
      }
    });
    this.selectedKeyframe = best;
  }

  exportCurrent(): string {
    return JSON.stringify(this.current, null, 2);
  }

  exportFileName(): string {
    return `${this.current.id}.json`;
  }
}

export const actionStore = new ActionStore();
