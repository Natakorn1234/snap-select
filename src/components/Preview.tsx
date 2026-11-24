'use client';
import { useEffect, useState } from 'react';
import { displayableBlob } from '@/lib/thumbs';
import { formatBytes } from '@/lib/files';
import { CullStatus, PhotoGroup } from '@/lib/types';
import { STATUS_BADGE, STATUS_LABEL } from './statusStyle';
import ZoomImage from './ZoomImage';

/** Full-size preview. Only ONE full image is held in memory; its object URL is revoked on change/close. */
export default function Preview({ group, status, index, total, onClose }: { group: PhotoGroup; status: CullStatus; index: number; total: number; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    setUrl(null);
    setError(null);
    displayableBlob(group.preview)
      .then((b) => {
        if (!alive) return;
        if (!b) { setError('No embedded preview in this RAW file.'); return; }
        created = URL.createObjectURL(b);
        setUrl(created);
      })
      .catch((e) => alive && setError(e instanceof DOMException && e.name === 'NotFoundError' ? 'File not found — SD card removed?' : `Cannot read file: ${(e as Error).message}`));
    return () => { alive = false; if (created) URL.revokeObjectURL(created); };
  }, [group]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black/95">
      <div className="flex items-center justify-between px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-medium">{group.baseName}</span>
          <span className="text-neutral-400">{group.files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(' · ')}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`rounded px-2 py-0.5 ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>
          <span className="text-neutral-400">{index + 1} / {total}</span>
          <button onClick={onClose} className="rounded border border-neutral-700 px-2 py-0.5">Esc</button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {error ? <p className="text-red-400">{error}</p>
          : url ? <ZoomImage src={url} alt={group.baseName} />
          : <span className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-200" />}
      </div>
      <div className="pb-2 text-center text-xs text-neutral-500">1 Keep · 2 Maybe · X Reject · ←/→ Navigate · Wheel/+/− zoom · Z or double-click 100% · 0 fit · drag to pan · Ctrl+Z Undo · Space/Esc Close</div>
    </div>
  );
}
