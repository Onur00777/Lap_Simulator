'use client';

import { memo, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LapResult, SimulationContext } from '@/lib/solver';
import { replayLapThermals } from '@/lib/solver/lap-thermals';
import { strideFor } from '@/lib/ui/format';
import { tooltipStyle } from '../ui';

function ThermalReplayPanel({ lap, ctx }: { lap: LapResult; ctx: SimulationContext }) {
  const [tireC, setTireC] = useState(80);
  const [rotorC, setRotorC] = useState(100);
  const replay = useMemo(() => replayLapThermals(lap, ctx, { initialTireC: tireC, initialRotorC: rotorC }), [lap, ctx, tireC, rotorC]);
  const stride = strideFor(replay.rows.length, 700);
  const rows = useMemo(() => replay.rows.filter((_, i) => i % stride === 0 || i === replay.rows.length - 1), [replay, stride]);
  const peak = replay.rows.reduce((a, row) => ({
    rotor: Math.max(a.rotor, row.rotorFL, row.rotorFR, row.rotorRL, row.rotorRR),
    grip: Math.min(a.grip, row.minTireGrip),
    unmetBrake: Math.max(a.unmetBrake, row.unmetBrakeN),
  }), { rotor: rotorC, grip: 1, unmetBrake: 0 });

  return (
    <section aria-label="Lap thermal replay" className="m-3 space-y-3 rounded border border-white/[0.08] p-3 font-mono text-xs tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-100">Lap thermal replay</h3>
        <span className="text-slate-400">Peak rotor {peak.rotor.toFixed(0)} °C · Min grip {(peak.grip * 100).toFixed(0)}% · Peak unmet braking {peak.unmetBrake.toFixed(0)} N</span>
      </div>
      <p className="text-[11px] text-slate-400">Temperature and brake allocation along the solved speed trace at 25 °C ambient.</p>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">Initial tires {tireC} °C <input type="range" min={20} max={150} value={tireC} onChange={(event) => setTireC(event.target.valueAsNumber)} className="accent-cyan-400" /></label>
        <label className="flex items-center gap-2">Initial rotors {rotorC} °C <input type="range" min={25} max={850} step={5} value={rotorC} onChange={(event) => setRotorC(event.target.valueAsNumber)} className="accent-amber-400" /></label>
      </div>
      <ResponsiveContainer width="100%" height={225}>
        <LineChart data={rows} margin={{ right: 18, top: 8 }}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis dataKey="s" type="number" unit=" m" tick={{ fontSize: 10 }} />
          <YAxis unit=" °C" width={54} tick={{ fontSize: 10 }} />
          <Tooltip {...tooltipStyle} formatter={(value: number) => `${value.toFixed(1)} °C`} labelFormatter={(value) => `${Number(value).toFixed(1)} m`} isAnimationActive={false} />
          <Legend />
          <Line dataKey="surfaceC" name="Tire flash max" stroke="#22d3ee" dot={false} isAnimationActive={false} />
          <Line dataKey="coreC" name="Tire core max" stroke="#a5f3fc" strokeDasharray="3 3" dot={false} isAnimationActive={false} />
          <Line dataKey="rotorFL" name="Rotor FL" stroke="#fbbf24" dot={false} isAnimationActive={false} />
          <Line dataKey="rotorFR" name="Rotor FR" stroke="#fb923c" dot={false} isAnimationActive={false} />
          <Line dataKey="rotorRL" name="Rotor RL" stroke="#a78bfa" dot={false} isAnimationActive={false} />
          <Line dataKey="rotorRR" name="Rotor RR" stroke="#f472b6" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
}

export default memo(ThermalReplayPanel);
