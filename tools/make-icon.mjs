#!/usr/bin/env node
// Generates the application icon with zero dependencies.
//   node tools/make-icon.mjs
// Outputs assets/icon.png (256), build/icon.png (512) and build/icon.ico.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4; // supersampling factor for smooth edges

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function ico(pngBuf) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([head, entry, pngBuf]);
}

/** Draw the mark: a rounded dark slate tile with two list panes and an accent chevron. */
function draw(size) {
  const w = size * SS, h = size * SS;
  const px = Buffer.alloc(w * h * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const mix = (x, y, r, g, b, alpha) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    const a = alpha;
    px[i] = Math.round(px[i] * (1 - a) + r * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + g * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + b * a);
    px[i + 3] = Math.max(px[i + 3], Math.round(255 * a));
  };
  const u = w / 100; // design units: 0..100

  // rounded tile
  const r = 22 * u, pad = 3 * u;
  const inside = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
    const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad || (x >= x0 + rad && x <= x1 - rad) || (y >= y0 + rad && y <= y1 - rad);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y, pad, pad, w - pad, h - pad, r)) continue;
      const t = y / h;
      // vertical gradient: deep slate -> slightly lighter
      set(x, y, Math.round(18 + 10 * t), Math.round(22 + 12 * t), Math.round(30 + 16 * t), 255);
    }
  }
  // accent rim
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y, pad, pad, w - pad, h - pad, r)) continue;
      const edge = !inside(x, y, pad + 1.4 * u, pad + 1.4 * u, w - pad - 1.4 * u, h - pad - 1.4 * u, r - 1.4 * u);
      if (edge) mix(x, y, 76, 194, 255, 0.55);
    }
  }
  // two panes
  const pane = (x0, y0, x1, y1, alpha) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (inside(x, y, x0, y0, x1, y1, 3 * u)) mix(x, y, 231, 235, 240, alpha);
    }
  };
  pane(15 * u, 18 * u, 45 * u, 82 * u, 0.92);
  pane(52 * u, 18 * u, 85 * u, 82 * u, 0.35);
  // pane content lines (dark)
  const line = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mix(x, y, 24, 29, 38, 0.85);
  };
  for (let i = 0; i < 4; i++) line(19 * u, (26 + i * 12) * u, 41 * u, (29 + i * 12) * u);
  // accent chevron in the right pane
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - 62 * u) / u, dy = (y - 50 * u) / u;
      const t = (dx - Math.abs(dy) * 0.55);
      if (t > 0 && t < 9 && Math.abs(dy) < 15) mix(x, y, 126, 224, 163, 0.95);
    }
  }
  // downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * w + (x * SS + sx)) * 4;
        const a = px[i + 3] / 255;
        rr += px[i] * a; gg += px[i + 1] * a; bb += px[i + 2] * a; aa += a;
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      out[i] = aa ? Math.round(rr / aa) : 0;
      out[i + 1] = aa ? Math.round(gg / aa) : 0;
      out[i + 2] = aa ? Math.round(bb / aa) : 0;
      out[i + 3] = Math.round((aa / n) * 255);
    }
  }
  return png(size, size, out);
}

fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
const icon256 = draw(256);
const icon512 = draw(512);
fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), icon256);
fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), icon512);
fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(icon256));
console.log('icons written: assets/icon.png, build/icon.png, build/icon.ico');
