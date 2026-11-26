import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(__dirname, '..', 'extension', 'icons');

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaPng(width, height, rgba) {
  const rawScanlines = Buffer.allocUnsafe(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawScanlines[rowStart] = 0; // Filter type 0 (None)
    const srcOffset = y * width * 4;
    rgba.copy(rawScanlines, rowStart + 1, srcOffset, srcOffset + width * 4);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(rawScanlines, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function roundedBoxSdf(nx, ny, halfSize, radius) {
  const qx = Math.abs(nx) - (halfSize - radius);
  const qy = Math.abs(ny) - (halfSize - radius);
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - radius;
}

function samplePoint(nx, ny) {
  // Normalized coordinates nx, ny in [-1, 1] — Full-Bleed Enlarged Viewfinder Tally Icon
  const bgDist = roundedBoxSdf(nx, ny, 0.8869, 0.24);
  const fullDist = roundedBoxSdf(nx, ny, 0.96, 0.24);
  if (fullDist > 0) {
    return [0, 0, 0, 0];
  }

  // Crisp white porcelain surface (#ffffff) with bold contrast border
  const t = (nx + ny + 2) / 4;
  let r = Math.round(255 - t * 4);
  let g = Math.round(255 - t * 3);
  let b = Math.round(255 - t * 1);

  if (fullDist > -0.08 && bgDist > -0.16) {
    r = 168;
    g = 184;
    b = 204;
  }

  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const distCenter = Math.max(ax, ay);

  // Bold enlarged corner viewfinder brackets in Prussian blue (#2563eb)
  const ringDist = Math.abs(distCenter - 0.5017);
  const outerBracket = Math.abs(distCenter - 0.62);
  const angle = Math.atan2(ny, nx);
  const onDiagonalArm = ax >= 0.28 && ay >= 0.28 && Math.abs(Math.sin(angle - 0.6589)) <= 1.0;
  if (onDiagonalArm && (outerBracket < 0.095 || ringDist < 0.03)) {
    r = 37;
    g = 99;
    b = 235;
  }

  // Enlarged center solid tally core (#2563eb)
  const coreDist = roundedBoxSdf(nx, ny, 0.27, 0.08);
  if (distCenter < 0.2335) {
    const coreMix = Math.min(1, (0.2335 - distCenter) / 0.06);
    if (coreDist <= 0) {
      r = Math.round(r * (1 - coreMix) + 37 * coreMix);
      g = Math.round(g * (1 - coreMix) + 99 * coreMix);
      b = Math.round(b * (1 - coreMix) + 235 * coreMix);
    }
  } else if (coreDist <= 0) {
    r = 37;
    g = 99;
    b = 235;
  }

  return [r, g, b, 255];
}

function renderSupersampledIcon(size) {
  const buf = Buffer.allocUnsafe(size * size * 4);
  const samples = 4; // 4x4 MSAA
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const nx = (((x + (sx + 0.5) / samples) / size) * 2) - 1;
          const ny = (((y + (sy + 0.5) / samples) / size) * 2) - 1;
          const [r, g, b, a] = samplePoint(nx, ny);
          sr += r * (a / 255);
          sg += g * (a / 255);
          sb += b * (a / 255);
          sa += a;
        }
      }
      const totalSamples = samples * samples;
      const outA = Math.round(sa / totalSamples);
      const idx = (y * size + x) * 4;
      if (outA === 0) {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      } else {
        const alphaNorm = sa / 255;
        buf[idx] = Math.min(255, Math.round(sr / alphaNorm));
        buf[idx + 1] = Math.min(255, Math.round(sg / alphaNorm));
        buf[idx + 2] = Math.min(255, Math.round(sb / alphaNorm));
        buf[idx + 3] = outA;
      }
    }
  }
  return encodeRgbaPng(size, size, buf);
}

fs.mkdirSync(ICONS_DIR, { recursive: true });
for (const sz of [16, 24, 32, 48, 128]) {
  const png = renderSupersampledIcon(sz);
  const out = path.join(ICONS_DIR, `icon${sz}.png`);
  fs.writeFileSync(out, png);
}
process.stdout.write(`[icons] Generated 16/24/32/48/128px PNG icons in ${ICONS_DIR}\n`);
