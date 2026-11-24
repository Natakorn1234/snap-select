'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Thumb from './Thumb';
import { PhotoGroup, StatusMap } from '@/lib/types';

const TILE_W = 200;
const TILE_H = 180;
const GAP = 10;
const OVERSCAN_ROWS = 2;

interface Props {
  items: PhotoGroup[];
  statuses: StatusMap;
  current: number;
  onSelect: (i: number) => void;
  onOpen: (i: number) => void;
  onColumns: (c: number) => void;
}

/** Simple windowed grid: only rows in (or near) the viewport are mounted. */
export default function VirtualGrid({ items, statuses, current, onSelect, onOpen, onColumns }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((size.w - GAP) / (TILE_W + GAP)));
  const rowH = TILE_H + GAP;
  const rows = Math.ceil(items.length / cols);
  useEffect(() => onColumns(cols), [cols, onColumns]);

  // Keep the current item scrolled into view.
  useEffect(() => {
    const el = ref.current;
    if (!el || current < 0) return;
    const top = Math.floor(current / cols) * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight + GAP;
  }, [current, cols, rowH]);

  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN_ROWS);
  const last = Math.min(rows - 1, Math.ceil((scrollTop + size.h) / rowH) + OVERSCAN_ROWS);
  const tiles = [];
  for (let r = first; r <= last; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= items.length) break;
      const g = items[i];
      tiles.push(
        <div key={g.id} style={{ position: 'absolute', top: r * rowH + GAP, left: c * (TILE_W + GAP) + GAP, width: TILE_W, height: TILE_H }}>
          <Thumb group={g} status={statuses[g.id] ?? 'UNRATED'} selected={i === current} onClick={() => onSelect(i)} onDoubleClick={() => onOpen(i)} />
        </div>,
      );
    }
  }

  return (
    <div ref={ref} className="h-full overflow-y-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ position: 'relative', height: rows * rowH + GAP }}>{tiles}</div>
    </div>
  );
}
