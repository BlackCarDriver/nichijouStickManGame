#!/usr/bin/env node
/**
 * 联机服务端冒烟测试（不依赖聊天室，也不需要浏览器）。
 *
 * 用法：
 *   node tools/net-smoke.mjs [ws://127.0.0.1:8095/ws]
 *
 * 需要服务端以 --dev 启动（允许 ?dev=1&nick=xxx 假身份）：
 *   cd server && go run . --dev
 *
 * 覆盖：开局、房主选举、输入中继、权威世界快照（snap）、伤害与击杀、
 *       拾取仲裁、物体销毁广播、聊天、延迟测量、掉线/观战/重开。
 */
const base = process.argv[2] ?? 'ws://127.0.0.1:8095/ws';
/** healthz 地址由 ws 地址推导，方便在任意端口跑冒烟 */
const healthUrl = base.replace(/^ws/, 'http').replace(/\/ws.*$/, '/healthz');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Player {
  constructor(nick) {
    this.nick = nick;
    this.msgs = [];
    this.waiters = [];
  }

  async connect() {
    const url = `${base}?dev=1&nick=${encodeURIComponent(this.nick)}`;
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      this.msgs.push(msg);
      for (const w of [...this.waiters]) w(msg);
    });
    return this;
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** 等待满足条件的消息（含已经收到的） */
  wait(type, predicate = () => true, timeout = 3000) {
    const found = this.msgs.find((m) => m.t === type && predicate(m));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onMsg);
        reject(new Error(`${this.nick} 等待 ${type} 超时`));
      }, timeout);
      const onMsg = (msg) => {
        if (msg.t === type && predicate(msg)) {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== onMsg);
          resolve(msg);
        }
      };
      this.waiters.push(onMsg);
    });
  }

  clear() {
    this.msgs = [];
  }

  close() {
    this.ws?.close();
  }
}

