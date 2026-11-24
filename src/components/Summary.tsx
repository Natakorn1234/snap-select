'use client';
import { useMemo, useState } from 'react';
import { buildDeletePlan, DeleteResult, DeleteStage, executeDeletion } from '@/lib/deletion';
import { countStatuses } from '@/lib/cull';
import { formatBytes } from '@/lib/files';
import { PhotoGroup, StatusMap } from '@/lib/types';

interface Props {
  dir: FileSystemDirectoryHandle;
  groups: PhotoGroup[];
  statuses: StatusMap;
  onBack: () => void;
  onExit: () => void;
  onDeleted: (names: string[]) => void;
}

export default function Summary({ dir, groups, statuses, onBack, onExit, onDeleted }: Props) {
  const counts = countStatuses(groups.map((g) => g.id), statuses);
  const plan = useMemo(() => buildDeletePlan(groups, statuses), [groups, statuses]);
  const allFiles = groups.flatMap((g) => g.files);
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [running, setRunning] = useState<{ stage: DeleteStage; done: number; total: number } | null>(null);
  const [result, setResult] = useState<DeleteResult | null>(null);

  async function run() {
    setConfirming(false);
    setRunning({ stage: 'permission', done: 0, total: plan.items.length });
    let r: DeleteResult;
    try {
      r = await executeDeletion(dir, plan, statuses, (stage, done, total) => setRunning({ stage, done, total }));
    } catch (e) {
      r = { deleted: [], failed: [], notAttempted: plan.items.map((i) => i.file.name), aborted: true, fatal: `Unexpected error: ${(e as Error).message}` };
    }
    setRunning(null);
    setResult(r);
    if (r.deleted.length) onDeleted(r.deleted);
  }

  if (result) {
    const ok = !result.fatal && result.failed.length === 0 && result.notAttempted.length === 0;
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold">{ok ? '✅ Deletion complete' : '⚠️ Deletion stopped'}</h1>
        {result.fatal && <p className="mt-4 rounded bg-red-950/60 p-3 text-red-300">{result.fatal}</p>}
        <p className="mt-4">Deleted and verified: <b>{result.deleted.length}</b> file(s)</p>
        {result.failed.length > 0 && (
          <div className="mt-4">
            <p className="text-red-400">Failed ({result.failed.length}):</p>
            <ul className="mt-1 text-sm">{result.failed.map((f) => <li key={f.name} className="font-mono">{f.name} — {f.reason}</li>)}</ul>
          </div>
        )}
        {result.notAttempted.length > 0 && (
          <div className="mt-4">
            <p className="text-amber-400">Not attempted because the process stopped ({result.notAttempted.length}) — these files are still on the card:</p>
            <FileList names={result.notAttempted} />
          </div>
        )}
        <p className="mt-4 text-sm text-neutral-400">Keep and Maybe files were not touched.</p>
        <div className="mt-6 flex gap-2">
          <button onClick={() => { setResult(null); onBack(); }} className="rounded bg-neutral-800 px-4 py-2">Back to culling</button>
          <button onClick={onExit} className="rounded bg-neutral-200 px-4 py-2 text-neutral-900">Done</button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <button onClick={onBack} className="text-sm text-neutral-400 hover:text-white">← Back to culling</button>
      <h1 className="mt-2 text-2xl font-semibold">Finish Summary — {dir.name}</h1>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Keep" value={counts.KEEP} cls="text-emerald-400" />
        <Stat label="Maybe" value={counts.MAYBE} cls="text-amber-400" />
        <Stat label="Reject" value={counts.REJECT} cls="text-red-400" />
        <Stat label="Unrated" value={counts.UNRATED} cls="text-neutral-400" />
        <Stat label="RAW files (total)" value={allFiles.filter((f) => f.kind === 'raw').length} />
        <Stat label="JPEG files (total)" value={allFiles.filter((f) => f.kind === 'jpeg').length} />
        <Stat label="RAW to delete" value={plan.rawCount} cls="text-red-400" />
        <Stat label="JPEG to delete" value={plan.jpegCount} cls="text-red-400" />
      </div>
      {counts.UNRATED > 0 && <p className="mt-3 text-sm text-neutral-400">Unrated photos are treated like Keep: they will NOT be deleted.</p>}

      <h2 className="mt-8 font-medium">Files to be deleted ({plan.items.length}{plan.otherCount ? `, incl. ${plan.otherCount} PNG` : ''}, {formatBytes(plan.totalBytes)})</h2>
      {plan.items.length ? <FileList names={plan.items.map((i) => i.file.name)} /> : <p className="mt-2 text-sm text-neutral-500">No photos marked Reject.</p>}

      <button
        disabled={!plan.items.length || !!running}
        onClick={() => { setAck(false); setConfirming(true); }}
        className="mt-6 rounded bg-red-600 px-5 py-2.5 font-medium text-white disabled:opacity-40"
      >
        Finish &amp; Delete Rejected
      </button>

      {running && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
          <div className="rounded border border-neutral-700 bg-neutral-900 p-6 text-center">
            <p>{running.stage === 'permission' ? 'Requesting write permission…' : running.stage === 'connection' ? 'Checking SD card…' : `Deleting ${running.done + 1} / ${running.total}…`}</p>
            <p className="mt-2 text-xs text-neutral-500">Do not remove the SD card.</p>
          </div>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded border border-red-700 bg-neutral-900 p-6">
            <h3 className="text-lg font-semibold text-red-400">Permanently delete {plan.items.length} file(s)?</h3>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-300">
              <li>{plan.groupIds.length} rejected photo(s): {plan.rawCount} RAW + {plan.jpegCount} JPEG{plan.otherCount ? ` + ${plan.otherCount} PNG` : ''} ({formatBytes(plan.totalBytes)}).</li>
              <li>Files are deleted <b>permanently</b> from <b>{dir.name}</b>. They are NOT moved to the Recycle Bin and cannot be undone.</li>
              <li>{counts.KEEP} Keep, {counts.MAYBE} Maybe and {counts.UNRATED} Unrated photos stay where they are.</li>
              <li>The browser will ask for permission to modify files in this folder.</li>
            </ul>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              I understand this cannot be undone.
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} className="rounded bg-neutral-800 px-4 py-2" autoFocus>Cancel</button>
              <button onClick={run} disabled={!ack} className="rounded bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-40">Delete permanently</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: number; cls?: string }) {
  return (
    <div className="rounded border border-neutral-800 p-3">
      <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
      <div className="text-xs text-neutral-400">{label}</div>
    </div>
  );
}

function FileList({ names }: { names: string[] }) {
  return (
    <div className="mt-2 max-h-64 overflow-y-auto rounded border border-neutral-800 p-2 font-mono text-xs text-neutral-300">
      {names.map((n) => <div key={n}>{n}</div>)}
    </div>
  );
}
