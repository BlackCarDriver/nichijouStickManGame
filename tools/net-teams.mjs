#!/usr/bin/env node
/**
 * 团队战（tdm）协议回归：分边 / 出生点分半区 / 同队伤害丢弃 / 跨队伤害 / 一方全灭结算。
 *
 * 用法（服务端必须用 `--mode tdm` 启动，见 docs/联机协议.md「本地开发」）：
 *   cd server && go run . --dev --mode tdm
 *   node tools/net-teams.mjs ws://127.0.0.1:8092/ws
 *
 * 注意：首个进房的人是**单人开局**，服务端会把团队战回落成混战（至少要 2 人才分两队），
 * 所以这里先靠"打到只剩一人"结束首局，等下一局 3 人齐，才是真正的团队战。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'ws://127.0.0.1:8095/ws';
const mapsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'maps');

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
    this.ws = new WebSocket(`${base}?dev=1&nick=${encodeURIComponent(this.nick)}`);
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
  console.log(`团队战协议回归 → ${base}\n`);
  const tag = Math.random().toString(36).slice(2, 6);
  const players = [];

  const a = await new Player(`teamA_${tag}`).connect();
  players.push(a);
  await a.wait('welcome');
  a.send({ t: 'enter' });
  const startA = await a.wait('match_start', (m) => m.you >= 0);

  const b = await new Player(`teamB_${tag}`).connect();
  players.push(b);
  await b.wait('welcome');
  b.send({ t: 'enter' });
  const startB = await b.wait('match_start', (m) => m.you >= 0);

  const c = await new Player(`teamC_${tag}`).connect();
  players.push(c);
  await c.wait('welcome');
  c.send({ t: 'enter' });
  const startC = await c.wait('match_start', (m) => m.you >= 0);

  const seatA = startA.you;
  const seatB = startB.you;
  const seatC = startC.you;

  check(
    '单人开局回落混战（团队战至少 2 人）',
    startC.mode === 'ffa',
    `mode=${startC.mode}`,
  );

  // 结束首局：只剩一人
  a.send({ t: 'dmg', target: seatB, src: seatA, amount: 200, kind: 'bullet', crit: false, attack: 101, ignoreInvuln: true });
  await sleep(150);
  a.send({ t: 'dmg', target: seatC, src: seatA, amount: 200, kind: 'bullet', crit: false, attack: 102, ignoreInvuln: true });
  const firstEnd = await a.wait('match_end', undefined, 5000);
  check('混战只剩一人结算', firstEnd.mode === 'ffa' && firstEnd.reason === 'lastman', JSON.stringify({ mode: firstEnd.mode, reason: firstEnd.reason }));

  // 下一局：3 人齐 → 团队战
  const m = await a.wait('match_start', (x) => x.matchId !== startA.matchId, 20000);
  check('新局模式为 tdm', m.mode === 'tdm', `mode=${m.mode}`);
  check(
    '按座位交替分边（0/1/0）',
    m.players.length === 3 && m.players[0].team === 0 && m.players[1].team === 1 && m.players[2].team === 0,
    JSON.stringify(m.players.map((p) => p.team)),
  );
  check(
    '颜色 = 队伍色（0=红 / 1=蓝）',
    m.players.every((p) => p.color === p.team),
    JSON.stringify(m.players.map((p) => p.color)),
  );

  // 出生点：红队左半区 / 蓝队右半区
  const mapData = JSON.parse(readFileSync(resolve(mapsDir, `${m.map}.json`), 'utf8'));
  const byX = mapData.spawnPoints.map((p, i) => ({ i, x: p.x })).sort((l, r) => l.x - r.x);
  const half = Math.ceil(byX.length / 2);
  const left = new Set(byX.slice(0, half).map((o) => o.i));
  const right = new Set(byX.slice(half).map((o) => o.i));
  check(
    '红队出生在左半区 / 蓝队在右半区',
    m.players.every((p) => (p.team === 0 ? left.has(p.spawn) : right.has(p.spawn))),
    JSON.stringify({ map: m.map, players: m.players.map((p) => ({ team: p.team, spawn: p.spawn })) }),
  );

  const seat = new Map(m.players.map((p) => [p.nick, p.netId]));
  const a2 = seat.get(`teamA_${tag}`);
  const b2 = seat.get(`teamB_${tag}`);
  const c2 = seat.get(`teamC_${tag}`);

  // 同队（A、C 都红队）：服务端直接丢弃
  c.clear();
  c.send({ t: 'dmg', target: a2, src: c2, amount: 30, kind: 'bullet', crit: false, attack: 201, ignoreInvuln: true });
  await sleep(500);
  check('同队伤害被服务端丢弃', !c.msgs.some((x) => x.t === 'hp' && x.id === a2), JSON.stringify(c.msgs.filter((x) => x.t === 'hp')));

  // 跨队（C 打 B）：正常结算
  c.clear();
  c.send({ t: 'dmg', target: b2, src: c2, amount: 30, kind: 'bullet', crit: false, attack: 202, ignoreInvuln: true });
  const hp = await c.wait('hp', (x) => x.id === b2, 3000);
  check('跨队伤害正常结算（100 → 70）', hp.hp === 70, `hp=${hp.hp} shield=${hp.shield}`);

  // 蓝队全灭 → 立即结算
  c.clear();
  c.send({ t: 'dmg', target: b2, src: c2, amount: 200, kind: 'bullet', crit: false, attack: 203, ignoreInvuln: true });
  const end = await c.wait('match_end', undefined, 5000);
  check('一方全灭即结算（teamwipe）', end.reason === 'teamwipe' && end.mode === 'tdm', JSON.stringify({ reason: end.reason, mode: end.mode }));
  check('胜方为红队（team0）', end.winnerTeam === 0 && end.winner === '红队', JSON.stringify({ winner: end.winner, winnerTeam: end.winnerTeam }));
  check('results 带队伍信息', end.results.every((r) => typeof r.team === 'number'), JSON.stringify(end.results));
  check(
    '结算带下一局模式（预告用）',
    end.nextMode === 'ffa' || end.nextMode === 'tdm',
    JSON.stringify({ nextMode: end.nextMode, nextMap: end.nextMap }),
  );

  for (const p of players) p.close();
  await sleep(200);
  console.log(failures === 0 ? '\n✅ 团队战回归全部通过' : `\n❌ 团队战回归失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n❌ 团队战回归异常: ${err?.stack ?? err}`);
  process.exit(1);
});
