import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { groupFiles, isSupported, scanDirectory } from '@/lib/files';
import { cullReducer, CullState } from '@/lib/cull';
import { buildDeletePlan, executeDeletion } from '@/lib/deletion';
import { buildRecord, findMatchingSession, restoreStatuses, saveSession } from '@/lib/db';
import { extractEmbeddedJpeg } from '@/lib/thumbs';
import { MockDir, MockFile } from './mockFs';
import { PhotoGroup, StatusMap } from '@/lib/types';

const NAMES = ['IMG_1001.CR3', 'IMG_1001.JPG', 'IMG_1002.JPG', 'IMG_1003.NEF', 'IMG_1004.jpeg', 'IMG_1004.ARW', 'notes.txt', '._IMG_1001.JPG', 'shot.png', 'DSC_9.dng', 'x.raf', 'y.cr2'];

async function setup(names = NAMES) {
  const dir = new MockDir('100CANON', names.map((n, i) => new MockFile(n, 1000 + i)));
  const files = await scanDirectory(dir as unknown as FileSystemDirectoryHandle);
  return { dir, files, groups: groupFiles(files) };
}

describe('import & pairing', () => {
  it('filters supported extensions only', () => {
    expect(isSupported('a.JPG')).toBe(true);
    expect(isSupported('a.cr3')).toBe(true);
    expect(isSupported('a.txt')).toBe(false);
    expect(isSupported('._a.jpg')).toBe(false);
  });
  it('pairs RAW+JPEG by base name and prefers JPEG for preview', async () => {
    const { files, groups } = await setup();
    expect(files).toHaveLength(10);
    const g1 = groups.find((g) => g.id === 'img_1001')!;
    expect(g1.files.map((f) => f.name).sort()).toEqual(['IMG_1001.CR3', 'IMG_1001.JPG']);
    expect(g1.preview.name).toBe('IMG_1001.JPG');
    const g4 = groups.find((g) => g.id === 'img_1004')!;
    expect(g4.preview.name).toBe('IMG_1004.jpeg');
    expect(groups.find((g) => g.id === 'img_1003')!.files).toHaveLength(1); // RAW only
    expect(groups.find((g) => g.id === 'img_1002')!.files).toHaveLength(1); // JPEG only
    expect(groups).toHaveLength(8);
  });
});

describe('culling & undo', () => {
  it('sets status and undoes in order', () => {
    let s: CullState = { statuses: {}, undo: [] };
    s = cullReducer(s, { type: 'set', ids: ['a'], status: 'KEEP' });
    s = cullReducer(s, { type: 'set', ids: ['a'], status: 'REJECT' });
    s = cullReducer(s, { type: 'set', ids: ['b'], status: 'MAYBE' });
    expect(s.statuses).toEqual({ a: 'REJECT', b: 'MAYBE' });
    s = cullReducer(s, { type: 'undo' });
    expect(s.statuses.b).toBe('UNRATED');
    s = cullReducer(s, { type: 'undo' });
    expect(s.statuses.a).toBe('KEEP');
    s = cullReducer(s, { type: 'undo' });
    expect(s.statuses.a).toBe('UNRATED');
    expect(cullReducer(s, { type: 'undo' })).toBe(s);
  });
  it('setting the same status is a no-op (no undo entry)', () => {
    const s = cullReducer({ statuses: { a: 'KEEP' }, undo: [] }, { type: 'set', ids: ['a'], status: 'KEEP' });
    expect(s.undo).toHaveLength(0);
  });
});

