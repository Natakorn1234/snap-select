import { PhotoFile } from './types';

/**
 * Thumbnail pipeline:
 *  - concurrency-limited queue (UI never blocks; at most N decodes at once)
 *  - LIFO ordering so the tiles the user is looking at right now load first
 *  - cancellable (tiles scrolled out of view drop their request)
 *  - LRU cache of object URLs; evicted URLs are revoked to avoid leaks
 */
const CONCURRENCY = 4;
const CACHE_MAX = 600;
export const THUMB_SIZE = 320;

type Job = { key: string; file: PhotoFile; resolve: (u: string | null) => void; cancelled: boolean };

const cache = new Map<string, string>(); // insertion order = LRU
const pending = new Map<string, Promise<string | null>>();
const queue: Job[] = [];
let active = 0;

function touch(key: string, url: string) {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > CACHE_MAX) {
    const [k, u] = cache.entries().next().value as [string, string];
    cache.delete(k);
    URL.revokeObjectURL(u);
  }
}

export function clearThumbCache() {
  for (const u of cache.values()) URL.revokeObjectURL(u);
  cache.clear();
  for (const j of queue) { j.cancelled = true; j.resolve(null); }
  queue.length = 0;
  pending.clear();
}

/** Find the largest embedded JPEG (preview) inside a RAW file. Works for CR2/CR3/NEF/ARW/RAF/DNG in practice. */
export async function extractEmbeddedJpeg(blob: Blob): Promise<Blob | null> {
  // Previews sit near the start; limit scan to keep memory bounded.
  const limit = Math.min(blob.size, 40 * 1024 * 1024);
  const buf = new Uint8Array(await blob.slice(0, limit).arrayBuffer());
  let best: [number, number] | null = null;
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] !== 0xff || buf[i + 1] !== 0xd8 || buf[i + 2] !== 0xff) continue;
    // Walk JPEG markers to find the real end (EOI after SOS scan data).
    const end = findJpegEnd(buf, i);
    if (end > 0) {
      if (!best || end - i > best[1] - best[0]) best = [i, end];
      i = end - 1;
    }
  }
  if (!best || best[1] - best[0] < 10 * 1024) return null; // ignore tiny thumbnails
  return new Blob([buf.slice(best[0], best[1])], { type: 'image/jpeg' });
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

/** Returns a displayable blob for a file (JPEG/PNG as-is, RAW → embedded preview). */
export async function displayableBlob(file: PhotoFile): Promise<Blob | null> {
  const f = await file.handle.getFile();
  if (file.kind !== 'raw') return f;
  return extractEmbeddedJpeg(f);
}

async function makeThumb(file: PhotoFile): Promise<string | null> {
  const blob = await displayableBlob(file);
  if (!blob) return null;
  const bmp = await createImageBitmap(blob, { resizeWidth: THUMB_SIZE, resizeQuality: 'medium' } as ImageBitmapOptions)
    .catch(() => createImageBitmap(blob));
  try {
    const scale = Math.min(1, THUMB_SIZE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return URL.createObjectURL(out);
  } finally {
    bmp.close();
  }
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.pop()!; // LIFO: newest request first
    if (job.cancelled) continue;
    active++;
    makeThumb(job.file)
      .catch((e) => { console.warn('thumb failed', job.file.name, e); return null; })
      .then((url) => {
        if (url) touch(job.key, url);
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
  if (u) touch(key, u);
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
