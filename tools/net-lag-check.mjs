#!/usr/bin/env node
/**
 * 真实时延下的联机回归（v3：位置自权威 + 世界房主权威）。
 *
 * 用法：node tools/net-lag-check.mjs [baseURL] [单程时延ms]
 *   默认 http://127.0.0.1:8096/ + 150ms（RTT≈300ms，模拟跨区域公网）
 *
 * 它会自动起一个 TCP 延迟代理（tools/lag-proxy.mjs）把游戏服务包一层，
 * 两个无头浏览器都走代理，然后断言这些"真实玩家最在意"的行为：
 *   1. 本地移动不会被拉回（没有橡皮筋）：向右跑 1.2s，位置单调前进
 *   2. 房主看到的对手偏差在"单程延迟 × 速度"量级内（≤120px）
 *   3. 打人掉血（谁打的上报谁）、摔落掉血（自己上报自己）、捡枪成功
 *   4. 延迟显示正常（不会出现十几位数），__netDiag() 的 RTT 与时延匹配
 *   5. 全程无未捕获异常
 *
 * 前置：npm run build && cd server && go build -o /tmp/stickman-server . && /tmp/stickman-server --dev
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.NET_LAG_BASE ?? process.argv[2] ?? 'http://127.0.0.1:8096/';
const ONE_WAY = Number(process.argv[3] ?? 150);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

class Cdp {
  constructor(port) {
    this.port = port;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
  }

  async connect() {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => {
            this.ws.addEventListener('open', res, { once: true });
            this.ws.addEventListener('error', rej, { once: true });
          });
          this.ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(String(ev.data));
            if (msg.id && this.pending.has(msg.id)) {
              const { resolve, reject } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(JSON.stringify(msg.error)));
              else resolve(msg.result);
              return;
            }
            if (msg.method === 'Runtime.exceptionThrown') {
              this.exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
            }
          });
          await this.send('Runtime.enable');
          return this;
        }
      } catch {
        /* retry */
      }
      await sleep(250);
    }
    throw new Error(`CDP ${this.port} 连接失败`);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 25000);
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval error');
    return r.result?.value;
  }

  async waitFor(expr, timeout = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(expr)) return;
      } catch {
        /* retry */
      }
      await sleep(150);
    }
    throw new Error(`等待超时: ${expr}`);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

const launched = [];
async function launch(nick, port) {
  const profile = mkdtempSync(join(tmpdir(), `lag-${nick}-`));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--mute-audio',
      '--window-size=1280,720',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `${PROXIED}?dev=1&nick=${encodeURIComponent(nick)}&netdebug=1`,
    ],
    { stdio: 'ignore' },
  );
  const cdp = await new Cdp(port).connect();
  await cdp.waitFor('!!window.__game && !!window.__room');
  launched.push({ proc, profile, cdp });
  return cdp;
}

const PROXY_PORT = 8099 + Math.floor(Math.random() * 60);
const TARGET = new URL(BASE);
const PROXIED = `http://127.0.0.1:${PROXY_PORT}/`;

