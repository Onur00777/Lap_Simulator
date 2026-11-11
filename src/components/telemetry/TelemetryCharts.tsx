'use client';

import { memo, useId, useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Area,
  ComposedChart,
} from 'recharts';
import type { LapResult } from '@/lib/solver';
import { deltaTimeAtDistance, sampleDeltaTime, sampleLapDistance } from '@/lib/telemetry/distance';
import { CHART } from '@/lib/ui/colors';
import { strideFor } from '@/lib/ui/format';
import { tickFmt, tooltipStyle } from '../ui';

interface Props {
  lap: LapResult;
  baselineLap?: LapResult | null;
  cursorS: number | null;
  onHoverS: (s: number | null) => void;
}

interface Row {
  s: number;
  v: number;
  vBase?: number;
  vLim: number;
  gLong: number;
  gLat: number;
  energy: number;
  heat: number;
  pElec: number;
  pWheel: number;
  torque: number;
  fzFL: number;
  fzFR: number;
  fzRL: number;
  fzRR: number;
  kus: number;
}

const SYNC = 'lap-telemetry';

function useRows(lap: LapResult, baselineLap?: LapResult | null): Row[] {
  return useMemo(() => {
    const ch = lap.channels;
    const bch = baselineLap?.channels;
    const n = ch.s.length;
    const st = strideFor(n, 700);
    const rows: Row[] = [];
    for (let i = 0; i < n; i += st) {
      const vBase = baselineLap && bch && ch.s[i] <= baselineLap.distance
        ? sampleLapDistance(baselineLap, bch.v, ch.s[i], bch.v[0]) * 3.6
        : undefined;
      rows.push({
        s: +ch.s[i].toFixed(2),
        v: +(ch.v[i] * 3.6).toFixed(2),
        vBase,
        vLim: +(Math.min(ch.vLimit[i], 45) * 3.6).toFixed(2),
        gLong: +ch.gLong[i].toFixed(3),
        gLat: +ch.gLat[i].toFixed(3),
        energy: +(ch.energyKWh[i] * 1000).toFixed(2),
        heat: +ch.heatKJ[i].toFixed(2),
        pElec: +ch.pElecKW[i].toFixed(2),
        pWheel: +ch.pWheelKW[i].toFixed(2),
        torque: +ch.motorTorque[i].toFixed(2),
        fzFL: +ch.fzFL[i].toFixed(0),
        fzFR: +ch.fzFR[i].toFixed(0),
        fzRL: +ch.fzRL[i].toFixed(0),
        fzRR: +ch.fzRR[i].toFixed(0),
        kus: +ch.understeerDegPerG[i].toFixed(2),
      });
    }
    return rows;
  }, [lap, baselineLap]);
}

const axisProps = {
  stroke: CHART.axis,
  tick: { fontSize: 10, fontFamily: 'Consolas, monospace', fill: CHART.axis },
  tickLine: false,
  tickFormatter: tickFmt,
};

