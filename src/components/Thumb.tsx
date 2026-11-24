'use client';
import { memo, useEffect, useState } from 'react';
import { getCachedThumb, requestThumb } from '@/lib/thumbs';
import { CullStatus, PhotoGroup } from '@/lib/types';
import { STATUS_BADGE, STATUS_LABEL, STATUS_RING } from './statusStyle';

interface Props { group: PhotoGroup; status: CullStatus; selected: boolean; onClick: () => void; onDoubleClick: () => void }

function ThumbImpl({ group, status, selected, onClick, onDoubleClick }: Props) {
  const key = group.preview.name;
  const [url, setUrl] = useState<string | null | undefined>(() => getCachedThumb(key));

  useEffect(() => {
    if (url) return;
    let alive = true;
    const [p, cancel] = requestThumb(key, group.preview);
    p.then((u) => alive && setUrl(u));
    return () => { alive = false; cancel(); };
  }, [key, group.preview, url]);

  const hasRaw = group.files.some((f) => f.kind === 'raw');
  const hasJpg = group.files.some((f) => f.kind !== 'raw');
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`relative flex h-full w-full flex-col overflow-hidden rounded bg-neutral-900 ring-2 ${STATUS_RING[status]} ${selected ? 'outline outline-2 outline-offset-2 outline-sky-400' : ''}`}
    >
      <div className="flex flex-1 items-center justify-center overflow-hidden">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={group.baseName} className={`max-h-full max-w-full object-contain ${status === 'REJECT' ? 'opacity-40' : ''}`} draggable={false} />
        ) : url === null ? (
          <span className="text-xs text-neutral-500">No preview</span>
        ) : (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300" />
        )}
      </div>
      <div className="flex items-center justify-between gap-1 px-1.5 py-1 text-[11px]">
        <span className="truncate text-neutral-300">{group.baseName}</span>
        <span className="flex shrink-0 gap-1">
          {hasRaw && hasJpg && <span className="rounded bg-neutral-700 px-1">R+J</span>}
          {hasRaw && !hasJpg && <span className="rounded bg-neutral-700 px-1">RAW</span>}
          {status !== 'UNRATED' && <span className={`rounded px-1 ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>}
        </span>
      </div>
    </button>
  );
}

export default memo(ThumbImpl);
