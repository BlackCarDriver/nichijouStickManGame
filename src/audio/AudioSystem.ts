/**
 * 程序化音效系统（WebAudio 合成，不需要任何音频资源文件）。
 *
 * 枪声不是"一个音"，而是四层叠加（真实枪声的构成）：
 *   1. 瞬态爆裂 crack  —— 极短的高频噪声（枪口激波），决定"脆"
 *   2. 枪体爆音 blast  —— 中低频噪声爆发，决定"厚"
 *   3. 低频冲击 thump  —— 扫频正弦（下坠），决定"重"
 *   4. 房间尾音 tail   —— 更长的低通噪声，决定"空间感"
 *
 * 每把武器只是改变四层的比例/时长：
 *   手枪 = 中等 crack + 短 blast；霰弹 = 大 blast + 重 thump；
 *   狙击 = 极强 crack + 长 tail；AK = 更短更紧。
 *
 * 浏览器限制：AudioContext 必须在**用户手势之后**才能启动，
 * 因此由 GameScene 在首次 pointerdown / keydown 时调用 unlock()。
 * 将来接真实素材时，只要把 play() 内部换成 buffer 播放即可，调用点不变。
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
  private static readonly MASTER_GAIN = 0.32;

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
    if (!ctx || !this.master || this.muted || ctx.state !== 'running') return;

    switch (name) {
      // ---- 手枪：脆 + 短 ----
      case 'pistol':
        this.crack(0.5, 2600, 0.035);
        this.blast(0.5, 1800, 0.10);
        this.thump(0.5, 210, 70, 0.11);
        this.tail(0.16, 0.22, 900);
        break;

      // ---- AK47：更短更紧，连发时不会糊成一片 ----
      case 'ak47':
        this.crack(0.42, 3000, 0.028);
        this.blast(0.4, 2200, 0.075);
        this.thump(0.42, 185, 65, 0.085);
        this.tail(0.1, 0.16, 1100);
        break;

      // ---- 霰弹枪：厚 + 重 ----
      case 'shotgun':
        this.crack(0.35, 1800, 0.05);
        this.blast(0.85, 1100, 0.22);
        this.thump(0.7, 130, 42, 0.24);
        this.tail(0.28, 0.4, 700);
        break;

      // ---- 狙击枪：极强爆裂 + 长尾音 ----
      case 'sniper':
        this.crack(0.75, 4200, 0.03);
        this.blast(0.55, 2600, 0.12);
        this.thump(0.62, 160, 45, 0.18);
        this.tail(0.3, 0.55, 1400);
        break;

      // ---- 火箭炮：发射气流 + 低频推力 ----
      case 'rocket':
        this.swish(0.5, 380, 1100, 0.3);
        this.blast(0.4, 900, 0.2);
        this.thump(0.45, 120, 45, 0.3);
        break;

      // ---- 激光：电子音 + 一点空气电离的高频嘶声 ----
      case 'laser':
        this.beep(0.2, 1400, 0.07, 'sine', 1900);
        this.crack(0.08, 5200, 0.03);
        break;

      // ---- 近战挥击：气流声 ----
      case 'melee':
        this.swish(0.34, 500, 2600, 0.14);
        break;

      case 'throw':
        this.swish(0.26, 300, 1400, 0.16);
        break;

      // ---- 踢：闷响 ----
      case 'kick':
        this.thump(0.5, 150, 55, 0.12);
        this.blast(0.3, 700, 0.09);
        break;

      // ---- 命中：短促的"噗" ----
      case 'hit':
        this.crack(0.28, 2400, 0.02);
        this.blast(0.3, 1300, 0.06);
        this.thump(0.26, 220, 90, 0.06);
        break;

      // ---- 爆炸：低频轰鸣 + 长尾 ----
      case 'explosion':
        this.blast(1.0, 480, 0.55);
        this.thump(0.85, 110, 30, 0.6);
        this.tail(0.45, 0.9, 500);
        break;

      case 'pickup':
        this.beep(0.24, 700, 0.08, 'sine', 1050);
        break;

      case 'death':
        this.beep(0.3, 300, 0.45, 'sawtooth', 60);
        break;

      case 'empty':
        this.beep(0.18, 190, 0.05, 'square', 130);
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

    // 预生成 1s 白噪声，供所有噪声层复用
    const len = Math.floor(this.ctx.sampleRate * 1);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }

  // ==========================================================
  //  合成层
  // ==========================================================

  /** 噪声源（带随机起点，避免每发听起来完全一样） */
  private noiseSource(durationSec: number): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // 随机偏移让每发噪声纹理不同
    const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - durationSec - 0.01);
    src.start(ctx.currentTime, offset);
    src.stop(ctx.currentTime + durationSec + 0.02);
    return src;
  }

  /** 1. 瞬态爆裂：高通噪声，极短 → 提供"脆"的枪口激波 */
  private crack(gain: number, highpassHz: number, durationSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const src = this.noiseSource(durationSec);
    if (!src) return;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpassHz;

    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    src.connect(hp);
    hp.connect(g);
    g.connect(this.master);
  }

  /** 2. 枪体爆音：低通噪声爆发 → 提供"厚" */
  private blast(gain: number, lowpassHz: number, durationSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const src = this.noiseSource(durationSec);
    if (!src) return;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(lowpassHz, ctx.currentTime);
    // 滤波频率快速下滑 → 声音"闷下去"，比固定滤波更像爆炸/爆音
    lp.frequency.exponentialRampToValueAtTime(Math.max(120, lowpassHz * 0.25), ctx.currentTime + durationSec);

    const g = ctx.createGain();
    const now = ctx.currentTime;
    // 极快起音 + 指数衰减（真实爆音的形状）
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
  }

  /** 3. 低频冲击：扫频正弦 → 提供"重" */
  private thump(gain: number, fromHz: number, toHz: number, durationSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fromHz, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), now + durationSec);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  /** 4. 房间尾音：低通噪声，慢衰减 → 提供空间感 */
  private tail(gain: number, durationSec: number, lowpassHz: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const src = this.noiseSource(durationSec);
    if (!src) return;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpassHz;

    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
  }

  /** 带通扫频噪声：气流/挥击声（投掷、火箭发射、挥刀） */
  private swish(gain: number, fromHz: number, toHz: number, durationSec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const src = this.noiseSource(durationSec);
    if (!src) return;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    const now = ctx.currentTime;
    bp.frequency.setValueAtTime(fromHz, now);
    bp.frequency.exponentialRampToValueAtTime(Math.max(80, toHz), now + durationSec);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + durationSec * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
  }

  /** 单音（可扫频），用于激光/拾取/死亡等非噪声音效 */
  private beep(
    gain: number,
    fromHz: number,
    durationSec: number,
    type: OscillatorType,
    toHz?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, now);
    if (toHz !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), now + durationSec);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }
}