function ChartFrame({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative h-[142px] w-full">
      <div className="pointer-events-none absolute left-12 right-3 top-0 z-10 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-hud-dim">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function TelemetryChartsImpl({ lap, baselineLap, cursorS, onHoverS }: Props) {
  const rows = useRows(lap, baselineLap);
  const deltaId = useId();
  const delta = useMemo(() => {
    if (!baselineLap) return null;
    const rows = sampleDeltaTime(lap, baselineLap);
    const domain: [number, number] = [Math.min(-0.001, ...rows.map((r) => r.deltaTS)), Math.max(0.001, ...rows.map((r) => r.deltaTS))];
    const distance = Math.min(lap.distance, baselineLap.distance);
    const gates = Array.from({ length: Math.floor(distance / 50) }, (_, i) => {
      const s = (i + 1) * 50;
      return { s, delta: deltaTimeAtDistance(lap, baselineLap, s) ?? 0 };
    });
    return { rows, domain, gates, zero: domain[1] / (domain[1] - domain[0]) };
  }, [lap, baselineLap]);
  const L = lap.distance;
  const common = {
    data: rows,
    syncId: SYNC,
    margin: { top: 14, right: 12, bottom: 0, left: 0 },
    onMouseMove: (st: { activeLabel?: string | number } | undefined) => {
      if (st && st.activeLabel != null) onHoverS(Number(st.activeLabel));
    },
    onMouseLeave: () => onHoverS(null),
  };
  const xAxis = (show: boolean) => (
    <XAxis
      dataKey="s"
      type="number"
      domain={[0, L]}
      {...axisProps}
      tick={show ? axisProps.tick : false}
      height={show ? 18 : 4}
      unit={show ? ' m' : ''}
      allowDataOverflow
    />
  );
  const cursor = cursorS != null ? <ReferenceLine x={cursorS} stroke={CHART.cyan} strokeWidth={1.2} ifOverflow="hidden" /> : null;
  const grid = <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />;
  const tt = <Tooltip {...tooltipStyle} labelFormatter={(s) => `s = ${Number(s).toFixed(1)} m`} isAnimationActive={false} />;

  const endDeltaS = baselineLap ? lap.lapTime - baselineLap.lapTime : null;

  return (
    <div className="flex flex-col gap-1">
      {delta && (
        <>
        <ChartFrame
          title="Delta-T trace Δt(s) = Setup B − Setup A [s] (negative = Setup B faster)"
          right={
            endDeltaS != null && (
              <span className={endDeltaS <= 0 ? 'text-hud-lime' : 'text-hud-red'}>
                Finish Δt: {endDeltaS >= 0 ? '+' : ''}
                {endDeltaS.toFixed(3)} s ({endDeltaS >= 0 ? '+' : ''}
                {(endDeltaS * 1000).toFixed(0)} ms)
              </span>
            )
          }
        >
          <ResponsiveContainer>
            <ComposedChart {...common} data={delta.rows}>
              <defs>
                <linearGradient id={deltaId} x1="0" x2="0" y1="0" y2="1" gradientUnits="objectBoundingBox">
                  <stop offset="0%" stopColor={CHART.red} />
                  <stop offset={delta.zero} stopColor={CHART.red} />
                  <stop offset={delta.zero} stopColor={CHART.lime} />
                  <stop offset="100%" stopColor={CHART.lime} />
                </linearGradient>
              </defs>
              {grid}
              {xAxis(false)}
              <YAxis {...axisProps} width={44} domain={delta.domain} allowDataOverflow />
              {tt}
              <ReferenceLine y={0} stroke={CHART.slate} strokeDasharray="3 3" />
              <Area
                dataKey="deltaTS"
                name="Δt [s]"
                stroke={`url(#${deltaId})`}
                fill={`url(#${deltaId})`}
                fillOpacity={0.14}
                dot={false}
                strokeWidth={1.6}
                isAnimationActive={false}
              />
              {cursor}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
        {delta.gates.length > 0 && (
          <ol aria-label="Cumulative time difference every 50 metres" className="mx-3 ml-11 flex gap-1 overflow-x-auto pb-1 font-mono text-[10px] tabular-nums">
            {delta.gates.map(({ s, delta }) => (
              <li key={s} className="shrink-0 rounded border border-white/10 px-2 py-1 text-slate-400">
                {s} m <span className={delta <= 0 ? 'text-hud-lime' : 'text-hud-red'}>{delta >= 0 ? '+' : ''}{(delta * 1000).toFixed(0)} ms</span>
              </li>
            ))}
          </ol>
        )}
        </>
      )}
      <ChartFrame title="Speed [km/h] · cornering limit">
        <ResponsiveContainer>
          <LineChart {...common}>
            {grid}
            {xAxis(false)}
            <YAxis {...axisProps} width={44} domain={[0, 'auto']} />
            {tt}
            <Line dataKey="vLim" name="v limit" stroke={CHART.slate} strokeDasharray="3 3" dot={false} strokeWidth={1} isAnimationActive={false} />
            {baselineLap && (
              <Line
                dataKey="vBase"
                name="v Setup A [km/h]"
                stroke={CHART.violet}
                strokeDasharray="4 3"
                dot={false}
                strokeWidth={1.3}
                isAnimationActive={false}
              />
            )}
            <Line dataKey="v" name="v Setup B [km/h]" stroke={CHART.cyan} dot={false} strokeWidth={1.6} isAnimationActive={false} />
            {cursor}
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ChartFrame title="Longitudinal & lateral acceleration [G]">
        <ResponsiveContainer>
          <LineChart {...common}>
            {grid}
            {xAxis(false)}
            <YAxis {...axisProps} width={44} />
            {tt}
            <ReferenceLine y={0} stroke={CHART.grid} />
            <Line dataKey="gLong" name="G long" stroke={CHART.lime} dot={false} strokeWidth={1.3} isAnimationActive={false} />
            <Line dataKey="gLat" name="G lat" stroke={CHART.red} dot={false} strokeWidth={1.3} isAnimationActive={false} />
            {cursor}
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ChartFrame title="4-Corner vertical wheel loads Fz [N] (FL · FR · RL · RR)">
        <ResponsiveContainer>
          <LineChart {...common}>
            {grid}
            {xAxis(false)}
            <YAxis {...axisProps} width={44} domain={[0, 'auto']} />
            {tt}
            <ReferenceLine y={0} stroke={CHART.red} strokeDasharray="2 2" />
            <Line dataKey="fzFL" name="Fz FL [N]" stroke={CHART.cyan} dot={false} strokeWidth={1.1} isAnimationActive={false} />
            <Line dataKey="fzFR" name="Fz FR [N]" stroke={CHART.amber} dot={false} strokeWidth={1.1} isAnimationActive={false} />
            <Line dataKey="fzRL" name="Fz RL [N]" stroke={CHART.lime} dot={false} strokeWidth={1.1} isAnimationActive={false} />
            <Line dataKey="fzRR" name="Fz RR [N]" stroke={CHART.violet} dot={false} strokeWidth={1.1} isAnimationActive={false} />
            {cursor}
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ChartFrame title="Accumulator energy [Wh] · cooling heat [kJ]">
        <ResponsiveContainer>
          <ComposedChart {...common}>
            {grid}
            {xAxis(false)}
            <YAxis {...axisProps} width={44} />
            {tt}
            <Area dataKey="energy" name="E net [Wh]" stroke={CHART.amber} fill={CHART.amber} fillOpacity={0.12} dot={false} isAnimationActive={false} />
            <Line dataKey="heat" name="Heat [kJ]" stroke={CHART.violet} dot={false} strokeWidth={1.2} isAnimationActive={false} />
            {cursor}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      <ChartFrame title="Motor power [kW] · accumulator (+drive / −regen) & wheel">
        <ResponsiveContainer>
          <ComposedChart {...common}>
            {grid}
            {xAxis(true)}
            <YAxis {...axisProps} width={44} />
            {tt}
            <ReferenceLine y={80} stroke={CHART.red} strokeDasharray="4 4" label={{ value: '80 kW', fill: CHART.red, fontSize: 9, position: 'insideTopRight' }} />
            <ReferenceLine y={0} stroke={CHART.grid} />
            <Area dataKey="pElec" name="P batt [kW]" stroke={CHART.blue} fill={CHART.blue} fillOpacity={0.15} dot={false} isAnimationActive={false} />
            <Line dataKey="pWheel" name="P wheel [kW]" stroke={CHART.lime} dot={false} strokeWidth={1} isAnimationActive={false} />
            {cursor}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}

export default memo(TelemetryChartsImpl);
