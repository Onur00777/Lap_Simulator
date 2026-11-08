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
  magnitude: number;
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

  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 14; // margin for edge labels

  // Convert G-force to crosshair SVG coordinate
  const toCoords = (lat: number, long: number) => {
    // In motorsports crosshair:
    // x: Lateral G (+right, -left)
    // y: Longitudinal G (+acceleration up, -braking down)
    const normX = Math.max(-1.15, Math.min(1.15, lat / maxG));
    const normY = Math.max(-1.15, Math.min(1.15, long / maxG));
    const rawR = Math.hypot(normX, normY);
    const scale = rawR > 1.0 ? 1.0 / rawR : 1.0;
    return {
      x: cx + normX * scale * maxR,
      y: cy - normY * scale * maxR, // SVG Y is downwards
      magnitude: Math.hypot(lat, long),
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
  const r1G = (1.0 / maxG) * maxR;
  const r2G = (2.0 / maxG) * maxR;
  const r3G = maxR;

  return (
    <div
      className={`pointer-events-none rounded-xl border border-white/10 bg-[#0b0e17]/85 p-2.5 font-mono shadow-2xl backdrop-blur-md ${className}`}
      aria-label="Motorsport G-Force Crosshair Meter"
    >
      <div className="mb-1.5 flex items-center justify-between border-b border-white/[0.08] pb-1">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-300">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_6px_#f43f5e]" />
          <span>G-FORCE CROSSHAIR</span>
        </div>
        <div className="flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-rose-300 border border-rose-500/20">
          <span>|G| = {totalG.toFixed(2)} G</span>
        </div>
      </div>

      <div className="relative flex flex-col items-center justify-center">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="overflow-visible"
        >
          <defs>
            {/* Radial glow filter for current G-force dot */}
            <filter id="gforce-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id="gforce-core-grad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="35%" stopColor="#ff4560" />
              <stop offset="100%" stopColor="#ff1744" />
            </radialGradient>
          </defs>

          {/* Background circle backing */}
          <circle cx={cx} cy={cy} r={r3G} fill="rgba(15, 23, 42, 0.4)" />

          {/* Concentric G Rings */}
          {/* 1G Inner dashed ring */}
          <circle
            cx={cx}
            cy={cy}
            r={r1G}
            fill="none"
            stroke="rgba(255, 255, 255, 0.16)"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
          {/* 2G Middle dashed ring */}
          <circle
            cx={cx}
            cy={cy}
            r={r2G}
            fill="none"
            stroke="rgba(255, 255, 255, 0.22)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          {/* 3G Outer Solid Ring */}
          <circle
            cx={cx}
            cy={cy}
            r={r3G}
            fill="none"
            stroke="rgba(255, 255, 255, 0.4)"
            strokeWidth="1.2"
          />

          {/* Crosshair Axes */}
          {/* Horizontal Axis: Lateral G */}
          <line
            x1={cx - r3G - 4}
            y1={cy}
            x2={cx + r3G + 4}
            y2={cy}
            stroke="rgba(255, 255, 255, 0.25)"
            strokeWidth="1"
          />
          {/* Vertical Axis: Longitudinal G */}
          <line
            x1={cx}
            y1={cy - r3G - 4}
            x2={cx}
            y2={cy + r3G + 4}
            stroke="rgba(255, 255, 255, 0.25)"
            strokeWidth="1"
          />

          {/* Axis & Scale Labels */}
          <text
            x={cx}
            y={cy - r3G - 5}
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[8px] font-semibold tracking-wider"
          >
            ACC
          </text>
          <text
            x={cx}
            y={cy + r3G + 11}
            textAnchor="middle"
            className="fill-slate-400 font-mono text-[8px] font-semibold tracking-wider"
          >
            BRK
          </text>
          <text
            x={cx - r3G - 6}
            y={cy + 3}
            textAnchor="end"
            className="fill-slate-400 font-mono text-[8px] font-semibold"
          >
            L
          </text>
          <text
            x={cx + r3G + 6}
            y={cy + 3}
            textAnchor="start"
            className="fill-slate-400 font-mono text-[8px] font-semibold"
          >
            R
          </text>

          {/* Ring Labels */}
          <text
            x={cx + 3}
            y={cy - r1G + 8}
            className="fill-slate-500 font-mono text-[7px]"
          >
            1G
          </text>
          <text
            x={cx + 3}
            y={cy - r2G + 8}
            className="fill-slate-500 font-mono text-[7px]"
          >
            2G
          </text>
          <text
            x={cx + 3}
            y={cy - r3G + 9}
            className="fill-slate-400 font-mono text-[7px] font-medium"
          >
            3G
          </text>

          {/* Center Origin Mark */}
          <circle cx={cx} cy={cy} r={1.5} fill="rgba(255, 255, 255, 0.4)" />

          {/* Smooth Fading Comet Trail */}
          {trail.map((pt, idx) => {
            const fraction = (idx + 1) / trail.length;
            const alpha = (fraction * fraction * 0.7).toFixed(3);
            const radius = 1.0 + fraction * 2.2;
            return (
              <circle
                key={idx}
                cx={pt.x}
                cy={pt.y}
                r={radius}
                fill={`rgba(255, 42, 75, ${alpha})`}
              />
            );
          })}

          {/* Vector Line from Center to Current G */}
          <line
            x1={cx}
            y1={cy}
            x2={currentPt.x}
            y2={currentPt.y}
            stroke="rgba(255, 42, 75, 0.4)"
            strokeWidth="1.2"
            strokeDasharray="2 2"
          />

          {/* Glowing Red/Crimson Indicator Ball */}
          <circle
            cx={currentPt.x}
            cy={currentPt.y}
            r={5.5}
            fill="url(#gforce-core-grad)"
            filter="url(#gforce-glow)"
            stroke="#ffffff"
            strokeWidth="1.2"
          />
          {/* Crisp White Core Center */}
          <circle cx={currentPt.x} cy={currentPt.y} r={1.6} fill="#ffffff" />
        </svg>

        {/* Micro Axis Metrics Footer */}
        <div className="mt-1 flex w-full items-center justify-between px-1 text-[9px] font-mono tabular-nums text-slate-400">
          <div className="flex items-center gap-1">
            <span className="text-slate-500">Lat:</span>
            <span className={gLat >= 0 ? 'text-cyan-300' : 'text-amber-300'}>
              {gLat >= 0 ? '+' : ''}
              {gLat.toFixed(2)} G
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500">Long:</span>
            <span className={gLong >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
              {gLong >= 0 ? '+' : ''}
              {gLong.toFixed(2)} G
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