async function main() {
  console.log(`联机冒烟测试 → ${base}\n`);
  const tag = Math.random().toString(36).slice(2, 6);

  // 死锁回归：状态上报路径不能在持有房间锁时回调自己
  const health = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(healthUrl, { signal: ctrl.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  check('healthz 可响应（房间锁未卡死）', await health());

  // ---- 进房即开局：A 一个人也能立刻操控 ----
  const a = await new Player(`smokeA_${tag}`).connect();
  const welcomeA = await a.wait('welcome');
  check('A 收到 welcome', welcomeA.nick === `smokeA_${tag}`);
  check('welcome 带地图列表', Array.isArray(welcomeA.maps) && welcomeA.maps.length > 0);

  const startA0 = await a.wait('match_start');
  check(
    '未按"开始"前只加载、不占座位（不加入对局）',
    startA0.you === -1 && startA0.players.length === 0,
    JSON.stringify({ you: startA0.you, n: startA0.players.length }),
  );
  a.clear();
  a.send({ t: 'enter' });
  const startA1 = await a.wait('match_start', (m) => m.you >= 0, 5000);
  check('按开始后进入对局', startA1.you >= 0 && startA1.players.length === 1, JSON.stringify({ you: startA1.you, n: startA1.players.length }));
  check('对局下发随机地图', typeof startA1.map === 'string' && startA1.map.length > 0, startA1.map);
  check('服务端选出世界权威（单人时就是自己）', startA1.host === startA1.you, `host=${startA1.host} you=${startA1.you}`);
  check('服务端下发了掉落物', Array.isArray(startA1.drops) && startA1.drops.length > 0, `drops=${startA1.drops?.length}`);

  // ---- B 进房：加入同一局，A 收到 player_join ----
  a.clear();
  const b = await new Player(`smokeB_${tag}`).connect();
  const startB0 = await b.wait('match_start');
  check('中途加入的玩家开始前同样不占座位', startB0.you === -1, `you=${startB0.you}`);
  b.clear();
  b.send({ t: 'enter' });
  const startB1 = await b.wait('match_start', (m) => m.you >= 0, 5000);
  const seatA = startA1.you;
  const seatB = startB1.you;
  check('B 加入当前对局（拿到另一个座位）', seatB !== seatA && seatB >= 0, `A=${seatA} B=${seatB}`);
  const join = await a.wait('player_join');
  check('A 收到 player_join', join.player.nick === `smokeB_${tag}` && join.player.netId === seatB, JSON.stringify(join.player));
  check('player_join 带出生点/颜色', Number.isFinite(join.player.spawn) && Number.isFinite(join.player.color));

  // ---- 输入中继 ----
  b.clear();
  a.send({ t: 'in', seq: 1, mx: 1, jh: true, cr: false, ah: true, kh: false, sw: false, aim: 0.5, e: 3 });
  const inB = await b.wait('in', (m) => m.p?.some((p) => p.id === seatA && p.mx === 1));
  const snap = inB.p.find((p) => p.id === seatA);
  check('输入中继到对端', snap.mx === 1 && snap.jh === true && snap.ah === true);
  check('输入边沿被转发一次', (snap.e & 3) === 3, `e=${snap.e}`);

  await sleep(80);
  b.clear();
  a.send({ t: 'in', seq: 2, mx: 0, jh: false, cr: false, ah: false, kh: false, sw: false, aim: 0, e: 0 });
  const inB2 = await b.wait('in', (m) => m.p?.some((p) => p.id === seatA && p.seq === 2));
  const snap2 = inB2.p.find((p) => p.id === seatA && p.seq === 2);
  check('边沿不会重复下发', (snap2?.e ?? 0) === 0, `e=${snap2?.e}`);

  // ---- 主动观战：让出座位，收到 you=-1 的快照 ----
  const s1 = await new Player(`smokeS_${tag}`).connect();
  await s1.wait('welcome');
  s1.clear();
  s1.send({ t: 'spectate' });
  const specStart = await s1.wait('match_start', undefined, 5000);
  check('请求观战后以旁观身份入局（you=-1）', specStart.you === -1, `you=${specStart.you}`);
  const roomSpec = await b.wait('room', (m) => m.spectators.includes(`smokeS_${tag}`), 4000);
  check('房间快照把观战者放进 spectators', roomSpec.spectators.includes(`smokeS_${tag}`));
  s1.close();
  await sleep(200);

  // ---- 权威世界快照（房主 → 服务端 → 其它客户端）----
  b.clear();
  a.send({
    t: 'snap',
    seq: 1,
    key: true,
    p: [{ id: seatA, x: 500, y: 1000, vx: 0, vy: 0, g: true }],
    o: [{ id: 'crate_a#0', x: 720, y: 1380, a: 0.1 }],
    d: [{ id: 999999, x: 640, y: 900, f: false }],
  });
  const snapB = await b.wait('snap', (m) => m.seq === 1);
  check('房主快照被转发给其它客户端', snapB.key === true && snapB.p?.[0]?.x === 500);
  check('快照携带动态物体', snapB.o?.[0]?.id === 'crate_a#0');
  check('快照携带掉落物落点', snapB.d?.[0]?.y === 900);

  // 非房主伪造快照必须被丢弃
  b.clear();
  b.send({ t: 'snap', seq: 2, key: true, p: [{ id: seatB, x: 1, y: 1, vx: 0, vy: 0, g: true }] });
  await sleep(250);
  check('非房主上报的快照被拒绝', !a.msgs.some((m) => m.t === 'snap' && m.seq === 2));

  // 中途加入者能拿到缓存的world快照
  const late = await new Player(`smokeL_${tag}`).connect();
  const lateStart = await late.wait('match_start');
  check('中途加入的 match_start 带世界快照', !!lateStart.world && Array.isArray(lateStart.world.p), JSON.stringify(lateStart.world?.p?.length ?? null));
  late.close();
  await sleep(150);

  // ---- 拾取仲裁 ----
  const drop = startB1.drops.find((d) => d.kind === 'weapon');
  check('存在武器掉落物', !!drop);
  if (drop) {
    a.send({ t: 'pos', x: drop.x, y: drop.y, vx: 0, vy: 0 });
    await sleep(60);
    a.clear();
    b.clear();
    a.send({ t: 'pick', id: drop.id });
    const pick = await a.wait('pick');
    check('拾取被服务端授予', pick.by === seatA && pick.grant?.weaponId === drop.weaponId, JSON.stringify(pick.grant));
    check('B 也收到拾取广播', (await b.wait('pick')).id === drop.id);
    a.send({ t: 'pick', id: drop.id });
    await sleep(200);
    check('重复拾取同一件不生效', a.msgs.filter((m) => m.t === 'pick' && m.id === drop.id).length === 1);
  }

  // ---- 物体销毁 / 聊天 / 延迟 ----
  b.clear();
  a.send({ t: 'obj', id: 'crate_test_1' });
  check('物体销毁广播', (await b.wait('obj')).id === 'crate_test_1');

  b.clear();
  a.send({ t: 'chat', text: '你好，火柴人' });
  const chat = await b.wait('chat');
  check('聊天广播', chat.nick === `smokeA_${tag}` && chat.text === '你好，火柴人');

  a.clear();
  a.send({ t: 'ping', ts: Date.now() });
  check('pong 回包', typeof (await a.wait('pong')).ts === 'number');

  // ---- 伤害 → 最后一人胜出 → 自动换图重开 ----
  a.clear();
  b.clear();
  a.send({ t: 'dmg', target: seatB, src: seatA, amount: 30, kind: 'bullet', crit: false, attack: 1, ignoreInvuln: false });
  const hp = await a.wait('hp', (m) => m.id === seatB);
  check('伤害结算：100 → 70', hp.hp === 70, `hp=${hp.hp}`);
  check('双方血量广播一致', (await b.wait('hp', (m) => m.id === seatB)).hp === 70);

  await sleep(200);
  // 非房主上报伤害必须被丢弃（避免 N 端重复结算）
  b.clear();
  b.send({ t: 'dmg', target: seatA, src: seatB, amount: 30, kind: 'bullet', crit: false, attack: 77, ignoreInvuln: true });
  await sleep(200);
  check('非房主上报的伤害被拒绝', !a.msgs.some((m) => m.t === 'hp' && m.id === seatA && m.hp === 70));

  a.send({ t: 'dmg', target: seatB, src: seatA, amount: 200, kind: 'bullet', crit: false, attack: 2, ignoreInvuln: true });
  const end = await a.wait('match_end', undefined, 4000);
  check('最后一死触发本局结束', end.winner === `smokeA_${tag}`, JSON.stringify({ winner: end.winner, results: end.results }));
  check('结算带下一张地图与倒计时', typeof end.nextMap === 'string' && end.restartInMs > 0, JSON.stringify({ nextMap: end.nextMap, ms: end.restartInMs }));
  check('B 也收到结算', (await b.wait('match_end')).winner === `smokeA_${tag}`);

  const nextA = await a.wait('match_start', (m) => m.matchId !== startB1.matchId, 6000);
  check('结算后自动开新局', nextA.matchId !== startB1.matchId);
  check('新局换成另一张地图', nextA.map === end.nextMap && nextA.map !== startB1.map, `${startB1.map} → ${nextA.map}`);
  check('新局双方满血复活', nextA.stats.every((s) => s.hp === 100 && !s.dead), JSON.stringify(nextA.stats));
  check('新局沿用同一批玩家', nextA.players.length === 2);

  // ---- 离开 = 死亡：立即移出 + 只剩一人时本局结束；重进是全新状态 ----
  const seatA2 = nextA.you;
  // 先把 A 打掉 30 血（用于验证"重进不保留血量"）
  a.clear();
  b.clear();
  a.send({ t: 'dmg', target: seatA2, src: seatB, amount: 30, kind: 'bullet', crit: false, attack: 11, ignoreInvuln: true });
  await b.wait('hp', (m) => m.id === seatA2 && m.hp === 70, 4000);
  check('离开前 A 已受伤（70 血）', true);

  a.clear();
  b.clear();
  a.close();
  const left = await b.wait('player_left', (m) => m.nick === `smokeA_${tag}`, 4000);
  check('离开立即广播 player_left（不再等宽限期）', left.id === seatA2);
  const endByLeave = await b.wait('match_end', undefined, 4000);
  check('离开视为死亡：只剩一人立即结算', endByLeave.winner === `smokeB_${tag}`, JSON.stringify(endByLeave.results));

  // 重进：下一局作为全新玩家加入（满血 / 未阵亡 / 击杀归零）
  const a3 = await new Player(`smokeA_${tag}`).connect();
  await a3.wait('welcome');
  a3.send({ t: 'enter' });
  const rejoin = await a3.wait('match_start', (m) => m.you >= 0 && m.matchId !== nextA.matchId, 10000);
  const meStat = rejoin.stats.find((st) => st.id === rejoin.you);
  check('重进作为新玩家进入下一局', rejoin.you >= 0 && !!meStat, JSON.stringify({ you: rejoin.you, stats: rejoin.stats }));
  check('重进不保留血量/状态（满血、未阵亡、0 杀）', !!meStat && meStat.hp === 100 && meStat.dead === false && meStat.kills === 0, JSON.stringify(meStat));
  check('重进后对手也满血重开', rejoin.stats.every((st) => st.hp === 100), JSON.stringify(rejoin.stats));
  await sleep(300);
  check('处理离开/重进后服务仍可响应（无自锁）', await health());

  // ---- 最后一人离开 → 对局重置，下一个人进来是全新地图/全新世界 ----
  const mapBeforeReset = rejoin.map; // 最后一局（重进后的那一局）的地图
  a3.clear();
  a3.send({ t: 'obj', id: 'crate_reset_probe' });
  await sleep(250);
  a3.close();
  b.close();
  await sleep(800); // 等两条连接都断开（房间清空 → 服务端重置对局）

  const c = await new Player(`smokeC_${tag}`).connect();
  await c.wait('welcome');
  c.clear();
  c.send({ t: 'enter' });
  const fresh = await c.wait('match_start', (m) => m.you >= 0, 6000);
  check('最后一人离开后对局已重置（新玩家单人进新局）', fresh.players.length === 1, JSON.stringify(fresh.players));
  check('重置后换了一张地图', fresh.map !== mapBeforeReset, `${mapBeforeReset} → ${fresh.map}`);
  check('重置后世界是全新的（无残留摧毁/掉落）', fresh.destroyed.length === 0, JSON.stringify(fresh.destroyed));
  c.close();
  await sleep(100);

  console.log('');
  if (failures > 0) {
    console.log(`❌ 冒烟测试失败：${failures} 项`);
    process.exit(1);
  }
  console.log('✅ 联机冒烟测试全部通过');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 冒烟测试异常:', err);
  process.exit(1);
});
