// Benchmark: 24MP photos. Measures time to first visible thumbnails and preview open latency.
// Usage: npm run build && node e2e/bench.cjs [count]
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..', 'out');
const N = Number(process.argv[2] || 24);
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
(async () => {
  await new Promise((r) => server.listen(4174, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://localhost:4174/');
  const info = await page.evaluate(async (N) => {
    const root = await navigator.storage.getDirectory();
    for await (const n of root.keys()) await root.removeEntry(n, { recursive: true });
    const dir = await root.getDirectoryHandle('BENCH', { create: true });
    // One big 24MP JPEG + a 160x120 EXIF thumbnail, reused for all files (camera-like layout).
    const draw = async (w, h) => {
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, w, h); grd.addColorStop(0, '#345'); grd.addColorStop(1, '#c84'); g.fillStyle = grd; g.fillRect(0, 0, w, h);
      // sensor-like noise so the JPEG is camera-sized (~8-12 MB), tiled from a 1000x1000 block
      const bw = Math.min(w, 1000), bh = Math.min(h, 1000), id = g.getImageData(0, 0, bw, bh);
      for (let i = 0; i < id.data.length; i += 4) { const n = (Math.random() - 0.5) * 70; id.data[i] += n; id.data[i + 1] += n * 0.8; id.data[i + 2] += Math.random() * 40 - 20; }
      for (let y = 0; y < h; y += bh) for (let x = 0; x < w; x += bw) g.putImageData(id, x, y);
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer());
    };
    const big = await draw(6000, 4000), thumb = await draw(160, 120);
    // Build APP1 Exif: IFD0 (Orientation=1) -> IFD1 (JPEGInterchangeFormat/Length) + thumbnail bytes.
    const tiff = [];
    const u16 = (v) => tiff.push((v >> 8) & 255, v & 255), u32 = (v) => { u16(v >>> 16); u16(v & 0xffff); };
    tiff.push(0x4d, 0x4d); u16(42); u32(8);
    u16(1); u16(0x0112); u16(3); u32(1); u16(1); u16(0); u32(26);       // IFD0 @8 → next IFD1 @26
    u16(2); u16(0x0201); u16(4); u32(1); u32(56); u16(0x0202); u16(4); u32(1); u32(thumb.length); u32(0); // IFD1 @26, 30 bytes → 56
    const exif = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, ...thumb]);
    const app1 = new Uint8Array([0xff, 0xe1, ((exif.length + 2) >> 8) & 255, (exif.length + 2) & 255, ...exif]);
    const file = new Uint8Array(2 + app1.length + big.length - 2);
    file.set([0xff, 0xd8]); file.set(app1, 2); file.set(big.subarray(2), 2 + app1.length);
    for (let i = 0; i < N; i++) { const h = await dir.getFileHandle(`IMG_${String(i).padStart(4, '0')}.JPG`, { create: true }); const w = await h.createWritable(); await w.write(file); await w.close(); }
    window.showDirectoryPicker = async () => dir;
    return { mb: (file.length / 1e6).toFixed(1) };
  }, N);
  console.log(`${N} files × ${info.mb} MB (6000×4000)`);
  await page.click('text=Select Folder');
  await page.waitForSelector('text=Start Culling', { timeout: 60000 });
  const t0 = Date.now();
  await page.click('text=Start Culling');
  await page.waitForFunction(() => { const imgs = [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth); return imgs.length >= 1; }, null, { timeout: 120000, polling: 20 });
  const tFirst = Date.now() - t0;
  const visible = await page.evaluate(() => document.querySelectorAll('.h-full.overflow-y-auto button').length);
  await page.waitForFunction((v) => [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth).length >= v, visible, { timeout: 120000, polling: 20 });
  const tAll = Date.now() - t0;
  console.log(`thumbnails: first ${tFirst} ms, all ${visible} visible ${tAll} ms`);
  const times = [];
  await page.keyboard.press(' ');
  for (let i = 0; i < 6; i++) {
    const s = Date.now();
    await page.waitForFunction(() => { const im = document.querySelector('.fixed img'); return im && im.complete && im.naturalWidth >= 6000; }, null, { timeout: 60000, polling: 10 });
    times.push(Date.now() - s);
    await page.waitForTimeout(700); // user looks at the photo
    await page.keyboard.press('ArrowRight');
  }
  console.log(`full-res preview latency per photo (ms): ${times.join(', ')}`);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
