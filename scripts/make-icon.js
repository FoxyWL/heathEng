'use strict';
// Рисует логотип Hearth в Chrome и собирает build/hearth.ico (BMP-кадры 16–256 px, понятные и NSIS, и Windows).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='#12262a'/><path d='M16 5c1 4 6 6.5 6 12a6 6 0 0 1-12 0c0-2.6 1.2-4 2.4-5.4.3 1.6 1.2 2.6 2.1 3C14 11 14.6 8 16 5z' fill='#f0a030'/></svg>`;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  const frames = await page.evaluate(
    async ({ svg, sizes }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
      await img.decode();
      return sizes.map((s) => {
        const c = document.createElement('canvas');
        c.width = c.height = s;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, s, s);
        return Array.from(ctx.getImageData(0, 0, s, s).data);
      });
    },
    { svg: SVG, sizes: SIZES }
  );
  await b.close();

  const entries = [];
  frames.forEach((rgba, i) => {
    const s = SIZES[i];
    const maskRow = Math.ceil(s / 32) * 4;
    const hdr = Buffer.alloc(40);
    hdr.writeUInt32LE(40, 0);
    hdr.writeInt32LE(s, 4);
    hdr.writeInt32LE(s * 2, 8);
    hdr.writeUInt16LE(1, 12);
    hdr.writeUInt16LE(32, 14);
    hdr.writeUInt32LE(s * s * 4 + maskRow * s, 20);
    const px = Buffer.alloc(s * s * 4);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const src = ((s - 1 - y) * s + x) * 4;
        const dst = (y * s + x) * 4;
        px[dst] = rgba[src + 2];
        px[dst + 1] = rgba[src + 1];
        px[dst + 2] = rgba[src];
        px[dst + 3] = rgba[src + 3];
      }
    entries.push({ s, data: Buffer.concat([hdr, px, Buffer.alloc(maskRow * s)]) });
  });
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let off = head.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    head[o] = e.s === 256 ? 0 : e.s;
    head[o + 1] = e.s === 256 ? 0 : e.s;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(e.data.length, o + 8);
    head.writeUInt32LE(off, o + 12);
    off += e.data.length;
  });
  const out = path.join(__dirname, '..', 'build', 'hearth.ico');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([head, ...entries.map((e) => e.data)]));
  console.log('icon:', out, fs.statSync(out).size, 'bytes');
})();