describe('deletion', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let st: StatusMap;
  beforeEach(async () => {
    ctx = await setup();
    st = { img_1001: 'REJECT', img_1002: 'KEEP', img_1003: 'MAYBE', img_1004: 'REJECT' };
  });

  it('plans only REJECT groups, both files of a pair', () => {
    const plan = buildDeletePlan(ctx.groups, st);
    expect(plan.items.map((i) => i.file.name).sort()).toEqual(['IMG_1001.CR3', 'IMG_1001.JPG', 'IMG_1004.ARW', 'IMG_1004.jpeg']);
    expect(plan.rawCount).toBe(2);
    expect(plan.jpegCount).toBe(2);
  });

  it('deletes rejected files and keeps Keep/Maybe/unrated/other files', async () => {
    const r = await executeDeletion(ctx.dir as never, buildDeletePlan(ctx.groups, st), st);
    expect(r.failed).toEqual([]);
    expect(r.deleted.sort()).toEqual(['IMG_1001.CR3', 'IMG_1001.JPG', 'IMG_1004.ARW', 'IMG_1004.jpeg']);
    expect([...ctx.dir.files.keys()].sort()).toEqual(['._IMG_1001.JPG', 'DSC_9.dng', 'IMG_1002.JPG', 'IMG_1003.NEF', 'notes.txt', 'shot.png', 'x.raf', 'y.cr2']);
  });

  it('refuses if status changed away from REJECT after planning', async () => {
    const plan = buildDeletePlan(ctx.groups, st);
    const r = await executeDeletion(ctx.dir as never, plan, { ...st, img_1004: 'KEEP' });
    expect(r.fatal).toMatch(/not marked REJECT/);
    expect(ctx.dir.removed).toEqual([]);
  });

  it('permission denied → nothing deleted', async () => {
    ctx.dir.grantOnRequest = false;
    const r = await executeDeletion(ctx.dir as never, buildDeletePlan(ctx.groups, st), st);
    expect(r.fatal).toMatch(/denied/);
    expect(ctx.dir.removed).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  it('card removed before start → nothing deleted', async () => {
    ctx.dir.disconnected = true;
    const r = await executeDeletion(ctx.dir as never, buildDeletePlan(ctx.groups, st), st);
    expect(r.fatal).toMatch(/SD card removed/);
    expect(ctx.dir.removed).toEqual([]);
  });

  it('card removed mid-way → stops and lists remaining files', async () => {
    const plan = buildDeletePlan(ctx.groups, st);
    const r = await executeDeletion(ctx.dir as never, plan, st, (stage, done) => {
      if (stage === 'deleting' && done === 1) ctx.dir.disconnected = true;
    });
    expect(r.deleted).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
    expect(r.notAttempted).toHaveLength(2);
    expect(r.aborted).toBe(true);
  });

  it('stops on locked file error', async () => {
    const plan = buildDeletePlan(ctx.groups, st);
    ctx.dir.failRemoveOn.add(plan.items[0].file.name);
    const r = await executeDeletion(ctx.dir as never, plan, st);
    expect(r.deleted).toEqual([]);
    expect(r.failed[0].reason).toMatch(/read-only/);
    expect(r.notAttempted).toHaveLength(3);
  });

  it('refuses to delete a file replaced by a different file with same name', async () => {
    const plan = buildDeletePlan(ctx.groups, st);
    const name = plan.items[0].file.name;
    ctx.dir.files.set(name, { file: new MockFile(name, 1), id: {} });
    const r = await executeDeletion(ctx.dir as never, plan, st);
    expect(r.failed[0].reason).toMatch(/does not match/);
    expect(ctx.dir.files.has(name)).toBe(true);
  });

  it('refuses to delete a modified file', async () => {
    const plan = buildDeletePlan(ctx.groups, st);
    ctx.dir.files.get(plan.items[0].file.name)!.file.size = 5;
    const r = await executeDeletion(ctx.dir as never, plan, st);
    expect(r.failed[0].reason).toMatch(/modified/);
    expect(ctx.dir.removed).toEqual([]);
  });

  it('rejects path-like names', async () => {
    const plan = buildDeletePlan(ctx.groups, st);
    plan.items[0].file = { ...plan.items[0].file, name: '../evil.jpg' };
    const r = await executeDeletion(ctx.dir as never, plan, st);
    expect(r.fatal).toMatch(/Unsafe/);
    expect(ctx.dir.removed).toEqual([]);
  });
});

describe('session persistence', () => {
  it('saves and restores statuses for the same folder', async () => {
    const { groups } = await setup();
    const st: StatusMap = { img_1001: 'REJECT', img_1002: 'KEEP' };
    await saveSession(buildRecord('s1', '100CANON', groups, st, 1));
    const { groups: again } = await setup(); // fresh handles, same metadata
    const m = await findMatchingSession('100CANON', again);
    expect(m?.record.id).toBe('s1');
    expect(restoreStatuses(m!.record, again)).toEqual(st);
    expect(await findMatchingSession('OTHER', again)).toBeNull();
  });
  it('does not restore status for a group whose file changed', async () => {
    const { groups } = await setup();
    const rec = buildRecord('s2', 'X', groups, { img_1001: 'REJECT' }, 1);
    const changed: PhotoGroup[] = groups.map((g) => g.id === 'img_1001' ? { ...g, files: g.files.map((f, i) => i === 0 ? { ...f, size: 1 } : f) } : g);
    expect(restoreStatuses(rec, changed).img_1001).toBeUndefined();
  });
});

describe('RAW embedded preview', () => {
  it('extracts the largest embedded JPEG', async () => {
    const big = new Uint8Array(20000).fill(0x11);
    const jpeg = (body: Uint8Array) => new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, ...body, 0xff, 0xd9]);
    const small = jpeg(new Uint8Array(100).fill(0x22));
    const large = jpeg(big);
    const raw = new Blob([new Uint8Array(500), small, new Uint8Array(300), large, new Uint8Array(50)]);
    expect((await extractEmbeddedJpeg(new Blob([new Uint8Array(10), large])))?.size).toBe(large.length); // JPEG at end of file
    const out = await extractEmbeddedJpeg(raw);
    expect(out?.size).toBe(large.length);
  });
});