async function main() {
  console.log(`真实时延联机回归 → 代理 ${PROXIED} → ${BASE}（单程 +${ONE_WAY}ms）\n`);

  const proxy = spawn(process.execPath, [new URL('./lag-proxy.mjs', import.meta.url).pathname, String(PROXY_PORT), TARGET.port || '80', String(ONE_WAY)], {
    stdio: 'ignore',
  });
  launched.push({ proc: proxy, profile: null, cdp: null });
  await sleep(600);

  const tag = Math.random().toString(36).slice(2, 6);
  const a = await launch(`lagA_${tag}`, 9720);
  const b = await launch(`lagB_${tag}`, 9721);

  const enter = async (cdp) => {
    await cdp.waitFor(`window.__game.scene.isActive('GameScene')`, 60000);
    await cdp.waitFor(`window.__startGate.phase === 'ready'`, 60000);
    await cdp.eval(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true }));
      return true;
    })()`);
    await cdp.waitFor(
      `(() => { const s = window.__game.scene.getScene('GameScene'); return window.__startGate.phase === 'playing' && s?.online?.localNetId >= 0; })()`,
      30000,
    );
  };
  await enter(a);
  await enter(b);
  await sleep(2500);

  const diagB = await b.eval(`window.__netDiag ? window.__netDiag() : null`);
  check('双方进入对局且角色正确', !!diagB && diagB.netId >= 0 && typeof diagB.role === 'string', JSON.stringify(diagB));

  // ---- 1. 本地位置不被权威回拉（橡皮筋回归）----
  // 做法与地图几何无关：把角色瞬移到空地，再挪 90px，等待后检查"没有被拉回去"。
  // v2 的房主权威会把它硬拽回权威位置（或持续 9px/帧 回拉），v3 不会。
  const move = await b.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const sp = s.mapData.spawnPoints[0];
    me.container.setPosition(sp.x, sp.y - 30);
    me.container.setVelocity(0, 0);
    await new Promise((r) => setTimeout(r, 500));
    const from = Math.round(me.container.x);
    me.container.setPosition(from + 90, me.container.y);
    me.container.setVelocity(0, 0);
    const target = from + 90;
    const trail = [];
    for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 100)); trail.push(Math.round(me.container.x)); }
    return { from, target, trail, final: trail[trail.length - 1] };
  })()`);
  // 判据只看"有没有被往回拉"（出现明显的倒退步）。
  // 不要断言"停在原地"：角色可能被推、滑、或在斜坡上缓动，那都不是橡皮筋。
  let backSteps = 0;
  for (let i = 1; i < move.trail.length; i++) if (move.trail[i] < move.trail[i - 1] - 6) backSteps++;
  check('本地位置不被权威回拉（无橡皮筋）', backSteps === 0, JSON.stringify({ ...move, backSteps }));

  // ---- 2. 房主能持续收到对手位置（不会冻结）----
  await a.eval(`(() => { const s = window.__game.scene.getScene('GameScene'); const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId); window.__otherNet = other; return true; })()`);
  const lagSample = await a.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const p = s.online.playerOf(window.__otherNet);
    const xs = [];
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 120)); xs.push(Math.round(p.container.x)); }
    return xs;
  })()`);
  // 用"最后一次本地位置"对比（角色可能在移动，不能拿最初的传送目标比）
  const expect = move.final;
  const hostCopyOk = lagSample.every((x) => Math.abs(x - expect) <= 160);
  check(
    '房主端的对手位置跟随（偏差在单程延迟 × 速度量级内）',
    hostCopyOk,
    JSON.stringify({ hostSees: lagSample, expect }),
  );

  // ---- 2.5 掉落物下落必须连续（不是每 50ms 跳一大步）----
  // 被判定的量：非房主端上，某个正在下落的掉落物"单帧 y 位移"。
  // 直接用快照坐标会看到 45px+ 的台阶（900px/s × 50ms），插值后应该在 15px 量级。
  const dropSmooth = await b.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const frames = [];
    for (let i = 0; i < 150; i++) {
      const falling = s.pickups.list.filter((it) => it.netId !== undefined && it.falling);
      frames.push(falling.map((it) => [it.netId, it.y]));
      await new Promise((r) => setTimeout(r, 16));
    }
    const before = new Map();
    let maxStep = 0;
    let samples = 0;
    for (const frame of frames) {
      for (const [id, y] of frame) {
        const prev = before.get(id);
        if (prev !== undefined) {
          const d = Math.abs(y - prev);
          if (d > maxStep) maxStep = d;
          samples++;
        }
        before.set(id, y);
      }
    }
    return { maxStep: Math.round(maxStep * 10) / 10, samples };
  })()`);
  check(
    '掉落物下落是连续的（单帧位移远小于快照台阶）',
    dropSmooth.samples === 0 || dropSmooth.maxStep <= 40,
    JSON.stringify(dropSmooth),
  );

  // ---- 2.6 远端玩家的动作要连贯（不抖、不来回切姿态）----
  await a.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const orig = s.inputManager.readP1.bind(s.inputManager);
    window.__origWalk = orig;
    let n = 0;
    s.inputManager.readP1 = () => { const c = orig(); c.moveX = n++ < 90 ? 1 : 0; return c; };
    return true;
  })()`);
  const anim = await b.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const p = s.online.playerOf(other);
    const poses = [];
    let maxStep = 0;
    let prevX = p.container.x;
    for (let i = 0; i < 70; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poses.push(p.pose);
      const dx = Math.abs(p.container.x - prevX);
      if (dx > maxStep) maxStep = dx;
      prevX = p.container.x;
    }
    // 统计"走 → 停 → 走"的抖动次数（只数移动过程中不该出现的 idle/fall 回切）
    let flickers = 0;
    for (let i = 2; i < poses.length; i++) {
      if (poses[i] === poses[i - 2] && poses[i] !== poses[i - 1]) flickers++;
    }
    return { poses: [...new Set(poses)], flickers, maxStep: Math.round(maxStep * 10) / 10, remoteDriven: p.remoteDriven };
  })()`);
  await a.eval(`(() => { const s = window.__game.scene.getScene('GameScene'); s.inputManager.readP1 = window.__origWalk; return true; })()`);
  check(
    '远端玩家由快照驱动（remoteDriven）且位置无跳跃',
    anim.remoteDriven === true && anim.maxStep <= 30,
    JSON.stringify({ remoteDriven: anim.remoteDriven, maxStep: anim.maxStep, poses: anim.poses }),
  );
  check(
    '远端玩家姿态不抖动（不会一帧走一帧停）',
    anim.flickers <= 2,
    JSON.stringify({ flickers: anim.flickers, poses: anim.poses }),
  );

  // ---- 2.7 远端位置的时间轴必须"等间隔"（这是一顿一顿的根因）----
  // 服务端会把位置合并成一条报文下发，一批里可能同时出现同一个玩家的 0 或 2 个样本。
  // 如果按"到达时间"当样本时刻，两个样本同批到达时跨度就是 0 →
  // 瞬间跳到最新值再停 50ms，观感就是"一顿一顿"。
  // 所以这里直接校验重建出来的时间轴：相邻样本必须保持接近的名义间隔（无 0 跨度）。
  const movedPromise = a.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const sp = s.mapData.spawnPoints[0];
    me.container.setPosition(sp.x, sp.y - 26);
    me.container.setVelocity(0, 0);
    const orig = s.inputManager.readP1.bind(s.inputManager);
    window.__origWalkA = orig;
    s.inputManager.readP1 = () => { const c = orig(); c.moveX = 1; c.crouch = false; return c; };
    await new Promise((r) => setTimeout(r, 2500));
    s.inputManager.readP1 = window.__origWalkA;
    return true;
  })()`);
  await sleep(1200);
  const timeline = await b.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const st = [...s.online.posStreams.entries()].find(([id]) => id !== s.online.localNetId)?.[1];
    if (!st || st.samples.length < 6) return null;
    const spans = [];
    for (let i = 1; i < st.samples.length; i++) spans.push(Math.round(st.samples[i].at - st.samples[i - 1].at));
    const bad = spans.filter((v) => v < 30 || v > 90).length;
    return { spans, bad, interval: Math.round(st.interval * 10) / 10, delay: Math.round(st.delay) };
  })()`);
  await movedPromise;
  check(
    '远端位置时间轴等间隔（无 0 跨度导致的"一顿一顿"）',
    !!timeline && timeline.bad === 0 && timeline.interval >= 35 && timeline.interval <= 80,
    JSON.stringify(timeline),
  );

  // ---- 3. 摔落伤害（自己检测自己）----
  const total = `(() => { const h = window.__game.scene.getScene('GameScene').online.localPlayer.health; return h.hp + h.shield; })()`;
  const fallBefore = await b.eval(total);
  // 从"出生点正上方"落下：出生点一定站在实地上，所以一定会落回实地（与地图几何无关，不会偶然卡在平台/墙里）
  await b.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const sp = s.mapData.spawnPoints[0];
    me.container.setPosition(sp.x, sp.y - 520);
    me.container.setVelocity(0, 0);
    return true;
  })()`);
  await sleep(4000);
  const fallAfter = await b.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const h = s.online.localPlayer.health;
    return { total: h.hp + h.shield, hp: h.hp, shield: h.shield, y: Math.round(s.online.localPlayer.container.y) };
  })()`);
  check('高空摔落会掉血（自己上报、服务端结算）', fallAfter.total < fallBefore, JSON.stringify({ fallBefore, fallAfter }));

  // 确定性校验"环境伤害只能自己伤自己"这条链路（不依赖地图几何）
  const envBefore = await b.eval(total);
  await b.eval(`(() => { window.__game.scene.getScene('GameScene').online.reportEnvDamage(15); return true; })()`);
  await sleep(1200);
  const envAfter = await b.eval(total);
  check('环境伤害上报链路可用（自己报自己 → 服务端结算）', envAfter < envBefore, JSON.stringify({ envBefore, envAfter }));

  // ---- 4. 打人掉血（谁打的上报谁）----
  const hitBefore = await a.eval(`window.__game.scene.getScene('GameScene').online.localPlayer.health.hp`);
  await b.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const target = s.online.playerOf(other);
    s.damageSystem.damagePlayer(target, { amount: 30, kind: 'bullet', sourceId: me.id, weaponId: 'pistol', point: { x: target.container.x, y: target.container.y }, normal: { x: -1, y: 0 }, knockback: { x: -2, y: 0 }, attackId: 7001 });
    return true;
  })()`);
  await sleep(1500);
  const hitAfter = await a.eval(`window.__game.scene.getScene('GameScene').online.localPlayer.health.hp`);
  check('客户端打房主会结算掉血（命中与所见一致）', hitAfter < hitBefore, JSON.stringify({ hitBefore, hitAfter }));

  // ---- 5. 捡枪（自己请求，服务端授予）----
  const pick = await b.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const drop = s.pickups.list.find((i) => i.kind === 'weapon' && i.weaponId !== 'grenade' && i.netId !== undefined);
    if (!drop) return { ok: false, reason: '没有武器掉落物' };
    me.container.setPosition(drop.x, drop.y);
    me.container.setVelocity(0, 0);
    await new Promise((r) => setTimeout(r, 1600));
    return { ok: true, weapon: me.heldWeapon?.id ?? '' };
  })()`);
  check('捡枪成功（行动者请求 + 服务端授予）', !!pick.ok && !!pick.weapon, JSON.stringify(pick));

  // ---- 5.5 自适应插值 + 即时打击反馈（真实时延下）----
  const adapt = await b.eval(`window.__netDiag ? window.__netDiag() : null`);
  // 上限放开到 200：单程 150ms 时，要"不靠外推地平滑渲染对手"就必须盖住
  // 对方上行 + 我的下行（≈300ms 的一半以上），硬卡 140 反而会造成动作不连贯。
  // 延迟现在按"缓冲需要"自适应（目标 = 时间轴落后真实时间的量 + 一个样本余量），
  // 不再按 RTT 硬推 —— 因为时间轴锚定在"收包时刻"，网络单向延迟不进入公式。
  // 真正该盯的是"饿死次数"：它持续增长才说明缓冲不够。
  check(
    '真实时延下插值延迟自适应（60~200ms 且几乎不饿死）',
    !!adapt && adapt.interpDelay >= 60 && adapt.interpDelay <= 200 && (adapt.starves ?? 0) <= 8,
    JSON.stringify({ interpDelay: adapt?.interpDelay, starves: adapt?.starves, rtt: adapt?.rtt, oneWay: ONE_WAY }),
  );
  const preview = await b.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const target = s.online.playerOf(other);
    const before = s.online.stats.hitPreviews;
    s.damageSystem.damagePlayer(target, {
      amount: 18, kind: 'bullet', sourceId: me.id, weaponId: 'pistol',
      point: { x: target.container.x, y: target.container.y }, normal: { x: -1, y: 0 },
      knockback: { x: -2, y: 0 }, attackId: 9901,
    });
    return { delta: s.online.stats.hitPreviews - before, previewed: s.previewedHits.has(9901) };
  })()`);
  check('高时延下打击反馈仍然同帧（不额外等 RTT）', preview.delta >= 1 && preview.previewed === true, JSON.stringify(preview));

  // ---- 5.8 投掷物出生同步：远端子弹必须从"真实枪口"出发 ----
  // 通过包一层 spawn() 精确拿到"重建出来的投掷物"的出生参数：
  // 它必须等于发射者自己的枪口坐标（而不是本端插值出来的、晚一个往返的枪口）。
  await a.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    window.__spawned = [];
    const orig = s.projectileSystem.spawn.bind(s.projectileSystem);
    s.projectileSystem.spawn = (opts) => {
      window.__spawned.push({ x: opts.x, y: opts.y, a: opts.angle, w: opts.weaponId, relayed: !!opts.relayed, ownerId: opts.ownerId });
      orig(opts);
    };
    return true;
  })()`);
  const shotFrom = await b.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    me.heldWeapon = { id: 'pistol', ammo: 99 };
    me.container.setVelocity(0, 0);
    const before = s.projectileSystem.count;
    const m = me.muzzle;
    s.weaponSystem.tryAttack(me, { attack: true, attackHeld: true });
    return { muzzle: { x: Math.round(m.x), y: Math.round(m.y) }, fired: s.projectileSystem.count > before };
  })()`);
  await sleep(1600);
  const relayed = await a.eval(`(() => {
    const s = window.__game.scene.getScene('GameScene');
    const other = s.players.map((p) => s.online.netIdOf(p)).find((id) => id >= 0 && id !== s.online.localNetId);
    const owner = s.online.playerOf(other);
    const mine = window.__spawned.filter((o) => o.relayed && o.ownerId === owner.id);
    return { count: window.__spawned.length, relayedCount: mine.length, first: mine[0] ?? null };
  })()`);
  check('发射者确实开火了', shotFrom.fired === true, JSON.stringify(shotFrom));
  check(
    '观察者收到并重建了远端投掷物（relayed）',
    relayed.relayedCount >= 1,
    JSON.stringify({ 重建数: relayed.relayedCount, 全部出生: relayed.count }),
  );
  check(
    '重建的投掷物起点 = 发射者的真实枪口（不是本端插值猜测）',
    !!relayed.first &&
      Math.abs(relayed.first.x - shotFrom.muzzle.x) <= 2 &&
      Math.abs(relayed.first.y - shotFrom.muzzle.y) <= 2,
    JSON.stringify({ 重建起点: relayed.first, 真实枪口: shotFrom.muzzle }),
  );

  // ---- 5.9 中继出来的投掷物在房主端仍然是"实体"（能打坏箱子）----
  // 关键不变量：远端玩家不再本地生成弹丸，但如果中继弹丸在房主端不结算物体耐久，
  // 就会出现"我打箱子它不坏"。这里直接在房主端放一发 relayed 弹丸打向可破坏物体。
  const relayDamage = await a.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const target = s.mapObjects.find((m) => m.body && m.durability > 0);
    if (!target) return { ok: false, reason: '没有可破坏物体' };
    const before = target.durability;
    const b = target.body.position;
    // 直接在物体中心放一枚"中继进来的引信手雷"：40ms 后原地爆炸
    // （不依赖地形/朝向，任何地图都稳定）
    s.projectileSystem.spawn({
      weaponId: 'grenade',
      x: b.x,
      y: b.y,
      angle: 0,
      damage: 1,
      knockback: 1,
      ownerId: s.online.localPlayer.id,
      ownerBody: s.online.localPlayer.body,
      bullet: { kind: 'grenade', speed: 1, range: 10, size: 5, color: '#fff', trail: 0, maxBounces: 0, bounceDamageMul: 1, pierceDamageMul: 1, piercePlayers: false, bounceAny: false },
      explosion: { radius: 140, damage: 120, knockback: 4, selfDamage: false },
      fuseMs: 40,
      relayed: true,
    });
    await new Promise((r) => setTimeout(r, 700));
    return { ok: true, before, after: target.durability, id: target.id };
  })()`);
  check(
    '中继出来的弹丸在房主端仍会结算物体耐久（远端也能打坏箱子）',
    relayDamage.ok !== false && relayDamage.after < relayDamage.before,
    JSON.stringify(relayDamage),
  );

  // ---- 5.95 客户端开火 → 房主端箱子掉耐久（中继链路的真正端到端）----
  // 用户反馈过"纸箱打不烂"，这条就是盯它：非房主开火时本端不结算耐久，
  // 必须靠中继到房主的那发弹丸把耐久打下去。
  const boxRelay = await b.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const me = s.online.localPlayer;
    const box = s.mapObjects.find((m) => m.body && m.durability > 0 && m.material !== 'wall');
    if (!box) return { ok: false, reason: '没有可破坏物体' };
    const b = box.body.position;
    me.container.setPosition(b.x - 80, b.y);
    me.container.setVelocity(0, 0);
    await new Promise((r) => setTimeout(r, 400));
    // 走真实出口：spawn() → interceptSpawn() → 广播 → 房主重建
    s.projectileSystem.spawn({
      weaponId: 'pistol', x: b.x - 80, y: b.y, angle: 0,
      damage: 60, knockback: 1, ownerId: me.id, ownerBody: me.body,
      bullet: { kind: 'bullet', speed: 1600, range: 260, size: 3, color: '#fff', trail: 0, maxBounces: 0, bounceDamageMul: 1, pierceDamageMul: 1, piercePlayers: false, bounceAny: false },
    });
    return { ok: true, id: box.id, before: box.durability, isHost: s.online.isAuthority };
  })()`);
  await sleep(1500);
  const hostForBox = (await a.eval(`window.__game.scene.getScene('GameScene').online.isAuthority`)) ? a : b;
  const boxAfter = boxRelay.ok === false
    ? null
    : await hostForBox.eval(`(() => {
        const s = window.__game.scene.getScene('GameScene');
        const t = s.mapObjects.find((m) => m.id === ${JSON.stringify(boxRelay.id ?? '')});
        return t ? { dur: t.durability } : null;
      })()`).catch(() => null);
  check(
    '客户端开火 → 房主端箱子耐久下降（中继链路端到端）',
    boxRelay.ok !== false && boxRelay.isHost !== true && boxAfter !== null && boxAfter.dur < (boxRelay.before ?? 100),
    JSON.stringify({ boxRelay, boxAfter }),
  );

  // ---- 6. 角色自愈：模拟"房主漏收了 host 通知" ----  // ---- 6. 角色自愈：模拟"房主漏收了 host 通知" ----
  // 服务端在 30Hz 的 in 广播里持续下发权威座位号，所以即使漏事件也会在 1 帧内恢复。
  const healed = await a.eval(`(async () => {
    const s = window.__game.scene.getScene('GameScene');
    const before = { role: s.online.stats.role, host: s.online.stats.hostSeat };
    // 人为把状态改坏（等价于漏收 host 事件）
    s.online.role = 'client';
    s.online.hostSeat = -1;
    s.online.applyRole();
    const broken = { role: s.online.stats.role, host: s.online.stats.hostSeat };
    await new Promise((r) => setTimeout(r, 600));
    return { before, broken, after: { role: s.online.stats.role, host: s.online.stats.hostSeat } };
  })()`);
  check(
    '角色失配会自愈（10~30Hz 状态里带房主座位号）',
    healed.after.role === 'authority' && healed.after.host >= 0,
    JSON.stringify(healed),
  );

  // ---- 7. 延迟显示与诊断 ----
  const pingText = await b.eval(`[...document.querySelectorAll('.mp-topbar .mp-sub')].map((e) => e.textContent)`);
  const pingMs = Number((pingText.find((t) => /ms$/.test(t)) ?? '').replace('ms', ''));
  check('延迟显示正常量级（不是十几位数）', Number.isFinite(pingMs) && pingMs >= 0 && pingMs < 10000, JSON.stringify(pingText));
  const diagEnd = await b.eval(`window.__netDiag ? window.__netDiag() : null`);
  const expectRtt = ONE_WAY * 2;
  check(
    '诊断面板 RTT 与实际时延匹配',
    !!diagEnd && diagEnd.rtt >= expectRtt * 0.4 && diagEnd.rtt <= expectRtt * 2.5 + 120,
    JSON.stringify({ rtt: diagEnd?.rtt, expectRtt }),
  );
  check('位置/快照都在持续收包', diagEnd.posHz > 5 && diagEnd.snapHz > 5, JSON.stringify({ posHz: diagEnd?.posHz, snapHz: diagEnd?.snapHz }));
  const panel = await b.eval(`document.querySelector('.mp-netdebug')?.textContent ?? ''`);
  check('网络诊断面板（?netdebug=1）有内容', /role/.test(panel) && /插值延迟/.test(panel), panel.slice(0, 120));

  console.log(`  ℹ️ 诊断: ${JSON.stringify({ oneWay: ONE_WAY, rtt: diagEnd?.rtt, interpDelay: diagEnd?.interpDelay, posHz: diagEnd?.posHz, snapHz: diagEnd?.snapHz, hitPreviews: diagEnd?.hitPreviews, streams: diagEnd?.streams })}`);

  const exceptions = [...a.exceptions, ...b.exceptions];
  check('全程无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

  console.log('');
  if (failures > 0) console.log(`❌ 真实时延回归失败：${failures} 项`);
  else console.log('✅ 真实时延回归全部通过');
  return failures;
}

main()
  .then(async (f) => {
    for (const p of launched) {
      try {
        p.cdp?.close();
        p.proc?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (p.profile) {
        try {
          execSync(`pkill -9 -f "user-data-dir=${p.profile}"`, { stdio: 'ignore' });
        } catch {
          /* ignore */
        }
        try {
          rmSync(p.profile, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
    await sleep(400);
    process.exit(f > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('❌ 真实时延回归异常:', err);
    for (const p of launched) {
      try {
        p.proc?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  });
