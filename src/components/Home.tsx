'use client';
import { useEffect, useState } from 'react';
import { groupFiles, scanDirectory, formatBytes, ensurePermission } from '@/lib/files';
import { findMatchingSession, newSessionId, restoreStatuses, SessionRecord } from '@/lib/db';
import { PhotoGroup, StatusMap } from '@/lib/types';

export interface LoadedFolder {
  dir: FileSystemDirectoryHandle;
  groups: PhotoGroup[];
  sessionId: string;
  createdAt: number;
  initialStatuses: StatusMap;
}

type Scan = { dir: FileSystemDirectoryHandle; groups: PhotoGroup[]; fileCount: number; bytes: number; raw: number; jpeg: number; png: number; match: { record: SessionRecord; matched: number } | null };

export default function Home({ onStart }: { onStart: (f: LoadedFolder) => void }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && window.isSecureContext && 'showDirectoryPicker' in window);
  }, []);

  async function pick() {
    setError(null);
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ id: 'snapselect', mode: 'read' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(`Could not open folder: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    setScan(null);
    try {
      if (!(await ensurePermission(dir, 'read'))) throw new Error('Read permission denied.');
      const files = await scanDirectory(dir, (p) => setProgress(`Scanned ${p.scanned} entries, ${p.found} photos…`));
      const groups = groupFiles(files);
      let match = null;
      try { match = await findMatchingSession(dir.name, groups); } catch { /* IndexedDB unavailable: continue without restore */ }
      setScan({
        dir, groups, fileCount: files.length,
        bytes: files.reduce((s, f) => s + f.size, 0),
        raw: files.filter((f) => f.kind === 'raw').length,
        jpeg: files.filter((f) => f.kind === 'jpeg').length,
        png: files.filter((f) => f.kind === 'png').length,
        match,
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      setError(name === 'NotAllowedError' ? 'Permission denied. Please allow access to the folder.'
        : name === 'NotFoundError' ? 'Folder not found — was the SD card removed?'
        : `Failed to read folder: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  function start(restore: boolean) {
    if (!scan) return;
    const m = restore ? scan.match : null;
    onStart({
      dir: scan.dir,
      groups: scan.groups,
      sessionId: m ? m.record.id : newSessionId(),
      createdAt: m ? m.record.createdAt : Date.now(),
      initialStatuses: m ? restoreStatuses(m.record, scan.groups) : {},
    });
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-3xl font-semibold">SnapSelect</h1>
      <p className="mt-2 text-sm text-neutral-400">Cull photos directly on your SD card. Nothing is uploaded — everything runs in your browser.</p>

      {supported === false && (
        <div className="mt-6 rounded border border-red-700 bg-red-950/50 p-4 text-sm">
          This browser does not support the File System Access API, or the page is not served over HTTPS.
          Please use Chrome or Edge on desktop via https:// (or http://localhost).
        </div>
      )}

      <button
        onClick={pick}
        disabled={!supported || busy}
        className="mt-8 rounded bg-neutral-100 px-5 py-2.5 font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
      >
        {busy ? 'Reading…' : 'Select Folder'}
      </button>
      {progress && <p className="mt-3 text-sm text-neutral-400">{progress}</p>}
      {error && <p className="mt-4 rounded bg-red-950/60 p-3 text-sm text-red-300">{error}</p>}

      {scan && (
        <section className="mt-8 rounded border border-neutral-800 p-4">
          <div className="text-lg font-medium">📁 {scan.dir.name}</div>
          <dl className="mt-3 grid grid-cols-2 gap-1 text-sm text-neutral-300">
            <dt>Photos (shots)</dt><dd>{scan.groups.length}</dd>
            <dt>Files</dt><dd>{scan.fileCount} ({formatBytes(scan.bytes)})</dd>
            <dt>RAW</dt><dd>{scan.raw}</dd>
            <dt>JPEG</dt><dd>{scan.jpeg}</dd>
            {scan.png > 0 && (<><dt>PNG</dt><dd>{scan.png}</dd></>)}
          </dl>
          <p className="mt-2 text-xs text-neutral-500">Only the top level of this folder is read (subfolders are ignored).</p>

          {scan.groups.length === 0 ? (
            <p className="mt-4 text-sm text-amber-400">No supported photos found. Tip: on most cameras photos are inside DCIM/100XXXXX.</p>
          ) : scan.match ? (
            <div className="mt-4 space-y-2">
              <p className="text-sm text-sky-300">
                Previous session found ({scan.match.matched} matching files, last updated {new Date(scan.match.record.updatedAt).toLocaleString()}).
              </p>
              <div className="flex gap-2">
                <button onClick={() => start(true)} className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white">Restore & Continue</button>
                <button onClick={() => start(false)} className="rounded border border-neutral-700 px-4 py-2 text-sm">Start Fresh</button>
              </div>
            </div>
          ) : (
            <button onClick={() => start(false)} className="mt-4 rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white">Start Culling</button>
          )}
        </section>
      )}
    </main>
  );
}
