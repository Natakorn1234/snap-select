/**
 * Minimal EXIF/TIFF reader: just enough to find the camera's embedded thumbnail
 * and the orientation. Reads only the first few KB of a file instead of decoding
 * the whole 24MP image.
 */
export interface ExifInfo { orientation: number; thumb?: { offset: number; length: number } }

/** Parse a TIFF structure starting at `start` (offsets in the TIFF are relative to it). */
export function parseTiff(b: Uint8Array, start: number): ExifInfo | null {
  if (start + 8 > b.length) return null;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  const be = b[start] === 0x4d && b[start + 1] === 0x4d;
  if (!le && !be) return null;
  const u16 = (o: number) => (o + 2 > b.length ? -1 : le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (o + 4 > b.length ? -1 : le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
    : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  if (u16(start + 2) !== 42) return null;

  const info: ExifInfo = { orientation: 1 };
  const readIfd = (rel: number, cb: (tag: number, entry: number) => void): number => {
    const p = start + rel;
    const n = u16(p);
    if (n < 0 || n > 500) return 0;
    for (let i = 0; i < n; i++) {
      const e = p + 2 + i * 12;
      if (e + 12 > b.length) return 0;
      cb(u16(e), e);
    }
    const next = u32(p + 2 + n * 12);
    return next > 0 ? next : 0;
  };
  const ifd1 = readIfd(u32(start + 4), (tag, e) => {
    if (tag === 0x0112) { const v = u16(e + 8); if (v >= 1 && v <= 8) info.orientation = v; }
  });
  if (ifd1) {
    let off = -1, len = -1;
    readIfd(ifd1, (tag, e) => {
      if (tag === 0x0201) off = u32(e + 8);
      if (tag === 0x0202) len = u32(e + 8);
    });
    if (off > 0 && len > 0) info.thumb = { offset: start + off, length: len };
  }
  return info;
}

/** Find the APP1 "Exif" segment in a JPEG header and parse it. */
export function parseJpegExif(b: Uint8Array): ExifInfo | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1];
    if (m === 0xda || m === 0xd9) break; // image data starts: no more metadata
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0)
      return parseTiff(b, p + 10);
    p += 2 + len;
  }
  return null;
}
