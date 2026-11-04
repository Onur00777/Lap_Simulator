'use client';

import { useMemo } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { sampleLateralCurve, sampleMotorCurve, wheelLoads, type EfficiencyMap, type PowertrainParams, type VehicleParams } from '@/lib/physics';
import { CHART, rgb, turbo } from '@/lib/ui/colors';
import { fmt } from '@/lib/ui/format';
import { tickFmt, tooltipStyle } from '../ui';

const axis = { stroke: CHART.axis, tick: { fontSize: 10, fill: CHART.axis }, tickLine: false, tickFormatter: tickFmt };
const legend = { wrapperStyle: { fontSize: 10, fontFamily: 'Consolas, monospace' } };

export default function PowertrainPanel({ veh, pt, map }: { veh: VehicleParams; pt: PowertrainParams; map: EfficiencyMap }) {
  const motor = useMemo(
    () => sampleMotorCurve(veh, pt, map, 41).map((p) => ({ rpm: Math.round(p.rpm), T: +p.torque.toFixed(2), P: +p.powerKW.toFixed(2), E: +p.elecKW.toFixed(2) })),
    [veh, pt, map],
  );
  const loads = useMemo(() => {
    const w = wheelLoads(veh, 0, 0, 0);
    return [Math.round(w.fl * 0.5), Math.round(w.fl), Math.round(w.rl * 1.6), Math.round(w.rl * 2.4)];
  }, [veh]);
  const tire = useMemo(() => {
    const curves = loads.map((Fz) => sampleLateralCurve(veh.tire, Fz, 15, 61));
    return curves[0].map((p, i) => {
      const row: Record<string, number> = { a: +p.alphaDeg.toFixed(2) };
      loads.forEach((Fz, k) => (row[`F${Fz}`] = +curves[k][i].Fy.toFixed(1)));
      return row;
    });
  }, [veh, loads]);
  const colors = [CHART.blue, CHART.cyan, CHART.lime, CHART.amber];

  return (
    <div className="grid gap-3 p-3 xl:grid-cols-3">
      <div className="h-[260px]">
        <div className="font-mono text-[10px] uppercase tracking-widest text-hud-dim">Motor envelope per motor (incl. 80 kW accumulator limit)</div>
        <ResponsiveContainer>
          <LineChart data={motor} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
            <XAxis dataKey="rpm" type="number" domain={[0, 'dataMax']} {...axis} />
            <YAxis yAxisId="T" width={34} {...axis} />
            <YAxis yAxisId="P" orientation="right" width={34} {...axis} />
            <Tooltip {...tooltipStyle} isAnimationActive={false} />
            <Legend {...legend} />
            <Line yAxisId="T" dataKey="T" name="Torque [Nm]" stroke={CHART.lime} dot={false} isAnimationActive={false} />
            <Line yAxisId="P" dataKey="P" name="Shaft total [kW]" stroke={CHART.cyan} dot={false} isAnimationActive={false} />
            <Line yAxisId="P" dataKey="E" name="DC total [kW]" stroke={CHART.red} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">Motor + inverter efficiency lookup table [%]</div>
        <div className="overflow-auto">
          <table className="border-collapse font-mono text-[9px] tabular-nums">
            <thead>
              <tr>
                <th className="px-1 text-hud-dim">rpm \ Nm</th>
                {map.torque.map((t) => (
                  <th key={t} className="px-1 font-normal text-hud-dim">
                    {fmt(t, 0)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {map.rpm.map((r, i) => (
                <tr key={r}>
                  <td className="px-1 text-right text-hud-dim">{r}</td>
                  {map.eta[i].map((e, j) => (
                    <td key={j} className="px-1 text-center text-black" style={{ background: rgb(turbo((e - 0.6) / 0.36), 0.85) }}>
                      {fmt(e * 100, 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="h-[260px]">
        <div className="font-mono text-[10px] uppercase tracking-widest text-hud-dim">Pacejka lateral force Fy [N] vs slip angle [°] — load sensitivity</div>
        <ResponsiveContainer>
          <LineChart data={tire} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="2 4" />
            <XAxis dataKey="a" type="number" domain={[-15, 15]} {...axis} />
            <YAxis width={44} {...axis} />
            <Tooltip {...tooltipStyle} isAnimationActive={false} />
            <Legend {...legend} />
            {loads.map((Fz, k) => (
              <Line key={Fz} dataKey={`F${Fz}`} name={`Fz ${Fz} N`} stroke={colors[k]} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
