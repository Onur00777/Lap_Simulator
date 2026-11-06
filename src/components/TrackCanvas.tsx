'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { solveRacingLine, type LapResult, type RacingLineSolution } from '@/lib/solver';
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
  track: Track & { racingLine?: RacingLineSolution };
  lap: LapResult;
  colorMode: ColorMode;
  cursor: number | null;
  /** Optional ghost lap for dual-dot replay (Centerline / Baseline Setup A vs Optimal / Active Setup B). */
  ghostLap?: LapResult | null;
  ghostTrack?: Track | null;
  ghostCursor?: number | null;
  ghostLabel?: string;
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

export default function TrackCanvas({
  track,
  lap,
  colorMode,
  cursor,
  ghostLap,
  ghostTrack,
  ghostCursor,
  ghostLabel = 'Centerline Ghost',
  onHover,
  mapAlign,
  mapSrcOverride,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const { w, h } = useSize(wrapRef);
  const ch = lap.channels;

  const rl: RacingLineSolution = useMemo(() => track.racingLine ?? solveRacingLine(track), [track]);

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
    const pad = 38;
    const allX = [...rl.leftCurbX, ...rl.rightCurbX, ...track.x];
    const allY = [...rl.leftCurbY, ...rl.rightCurbY, ...track.y];
    const minX = Math.min(...allX);
    const maxX = Math.max(...allX);
    const minY = Math.min(...allY);
    const maxY = Math.max(...allY);
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    const ox = (w - spanX * scale) / 2;
    const oy = (h - spanY * scale) / 2;
    return { sx: (x) => ox + (x - minX) * scale, sy: (y) => h - oy - (y - minY) * scale, scale };
  }, [track, rl, w, h]);

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
      for (let x = tf.sx(Math.floor(Math.min(...rl.centerX) / 10) * 10); x < w; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = tf.sy(Math.floor(Math.min(...rl.centerY) / 10) * 10); y > 0; y -= step) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }

    const n = track.x.length;
    const segs = track.closed ? n : n - 1;

    // 1. Track ribbon asphalt surface + left/right curb boundaries
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0e1722';
    ctx.lineWidth = Math.max(10, rl.trackWidthM * tf.scale);
    ctx.beginPath();
    ctx.moveTo(tf.sx(rl.centerX[0]), tf.sy(rl.centerY[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(tf.sx(rl.centerX[i]), tf.sy(rl.centerY[i]));
    if (track.closed) ctx.closePath();
    ctx.stroke();

    // Left & Right curb boundary lines
    ctx.save();
    ctx.strokeStyle = 'rgba(148,163,184,0.42)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(tf.sx(rl.leftCurbX[0]), tf.sy(rl.leftCurbY[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(tf.sx(rl.leftCurbX[i]), tf.sy(rl.leftCurbY[i]));
    if (track.closed) ctx.closePath();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tf.sx(rl.rightCurbX[0]), tf.sy(rl.rightCurbY[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(tf.sx(rl.rightCurbX[i]), tf.sy(rl.rightCurbY[i]));
    if (track.closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 2. Dashed grey centerline
    ctx.save();
    ctx.strokeStyle = rl.mode === 'optimal' ? 'rgba(148,163,184,0.55)' : 'rgba(148,163,184,0.3)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(tf.sx(rl.centerX[0]), tf.sy(rl.centerY[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(tf.sx(rl.centerX[i]), tf.sy(rl.centerY[i]));
    if (track.closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 3. Glowing colored racing line (cutting outer entry curb -> inner apex curb -> outer exit curb)
    ctx.save();
    if (rl.mode === 'optimal') {
      ctx.shadowColor = 'rgba(34,211,238,0.35)';
      ctx.shadowBlur = 6;
    }
    ctx.lineWidth = Math.max(2.6, 0.95 * tf.scale);
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      ctx.strokeStyle = colorAt(i);
      ctx.beginPath();
      ctx.moveTo(tf.sx(track.x[i]), tf.sy(track.y[i]));
      ctx.lineTo(tf.sx(track.x[j]), tf.sy(track.y[j]));
      ctx.stroke();
    }
    ctx.restore();

    // Start / finish line across full track width
    const th = track.heading[0];
    const nx = -Math.sin(th);
    const ny = Math.cos(th);
    const sfHalf = Math.max(3, rl.trackWidthM * 0.55);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tf.sx(rl.centerX[0] + sfHalf * nx), tf.sy(rl.centerY[0] + sfHalf * ny));
    ctx.lineTo(tf.sx(rl.centerX[0] - sfHalf * nx), tf.sy(rl.centerY[0] - sfHalf * ny));
    ctx.stroke();

    // Sector markers
    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = '#a78bfa';
    track.sectors.slice(1, -1).forEach((s, k) => {
      const i = Math.min(n - 1, Math.round(s / track.ds));
      ctx.beginPath();
      ctx.arc(tf.sx(track.x[i]), tf.sy(track.y[i]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`S${k + 2}`, tf.sx(track.x[i]) + 6, tf.sy(track.y[i]) - 6);
    });

    // Direction arrows
    if (track.direction) {
      const stride = Math.max(8, Math.round(80 / track.ds));
      for (let i = stride; i < n; i += stride) {
        const x = tf.sx(rl.centerX[i]);
        const y = tf.sy(rl.centerY[i]);
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

    // Pit lane and garage stalls
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
      const stepPit = Math.max(1, Math.floor((pit.x.length - 1) / pit.garages));
      for (let g = 0; g < pit.garages; g++) {
        const i = Math.min(pit.x.length - 1, g * stepPit);
        ctx.fillRect(tf.sx(pit.x[i]) - 1.5, tf.sy(pit.y[i]) - 1.5, 3, 3);
      }
      ctx.font = '10px Consolas, monospace';
      ctx.fillText(`${pit.garages} pit`, tf.sx(pit.x[0]) + 6, tf.sy(pit.y[0]) - 6);
      ctx.restore();
    }

    // Corner labels — named landmarks when the circuit provides them
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
  }, [track, lap, rl, tf, w, h, colorAt, mapImg, mapAlign, mapSrcOverride]);

  // overlay: active cursor dot + ghost dot (dual-dot replay)
  useEffect(() => {
    const c = overRef.current;
    if (!c) return;
    const ctx = setupCanvas(c, w, h);
    ctx.clearRect(0, 0, w, h);

    // 1. Draw Ghost Dot (Baseline / Centerline Ghost)
    if (ghostLap && ghostCursor != null) {
      const gxArr = ghostTrack ? ghostTrack.x : rl.centerX;
      const gyArr = ghostTrack ? ghostTrack.y : rl.centerY;
      const ghArr = ghostTrack ? ghostTrack.heading : track.heading;
      const gi = Math.min(gxArr.length - 1, Math.max(0, ghostCursor));
      const gx = tf.sx(gxArr[gi]);
      const gy = tf.sy(gyArr[gi]);
      const gth = ghArr[gi] ?? 0;

      ctx.save();
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 10;
      ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
      ctx.strokeStyle = '#fef3c7';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(gx, gy, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + 15 * Math.cos(gth), gy - 15 * Math.sin(gth));
      ctx.stroke();

      ctx.font = 'bold 9px Consolas, monospace';
      ctx.fillStyle = '#fbbf24';
      ctx.fillText('GHOST', gx + 8, gy + 12);
      ctx.restore();
    }

    // 2. Draw Primary Active Dot (Optimal Racing Line / Active Setup)
    if (cursor == null || cursor >= track.x.length) return;
    const x = tf.sx(track.x[cursor]);
    const y = tf.sy(track.y[cursor]);
    const th = track.heading[cursor];
    ctx.save();
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 18 * Math.cos(th), y - 18 * Math.sin(th));
    ctx.stroke();
    ctx.restore();
  }, [cursor, ghostLap, ghostTrack, ghostCursor, rl, tf, track, w, h]);

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
        <div className="mt-1 flex items-center gap-2 border-t border-hud-line/60 pt-1 text-[9px]">
          <span className="inline-block h-0.5 w-3.5 border-b border-dashed border-slate-400" />
          <span>Centerline</span>
          <span className="inline-block h-2 w-2 rounded-full bg-hud-cyan shadow-[0_0_5px_#22d3ee]" />
          <span className="text-hud-cyan">{rl.mode === 'optimal' ? 'Optimal Apex' : 'Active Car'}</span>
          {ghostLap && (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_5px_#f59e0b]" />
              <span className="text-hud-amber">{ghostLabel}</span>
            </>
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-2 left-3 font-mono text-[10px] text-hud-dim">
        {rl.mode === 'optimal' ? (
          <span className="text-hud-cyan">
            Out-In-Out Optimal Line · width {fmt(rl.trackWidthM, 1)} m · ΔL {fmt(rl.lengthDeltaM, 1)} m · κ_peak −{fmt(rl.peakCurvatureReductionPct, 1)}%
          </span>
        ) : (
          <span>Geometric Centerline · width {fmt(rl.trackWidthM, 1)} m</span>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-2 right-3 font-mono text-[10px] text-hud-dim">grid 10 m · {track.length.toFixed(0)} m</div>
      {tip != null && tipPos && (
        <div
          className="pointer-events-none absolute z-10 w-56 rounded border border-hud-cyan/50 bg-hud-bg/95 px-2.5 py-2 font-mono text-[11px] shadow-glow"
          style={{ left: Math.min(tipPos.x + 14, w - 230), top: Math.max(4, Math.min(tipPos.y - 80, h - 235)) }}
        >
          <div className="mb-1 flex justify-between text-hud-cyan">
            <span>s = {fmt(ch.s[tip], 1)} m</span>
            <span>t = {fmt(ch.t[tip], 2)} s</span>
          </div>
          <Row k="Speed" v={`${fmt(kph(ch.v[tip]), 1)} km/h`} />
          <Row k="Lat offset n(s)" v={`${rl.offsetN[tip] >= 0 ? '+' : ''}${fmt(rl.offsetN[tip], 2)} m`} />
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
