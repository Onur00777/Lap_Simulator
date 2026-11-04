'use client';

import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LaunchResult } from '@/lib/tracks';
import { CHART } from '@/lib/ui/colors';
import { fmt, strideFor } from '@/lib/ui/format';
import { Kpi, tickFmt, tooltipStyle } from '../ui';

const axis = { stroke: CHART.axis, tick: { fontSize: 10, fill: CHART.axis }, tickLine: false, tickFormatter: tickFmt };

export default function LaunchPanel({ launch, qssTime }: { launch: LaunchResult; qssTime?: number }) {
  const rows = useMemo(() => {
    const st = strideFor(launch.samples.length, 500);
    return launch.samples
      .filter((_, i) => i % st === 0)
      .map((p) => ({
        t: +p.t.toFixed(3),
        v: +(p.v * 3.6).toFixed(2),
        ws: +(p.wheelSpeed * 3.6).toFixed(2),
        slip: +(p.slip * 100).toFixed(2),
        T: +p.motorTorque.toFixed(2),
        Treq: +p.torqueRequest.toFixed(2),
        P: +(p.pElec / 1000).toFixed(2),
        x: +p.x.toFixed(2),
      }));
  }, [launch]);
  return (
    <div className="p-3">
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        <Kpi label="75 m (timed, 0.3 m staging)" value={fmt(launch.time75, 3)} unit="s" accent="text-hud-cyan" />
        <Kpi label="Standing 0–75 m" value={fmt(launch.standingTime75, 3)} unit="s" sub={qssTime ? `QSS: ${fmt(qssTime, 3)} s` : undefined} />
        <Kpi label="0–100 km/h" value={fmt(launch.time0to100, 3)} unit="s" />
        <Kpi label="Trap speed" value={fmt(launch.trapSpeed * 3.6, 1)} unit="km/h" />
        <Kpi label="Peak slip / TC target" value={`${fmt(launch.peakSlip * 100, 1)} / ${fmt(launch.targetSlip * 100, 1)}`} unit="%" />
        <Kpi label="Energy · peak power" value={fmt(launch.energyKWh * 1000, 1)} unit="Wh" sub={`${fmt(launch.peakPowerKW, 1)} kW peak`} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Chart title="Vehicle & wheel speed [km/h]" rows={rows} lines={[{ k: 'v', c: CHART.cyan }, { k: 'ws', c: CHART.slate, dash: true }]} />
        <Chart title="Slip ratio [%] vs TC set point" rows={rows} lines={[{ k: 'slip', c: CHART.amber }]} refY={launch.targetSlip * 100} />
        <Chart title="Motor torque cmd vs driver request [Nm]" rows={rows} lines={[{ k: 'T', c: CHART.lime }, { k: 'Treq', c: CHART.slate, dash: true }]} />
        <Chart title="Accumulator power [kW]" rows={rows} lines={[{ k: 'P', c: CHART.blue }]} refY={80} />
      </div>
    </div>
  );
}

function Chart({
  title,
  rows,
  lines,
  refY,
}: {
  title: string;
  rows: Record<string, number>[];
  lines: { k: string; c: string; dash?: boolean }[];
  refY?: number;
}) {
  return (
    <div className="h-[170px]">
      <div className="font-mono text-[10px] uppercase tracking-widest text-hud-dim">{title}</div>
      <ResponsiveContainer>
        <LineChart data={rows} syncId="launch" margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
          <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} unit=" s" {...axis} />
          <YAxis width={40} {...axis} />
          <Tooltip {...tooltipStyle} isAnimationActive={false} />
          {refY != null && <ReferenceLine y={refY} stroke={CHART.red} strokeDasharray="4 4" />}
          {lines.map((l) => (
            <Line key={l.k} dataKey={l.k} stroke={l.c} strokeDasharray={l.dash ? '4 3' : undefined} dot={false} strokeWidth={1.5} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
