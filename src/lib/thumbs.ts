import { PhotoFile } from './types';
import { parseJpegExif, parseTiff } from './exif';

/**
 * Thumbnail & preview pipeline, tuned for slow SD cards:
 *  - FAST PATH: read only the first 128 KB of a JPEG and use the camera's EXIF
 *    thumbnail (no 24MP decode, ~100x less I/O). RAW files: scan the start of the
 *    file in growing windows for the embedded JPEG instead of reading 40 MB.
 *  - SLOW PATH (no embedded thumb): decode the full image, resized.
 *  - concurrency-limited LIFO queue, cancellable; LRU of object URLs (revoked on evict)
 *  - previews: small LRU + prefetch of neighbours so ←/→ is instant.
 */
const CONCURRENCY = 4;
const CACHE_MAX = 600;
export const THUMB_SIZE = 320;
const HEAD_BYTES = 128 * 1024;
const MIN_EXIF_THUMB = 2 * 1024; // smaller is likely junk

type Job = { key: string; file: PhotoFile; resolve: (u: string | null) => void; cancelled: boolean };

const cache = new Map<string, string>(); // insertion order = LRU
const pending = new Map<string, Promise<string | null>>();
const queue: Job[] = [];
let active = 0;

function lruPut(map: Map<string, string>, max: number, key: string, url: string) {
  map.delete(key);
  map.set(key, url);
  while (map.size > max) {
    const [k, u] = map.entries().next().value as [string, string];
    map.delete(k);
    URL.revokeObjectURL(u);
  }
}

export function clearThumbCache() {
  for (const u of cache.values()) URL.revokeObjectURL(u);
  cache.clear();
  for (const j of queue) { j.cancelled = true; j.resolve(null); }
  queue.length = 0;
  pending.clear();
  clearPreviewCache();
}

// ---------------------------------------------------------------- RAW embedded JPEG

/**
 * Find the largest embedded JPEG inside a RAW file. Scans growing windows from the
 * start of the file and stops as soon as a JPEG of at least `minBytes` is found,
 * so thumbnails usually need only the first few hundred KB.
 */
export async function extractEmbeddedJpeg(blob: Blob, minBytes = 10 * 1024): Promise<Blob | null> {
  const windows = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024, 40 * 1024 * 1024];
  let best: [number, number] | null = null;
  let buf: Uint8Array | null = null;
  for (const w of windows) {
    const limit = Math.min(blob.size, w);
    buf = new Uint8Array(await blob.slice(0, limit).arrayBuffer());
    best = findLargestJpeg(buf);
    if ((best && best[1] - best[0] >= minBytes) || limit === blob.size) break;
  }
  if (!best || !buf || best[1] - best[0] < Math.min(minBytes, 4 * 1024)) return null;
  return new Blob([buf.slice(best[0], best[1])], { type: 'image/jpeg' });
}

function findLargestJpeg(buf: Uint8Array): [number, number] | null {
  let best: [number, number] | null = null;
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] !== 0xff || buf[i + 1] !== 0xd8 || buf[i + 2] !== 0xff) continue;
    const end = findJpegEnd(buf, i);
    if (end > 0) {
      if (!best || end - i > best[1] - best[0]) best = [i, end];
      i = end - 1;
    }
  }
  return best;
}

