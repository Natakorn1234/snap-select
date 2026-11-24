import { CullStatus, PhotoGroup, StatusMap } from './types';

/**
 * Session persistence in IndexedDB. Deliberately stores NO file handles:
 * on reopen the user must pick the folder again (fresh permission), and
 * statuses are re-attached only to files whose name+size+lastModified match.
 */
export interface SessionFileRecord { name: string; size: number; lastModified: number; status: CullStatus }
export interface SessionRecord {
  id: string;
  folderName: string;
  files: SessionFileRecord[];
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'snapselect';
const STORE = 'sessions';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('folderName', 'folderName');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => { db.close(); resolve(req.result); };
        t.onerror = () => { db.close(); reject(t.error); };
        t.onabort = () => { db.close(); reject(t.error); };
      }),
  );
}

export const fingerprint = (f: { name: string; size: number; lastModified: number }) =>
  `${f.name}|${f.size}|${f.lastModified}`;

export function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildRecord(
  id: string, folderName: string, groups: PhotoGroup[], statuses: StatusMap, createdAt: number,
): SessionRecord {
  const files: SessionFileRecord[] = [];
  for (const g of groups)
    for (const f of g.files)
      files.push({ name: f.name, size: f.size, lastModified: f.lastModified, status: statuses[g.id] ?? 'UNRATED' });
  return { id, folderName, files, createdAt, updatedAt: Date.now() };
}

export const saveSession = (r: SessionRecord) => tx('readwrite', (s) => s.put(r)).then(() => undefined);
export const deleteSession = (id: string) => tx('readwrite', (s) => s.delete(id)).then(() => undefined);
export const listSessions = () => tx<SessionRecord[]>('readonly', (s) => s.getAll());

/** Find the best previous session for this folder: same name and most matching files. */
export async function findMatchingSession(
  folderName: string, groups: PhotoGroup[],
): Promise<{ record: SessionRecord; matched: number } | null> {
  const all = (await listSessions()).filter((r) => r.folderName === folderName);
  const current = new Set(groups.flatMap((g) => g.files.map(fingerprint)));
  let best: { record: SessionRecord; matched: number } | null = null;
  for (const r of all) {
    const matched = r.files.filter((f) => current.has(fingerprint(f))).length;
    if (matched > 0 && (!best || matched > best.matched || (matched === best.matched && r.updatedAt > best.record.updatedAt)))
      best = { record: r, matched };
  }
  return best;
}

/**
 * Re-attach statuses. A group gets a stored status only if EVERY one of its
 * current files matches a stored fingerprint with the same status; otherwise
 * it stays UNRATED (safe default — never restores REJECT on a changed file).
 */
export function restoreStatuses(record: SessionRecord, groups: PhotoGroup[]): StatusMap {
  const byFp = new Map(record.files.map((f) => [fingerprint(f), f.status]));
  const out: StatusMap = {};
  for (const g of groups) {
    const sts = g.files.map((f) => byFp.get(fingerprint(f)));
    if (sts.every((s) => s !== undefined && s === sts[0]) && sts[0] !== 'UNRATED') out[g.id] = sts[0]!;
  }
  return out;
}
