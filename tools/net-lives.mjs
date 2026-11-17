#!/usr/bin/env node
/**
 * 命数（可复活次数）回归：死亡 → 倒计时 → 服务端指定复活 → 命尽出局 → 回合结束。
 *
 * 用法（命数取地图属性 lives，默认 1）：
 *   cd server && go run . --dev
 *   node tools/net-lives.mjs ws://127.0.0.1:8092/ws
 *
 * 脚本会从 match_start.stats 读取本局命数，所以对任何 lives（0/1/3/5…）都适用：
 *   - lives=0：一命到底，第一击就结算
 *   - lives=N：每死一次都要等复活，第 N+1 次死亡才出局
 * 不依赖团队战（首局单人会回落混战），只验证命数与复活链路本身。
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

  wait(type, predicate = () => true, timeout = 5000) {
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
  console.log(`命数/复活回归 → ${base}\n`);
  const tag = Math.random().toString(36).slice(2, 6);

  const a = await new Player(`lifeA_${tag}`).connect();
  await a.wait('welcome');
  a.send({ t: 'enter' });
  const startA = await a.wait('match_start', (m) => m.you >= 0);

  const b = await new Player(`lifeB_${tag}`).connect();
  await b.wait('welcome');
  b.send({ t: 'enter' });
  const startB = await b.wait('match_start', (m) => m.you >= 0);

  const statB = startB.stats.find((s) => s.id === startB.you);
  const revives0 = Math.max(0, statB?.revives ?? 0);
  console.log(`本局命数：剩余 ${statB?.lives} 条命 / ${revives0} 次复活（地图 ${startB.map}，模式 ${startB.mode}）`);
  check('命数自洽（剩余生命 = 复活次数 + 1）', !!statB && statB.lives === revives0 + 1, JSON.stringify({ lives: statB?.lives, revives: statB?.revives }));

  const mapData = JSON.parse(readFileSync(resolve(mapsDir, `${startB.map}.json`), 'utf8'));
  const isSpawn = (x, y) =>
    mapData.spawnPoints.some((p) => Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5);

  let attack = 501;
  const deaths = revives0 + 1;
  for (let i = 0; i < deaths; i++) {
    const last = i === deaths - 1;
    // 死亡瞬间：当前这条命已消耗；等复活时显示的是“即将回来的那条”= Revives
    const expectLives = revives0 - i;
    b.clear();
    a.clear();
    a.send({ t: 'dmg', target: startB.you, src: startA.you, amount: 400, kind: 'bullet', crit: false, attack: attack++, ignoreInvuln: true });
    const hp = await b.wait('hp', (m) => m.id === startB.you && m.dead === true, 4000);
    check(
      `第 ${i + 1} 次死亡：剩余 ${expectLives} 条命（复活次数 ${hp.revives}）`,
      hp.lives === expectLives && hp.revives === revives0 - i,
      JSON.stringify({ lives: hp.lives, revives: hp.revives, respawnInMs: hp.respawnInMs }),
    );

    if (last) {
      check('命尽死亡不再进入复活倒计时', (hp.respawnInMs ?? 0) === 0, JSON.stringify({ respawnInMs: hp.respawnInMs }));
      break;
    }

    check('还有命：进入 3 秒复活倒计时', (hp.respawnInMs ?? 0) > 1000 && (hp.respawnInMs ?? 0) <= 3500, JSON.stringify({ respawnInMs: hp.respawnInMs }));
    await sleep(700);
    check('还有命时本局不结算', !b.msgs.some((m) => m.t === 'match_end') && !a.msgs.some((m) => m.t === 'match_end'));

    const respawn = await b.wait('respawn', (m) => m.id === startB.you, 8000);
    check('复活位置来自地图出生点', isSpawn(respawn.x, respawn.y), JSON.stringify({ x: respawn.x, y: respawn.y }));
    check(
      '复活：满血 + 复活次数扣减',
      respawn.hp === 100 && respawn.shield === 0 && respawn.lives === revives0 - i && respawn.revives === revives0 - i - 1,
      JSON.stringify({ hp: respawn.hp, shield: respawn.shield, lives: respawn.lives, revives: respawn.revives }),
    );
    const alive = await b.wait('hp', (m) => m.id === startB.you && m.dead === false, 4000);
    check('复活后的 hp 广播一致', alive.hp === 100 && alive.lives === revives0 - i, JSON.stringify({ hp: alive.hp, lives: alive.lives }));
  }

  // 命尽 + 只剩一人 → 结算
  const end = await a.wait('match_end', undefined, 6000);
  check('命尽后只剩一人 → 本局结算', typeof end.winner === 'string' || end.winner === '', JSON.stringify({ winner: end.winner, mode: end.mode }));

  // 新局命数重置
  a.clear();
  const next = await a.wait('match_start', (m) => m.matchId !== startA.matchId, 25000);
  const meNext = next.stats.find((s) => s.id === next.you);
  check(
    '新局命数重置（满血 + 命数回到初始）',
    !!meNext && meNext.hp === 100 && meNext.lives === meNext.revives + 1,
    JSON.stringify({ lives: meNext?.lives, revives: meNext?.revives }),
  );

  a.close();
  b.close();
  await sleep(200);
  console.log(failures === 0 ? '\n✅ 命数/复活回归全部通过' : `\n❌ 命数/复活回归失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n❌ 命数/复活回归异常: ${err?.stack ?? err}`);
  process.exit(1);
});