function findJpegEnd(b: Uint8Array, start: number): number {
  let p = start + 2;
  while (p + 2 <= b.length) {
    if (b[p] !== 0xff) return -1;
    const m = b[p + 1];
    if (m === 0xd9) return p + 2;
    if (p + 4 > b.length) return -1;
    if (m === 0xff) { p++; continue; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return -1;
    p += 2 + len;
    if (m === 0xda) {
      // entropy-coded data until a non-RST, non-stuffed marker
      while (p + 1 < b.length) {
        if (b[p] === 0xff && b[p + 1] !== 0x00 && !(b[p + 1] >= 0xd0 && b[p + 1] <= 0xd7)) break;
        p++;
      }
    }
  }
  return -1;
}

/** Orientation stored in a TIFF-based RAW header (CR2/NEF/ARW/DNG). 1 if unknown. */
async function rawOrientation(f: Blob): Promise<number> {
  const head = new Uint8Array(await f.slice(0, 64 * 1024).arrayBuffer());
  return parseTiff(head, 0)?.orientation ?? 1;
}

// ---------------------------------------------------------------- orientation / resize

/** Draw `blob` resized to fit `max` px and rotated by EXIF `orientation`. */
async function renderOriented(blob: Blob, orientation: number, max: number, quality = 0.85): Promise<Blob> {
  const manual = orientation > 1;
  const bmp = await createImageBitmap(blob, (manual ? { imageOrientation: 'none' } : {}) as ImageBitmapOptions);
  try {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const swap = orientation >= 5;
    const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
    const g = canvas.getContext('2d')!;
    // EXIF orientation transforms
    switch (orientation) {
      case 2: g.transform(-1, 0, 0, 1, w, 0); break;
      case 3: g.transform(-1, 0, 0, -1, w, h); break;
      case 4: g.transform(1, 0, 0, -1, 0, h); break;
      case 5: g.transform(0, 1, 1, 0, 0, 0); break;
      case 6: g.transform(0, 1, -1, 0, h, 0); break;
      case 7: g.transform(0, -1, -1, 0, h, w); break;
      case 8: g.transform(0, -1, 1, 0, 0, w); break;
    }
    g.drawImage(bmp, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } finally {
    bmp.close();
  }
}

// ---------------------------------------------------------------- thumbnails

/** Fast path: EXIF thumbnail of a JPEG, reading only the file header. */
export async function exifThumbnail(f: Blob): Promise<{ blob: Blob; orientation: number } | null> {
  const head = new Uint8Array(await f.slice(0, HEAD_BYTES).arrayBuffer());
  const info = parseJpegExif(head);
  const t = info?.thumb;
  if (!info || !t || t.length < MIN_EXIF_THUMB || t.offset + t.length > f.size) return null;
  const bytes = t.offset + t.length <= head.length
    ? head.subarray(t.offset, t.offset + t.length)
    : new Uint8Array(await f.slice(t.offset, t.offset + t.length).arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return { blob: new Blob([bytes.slice()], { type: 'image/jpeg' }), orientation: info.orientation };
}

async function makeThumb(file: PhotoFile): Promise<string | null> {
  const f = await file.handle.getFile();
  let out: Blob | null = null;
  if (file.kind === 'jpeg') {
    const t = await exifThumbnail(f).catch(() => null);
    if (t) out = t.orientation === 1 ? t.blob : await renderOriented(t.blob, t.orientation, THUMB_SIZE);
  } else if (file.kind === 'raw') {
    const emb = await extractEmbeddedJpeg(f, 10 * 1024);
    if (!emb) return null;
    out = await renderOriented(emb, await rawOrientation(f), THUMB_SIZE);
  }
  if (!out) {
    // Slow path: full decode, resized (createImageBitmap applies EXIF orientation itself).
    const bmp = await createImageBitmap(f, { resizeWidth: THUMB_SIZE, resizeQuality: 'medium' } as ImageBitmapOptions)
      .catch(() => createImageBitmap(f));
    try {
      const scale = Math.min(1, THUMB_SIZE / Math.max(bmp.width, bmp.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    } finally {
      bmp.close();
    }
  }
  return URL.createObjectURL(out);
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.pop()!; // LIFO: newest request first
    if (job.cancelled) continue;
    active++;
    makeThumb(job.file)
      .catch((e) => { console.warn('thumb failed', job.file.name, e); return null; })
      .then((url) => {
        if (url) lruPut(cache, CACHE_MAX, job.key, url);
        job.resolve(url);
      })
      .finally(() => {
        active--;
        pending.delete(job.key);
        pump();
      });
  }
}

export function getCachedThumb(key: string): string | undefined {
  const u = cache.get(key);
  if (u) lruPut(cache, CACHE_MAX, key, u);
  return u;
}

/** Request a thumbnail. Returns [promise, cancel]. */
export function requestThumb(key: string, file: PhotoFile): [Promise<string | null>, () => void] {
  const hit = getCachedThumb(key);
  if (hit) return [Promise.resolve(hit), () => {}];
  const existing = pending.get(key);
  if (existing) return [existing, () => {}];
  let job!: Job;
  const p = new Promise<string | null>((resolve) => {
    job = { key, file, resolve, cancelled: false };
  });
  queue.push(job);
  pending.set(key, p);
  pump();
  return [p, () => {
    if (!job.cancelled && queue.includes(job)) {
      job.cancelled = true;
      queue.splice(queue.indexOf(job), 1);
      pending.delete(key);
      job.resolve(null);
    }
  }];
}

// ---------------------------------------------------------------- full previews

const PREVIEW_MAX = 4; // current + neighbours; each is one full image in memory
const previewCache = new Map<string, string>();
const previewPending = new Map<string, Promise<string | null>>();

function clearPreviewCache() {
  for (const u of previewCache.values()) URL.revokeObjectURL(u);
  previewCache.clear();
  previewPending.clear();
}

/** Displayable full-size blob (JPEG/PNG as-is, RAW → embedded preview, rotated). */
export async function displayableBlob(file: PhotoFile): Promise<Blob | null> {
  const f = await file.handle.getFile();
  if (file.kind !== 'raw') return f;
  const emb = await extractEmbeddedJpeg(f, 300 * 1024);
  if (!emb) return null;
  const o = await rawOrientation(f);
  return o === 1 ? emb : renderOriented(emb, o, 8192, 0.92);
}

/**
 * Full-size preview URL, read (and decode started) ahead of time. Cached (LRU of 4), so
 * revisiting or prefetched neighbours show instantly. The URL stays valid while it
 * is in the cache; callers must not revoke it.
 */
export function getPreviewUrl(file: PhotoFile): Promise<string | null> {
  const key = file.name;
  const hit = previewCache.get(key);
  if (hit) { lruPut(previewCache, PREVIEW_MAX, key, hit); return Promise.resolve(hit); }
  const p0 = previewPending.get(key);
  if (p0) return p0;
  const p = (async () => {
    const blob = await displayableBlob(file);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    // Start decoding now (not awaited): prefetched neighbours are decoded before the
    // user gets there, while the current photo is shown without extra waiting.
    const img = new Image();
    img.src = url;
    img.decode().catch(() => { /* <img> will still try */ });
    lruPut(previewCache, PREVIEW_MAX, key, url);
    return url;
  })().finally(() => previewPending.delete(key));
  previewPending.set(key, p);
  return p;
}

/** Warm the preview cache for neighbouring photos (fire and forget). */
export function prefetchPreviews(files: PhotoFile[]) {
  for (const f of files.slice(0, PREVIEW_MAX - 1)) getPreviewUrl(f).catch(() => null);
}
