import { FileKind, PhotoFile, PhotoGroup, RAW_EXT, SUPPORTED_EXT } from './types';

export function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i + 1).toLowerCase() };
}

export function kindOf(ext: string): FileKind | null {
  if (!SUPPORTED_EXT.has(ext)) return null;
  if ((RAW_EXT as readonly string[]).includes(ext)) return 'raw';
  return ext === 'png' ? 'png' : 'jpeg';
}

export function isSupported(name: string): boolean {
  // Skip macOS resource forks / hidden files commonly found on cards.
  if (name.startsWith('.')) return false;
  return kindOf(splitName(name).ext) !== null;
}

/** Group files sharing a base name (case-insensitive). JPEG > PNG > RAW for preview. */
export function groupFiles(files: PhotoFile[]): PhotoGroup[] {
  const map = new Map<string, PhotoFile[]>();
  for (const f of files) {
    const key = splitName(f.name).base.toLowerCase();
    const arr = map.get(key);
    if (arr) arr.push(f);
    else map.set(key, [f]);
  }
  const rank: Record<FileKind, number> = { jpeg: 0, png: 1, raw: 2 };
  const groups: PhotoGroup[] = [];
  for (const [id, fs] of map) {
    fs.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
    groups.push({ id, baseName: splitName(fs[0].name).base, files: fs, preview: fs[0] });
  }
  groups.sort((a, b) => a.baseName.localeCompare(b.baseName, undefined, { numeric: true }));
  return groups;
}

export interface ScanProgress { scanned: number; found: number }

/** Reads only the top level of the folder (no recursion in the MVP). */
export async function scanDirectory(
  dir: FileSystemDirectoryHandle,
  onProgress?: (p: ScanProgress) => void,
): Promise<PhotoFile[]> {
  const out: PhotoFile[] = [];
  let scanned = 0;
  for await (const entry of dir.values()) {
    scanned++;
    if (entry.kind !== 'file' || !isSupported(entry.name)) continue;
    const handle = entry as FileSystemFileHandle;
    const file = await handle.getFile(); // metadata only; contents are not read
    const { ext } = splitName(entry.name);
    out.push({ name: entry.name, ext, kind: kindOf(ext)!, size: file.size, lastModified: file.lastModified, handle });
    if (scanned % 50 === 0) onProgress?.({ scanned, found: out.length });
  }
  onProgress?.({ scanned, found: out.length });
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export async function ensurePermission(
  handle: FileSystemHandle,
  mode: FileSystemPermissionMode,
): Promise<boolean> {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
