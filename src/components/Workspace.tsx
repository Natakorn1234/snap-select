'use client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import VirtualGrid from './VirtualGrid';
import Preview from './Preview';
import Summary from './Summary';
import { cullReducer, countStatuses } from '@/lib/cull';
import { buildRecord, saveSession } from '@/lib/db';
import { clearThumbCache } from '@/lib/thumbs';
import { CullStatus, PhotoGroup } from '@/lib/types';
import type { LoadedFolder } from './Home';

type Filter = 'ALL' | CullStatus;
const FILTERS: Filter[] = ['ALL', 'UNRATED', 'KEEP', 'MAYBE', 'REJECT'];

export default function Workspace({ folder, onExit }: { folder: LoadedFolder; onExit: () => void }) {
  const [groups, setGroups] = useState<PhotoGroup[]>(folder.groups);
  const [state, dispatch] = useReducer(cullReducer, { statuses: folder.initialStatuses, undo: [] });
  const [filter, setFilter] = useState<Filter>('ALL');
  const [current, setCurrent] = useState(0);
  const [preview, setPreview] = useState(false);
  const [view, setView] = useState<'grid' | 'summary'>('grid');
  const [saveError, setSaveError] = useState<string | null>(null);
  const cols = useRef(1);
  const onColumns = useCallback((c: number) => { cols.current = c; }, []);

  useEffect(() => () => clearThumbCache(), []);

  const items = useMemo(
    () => (filter === 'ALL' ? groups : groups.filter((g) => (state.statuses[g.id] ?? 'UNRATED') === filter)),
    [groups, filter, state.statuses],
  );
  const idx = Math.min(current, items.length - 1);
  const counts = useMemo(() => countStatuses(groups.map((g) => g.id), state.statuses), [groups, state.statuses]);

  // Autosave (debounced) to IndexedDB.
  useEffect(() => {
    const t = setTimeout(() => {
      saveSession(buildRecord(folder.sessionId, folder.dir.name, groups, state.statuses, folder.createdAt))
        .then(() => setSaveError(null))
        .catch((e) => setSaveError(`Session not saved: ${(e as Error).message}`));
    }, 400);
    return () => clearTimeout(t);
  }, [state.statuses, groups, folder]);

  const mark = useCallback((status: CullStatus) => {
    const g = items[idx];
    if (!g) return;
    dispatch({ type: 'set', ids: [g.id], status });
    // In "ALL" advance to next; in a filtered view the item drops out, so the index already points at the next one.
    if (filter === 'ALL' || filter === status) setCurrent(Math.min(idx + 1, items.length - 1));
  }, [items, idx, filter]);

  useEffect(() => {
    if (view !== 'grid') return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: 'undo' }); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === '1') mark('KEEP');
      else if (k === '2') mark('MAYBE');
      else if (k === 'x' || k === 'X') mark('REJECT');
      else if (k === 'ArrowRight') setCurrent((c) => Math.min(Math.min(c, items.length - 1) + 1, items.length - 1));
      else if (k === 'ArrowLeft') setCurrent((c) => Math.max(Math.min(c, items.length - 1) - 1, 0));
      else if (k === 'ArrowDown' && !preview) setCurrent((c) => Math.min(c + cols.current, items.length - 1));
      else if (k === 'ArrowUp' && !preview) setCurrent((c) => Math.max(c - cols.current, 0));
      else if (k === ' ') setPreview((p) => !p);
      else if (k === 'Escape') setPreview(false);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mark, items.length, preview, view]);

  if (view === 'summary') {
    return (
      <Summary
        dir={folder.dir}
        groups={groups}
        statuses={state.statuses}
        onBack={() => setView('grid')}
        onExit={onExit}
        onDeleted={(deletedNames) => {
          // Drop deleted files; drop groups with no files left.
          const gone = new Set(deletedNames);
          setGroups((gs) => gs
            .map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.name)) }))
            .filter((g) => g.files.length > 0)
            .map((g) => (gone.has(g.preview.name) ? { ...g, preview: g.files[0] } : g)));
        }}
      />
    );
  }

  const rated = groups.length - counts.UNRATED;
  const cur = items[idx];
  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
        <button onClick={onExit} className="text-neutral-400 hover:text-white">← Home</button>
        <span className="font-medium">📁 {folder.dir.name}</span>
        <span className="text-neutral-400">Progress: {rated}/{groups.length} ({groups.length ? Math.round((rated / groups.length) * 100) : 0}%)</span>
        <div className="h-1.5 w-32 overflow-hidden rounded bg-neutral-800"><div className="h-full bg-sky-500" style={{ width: `${groups.length ? (rated / groups.length) * 100 : 0}%` }} /></div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => { setFilter(f); setCurrent(0); }}
              className={`rounded px-2 py-1 ${filter === f ? 'bg-neutral-200 text-neutral-900' : 'bg-neutral-800 hover:bg-neutral-700'}`}>
              {f === 'ALL' ? `All ${groups.length}` : `${f[0]}${f.slice(1).toLowerCase()} ${counts[f]}`}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {saveError && <span className="text-xs text-red-400">{saveError}</span>}
          <button onClick={() => dispatch({ type: 'undo' })} disabled={!state.undo.length} className="rounded bg-neutral-800 px-2 py-1 disabled:opacity-40">Undo</button>
          <button onClick={() => setView('summary')} className="rounded bg-sky-600 px-3 py-1 font-medium text-white">Finish →</button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {items.length ? (
          <VirtualGrid items={items} statuses={state.statuses} current={idx} onSelect={setCurrent} onOpen={(i) => { setCurrent(i); setPreview(true); }} onColumns={onColumns} />
        ) : (
          <p className="p-8 text-neutral-500">No photos in this filter.</p>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-neutral-800 px-4 py-2 text-sm">
        <span className="min-w-40 truncate text-neutral-400">{cur ? `${idx + 1}/${items.length} · ${cur.files.map((f) => f.name).join(' + ')}` : '—'}</span>
        <button onClick={() => mark('KEEP')} className="rounded bg-emerald-600 px-3 py-1 text-white">Keep (1)</button>
        <button onClick={() => mark('MAYBE')} className="rounded bg-amber-500 px-3 py-1 text-black">Maybe (2)</button>
        <button onClick={() => mark('REJECT')} className="rounded bg-red-600 px-3 py-1 text-white">Reject (X)</button>
        <button onClick={() => setPreview(true)} className="rounded bg-neutral-800 px-3 py-1">Preview (Space)</button>
        <span className="ml-auto text-xs text-neutral-500">←/→/↑/↓ navigate · Ctrl+Z undo · double-click to preview</span>
      </footer>

      {preview && cur && <Preview group={cur} status={state.statuses[cur.id] ?? 'UNRATED'} index={idx} total={items.length} onClose={() => setPreview(false)} />}
    </div>
  );
}
