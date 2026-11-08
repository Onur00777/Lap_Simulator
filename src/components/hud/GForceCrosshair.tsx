'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface GForceCrosshairProps {
  /** Longitudinal G (positive = acceleration, negative = braking) */
  gLong: number;
  /** Lateral G (positive = right cornering, negative = left cornering) */
  gLat: number;
  /** Max scale limit in G's (defaults to 3.0 G) */
  maxG?: number;
  /** Max number of history samples for the comet trail (default: 25) */
  trailLength?: number;
  /** Container styling overrides */
  className?: string;
}

interface TrailPoint {
  x: number;
  y: number;
}

export default function GForceCrosshair({
  gLong,
  gLat,
  maxG = 3.0,
  trailLength = 25,
  className = '',
}: GForceCrosshairProps) {
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const prevRef = useRef<{ gLong: number; gLat: number }>({ gLong, gLat });

  const size = 150;
  const cx = 75;
  const cy = 75;
  const maxR = 60; // Represents 3.0 G
  const midR = 30; // Represents 1.5 G

  // Convert G-force to crosshair SVG coordinate clamped inside outer circle
  const toCoords = (lat: number, long: number) => {
    const normX = lat / maxG;
    const normY = long / maxG;
    const dist = Math.hypot(normX, normY);
    const clamp = dist > 1.0 ? 1.0 / dist : 1.0;
    return {
      x: cx + normX * clamp * maxR,
      y: cy - normY * clamp * maxR, // SVG Y is downwards
    };
  };

  const currentPt = toCoords(gLat, gLong);

  // Update comet trail
  useEffect(() => {
    if (
      Math.abs(prevRef.current.gLong - gLong) > 0.005 ||
      Math.abs(prevRef.current.gLat - gLat) > 0.005
    ) {
      prevRef.current = { gLong, gLat };
      setTrail((prev) => {
        const next = [...prev, currentPt];
        if (next.length > trailLength) {
          return next.slice(next.length - trailLength);
        }
        return next;
      });
    }
  }, [gLong, gLat, currentPt.x, currentPt.y, trailLength, currentPt]);

  const totalG = Math.hypot(gLong, gLat);

  return (
    <div
      className={`pointer-events-none rounded-xl border border-white/10 bg-[#0b0e17]/85 p-2.5 font-mono shadow-2xl backdrop-blur-md ${className}`}
      aria-label="Motorsport Circular G-Force Crosshair Meter"
    >
      {/* Header */}
      <div className="mb-1 flex items-center justify-between border-b border-white/[0.08] pb-1">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-300">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_6px_#f43f5e]" />
          <span>G-FORCE CROSSHAIR</span>
        </div>
        <div className="flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-rose-300 border border-rose-500/20">
          <span>|G| = {totalG.toFixed(2)} G</span>
        </div>
      </div>

      {/* 150px x 150px Circular Crosshair Target */}
      <div className="relative flex flex-col items-center justify-center">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="overflow-visible"
        >
          <defs>
            {/* Red radial glow filter for indicator ball */}
            <filter id="gforce-red-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id="gforce-dot-grad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#ff4560" />
              <stop offset="100%" stopColor="#ff2a4b" />
            </radialGradient>
          </defs>

          {/* Background target disk */}
          <circle cx={cx} cy={cy} r={maxR} fill="rgba(15, 23, 42, 0.45)" />

          {/* Middle dashed circle (1.5 G) */}
          <circle
            cx={cx}
            cy={cy}
            r={midR}
            fill="none"
            stroke="rgba(255, 255, 255, 0.2)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />

          {/* Crisp white/slate outer circle (r = 60, representing 3.0 G) */}
          <circle
            cx={cx}
            cy={cy}
            r={maxR}
            fill="none"
            stroke="rgba(255, 255, 255, 0.38)"
            strokeWidth="1.2"
          />

          {/* Full '+' crosshair lines intersecting at (cx, cy) */}
          {/* Horizontal line from left to right edge */}
          <line
            x1={cx - maxR}
            y1={cy}
            x2={cx + maxR}
            y2={cy}
            stroke="rgba(255, 255, 255, 0.28)"
            strokeWidth="1"
          />
          {/* Vertical line from top to bottom edge */}
          <line
            x1={cx}
            y1={cy - maxR}
            x2={cx}
            y2={cy + maxR}
            stroke="rgba(255, 255, 255, 0.28)"
            strokeWidth="1"
          />

          {/* Micro Axis Labels */}
          <text
            x={cx}
            y={cy - maxR + 9}
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[7px] font-semibold tracking-wider"
          >
            ACC
          </text>
          <text
            x={cx}
            y={cy + maxR - 4}
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[7px] font-semibold tracking-wider"
          >
            BRK
          </text>
          <text
            x={cx - maxR + 8}
            y={cy - 2}
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[7px] font-semibold"
          >
            L
          </text>
          <text
            x={cx + maxR - 8}
            y={cy - 2}
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[7px] font-semibold"
          >
            R
          </text>

          {/* Ring G-level labels */}
          <text
            x={cx + 3}
            y={cy - midR + 7}
            className="fill-slate-500 font-mono text-[6px]"
          >
            1.5G
          </text>
          <text
            x={cx + 3}
            y={cy - maxR + 18}
            className="fill-slate-400 font-mono text-[6px] font-medium"
          >
            3.0G
          </text>

          {/* Center Zero Origin Mark */}
          <circle cx={cx} cy={cy} r={1.5} fill="rgba(255, 255, 255, 0.5)" />

          {/* Smooth Fading Comet Trail */}
          {trail.map((pt, idx) => {
            const fraction = (idx + 1) / trail.length;
            const alpha = (fraction * fraction * 0.75).toFixed(3);
            const r = 1.0 + fraction * 2.5;
            return (
              <circle
                key={idx}
                cx={pt.x}
                cy={pt.y}
                r={r}
                fill={`rgba(255, 42, 75, ${alpha})`}
              />
            );
          })}

          {/* Vector dashed connecting line */}
          <line
            x1={cx}
            y1={cy}
            x2={currentPt.x}
            y2={currentPt.y}
            stroke="rgba(255, 42, 75, 0.45)"
            strokeWidth="1.2"
            strokeDasharray="2 2"
          />

          {/* Bright Red Dot (#ff2a4b, radius 6px, with red glow) */}
          <circle
            cx={currentPt.x}
            cy={currentPt.y}
            r={6}
            fill="url(#gforce-dot-grad)"
            filter="url(#gforce-red-glow)"
            stroke="#ffffff"
            strokeWidth="1.4"
          />
          {/* Crisp White Core Dot */}
          <circle cx={currentPt.x} cy={currentPt.y} r={2} fill="#ffffff" />
        </svg>

        {/* Compact Numeric Readouts in Corners */}
        <div className="mt-1 flex w-full items-center justify-between px-1.5 text-[9px] font-mono tabular-nums text-slate-300">
          <div className="flex items-center gap-1 rounded bg-black/40 px-1.5 py-0.5 border border-white/[0.05]">
            <span className="text-slate-500">LAT:</span>
            <span className={gLat >= 0 ? 'text-cyan-300' : 'text-amber-300'}>
              {gLat >= 0 ? '+' : ''}{gLat.toFixed(2)}G
            </span>
          </div>
          <div className="flex items-center gap-1 rounded bg-black/40 px-1.5 py-0.5 border border-white/[0.05]">
            <span className="text-slate-500">LONG:</span>
            <span className={gLong >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
              {gLong >= 0 ? '+' : ''}{gLong.toFixed(2)}G
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
