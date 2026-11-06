'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LapResult } from '@/lib/solver';
import type { Track } from '@/lib/tracks';
import { MODE_COLORS, MODE_LABELS, rgb, turbo } from '@/lib/ui/colors';
import { fmt, kph } from '@/lib/ui/format';

export type ColorMode = 'mode' | 'speed' | 'latg' | 'grip';

export interface MapAlign {
  opacity: number;
  scale: number;
  x: number;
  y: number;
  rotation: number;
  visible: boolean;
}

interface Props {
  track: Track;
  lap: LapResult;
  colorMode: ColorMode;
  cursor: number | null;
  onHover: (i: number | null) => void;
  mapAlign?: MapAlign;
  /** Replaces the built-in facility drawing when the user uploads their own map. */
  mapSrcOverride?: string | null;
}

interface Transform {
  sx: (x: number) => number;
  sy: (y: number) => number;
  scale: number;
}

function useSize(ref: React.RefObject<HTMLDivElement>) {
  const [size, setSize] = useState({ w: 600, h: 420 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(200, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function setupCanvas(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export default function TrackCanvas({ track, lap, colorMode, cursor, onHover, mapAlign, mapSrcOverride }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const { w, h } = useSize(wrapRef);
  const ch = lap.channels;
  const [mapImg, setMapImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const src = mapSrcOverride || track.mapImage?.src;
    if (!src) {
      setMapImg(null);
      return;
    }
    const img = new Image();
    img.onload = () => setMapImg(img);
    img.onerror = () => setMapImg(null);
    img.src = src;
  }, [track.mapImage?.src, mapSrcOverride]);

  const tf: Transform = useMemo(() => {
    const pad = 36;
    const minX = Math.min(...track.x);
    const maxX = Math.max(...track.x);
    const minY = Math.min(...track.y);
    const maxY = Math.max(...track.y);
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    const ox = (w - spanX * scale) / 2;
    const oy = (h - spanY * scale) / 2;
    return { sx: (x) => ox + (x - minX) * scale, sy: (y) => h - oy - (y - minY) * scale, scale };
  }, [track, w, h]);

  const colorAt = useMemo(() => {
    const vmax = Math.max(...ch.v);
    const vmin = Math.min(...ch.v);
    const latMax = Math.max(1e-3, ...ch.gLat.map(Math.abs));
    return (i: number): string => {
      switch (colorMode) {
        case 'speed':
          return rgb(turbo((ch.v[i] - vmin) / Math.max(1e-6, vmax - vmin)));
        case 'latg':
          return rgb(turbo(Math.abs(ch.gLat[i]) / latMax));
        case 'grip':
          return rgb(turbo(ch.gripUsage[i]));
        default: {
          const m = ch.mode[i];
          if (m === 'brake') return `rgba(59,130,246,${0.35 + 0.65 * ch.brake[i]})`;
          return MODE_COLORS[m];
        }
      }
    };
  }, [ch, colorMode]);

  // static layer
  useEffect(() => {
    const c = baseRef.current;
    if (!c) return;
    const ctx = setupCanvas(c, w, h);
    ctx.clearRect(0, 0, w, h);
    if (mapImg && mapAlign?.visible && (track.mapImage || mapSrcOverride)) {
      const mpp = track.mapImage?.metersPerPixel ?? 1;
      const widthPx = mapSrcOverride ? mapImg.naturalWidth : (track.mapImage?.widthPx ?? mapImg.naturalWidth);
      const heightPx = mapSrcOverride ? mapImg.naturalHeight : (track.mapImage?.heightPx ?? mapImg.naturalHeight);
      const worldW = widthPx * mpp * mapAlign.scale;
      const worldH = heightPx * mpp * mapAlign.scale;
      const cx = worldW / 2 + mapAlign.x;
      const cy = worldH / 2 + mapAlign.y;
      ctx.save();
      ctx.globalAlpha = mapAlign.opacity;
      ctx.translate(tf.sx(cx), tf.sy(cy));
      ctx.rotate((-mapAlign.rotation * Math.PI) / 180);
      ctx.drawImage(mapImg, (-worldW * tf.scale) / 2, (-worldH * tf.scale) / 2, worldW * tf.scale, worldH * tf.scale);
      ctx.restore();
    }
    // grid (10 m)
    const step = 10 * tf.scale;
    if (step > 6) {
      ctx.strokeStyle = 'rgba(27,38,51,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = tf.sx(Math.floor(Math.min(...track.x) / 10) * 10); x < w; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = tf.sy(Math.floor(Math.min(...track.y) / 10) * 10); y > 0; y -= step) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }
    const n = track.x.length;
    const segs = track.closed ? n : n - 1;
    // track ribbon (3 m wide)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111a24';
    ctx.lineWidth = Math.max(6, 3 * tf.scale);
    ctx.beginPath();
    ctx.moveTo(tf.sx(track.x[0]), tf.sy(track.y[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(tf.sx(track.x[i]), tf.sy(track.y[i]));
    if (track.closed) ctx.closePath();
    ctx.stroke();
    // heat-map centre line
    ctx.lineWidth = Math.max(2.5, 0.9 * tf.scale);
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      ctx.strokeStyle = colorAt(i);
      ctx.beginPath();
      ctx.moveTo(tf.sx(track.x[i]), tf.sy(track.y[i]));
      ctx.lineTo(tf.sx(track.x[j]), tf.sy(track.y[j]));
      ctx.stroke();
    }
    // start / finish line
    const th = track.heading[0];
    const nx = -Math.sin(th);
    const ny = Math.cos(th);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tf.sx(track.x[0] + 3 * nx), tf.sy(track.y[0] + 3 * ny));
    ctx.lineTo(tf.sx(track.x[0] - 3 * nx), tf.sy(track.y[0] - 3 * ny));
    ctx.stroke();
    // sector markers
    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = '#a78bfa';
    track.sectors.slice(1, -1).forEach((s, k) => {
      const i = Math.min(n - 1, Math.round(s / track.ds));
      ctx.beginPath();
      ctx.arc(tf.sx(track.x[i]), tf.sy(track.y[i]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`S${k + 2}`, tf.sx(track.x[i]) + 6, tf.sy(track.y[i]) - 6);
    });
    // direction arrows
    if (track.direction) {
      const stride = Math.max(8, Math.round(80 / track.ds));
      for (let i = stride; i < n; i += stride) {
        const x = tf.sx(track.x[i]);
        const y = tf.sy(track.y[i]);
        const dx = Math.cos(track.heading[i]) * 9;
        const dy = -Math.sin(track.heading[i]) * 9;
        ctx.strokeStyle = 'rgba(248,250,252,0.85)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x - dx, y - dy);
        ctx.lineTo(x + dx * 0.2, y + dy * 0.2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(248,250,252,0.85)';
        ctx.beginPath();
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(x + dy * 0.45, y - dx * 0.45);
        ctx.lineTo(x - dy * 0.45, y + dx * 0.45);
        ctx.fill();
      }
    }
    // pit lane and garage stalls
    if (track.pitLane && track.pitLane.x.length > 1) {
      const pit = track.pitLane;
      ctx.save();
      ctx.strokeStyle = '#94a3b8';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tf.sx(pit.x[0]), tf.sy(pit.y[0]));
      for (let i = 1; i < pit.x.length; i++) ctx.lineTo(tf.sx(pit.x[i]), tf.sy(pit.y[i]));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#94a3b8';
      const step = Math.max(1, Math.floor((pit.x.length - 1) / pit.garages));
      for (let g = 0; g < pit.garages; g++) {
        const i = Math.min(pit.x.length - 1, g * step);
        ctx.fillRect(tf.sx(pit.x[i]) - 1.5, tf.sy(pit.y[i]) - 1.5, 3, 3);
      }
      ctx.font = '10px Consolas, monospace';
      ctx.fillText(`${pit.garages} pit`, tf.sx(pit.x[0]) + 6, tf.sy(pit.y[0]) - 6);
      ctx.restore();
    }
    // corner labels — named landmarks when the circuit provides them
    if (track.landmarks && track.landmarks.length > 0) {
      ctx.font = 'bold 11px Consolas, monospace';
      for (const lm of track.landmarks) {
        const i = Math.min(n - 1, Math.round(lm.sApex / track.ds));
        const off = (lm.direction === 'L' ? 1 : -1) * 14;
        const px = track.x[i] + off * -Math.sin(track.heading[i]);
        const py = track.y[i] + off * Math.cos(track.heading[i]);
        ctx.fillStyle = lm.direction === 'L' ? '#22d3ee' : '#f59e0b';
        ctx.beginPath();
        ctx.arc(tf.sx(track.x[i]), tf.sy(track.y[i]), 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(`${lm.id} ${lm.direction === 'L' ? 'Sol' : 'Sağ'}`, tf.sx(px), tf.sy(py));
      }
    } else if (track.kind !== 'skidpad') {
      ctx.fillStyle = 'rgba(201,212,226,0.75)';
      for (const c of lap.corners) {
        const i = c.apexIndex;
        const k = track.kappa[i];
        const off = (Math.sign(k) || 1) * -9;
        const px = track.x[i] + off * -Math.sin(track.heading[i]);
        const py = track.y[i] + off * Math.cos(track.heading[i]);
        ctx.fillText(`T${c.index}`, tf.sx(px) - 6, tf.sy(py) + 3);
      }
    }
  }, [track, lap, tf, w, h, colorAt, mapImg, mapAlign, mapSrcOverride]);

  // overlay: cursor
  useEffect(() => {
    const c = overRef.current;
    if (!c) return;
    const ctx = setupCanvas(c, w, h);
    ctx.clearRect(0, 0, w, h);
    if (cursor == null || cursor >= track.x.length) return;
    const x = tf.sx(track.x[cursor]);
    const y = tf.sy(track.y[cursor]);
    const th = track.heading[cursor];
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 18 * Math.cos(th), y - 18 * Math.sin(th));
    ctx.stroke();
  }, [cursor, tf, track, w, h]);

  const onMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = -1;
    let bestD = 22 * 22;
    for (let i = 0; i < track.x.length; i++) {
      const dx = tf.sx(track.x[i]) - mx;
      const dy = tf.sy(track.y[i]) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    onHover(best >= 0 ? best : null);
  };

  const legend =
    colorMode === 'mode'
      ? (['brake', 'full-throttle', 'part-throttle', 'cornering', 'coast'] as const).map((m) => ({ c: MODE_COLORS[m], l: MODE_LABELS[m] }))
      : null;

  const tip = cursor != null && cursor < ch.v.length ? cursor : null;
  const tipPos = tip != null ? { x: tf.sx(track.x[tip]), y: tf.sy(track.y[tip]) } : null;

  return (
    <div ref={wrapRef} className="relative h-full min-h-[360px] w-full" onMouseMove={onMove} onMouseLeave={() => onHover(null)}>
      <canvas ref={baseRef} className="absolute inset-0" />
      <canvas ref={overRef} className="pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1 font-mono text-[10px] text-hud-dim">
        {legend ? (
          legend.map((g) => (
            <div key={g.l} className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-4 rounded" style={{ background: g.c }} />
              {g.l}
            </div>
          ))
        ) : (
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-24 rounded"
              style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => rgb(turbo(t))).join(',')})` }}
            />
            {colorMode === 'speed' ? 'min → max speed' : colorMode === 'latg' ? '0 → peak lateral G' : '0 → 100 % grip'}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-2 right-3 font-mono text-[10px] text-hud-dim">grid 10 m · {track.length.toFixed(0)} m</div>
      {tip != null && tipPos && (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded border border-hud-cyan/50 bg-hud-bg/95 px-2.5 py-2 font-mono text-[11px] shadow-glow"
          style={{ left: Math.min(tipPos.x + 14, w - 230), top: Math.max(4, Math.min(tipPos.y - 80, h - 220)) }}
        >
          <div className="mb-1 flex justify-between text-hud-cyan">
            <span>s = {fmt(ch.s[tip], 1)} m</span>
            <span>t = {fmt(ch.t[tip], 2)} s</span>
          </div>
          <Row k="Speed" v={`${fmt(kph(ch.v[tip]), 1)} km/h`} />
          <Row k="Gear / rpm" v={`1 · ${fmt(ch.motorRpm[tip], 0)}`} />
          <Row k="Long / Lat G" v={`${fmt(ch.gLong[tip], 2)} / ${fmt(ch.gLat[tip], 2)} G`} />
          <Row k="Fz FL / FR" v={`${fmt(ch.fzFL[tip], 0)} / ${fmt(ch.fzFR[tip], 0)} N`} />
          <Row k="Fz RL / RR" v={`${fmt(ch.fzRL[tip], 0)} / ${fmt(ch.fzRR[tip], 0)} N`} />
          <Row k="K_us / SI" v={`${fmt(ch.understeerDegPerG[tip], 2)}°/G · ${fmt(ch.stabilityIndex[tip] * 100, 1)}%`} />
          <Row k="Thr / Brk" v={`${fmt(ch.throttle[tip] * 100, 0)} / ${fmt(ch.brake[tip] * 100, 0)} %`} />
          <Row k="P batt" v={`${fmt(ch.pElecKW[tip], 1)} kW`} />
          <Row k="Radius" v={Math.abs(ch.kappa[tip]) > 1e-4 ? `${fmt(1 / Math.abs(ch.kappa[tip]), 1)} m` : '∞'} />
          {ch.wheelLift[tip] && <div className="mt-1 font-bold text-hud-red">⚠ Inner Wheel Lift!</div>}
          <div className="mt-1 text-[10px]" style={{ color: MODE_COLORS[ch.mode[tip]] }}>
            {MODE_LABELS[ch.mode[tip]]}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-hud-dim">{k}</span>
      <span className="tabular-nums text-hud-text">{v}</span>
    </div>
  );
}
