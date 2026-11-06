'use client';

import { memo, useMemo } from 'react';
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
import { CHART } from '@/lib/ui/colors';
import { strideFor } from '@/lib/ui/format';
import { tickFmt, tooltipStyle } from './ui';

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
  deltaTS?: number;
  deltaTMs?: number;
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
    const bn = bch?.s.length ?? 0;
    const st = strideFor(n, 700);
    const rows: Row[] = [];
    for (let i = 0; i < n; i += st) {
      let vBase: number | undefined;
      let deltaTS: number | undefined;
      let deltaTMs: number | undefined;
      if (bch && bn > 1) {
        const bi = Math.min(bn - 1, Math.round((i / Math.max(1, n - 1)) * (bn - 1)));
        vBase = +(bch.v[bi] * 3.6).toFixed(2);
        const dt = ch.t[i] - bch.t[bi];
        deltaTS = +dt.toFixed(4);
        deltaTMs = +(dt * 1000).toFixed(1);
      }
      rows.push({
        s: +ch.s[i].toFixed(2),
        v: +(ch.v[i] * 3.6).toFixed(2),
        vBase,
        vLim: +(Math.min(ch.vLimit[i], 45) * 3.6).toFixed(2),
        deltaTS,
        deltaTMs,
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
      {baselineLap && (
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
            <ComposedChart {...common}>
              {grid}
              {xAxis(false)}
              <YAxis {...axisProps} width={44} />
              {tt}
              <ReferenceLine y={0} stroke={CHART.slate} strokeDasharray="3 3" />
              <Area
                dataKey="deltaTS"
                name="Δt [s]"
                stroke={endDeltaS != null && endDeltaS <= 0 ? CHART.lime : CHART.red}
                fill={endDeltaS != null && endDeltaS <= 0 ? CHART.lime : CHART.red}
                fillOpacity={0.14}
                dot={false}
                strokeWidth={1.6}
                isAnimationActive={false}
              />
              {cursor}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartFrame>
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
