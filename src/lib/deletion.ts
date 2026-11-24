import { PhotoFile, PhotoGroup, StatusMap } from './types';

/**
 * Real deletion of REJECT files. Safety model:
 *  1. The plan contains ONLY files of groups whose status is exactly 'REJECT'
 *     (RAW+JPEG share one status, so pairs are always deleted together).
 *  2. Every name is a plain top-level name (no path separators) and every file is
 *     re-resolved via dir.getFileHandle(name) — the File System Access API cannot
 *     reach outside the directory the user picked.
 *  3. The fresh handle must be isSameEntry() with the handle seen at scan time and
 *     size + lastModified must still match, otherwise we refuse.
 *  4. Readwrite permission is requested and the card is probed before starting.
 *  5. On the first error we STOP and report: deleted / failed / not attempted.
 *  6. A file counts as deleted only after a follow-up lookup returns NotFoundError.
 */

export interface DeletePlanItem { groupId: string; file: PhotoFile }
export interface DeletePlan { items: DeletePlanItem[]; groupIds: string[]; rawCount: number; jpegCount: number; otherCount: number; totalBytes: number }

export function buildDeletePlan(groups: PhotoGroup[], statuses: StatusMap): DeletePlan {
  const items: DeletePlanItem[] = [];
  const groupIds: string[] = [];
  for (const g of groups) {
    if (statuses[g.id] !== 'REJECT') continue;
    groupIds.push(g.id);
    for (const file of g.files) items.push({ groupId: g.id, file });
  }
  return {
    items,
    groupIds,
    rawCount: items.filter((i) => i.file.kind === 'raw').length,
    jpegCount: items.filter((i) => i.file.kind === 'jpeg').length,
    otherCount: items.filter((i) => i.file.kind === 'png').length,
    totalBytes: items.reduce((s, i) => s + i.file.size, 0),
  };
}

export type DeleteStage = 'permission' | 'connection' | 'deleting' | 'done';
export interface DeleteFailure { name: string; reason: string }
export interface DeleteResult {
  deleted: string[];
  failed: DeleteFailure[];
  notAttempted: string[];
  aborted: boolean;
  fatal?: string; // error before any file was touched
}

export class DeleteSafetyError extends Error {}

function errMsg(e: unknown): string {
  if (e instanceof DOMException) {
    switch (e.name) {
      case 'NotFoundError': return 'File or folder not found (card removed or file moved?)';
      case 'NotAllowedError': return 'Permission denied';
      case 'NoModificationAllowedError': return 'Card is read-only / file locked (check SD lock switch)';
      case 'InvalidModificationError': return 'Invalid modification';
      case 'InvalidStateError': return 'File changed on disk';
      default: return `${e.name}: ${e.message}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

const isNotFound = (e: unknown) => e instanceof DOMException && e.name === 'NotFoundError';

/** Re-check the invariant right before deleting: never trust the caller. */
export function assertPlanSafe(plan: DeletePlan, statuses: StatusMap): void {
  const seen = new Set<string>();
  for (const { groupId, file } of plan.items) {
    if (statuses[groupId] !== 'REJECT') throw new DeleteSafetyError(`${file.name} is not marked REJECT`);
    if (!file.name || /[\\/]/.test(file.name) || file.name === '.' || file.name === '..')
      throw new DeleteSafetyError(`Unsafe file name: ${file.name}`);
    if (seen.has(file.name)) throw new DeleteSafetyError(`Duplicate file in plan: ${file.name}`);
    seen.add(file.name);
  }
}

export async function executeDeletion(
  dir: FileSystemDirectoryHandle,
  plan: DeletePlan,
  statuses: StatusMap,
  onProgress?: (stage: DeleteStage, done: number, total: number) => void,
): Promise<DeleteResult> {
  const names = plan.items.map((i) => i.file.name);
  const result: DeleteResult = { deleted: [], failed: [], notAttempted: [...names], aborted: false };
  const total = plan.items.length;

  try {
    assertPlanSafe(plan, statuses);
  } catch (e) {
    return { ...result, aborted: true, fatal: errMsg(e) };
  }

  // 1. Permission (must be called within the user's click activation).
  onProgress?.('permission', 0, total);
  try {
    let perm = await dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await dir.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return { ...result, aborted: true, fatal: 'Write permission was denied. Nothing was deleted.' };
  } catch (e) {
    return { ...result, aborted: true, fatal: `Could not get write permission: ${errMsg(e)}. Nothing was deleted.` };
  }

  // 2. Is the card still there? Listing the folder fails if it was removed.
  onProgress?.('connection', 0, total);
  let present: Set<string>;
  try {
    present = new Set<string>();
    for await (const e of dir.values()) present.add(e.name);
  } catch (e) {
    return { ...result, aborted: true, fatal: `Folder is not accessible (SD card removed?): ${errMsg(e)}. Nothing was deleted.` };
  }

  // 3. Delete one by one, stop on first failure.
  for (let idx = 0; idx < plan.items.length; idx++) {
    const { file } = plan.items[idx];
    onProgress?.('deleting', idx, total);
    try {
      if (!present.has(file.name)) throw new DOMException('missing', 'NotFoundError');
      const fresh = await dir.getFileHandle(file.name);
      if (!(await fresh.isSameEntry(file.handle))) throw new DeleteSafetyError('File handle does not match the scanned file');
      const f = await fresh.getFile();
      if (f.size !== file.size || f.lastModified !== file.lastModified)
        throw new DeleteSafetyError('File was modified since scanning — refusing to delete');

      const removable = fresh as FileSystemFileHandle & { remove?: () => Promise<void> };
      if (typeof removable.remove === 'function') await removable.remove();
      else await dir.removeEntry(file.name);

      // Verify it is really gone.
      try {
        await dir.getFileHandle(file.name);
        throw new DeleteSafetyError('File still exists after delete');
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      result.deleted.push(file.name);
      result.notAttempted.shift();
    } catch (e) {
      result.notAttempted.shift();
      result.failed.push({ name: file.name, reason: errMsg(e) });
      result.aborted = idx < plan.items.length - 1;
      break;
    }
  }
  onProgress?.('done', result.deleted.length, total);
  return result;
}
