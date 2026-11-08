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
  isPlaying?: boolean;
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
  isPlaying = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const { w, h } = useSize(wrapRef);
  const ch = lap.channels;
  const [isHovering, setIsHovering] = useState(false);

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
    const padTop = 36;
    const padX = 36;
    const padBottom = 96;
    const allX = [...rl.leftCurbX, ...rl.rightCurbX, ...track.x];
    const allY = [...rl.leftCurbY, ...rl.rightCurbY, ...track.y];
    const minX = Math.min(...allX);
    const maxX = Math.max(...allX);
    const minY = Math.min(...allY);
    const maxY = Math.max(...allY);
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((w - 2 * padX) / spanX, (h - padTop - padBottom) / spanY);
    const ox = (w - spanX * scale) / 2;
    const oy = padBottom + (h - padTop - padBottom - spanY * scale) / 2;
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

  // overlay: active directional car + ghost car (dual-vehicle replay)
  useEffect(() => {
    const c = overRef.current;
    if (!c) return;
    const ctx = setupCanvas(c, w, h);
    ctx.clearRect(0, 0, w, h);

    // 1. Draw Orange Ghost Car (Centerline Reference) FIRST so active car is on top
    if (ghostLap && ghostCursor != null) {
      const gxArr = ghostTrack ? ghostTrack.x : rl.centerX;
      const gyArr = ghostTrack ? ghostTrack.y : rl.centerY;
      const ghArr = ghostTrack ? ghostTrack.heading : track.heading;
      const gi = Math.min(gxArr.length - 1, Math.max(0, ghostCursor));
      const gx = tf.sx(gxArr[gi]);
      const gy = tf.sy(gyArr[gi]);
      const gth = ghArr[gi] ?? 0;

      ctx.save();
      // Outer subtle dashed ring (#f59e0b with 60% opacity)
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 2.5]);
      ctx.beginPath();
      ctx.arc(gx, gy, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Stylized translucent ghost chevron oriented along heading
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(-gth);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.strokeStyle = 'rgba(254, 243, 199, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(8, 0); // nose
      ctx.lineTo(-6, -5.5); // left wing
      ctx.lineTo(-2.5, 0); // inner notch
      ctx.lineTo(-6, 5.5); // right wing
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Label "GHOST" in tiny 8px uppercase font directly above it
      ctx.font = 'bold 8px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
      ctx.shadowColor = '#000000';
      ctx.shadowBlur = 3;
      ctx.fillText('GHOST', gx, gy - 12);
      ctx.restore();
    }

    // 2. Draw Cyan Active Car (Optimal Apex Line) on top
    if (cursor != null && cursor < track.x.length) {
      const ci = cursor;
      const x = tf.sx(track.x[ci]);
      const y = tf.sy(track.y[ci]);
      const th = track.heading[ci];
      const nPts = track.x.length;

      ctx.save();

      // A. 10-meter fading neon speed trail behind it
      const trailPoints = Math.min(28, Math.max(8, Math.round(10 / Math.max(0.2, track.ds))));
      const currentSpeed = ch.v[ci] ?? 10;
      const speedAlpha = Math.min(1, Math.max(0.4, currentSpeed / 25));

      for (let k = trailPoints; k >= 1; k--) {
        const prevIdx = track.closed ? (ci - k + nPts) % nPts : Math.max(0, ci - k);
        const nextIdx = track.closed ? (ci - k + 1 + nPts) % nPts : Math.max(0, ci - k + 1);
        if (prevIdx === nextIdx) continue;

        const x0 = tf.sx(track.x[prevIdx]);
        const y0 = tf.sy(track.y[prevIdx]);
        const x1 = tf.sx(track.x[nextIdx]);
        const y1 = tf.sy(track.y[nextIdx]);

        const fraction = 1 - k / trailPoints;
        const alpha = fraction * fraction * 0.75 * speedAlpha;
        const lineW = 1.0 + fraction * 2.8;

        ctx.strokeStyle = `rgba(34, 211, 238, ${alpha.toFixed(3)})`;
        ctx.lineWidth = lineW;
        ctx.shadowColor = '#06b6d4';
        ctx.shadowBlur = fraction * 8;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }

      // B. Subtle dynamic radial glow
      ctx.shadowBlur = 0;
      const glowGrad = ctx.createRadialGradient(x, y, 1, x, y, 18);
      glowGrad.addColorStop(0, 'rgba(34, 211, 238, 0.45)');
      glowGrad.addColorStop(0.5, 'rgba(6, 182, 212, 0.2)');
      glowGrad.addColorStop(1, 'rgba(6, 182, 212, 0)');
      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();

      // C. Sleek directional arrow / teardrop wedge oriented along instantaneous yaw
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-th);

      const bodyGrad = ctx.createLinearGradient(-8, 0, 10, 0);
      bodyGrad.addColorStop(0, '#0284c7');
      bodyGrad.addColorStop(0.6, '#06b6d4');
      bodyGrad.addColorStop(1, '#e0f2fe');

      ctx.shadowColor = '#22d3ee';
      ctx.shadowBlur = 12;
      ctx.fillStyle = bodyGrad;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;

      ctx.beginPath();
      ctx.moveTo(10, 0); // nose
      ctx.lineTo(-7, -5.5); // left wing
      ctx.lineTo(-4, 0); // rear diffuser notch
      ctx.lineTo(-7, 5.5); // right wing
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Center luminous core cockpit dot
      ctx.shadowBlur = 4;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(1, 0, 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      ctx.restore();
    }
  }, [cursor, ghostLap, ghostTrack, ghostCursor, rl, tf, track, w, h, ch.v]);

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
    setIsHovering(best >= 0);
    onHover(best >= 0 ? best : null);
  };

  const legend =
    colorMode === 'mode'
      ? (['brake', 'full-throttle', 'part-throttle', 'cornering', 'coast'] as const).map((m) => ({ c: MODE_COLORS[m], l: MODE_LABELS[m] }))
      : null;

  const activeIdx = cursor != null && cursor >= 0 && cursor < ch.v.length ? cursor : 0;

  const deltaInfo = useMemo(() => {
    if (!ghostLap || ghostCursor == null) return null;
    const gi = Math.min(ghostLap.channels.s.length - 1, Math.max(0, ghostCursor));
    const sOpt = ch.s[activeIdx] ?? 0;
    const sGhost = ghostLap.channels.s[gi] ?? 0;
    const distDelta = sOpt - sGhost;
    const vAvg = Math.max(2, ((ch.v[activeIdx] ?? 10) + (ghostLap.channels.v[gi] ?? 10)) / 2);
    const timeDelta = -distDelta / vAvg;
    const isOptimalLeading = distDelta >= 0;
    return {
      isOptimalLeading,
      timeStr: `${isOptimalLeading ? '-' : '+'}${Math.abs(timeDelta).toFixed(2)} s`,
      distStr: `${isOptimalLeading ? '-' : '+'}${Math.abs(distDelta).toFixed(1)} m`,
    };
  }, [ghostLap, ghostCursor, activeIdx, ch.s, ch.v]);

  const isHoverBadge = isHovering && !isPlaying;

  return (
    <div
      ref={wrapRef}
      className="relative h-full min-h-[360px] w-full"
      onMouseMove={onMove}
      onMouseLeave={() => {
        setIsHovering(false);
        onHover(null);
      }}
    >
      <canvas ref={baseRef} className="absolute inset-0" />
      <canvas ref={overRef} className="pointer-events-none absolute inset-0" />
      {/* Apple Pro Minimalist Horizontal Canvas Legend */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2.5 rounded-lg border border-white/[0.08] bg-[#0c0e17]/85 px-3 py-1.5 font-mono text-[10px] text-slate-300 shadow-lg backdrop-blur-md">
        {legend ? (
          <div className="flex flex-wrap items-center gap-2.5">
            {legend.map((g) => (
              <div key={g.l} className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full shadow-sm" style={{ background: g.c }} />
                <span>{g.l}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-20 rounded-full"
              style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => rgb(turbo(t))).join(',')})` }}
            />
            <span>{colorMode === 'speed' ? 'Min → Max Speed' : colorMode === 'latg' ? '0 → Peak Lat G' : '0 → 100% Grip'}</span>
          </div>
        )}
        <div className="h-3 w-[1px] bg-white/[0.12]" />
        <div className="flex items-center gap-2 text-[9px] text-slate-400">
          <span className="inline-block h-0.5 w-3 border-b border-dashed border-slate-400" />
          <span>Centerline</span>
          <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee]" />
          <span className="text-cyan-300 font-medium">{rl.mode === 'optimal' ? 'Optimal Apex' : 'Active Car'}</span>
          {ghostLap && (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_#f59e0b]" />
              <span className="text-amber-300 font-medium">{ghostLabel}</span>
            </>
          )}
        </div>
      </div>

      {/* Track & Alignment Footnote */}
      <div className="pointer-events-none absolute bottom-2.5 left-3 z-10 font-mono text-[10px] text-slate-400">
        {rl.mode === 'optimal' ? (
          <span className="text-cyan-300">
            Out-In-Out Optimal Line · width {fmt(rl.trackWidthM, 1)} m · ΔL {fmt(rl.lengthDeltaM, 1)} m · κ_peak −{fmt(rl.peakCurvatureReductionPct, 1)}%
          </span>
        ) : (
          <span>Geometric Centerline · width {fmt(rl.trackWidthM, 1)} m</span>
        )}
        <span className="ml-2 text-slate-500">· grid 10 m · {track.length.toFixed(0)} m</span>
      </div>

      {/* Docked Live Car Telemetry HUD */}
      <aside
        aria-label="Live Car Telemetry HUD"
        className="pointer-events-none absolute bottom-3 right-3 z-10 w-[300px] max-w-[calc(100%-24px)] rounded-xl border border-white/10 bg-[#0b0e17]/85 p-3 font-mono text-xs shadow-2xl backdrop-blur-md"
      >
        <div className="mb-2 flex items-center justify-between border-b border-white/[0.08] pb-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-300">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                isHoverBadge
                  ? 'bg-amber-400 shadow-[0_0_6px_#f59e0b]'
                  : 'bg-cyan-400 animate-pulse shadow-[0_0_6px_#22d3ee]'
              }`}
            />
            <span>{isHoverBadge ? 'HOVER CURSOR' : 'LIVE CAR'} TELEMETRY</span>
          </div>
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: `${MODE_COLORS[ch.mode[activeIdx]]}22`,
              color: MODE_COLORS[ch.mode[activeIdx]],
              border: `1px solid ${MODE_COLORS[ch.mode[activeIdx]]}55`,
            }}
          >
            {MODE_LABELS[ch.mode[activeIdx]]}
          </span>
        </div>

        {/* Dedicated Zero-Shift Instantaneous Telemetry Header */}
        <div className="mb-2 flex items-center justify-between rounded-md border border-white/[0.06] bg-black/40 px-2 py-1 font-mono text-[11px] tabular-nums">
          <span className="text-[10px] uppercase tracking-wider text-slate-400">
            {isHoverBadge ? 'Hover Pos' : 'Instant'}:
          </span>
          <span className="font-medium text-cyan-300">
            s = {fmt(ch.s[activeIdx], 1)} m <span className="text-slate-500">·</span> <span className="text-white">{fmt(kph(ch.v[activeIdx]), 1)} km/h</span>
          </span>
        </div>

        {deltaInfo && (
          <div
            className={`mb-2 flex items-center justify-between rounded-md px-2 py-1 text-[10px] font-semibold ${
              deltaInfo.isOptimalLeading
                ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border border-amber-500/30 bg-amber-500/10 text-amber-300'
            }`}
          >
            <span className="flex items-center gap-1">
              <span>{deltaInfo.isOptimalLeading ? '▲' : '▼'}</span>
              <span>{deltaInfo.isOptimalLeading ? 'OPTIMAL LEAD' : 'GHOST LEAD'}</span>
            </span>
            <span className="tabular-nums">
              {deltaInfo.timeStr} ({deltaInfo.distStr})
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <div className="flex justify-between">
            <span className="text-slate-400">Distance s:</span>
            <span className="tabular-nums text-white font-medium">{fmt(ch.s[activeIdx], 1)} m</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Lap time t:</span>
            <span className="tabular-nums text-cyan-300 font-medium">{fmt(ch.t[activeIdx], 2)} s</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Speed:</span>
            <span className="tabular-nums text-white font-medium">{fmt(kph(ch.v[activeIdx]), 1)} km/h</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Lat offset:</span>
            <span className="tabular-nums text-slate-300">
              {rl.offsetN[activeIdx] >= 0 ? '+' : ''}
              {fmt(rl.offsetN[activeIdx], 2)} m
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Long G:</span>
            <span className="tabular-nums text-white font-medium">{fmt(ch.gLong[activeIdx], 2)} G</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Lat G:</span>
            <span className="tabular-nums text-white font-medium">{fmt(ch.gLat[activeIdx], 2)} G</span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Fz Front:</span>
            <span className="tabular-nums text-slate-300">
              {fmt(ch.fzFL[activeIdx], 0)} / {fmt(ch.fzFR[activeIdx], 0)} N
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Fz Rear:</span>
            <span className="tabular-nums text-slate-300">
              {fmt(ch.fzRL[activeIdx], 0)} / {fmt(ch.fzRR[activeIdx], 0)} N
            </span>
          </div>

          <div className="flex justify-between">
            <span className="text-slate-400">Thr / Brk:</span>
            <span className="tabular-nums text-white">
              {fmt(ch.throttle[activeIdx] * 100, 0)}% / {fmt(ch.brake[activeIdx] * 100, 0)}%
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Radius:</span>
            <span className="tabular-nums text-slate-300">
              {Math.abs(ch.kappa[activeIdx]) > 1e-4 ? `${fmt(1 / Math.abs(ch.kappa[activeIdx]), 1)} m` : '∞'}
            </span>
          </div>
        </div>

        {ch.wheelLift[activeIdx] && (
          <div className="mt-1.5 flex items-center justify-center gap-1 rounded bg-rose-500/20 py-0.5 text-[10px] font-bold text-rose-300 border border-rose-500/30">
            <span>⚠</span>
            <span>Inner Wheel Lift!</span>
          </div>
        )}
      </aside>
    </div>
  );
}