describe('fast thumbnails (EXIF)', () => {
  /** Build a JPEG header with an APP1 Exif segment containing orientation + thumbnail. */
  function exifJpeg(thumb: Uint8Array, orientation: number, little = false): Uint8Array<ArrayBuffer> {
    const t: number[] = [];
    const u16 = (v: number) => (little ? t.push(v & 255, (v >> 8) & 255) : t.push((v >> 8) & 255, v & 255));
    const u32 = (v: number) => (little ? (u16(v & 0xffff), u16(v >>> 16)) : (u16(v >>> 16), u16(v & 0xffff)));
    t.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d])); u16(42); u32(8);
    u16(1); u16(0x0112); u16(3); u32(1); u16(orientation); u16(0); u32(26);
    u16(2); u16(0x0201); u16(4); u32(1); u32(56); u16(0x0202); u16(4); u32(1); u32(thumb.length); u32(0);
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t, ...thumb];
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ((exif.length + 2) >> 8) & 255, (exif.length + 2) & 255, ...exif, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
  }
  const thumb = new Uint8Array([0xff, 0xd8, ...new Uint8Array(4000).fill(7), 0xff, 0xd9]);

  it('reads orientation and thumbnail location (big & little endian)', async () => {
    const { parseJpegExif } = await import('@/lib/exif');
    for (const le of [false, true]) {
      const j = exifJpeg(thumb, 6, le);
      const info = parseJpegExif(j)!;
      expect(info.orientation).toBe(6);
      expect([...j.subarray(info.thumb!.offset, info.thumb!.offset + info.thumb!.length)]).toEqual([...thumb]);
    }
  });
  it('extracts the EXIF thumbnail without reading image data', async () => {
    const { exifThumbnail } = await import('@/lib/thumbs');
    const big = new Uint8Array(5_000_000); // pretend 5 MB of image data after the header
    const j = exifJpeg(thumb, 1);
    const blob = new Blob([j, big]);
    const t = await exifThumbnail(blob);
    expect(t?.blob.size).toBe(thumb.length);
    expect(t?.orientation).toBe(1);
  });
  it('returns null for JPEGs without EXIF thumbnail (falls back to full decode)', async () => {
    const { exifThumbnail } = await import('@/lib/thumbs');
    expect(await exifThumbnail(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 0xff, 0xd9])]))).toBeNull();
  });
  it('finds a RAW embedded preview located after the first window', async () => {
    const body = new Uint8Array(50_000).fill(0x11);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, ...body, 0xff, 0xd9]);
    const raw = new Blob([new Uint8Array(1_000_000), jpeg]); // beyond 256 KB
    expect((await extractEmbeddedJpeg(raw))?.size).toBe(jpeg.length);
  });
});
