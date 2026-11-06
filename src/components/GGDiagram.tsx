'use client';

import { memo, useMemo } from 'react';
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { GRAVITY } from '@/lib/physics';
import { ctxAyMax, longitudinalEnvelope, type LapResult, type SimulationContext } from '@/lib/solver';
import { CHART } from '@/lib/ui/colors';
import { strideFor } from '@/lib/ui/format';
import { tooltipStyle } from './ui';

interface Props {
  lap: LapResult;
  ctx: SimulationContext;
  cursor: number | null;
  baselineLap?: LapResult | null;
  baselineCtx?: SimulationContext | null;
}

/** Friction-ellipse envelope of the solver at speed v (G units), traced over the lateral range. */
function envelopeAt(ctx: SimulationContext, v: number) {
  const ayMax = ctxAyMax(ctx, v);
  const n = 48;
  const upper: { x: number; y: number }[] = [];
  const lower: { x: number; y: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const ay = -ayMax + (2 * ayMax * k) / n;
    const e = longitudinalEnvelope(ctx, v, ay);
    upper.push({ x: ay / GRAVITY, y: e.accel / GRAVITY });
    lower.push({ x: ay / GRAVITY, y: -e.decel / GRAVITY });
  }
  return [...upper, ...lower.reverse(), upper[0]];
}

function GGDiagramImpl({ lap, ctx, cursor, baselineLap, baselineCtx }: Props) {
  const ch = lap.channels;
  const points = useMemo(() => {
    const st = strideFor(ch.s.length, 900);
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < ch.s.length; i += st) out.push({ x: ch.gLat[i], y: ch.gLong[i] });
    return out;
  }, [ch]);

  const basePoints = useMemo(() => {
    if (!baselineLap) return [];
    const bch = baselineLap.channels;
    const st = strideFor(bch.s.length, 600);
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < bch.s.length; i += st) out.push({ x: bch.gLat[i], y: bch.gLong[i] });
    return out;
  }, [baselineLap]);

  const vLow = Math.max(8, lap.minSpeed);
  const vHigh = Math.max(vLow + 1, lap.maxSpeed);
  const envLow = useMemo(() => envelopeAt(ctx, vLow), [ctx, vLow]);
  const envHigh = useMemo(() => envelopeAt(ctx, vHigh), [ctx, vHigh]);
  const envHighBase = useMemo(() => (baselineCtx ? envelopeAt(baselineCtx, vHigh) : null), [baselineCtx, vHigh]);

  const cur = cursor != null && cursor < ch.s.length ? [{ x: ch.gLat[cursor], y: ch.gLong[cursor] }] : [];
  const maxEnvCoord = Math.max(
    ...envHigh.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))),
    ...(envHighBase ? envHighBase.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))) : [0]),
  );
  const lim = Math.ceil(maxEnvCoord * 2) / 2;

  return (
    <div className="relative h-full min-h-[320px] w-full">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 10, right: 14, bottom: 14, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey="x"
            domain={[-lim, lim]}
            stroke={CHART.axis}
            tick={{ fontSize: 10, fill: CHART.axis }}
            label={{ value: 'Lateral G', position: 'insideBottom', offset: -8, fill: CHART.axis, fontSize: 10 }}
            allowDataOverflow
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[-lim, Math.min(lim, 2)]}
            stroke={CHART.axis}
            tick={{ fontSize: 10, fill: CHART.axis }}
            width={36}
            allowDataOverflow
          />
          <ZAxis range={[10, 10]} />
          <ReferenceLine x={0} stroke={CHART.axis} strokeOpacity={0.4} />
          <ReferenceLine y={0} stroke={CHART.axis} strokeOpacity={0.4} />
          <Tooltip {...tooltipStyle} formatter={(v: number) => v.toFixed(2)} isAnimationActive={false} />
          {envHighBase && (
            <Scatter
              name={`Setup A Envelope @ ${(vHigh * 3.6).toFixed(0)} km/h`}
              data={envHighBase}
              line={{ stroke: CHART.violet, strokeWidth: 1.5, strokeDasharray: '6 3' }}
              shape={() => <g />}
              isAnimationActive={false}
            />
          )}
          <Scatter
            name={`Setup B Envelope @ ${(vHigh * 3.6).toFixed(0)} km/h`}
            data={envHigh}
            line={{ stroke: CHART.red, strokeWidth: 1.3 }}
            shape={() => <g />}
            isAnimationActive={false}
          />
          <Scatter
            name={`Setup B Envelope @ ${(vLow * 3.6).toFixed(0)} km/h`}
            data={envLow}
            line={{ stroke: CHART.amber, strokeWidth: 1.2, strokeDasharray: '4 3' }}
            shape={() => <g />}
            isAnimationActive={false}
          />
          {basePoints.length > 0 && (
            <Scatter name="Setup A (Baseline)" data={basePoints} fill={CHART.violet} fillOpacity={0.22} isAnimationActive={false} />
          )}
          <Scatter name="Setup B (Active)" data={points} fill={CHART.cyan} fillOpacity={0.35} isAnimationActive={false} />
          <Scatter
            name="Now"
            data={cur}
            isAnimationActive={false}
            shape={(p: { cx?: number; cy?: number }) => (
              <circle cx={p.cx} cy={p.cy} r={6} fill="#f8fafc" stroke={CHART.cyan} strokeWidth={2.5} style={{ filter: 'drop-shadow(0 0 6px #22d3ee)' }} />
            )}
          />
        </ScatterChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute right-4 top-3 space-y-0.5 text-right font-mono text-[10px]">
        <div style={{ color: CHART.red }}>— Setup B limit @ {(vHigh * 3.6).toFixed(0)} km/h</div>
        <div style={{ color: CHART.amber }}>-- Setup B limit @ {(vLow * 3.6).toFixed(0)} km/h</div>
        {envHighBase && <div style={{ color: CHART.violet }}>-- Setup A baseline limit</div>}
        <div className="text-hud-cyan">● Setup B operating points</div>
        {basePoints.length > 0 && <div className="text-hud-violet">● Setup A baseline points</div>}
        {cur.length > 0 && (
          <div className="text-hud-text">
            now: {cur[0].x.toFixed(2)} / {cur[0].y.toFixed(2)} G
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(GGDiagramImpl);
