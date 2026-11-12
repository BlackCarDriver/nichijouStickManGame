/**
 * 程序化音效系统（WebAudio 合成，不需要任何音频资源文件）。
 *
 * 为什么要合成：项目目前没有音效素材，而"有没有声音"对手感影响极大。
 * 用振荡器 + 噪声就能做出辨识度足够的枪声/命中/爆炸，体积为 0。
 * 将来接入真实素材时，只要把 play() 内部换成 audio buffer 播放即可，调用点不变。
 *
 * 浏览器限制：AudioContext 必须在**用户手势之后**才能启动，
 * 因此由 GameScene 在首次 pointerdown / keydown 时调用 unlock()。
 */

/** 可播放的音效名 */
export type SfxName =
  | 'pistol'
  | 'ak47'
  | 'shotgun'
  | 'sniper'
  | 'rocket'
  | 'laser'
  | 'melee'
  | 'throw'
  | 'kick'
  | 'hit'
  | 'explosion'
  | 'pickup'
  | 'death'
  | 'empty';

/** 武器 id → 音效名 */
const WEAPON_SFX: Record<string, SfxName> = {
  pistol: 'pistol',
  ak47: 'ak47',
  shotgun: 'shotgun',
  sniper: 'sniper',
  rocket: 'rocket',
  laser: 'laser',
  dagger: 'melee',
  spear: 'melee',
  lightsaber: 'melee',
  grenade: 'throw',
};

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  /** 主音量（0~1） */
  private static readonly MASTER_GAIN = 0.3;

  get isMuted(): boolean {
    return this.muted;
  }

  /** 是否已成功启动（测试/调试用） */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** 在用户手势回调里调用：创建/恢复 AudioContext */
  unlock(): void {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : AudioSystem.MASTER_GAIN;
    return this.muted;
  }

  /** 按武器 id 播放开火音效 */
  playWeapon(weaponId: string): void {
    const name = WEAPON_SFX[weaponId];
    if (name) this.play(name);
  }

  play(name: SfxName): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted || ctx.state !== 'running') return;

    switch (name) {
      case 'pistol':
        this.tone(ctx, 420, 0.09, 'square', 0.5, 180);
        this.burst(ctx, 0.05, 2400, 0.25);
        break;
      case 'ak47':
        this.tone(ctx, 320, 0.07, 'square', 0.45, 140);
        this.burst(ctx, 0.045, 2000, 0.22);
        break;
      case 'shotgun':
        this.burst(ctx, 0.18, 1100, 0.8);
        this.tone(ctx, 160, 0.16, 'sawtooth', 0.4, 60);
        break;
      case 'sniper':
        this.tone(ctx, 180, 0.22, 'sawtooth', 0.55, 55);
        this.burst(ctx, 0.16, 3200, 0.55);
        break;
      case 'rocket':
        this.tone(ctx, 200, 0.3, 'sawtooth', 0.4, 700);
        this.burst(ctx, 0.3, 700, 0.35);
        break;
      case 'laser':
        this.tone(ctx, 1250, 0.07, 'sine', 0.18, 1500);
        break;
      case 'melee':
        this.burst(ctx, 0.1, 4200, 0.3);
        this.tone(ctx, 700, 0.09, 'triangle', 0.2, 380);
        break;
      case 'throw':
        this.burst(ctx, 0.12, 1600, 0.22);
        break;
      case 'kick':
        this.tone(ctx, 130, 0.1, 'triangle', 0.4, 70);
        this.burst(ctx, 0.06, 900, 0.2);
        break;
      case 'hit':
        this.tone(ctx, 240, 0.07, 'square', 0.3, 120);
        this.burst(ctx, 0.05, 3000, 0.22);
        break;
      case 'explosion':
        this.burst(ctx, 0.5, 420, 1.0);
        this.tone(ctx, 90, 0.45, 'sawtooth', 0.6, 35);
        break;
      case 'pickup':
        this.tone(ctx, 660, 0.08, 'sine', 0.25, 990);
        break;
      case 'death':
        this.tone(ctx, 300, 0.4, 'sawtooth', 0.35, 70);
        break;
      case 'empty':
        this.tone(ctx, 180, 0.05, 'square', 0.2, 120);
        break;
      default:
        break;
    }
  }

  private init(): void {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : AudioSystem.MASTER_GAIN;
    this.master.connect(this.ctx.destination);

    // 预生成 0.5s 白噪声，供"啪/爆"类音效复用
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }

  /** 单音（可扫频） */
  private tone(
    ctx: AudioContext,
    fromHz: number,
    durationSec: number,
    type: OscillatorType,
    gain: number,
    toHz?: number,
  ): void {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, now);
    if (toHz !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), now + durationSec);
    }
    // 快速起音 + 指数衰减
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
    osc.connect(g);
    g.connect(this.master!);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  /** 噪声爆音（带低通滤波） */
  private burst(ctx: AudioContext, durationSec: number, filterHz: number, gain: number): void {
    if (!this.noiseBuffer) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterHz, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master!);
    src.start(now);
    src.stop(now + durationSec + 0.02);
  }
}
