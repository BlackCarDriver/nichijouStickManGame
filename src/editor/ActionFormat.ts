/**
 * 火柴人动作资源格式。
 *
 * 关键帧保存的是骨骼参数和脚部目标，不保存绝对关节坐标：
 * - 手臂由肩角 + 肘弯曲 FK 重建
 * - 腿由相对髋部的脚目标 IK 重建
 * 这样拖动编辑时不会改变骨骼长度。
 */

export type ActionWeapon = 'none' | 'spear';

export interface ActionPose {
  rootX: number;
  rootY: number;
  torsoTilt: number;
  torsoTwist: number;
  headTilt: number;
  headOffsetY: number;
  armFrontShoulder: number;
  armFrontElbow: number;
  armBackShoulder: number;
  armBackElbow: number;
  footLX: number;
  footLY: number;
  footRX: number;
  footRY: number;
}

export interface ActionKeyframe {
  timeMs: number;
  pose: ActionPose;
}

export interface ActionClip {
  version: 1;
  id: string;
  name: string;
  weapon: ActionWeapon;
  durationMs: number;
  loop: boolean;
  keyframes: ActionKeyframe[];
}

export function clonePose(pose: ActionPose): ActionPose {
  return { ...pose };
}

export function defaultPose(weapon: ActionWeapon = 'none'): ActionPose {
  if (weapon === 'spear') {
    return {
      rootX: 0,
      rootY: 0,
      torsoTilt: 5,
      torsoTwist: 2,
      headTilt: 6,
      headOffsetY: 0,
      armFrontShoulder: 58,
      armFrontElbow: 4,
      armBackShoulder: 34,
      armBackElbow: -26,
      footLX: -8,
      footLY: 48,
      footRX: 9,
      footRY: 48,
    };
  }
  return {
    rootX: 0,
    rootY: 0,
    torsoTilt: 0,
    torsoTwist: 0,
    headTilt: 0,
    headOffsetY: 0,
    armFrontShoulder: 10,
    armFrontElbow: 18,
    armBackShoulder: -10,
    armBackElbow: 18,
    footLX: -8,
    footLY: 48,
    footRX: 8,
    footRY: 48,
  };
}

export function interpolatePose(a: ActionPose, b: ActionPose, t: number): ActionPose {
  const k = Math.max(0, Math.min(1, t));
  const out = {} as ActionPose;
  for (const key of Object.keys(a) as Array<keyof ActionPose>) {
    out[key] = a[key] + (b[key] - a[key]) * k;
  }
  return out;
}

export function sampleAction(action: ActionClip, timeMs: number): ActionPose {
  const frames = action.keyframes;
  if (frames.length === 0) return defaultPose(action.weapon);
  let t = Math.max(0, Math.min(action.durationMs, timeMs));
  if (action.loop && action.durationMs > 0) t %= action.durationMs;
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

export function makeAction(
  id: string,
  name: string,
  weapon: ActionWeapon,
  durationMs = 1000,
): ActionClip {
  const pose = defaultPose(weapon);
  return {
    version: 1,
    id,
    name,
    weapon,
    durationMs,
    loop: false,
    keyframes: [
      { timeMs: 0, pose: clonePose(pose) },
      { timeMs: durationMs, pose: clonePose(pose) },
    ],
  };
}

export function defaultActions(): ActionClip[] {
  const unarmed = makeAction('unarmed_idle', '无武器待机', 'none', 1000);
  const spearIdle = makeAction('spear_idle', '长矛持握', 'spear', 1000);
  const spearThrust = makeAction('spear_thrust', '长矛突刺', 'spear', 360);
  const spearThrow = makeAction('spear_throw', '长矛投掷', 'spear', 420);

  const thrustStart = defaultPose('spear');
  thrustStart.rootX = -5;
  thrustStart.rootY = 2;
  thrustStart.torsoTilt = 3;
  thrustStart.torsoTwist = -2;
  thrustStart.armFrontShoulder = 46;
  thrustStart.armFrontElbow = 20;
  thrustStart.armBackShoulder = 20;
  thrustStart.armBackElbow = -34;
  thrustStart.footLX = -10;
  thrustStart.footRX = 10;
  const thrustHit = defaultPose('spear');
  thrustHit.rootX = 13;
  thrustHit.rootY = 5;
  thrustHit.torsoTilt = 20;
  thrustHit.torsoTwist = 10;
  thrustHit.headTilt = 18;
  thrustHit.armFrontShoulder = 60;
  thrustHit.armFrontElbow = 2;
  thrustHit.armBackShoulder = 56;
  thrustHit.armBackElbow = -26;
  thrustHit.footLX = -19;
  thrustHit.footRX = 30;
  spearThrust.keyframes = [
    { timeMs: 0, pose: thrustStart },
    { timeMs: 105, pose: clonePose(thrustStart) },
    { timeMs: 190, pose: thrustHit },
    { timeMs: 360, pose: defaultPose('spear') },
  ];

  const throwStart = defaultPose('spear');
  throwStart.rootX = -8;
  throwStart.rootY = 5;
  throwStart.torsoTilt = 6;
  throwStart.torsoTwist = -8;
  throwStart.armFrontShoulder = 36;
  throwStart.armFrontElbow = 26;
  throwStart.armBackShoulder = 8;
  throwStart.armBackElbow = 38;
  throwStart.footLX = -16;
  throwStart.footRX = 8;
  const throwRelease = defaultPose('spear');
  throwRelease.rootX = 12;
  throwRelease.rootY = 2;
  throwRelease.torsoTilt = 25;
  throwRelease.torsoTwist = 12;
  throwRelease.headTilt = 22;
  throwRelease.armFrontShoulder = 68;
  throwRelease.armFrontElbow = 0;
  throwRelease.armBackShoulder = -20;
  throwRelease.armBackElbow = 46;
  throwRelease.footLX = -20;
  throwRelease.footRX = 26;
  spearThrow.keyframes = [
    { timeMs: 0, pose: throwStart },
    { timeMs: 145, pose: clonePose(throwStart) },
    { timeMs: 215, pose: throwRelease },
    { timeMs: 420, pose: defaultPose('spear') },
  ];

  return [unarmed, spearIdle, spearThrust, spearThrow];
}
