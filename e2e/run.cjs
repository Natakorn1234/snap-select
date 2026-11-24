// End-to-end test: real Chromium, real File System Access handles (OPFS stands in for the SD card).
// Usage: npm run build && node e2e/run.cjs
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..', 'out');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('  ✓', m); };

(async () => {
  await new Promise((r) => server.listen(4173, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => m.type() !== 'log' && console.log('CONSOLE', m.text()));
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto('http://localhost:4173/');
  // Create a fake card in OPFS and make showDirectoryPicker return it.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const n of root.keys()) await root.removeEntry(n, { recursive: true });
    const dir = await root.getDirectoryHandle('DCIM_100', { create: true });
    const jpeg = async (color) => {
      const c = new OffscreenCanvas(600, 400); const g = c.getContext('2d');
      g.fillStyle = color; g.fillRect(0, 0, 600, 400);
      for (let i = 0; i < 2000; i++) { g.fillStyle = `hsl(${i % 360},50%,50%)`; g.fillRect(Math.random() * 600, Math.random() * 400, 4, 4); }
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    };
    const write = async (name, data) => { const h = await dir.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(data); await w.close(); };
    await write('IMG_0001.JPG', await jpeg('red'));
    await write('IMG_0001.CR3', new Uint8Array([...new Uint8Array(4096), ...(await jpeg('red'))]));
    await write('IMG_0002.JPG', await jpeg('green'));
    await write('IMG_0003.JPG', await jpeg('blue'));
    await write('IMG_0004.NEF', new Uint8Array([...new Uint8Array(2048), ...(await jpeg('yellow'))]));
    await write('IMG_0004.JPG', await jpeg('yellow'));
    await write('IMG_0005.ARW', new Uint8Array([...new Uint8Array(1024), ...(await jpeg('purple'))]));
    await write('readme.txt', new TextEncoder().encode('not a photo'));
    window.showDirectoryPicker = async () => dir;
  });

  console.log('Import');
  await page.click('text=Select Folder');
  await page.waitForSelector('text=Start Culling');
  const homeText = await page.textContent('main');
  assert(homeText.includes('DCIM_100'), 'folder name shown');
  assert(/Photos \(shots\)5/.test(homeText), '5 shots (pairs grouped)');
  assert(/Files7/.test(homeText.replace(/\s/g, '')), '7 supported files (txt ignored)');
  await page.click('text=Start Culling');
  await page.waitForFunction(() => [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 0).length === 5, null, { timeout: 15000 });
  assert(true, 'thumbnails rendered for JPEG and RAW-only (embedded preview)');
  await page.screenshot({ path: path.join(__dirname, 'workspace.png') });

  console.log('Culling + undo');
  await page.keyboard.press('x');            // 0001 REJECT (pair)
  await page.keyboard.press('1');            // 0002 KEEP
  await page.keyboard.press('2');            // 0003 MAYBE
  await page.keyboard.press('x');            // 0004 REJECT
  await page.keyboard.press('x');            // 0005 REJECT
  await page.keyboard.press('Control+z');    // undo 0005 -> unrated
  let header = await page.textContent('header');
  assert(header.includes('Progress: 4/5'), 'progress counter 4/5 after undo');
  assert(header.includes('Reject 2') && header.includes('Keep 1') && header.includes('Maybe 1'), 'filter counts');
  await page.keyboard.press(' ');
  await page.waitForSelector('.fixed img');
  assert(true, 'space opens full preview');
  await page.keyboard.press('Escape');
  assert((await page.$('.fixed img')) === null, 'escape closes preview');

  console.log('Session persistence');
  await page.waitForTimeout(800);
  await page.reload();
  await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); const d = await r.getDirectoryHandle('DCIM_100'); window.showDirectoryPicker = async () => d; });
  await page.click('text=Select Folder');
  await page.waitForSelector('text=Restore & Continue');
  await page.click('text=Restore & Continue');
  header = await page.textContent('header');
  assert(header.includes('Progress: 4/5') && header.includes('Reject 2'), 'statuses restored after reload');

  console.log('Delete');
  await page.click('text=Finish →');
  const summary = await page.textContent('main');
  for (const n of ['IMG_0001.JPG', 'IMG_0001.CR3', 'IMG_0004.JPG', 'IMG_0004.NEF']) assert(summary.includes(n), `${n} listed for deletion`);
  assert(!summary.includes('IMG_0002.JPG') && !summary.includes('IMG_0003.JPG'), 'keep/maybe not listed');
  await page.click('text=Finish & Delete Rejected');
  assert(await page.isDisabled('text=Delete permanently'), 'delete disabled until acknowledged');
  await page.check('input[type=checkbox]');
  await page.click('text=Delete permanently');
  await page.waitForSelector('text=Deletion complete');
  assert((await page.textContent('main')).includes('Deleted and verified: 4'), 'report says 4 deleted');
  const left = await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); const d = await r.getDirectoryHandle('DCIM_100'); const a = []; for await (const k of d.keys()) a.push(k); return a.sort(); });
  assert(JSON.stringify(left) === JSON.stringify(['IMG_0002.JPG', 'IMG_0003.JPG', 'IMG_0005.ARW', 'readme.txt']), 'on disk: only rejected files removed → ' + left.join(', '));

  console.log('Folder removed during use');
  await page.click('text=Back to culling');
  await page.keyboard.press('x');
  await page.click('text=Finish →');
  await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); await r.removeEntry('DCIM_100', { recursive: true }); });
  await page.click('text=Finish & Delete Rejected');
  await page.check('input[type=checkbox]');
  await page.click('text=Delete permanently');
  await page.waitForSelector('text=Deletion stopped');
  assert((await page.textContent('main')).includes('Deleted and verified: 0'), 'card removed → stopped, nothing reported as deleted');

  await browser.close();
  server.close();
  console.log('\nE2E PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
