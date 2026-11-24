'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_SCALE = 10;

/**
 * Zoom & pan viewer. scale=1 means "fit to screen".
 *  - Mouse wheel: zoom toward the cursor
 *  - Drag: pan while zoomed
 *  - Double-click: toggle Fit ↔ 100% (actual pixels) at the clicked point
 *  - Keys: Z toggle Fit/100%, + / - zoom, 0 fit
 */
export default function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => setView({ s: 1, x: 0, y: 0 }), [src]);

  /** Scale at which 1 image pixel = 1 screen pixel. */
  const actualScale = () => {
    const el = img.current;
    if (!el || !el.naturalWidth || !el.offsetWidth) return 2;
    const s = el.naturalWidth / el.offsetWidth / window.devicePixelRatio;
    return s > 1.25 ? Math.min(MAX_SCALE, s) : 2; // small images: 2× instead of a no-op
  };

  /** Zoom to scale `s2` keeping the point (cx, cy) (client coords; default = centre) fixed. */
  const zoomTo = useCallback((s2: number, cx?: number, cy?: number) => {
    setView((v) => {
      const s = Math.min(MAX_SCALE, Math.max(1, s2));
      if (s === 1) return { s: 1, x: 0, y: 0 };
      const r = box.current!.getBoundingClientRect();
      const px = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2);
      const py = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  // Wheel must be non-passive to preventDefault page scroll.
  useEffect(() => {
    const el = box.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomTo(viewRef.current.s * factor, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === 'z' || k === 'Z') zoomTo(viewRef.current.s > 1 ? 1 : actualScale());
      else if (k === '+' || k === '=') zoomTo(viewRef.current.s * 1.5);
      else if (k === '-' || k === '_') zoomTo(viewRef.current.s / 1.5);
      else if (k === '0') zoomTo(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomTo]);

  const zoomed = view.s > 1;
  return (
    <div
      ref={box}
      className={`relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden ${zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
      onDoubleClick={(e) => zoomTo(view.s > 1 ? 1 : actualScale(), e.clientX, e.clientY)}
      onPointerDown={(e) => {
        if (!zoomed) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        className="max-h-full max-w-full object-contain"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transition: drag.current ? 'none' : 'transform 60ms ease-out', imageRendering: view.s >= actualScale() * 2 ? 'pixelated' : 'auto' }}
      />
      <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-xs text-neutral-200" onDoubleClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <button className="px-1.5 hover:text-white" onClick={() => zoomTo(view.s / 1.5)} title="Zoom out (-)">−</button>
        <span className="w-12 text-center tabular-nums">{view.s === 1 ? 'Fit' : `${Math.round(view.s * 100)}%`}</span>
        <button className="px-1.5 hover:text-white" onClick={() => zoomTo(view.s * 1.5)} title="Zoom in (+)">+</button>
        <button className="ml-1 rounded border border-neutral-600 px-1.5" onClick={() => zoomTo(1)} title="Fit (0)">Fit</button>
        <button className="rounded border border-neutral-600 px-1.5" onClick={() => zoomTo(actualScale())} title="Actual pixels (Z)">1:1</button>
      </div>
    </div>
  );
}
