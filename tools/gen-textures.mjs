/**
 * 生成占位贴图（可重复运行，输出到 public/textures/*.png）。
 * 只用 Node 内置 zlib 手写 PNG，不引入依赖。
 *
 * 用法：node tools/gen-textures.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'textures');

// ---------------- 最小 PNG 编码器 ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- 画布助手 ----------------
const S = 64;

function canvas() {
  const buf = Buffer.alloc(S * S * 4);
  const set = (x, y, [r, g, b, a = 255]) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  };
  return {
    buf,
    set,
    fill(color) {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, color);
      return this;
    },
    rect(x0, y0, w, h, color) {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, color);
      return this;
    },
    hline(y, color, x0 = 0, x1 = S) {
      for (let x = x0; x < x1; x++) set(x, y, color);
      return this;
    },
    vline(x, color, y0 = 0, y1 = S) {
      for (let y = y0; y < y1; y++) set(x, y, color);
      return this;
    },
    noise(rand, amount, dark = true) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (rand() > amount) continue;
          const i = (y * S + x) * 4;
          const d = dark ? -14 : 14;
          buf[i] = Math.max(0, Math.min(255, buf[i] + d));
          buf[i + 1] = Math.max(0, Math.min(255, buf[i + 1] + d));
          buf[i + 2] = Math.max(0, Math.min(255, buf[i + 2] + d));
        }
      }
      return this;
    },
  };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------- 各贴图 ----------------
const textures = {
  wood() {
    const c = canvas().fill([139, 90, 43]);
    const r = rng(7);
    for (let i = 0; i < 9; i++) {
      const y = Math.floor(r() * S);
      c.hline(y, [110, 68, 30], 0, S);
      if (r() > 0.5) c.hline(y + 1, [156, 104, 52], 0, S);
    }
    // 木节
    for (let k = 0; k < 3; k++) {
      const cx = Math.floor(r() * S);
      const cy = Math.floor(r() * S);
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        c.set(Math.round(cx + Math.cos(a) * 3), Math.round(cy + Math.sin(a) * 2), [110, 68, 30]);
      }
    }
    return c.noise(r, 0.12);
  },
  metal() {
    const c = canvas().fill([154, 165, 177]);
    for (let i = -S; i < S * 2; i += 8) {
      for (let t = 0; t < S; t++) c.set(t, (i + t) % S, [130, 140, 152]);
    }
    for (let i = -S; i < S * 2; i += 16) {
      for (let t = 0; t < S; t++) c.set(t, (i + t + 4) % S, [176, 186, 197]);
    }
    return c.noise(rng(11), 0.06);
  },
  cardboard() {
    const c = canvas().fill([200, 161, 101]);
    const r = rng(23);
    for (let y = 4; y < S; y += 8) {
      for (let x = 4; x < S; x += 8) {
        if (r() > 0.45) c.rect(x, y, 2, 2, [178, 140, 84]);
      }
    }
    c.rect(0, 0, S, 2, [170, 132, 78]).rect(0, S - 2, S, 2, [170, 132, 78]);
    return c.noise(r, 0.1);
  },
  ice() {
    const c = canvas().fill([143, 208, 232]);
    for (let i = 0; i < 7; i++) {
      const x = Math.floor(rng(i * 13 + 5)() * S);
      for (let t = 0; t < S; t++) c.set((x + t) % S, t, [186, 232, 248]);
    }
    return c.noise(rng(31), 0.05, false);
  },
  ground() {
    const c = canvas().fill([61, 90, 61]);
    c.rect(0, 0, S, 9, [74, 106, 66]);
    const r = rng(41);
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(r() * S);
      c.rect(x, 10 + Math.floor(r() * (S - 12)), 2, 2, [48, 72, 48]);
    }
    for (let i = 0; i < 26; i++) {
      const x = Math.floor(r() * S);
      c.set(x, 6 + Math.floor(r() * 4), [96, 132, 78]);
    }
    return c;
  },
  wall() {
    const c = canvas().fill([74, 74, 90]);
    for (let y = 0; y < S; y += 16) {
      c.hline(y, [58, 58, 72], 0, S);
      const offset = (y / 16) % 2 === 0 ? 0 : 16;
      for (let x = offset; x < S; x += 32) c.vline(x, [58, 58, 72], y, y + 16);
    }
    return c.noise(rng(53), 0.08);
  },
};

mkdirSync(OUT, { recursive: true });
for (const [name, draw] of Object.entries(textures)) {
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, encodePng(S, S, draw().buf));
  console.log('生成', file);
}
