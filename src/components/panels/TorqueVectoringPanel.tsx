'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TVAnalysis } from '@/lib/dynamics';
import { CHART } from '@/lib/ui/colors';
import { fmt, fmtTime, kph, strideFor } from '@/lib/ui/format';
import { DataTable, Kpi, tickFmt, tooltipStyle } from '../ui';

const axis = { stroke: CHART.axis, tick: { fontSize: 10, fill: CHART.axis }, tickLine: false, tickFormatter: tickFmt };
const legend = { wrapperStyle: { fontSize: 10, fontFamily: 'Consolas, monospace' } };

export default function TorqueVectoringPanel({ tv, cursorS }: { tv: TVAnalysis; cursorS: number | null }) {
  const alloc = useMemo(() => {
    const a = tv.allocation;
    const st = strideFor(a.s.length, 600);
    const rows = [];
    for (let i = 0; i < a.s.length; i += st) {
      rows.push({ s: +a.s[i].toFixed(1), rl: +a.wheelTorqueRL[i].toFixed(1), rr: +a.wheelTorqueRR[i].toFixed(1), mz: +a.mz[i].toFixed(1) });
    }
    return rows;
  }, [tv]);
  const step = useMemo(
    () => tv.step.series.map((p) => ({ t: +p.t.toFixed(3), open: +p.rOpen.toFixed(4), tv: +p.rTv.toFixed(4), ref: +p.rRef.toFixed(4), mz: +p.mz.toFixed(1) })),
    [tv],
  );
  const usOpen = useMemo(() => tv.ramp.usSeries.filter((p) => p.usOpen != null).map((p) => ({ x: p.ayG, y: p.usOpen as number })), [tv]);
  const usTv = useMemo(() => tv.ramp.usSeries.filter((p) => p.usTv != null).map((p) => ({ x: p.ayG, y: p.usTv as number })), [tv]);
  const L = tv.lap;
  const so = tv.step.open;
  const st = tv.step.tv;
  const ro = tv.ramp.open;
  const rt = tv.ramp.tv;
  const pct = (a: number, b: number) => `${fmt(((b - a) / a) * 100, 0)} %`;

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Lap · open diff" value={fmtTime(L.open)} />
        <Kpi label="Lap · torque vectoring" value={fmtTime(L.tv)} accent="text-hud-lime" />
        <Kpi label="Δ lap time (TV)" value={`${L.deltaTv <= 0 ? '' : '+'}${fmt(L.deltaTv, 3)}`} unit="s" sub={`${fmt(L.deltaPct, 2)} % · PM bound ${fmtTime(L.pointMass)}`} accent={L.deltaTv <= 0 ? 'text-hud-lime' : 'text-hud-red'} />
        <Kpi label="Yaw rise 10–90 %" value={`${fmt(so.riseTime * 1000, 0)} → ${fmt(st.riseTime * 1000, 0)}`} unit="ms" sub={`entry response ${pct(so.riseTime, st.riseTime)}`} accent="text-hud-cyan" />
        <Kpi label="Yaw delay (50 %)" value={`${fmt(so.delay50 * 1000, 0)} → ${fmt(st.delay50 * 1000, 0)}`} unit="ms" sub={`overshoot ${fmt(st.overshootPct, 1)} %`} />
        <Kpi label="Mid-corner US gradient" value={`${fmt(ro.limitGradientDegPerG, 2)} → ${fmt(rt.limitGradientDegPerG, 2)}`} unit="°/g" sub={`0.8–1.5 g · ${pct(ro.limitGradientDegPerG, rt.limitGradientDegPerG)}`} accent="text-hud-amber" />
        <Kpi label="Max lateral (ramp)" value={`${fmt(ro.maxAyG, 2)} → ${fmt(rt.maxAyG, 2)}`} unit="G" sub={`US @ limit ${fmt(ro.understeerAtLimitDeg, 2)}° → ${fmt(rt.understeerAtLimitDeg, 2)}°`} />
        <Kpi label="Peak wheel torque" value={`+${fmt(tv.allocation.peakOuterWheelTorque, 0)} / ${fmt(tv.allocation.peakInnerWheelTorque, 0)}`} unit="Nm" sub={`outer / inner · Mz ${fmt(tv.allocation.peakMz, 0)} Nm`} />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Box title={`Step steer @ ${fmt(kph(tv.testSpeed), 0)} km/h — yaw rate [rad/s]`}>
          <LineChart data={step} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
            <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} unit=" s" {...axis} />
            <YAxis width={44} {...axis} />
            <Tooltip {...tooltipStyle} isAnimationActive={false} />
            <Legend {...legend} />
            <Line dataKey="ref" name="r_ref (target)" stroke={CHART.slate} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            <Line dataKey="open" name="Open diff" stroke={CHART.amber} dot={false} strokeWidth={1.5} isAnimationActive={false} />
            <Line dataKey="tv" name="TV (PI DYC)" stroke={CHART.lime} dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </LineChart>
        </Box>
        <Box title="Ramp steer — understeer angle δ − L·r/v [°] vs lateral G">
          <ScatterChart margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
            <XAxis dataKey="x" type="number" domain={[0, 'dataMax']} name="ay" unit=" G" {...axis} />
            <YAxis dataKey="y" type="number" width={44} name="US" {...axis} />
            <Tooltip {...tooltipStyle} isAnimationActive={false} />
            <Legend {...legend} />
            <Scatter name="Open diff" data={usOpen} line={{ stroke: CHART.amber, strokeWidth: 1.5 }} shape={() => <g />} isAnimationActive={false} />
            <Scatter name="Torque vectoring" data={usTv} line={{ stroke: CHART.lime, strokeWidth: 1.5 }} shape={() => <g />} isAnimationActive={false} />
          </ScatterChart>
        </Box>
        <Box title="Steady-state lateral limit [G] vs speed [km/h]">
          <LineChart data={tv.envelopeCurves.map((p) => ({ ...p, kph: +p.kph.toFixed(1) }))} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
            <XAxis dataKey="kph" type="number" domain={[0, 'dataMax']} {...axis} />
            <YAxis width={44} domain={['auto', 'auto']} {...axis} />
            <Tooltip {...tooltipStyle} formatter={(v: number) => v.toFixed(3)} isAnimationActive={false} />
            <Legend {...legend} />
            <Line dataKey="pointMass" name="Point-mass bound" stroke={CHART.slate} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            <Line dataKey="open" name="2-track open diff" stroke={CHART.amber} dot={false} isAnimationActive={false} />
            <Line dataKey="tv" name="2-track TV" stroke={CHART.lime} dot={false} isAnimationActive={false} />
          </LineChart>
        </Box>
        <Box title="Optimal TV allocation along the lap — wheel torque [Nm] & yaw moment [Nm]">
          <LineChart data={alloc} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
            <XAxis dataKey="s" type="number" domain={[0, 'dataMax']} unit=" m" {...axis} />
            <YAxis width={44} {...axis} />
            <Tooltip {...tooltipStyle} isAnimationActive={false} />
            <Legend {...legend} />
            <ReferenceLine y={0} stroke={CHART.grid} />
            {cursorS != null && <ReferenceLine x={cursorS} stroke={CHART.cyan} />}
            <Line dataKey="rl" name="Rear-left" stroke={CHART.blue} dot={false} strokeWidth={1.2} isAnimationActive={false} />
            <Line dataKey="rr" name="Rear-right" stroke={CHART.red} dot={false} strokeWidth={1.2} isAnimationActive={false} />
            <Line dataKey="mz" name="Mz" stroke={CHART.violet} dot={false} strokeWidth={1} strokeOpacity={0.7} isAnimationActive={false} />
          </LineChart>
        </Box>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <div className="max-h-[260px] overflow-auto">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">Corner minimum speed — open vs TV [km/h]</div>
          <DataTable
            head={['Corner', 'R [m]', 'Open', 'TV', 'Gain']}
            rows={tv.corners.map((c) => [`T${c.index} ${c.direction}`, fmt(c.radius, 1), fmt(kph(c.apexOpen), 1), fmt(kph(c.apexTv), 1), `+${fmt(kph(c.gain), 2)}`])}
          />
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">Controller calibration (exported to firmware)</div>
          <DataTable
            head={['Parameter', 'Value']}
            rows={[
              ['Yaw-rate target r_ref', 'v·δ / (L + K_us·v²), |r| ≤ 0.95·a_y,lim / v'],
              ['Target understeer K_us', `${fmt((tv.controller.understeerTarget * 9.81 * 180) / Math.PI, 2)} °/g`],
              ['Kp', `${fmt(tv.controller.kp, 0)} Nm/(rad/s)`],
              ['Ki', `${fmt(tv.controller.ki, 0)} Nm/rad`],
              ['Mz limit', `${fmt(tv.controller.mzLimit, 0)} Nm`],
              ['Task period', `${fmt(tv.controller.dt * 1000, 0)} ms`],
              ['Energy / lap open → TV', `${fmt(L.energyOpenKWh * 1000, 1)} → ${fmt(L.energyTvKWh * 1000, 1)} Wh`],
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function Box({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="h-[230px]">
      <div className="font-mono text-[10px] uppercase tracking-widest text-hud-dim">{title}</div>
      <ResponsiveContainer>{children}</ResponsiveContainer>
    </div>
  );
}
