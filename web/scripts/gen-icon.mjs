/**
 * 用 node:zlib 手写 PNG 编码，生成 PWA 图标：
 *   public/apple-touch-icon.png (180x180)
 *   public/icon-512.png         (512x512)
 * 画面：电光青 → 紫 对角渐变背景 + 白色 ⚡ 闪电多边形（3x3 超采样抗锯齿）。
 * 无任何依赖：PNG = 签名 + IHDR + IDAT(zlib deflate) + IEND，CRC32 手写查表。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG 编码 ----------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // 每行前加 filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 渲染 ----------
// 闪电多边形（feather "zap" 形状，24x24 视框坐标）
const BOLT_24 = [
  [13, 2],
  [3, 14],
  [12, 14],
  [11, 22],
  [21, 10],
  [12, 10],
];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 渐变端点色：电光青 #22d3ee → 紫 #a855f7
const C1 = [0x22, 0xd3, 0xee];
const C2 = [0xa8, 0x55, 0xf7];

function renderIcon(size) {
  // 闪电缩放：占画面约 72%，居中
  const scale = (size * 0.72) / 24;
  const offset = (size - 24 * scale) / 2;
  const bolt = BOLT_24.map(([x, y]) => [offset + x * scale, offset + y * scale]);

  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // 3x3 超采样
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 对角渐变
      const t = (x + y) / (2 * (size - 1));
      let r = C1[0] + (C2[0] - C1[0]) * t;
      let g = C1[1] + (C2[1] - C1[1]) * t;
      let b = C1[2] + (C2[2] - C1[2]) * t;
      // 闪电覆盖率（抗锯齿）
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (pointInPolygon(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, bolt)) cover++;
        }
      }
      const a = cover / (SS * SS);
      r = r * (1 - a) + 255 * a;
      g = g * (1 - a) + 255 * a;
      b = b * (1 - a) + 255 * a;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

mkdirSync(PUBLIC_DIR, { recursive: true });
writeFileSync(join(PUBLIC_DIR, 'apple-touch-icon.png'), renderIcon(180));
writeFileSync(join(PUBLIC_DIR, 'icon-512.png'), renderIcon(512));
console.log('生成完成: public/apple-touch-icon.png (180x180), public/icon-512.png (512x512)');
