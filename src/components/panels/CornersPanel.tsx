'use client';

import type { LapResult } from '@/lib/solver';
import type { SkidpadSteadyState } from '@/lib/tracks';
import { fmt, fmtTime, kph } from '@/lib/ui/format';
import { DataTable, Kpi } from '../ui';

export default function CornersPanel({ lap, skid, onSelect }: { lap: LapResult; skid: SkidpadSteadyState; onSelect: (i: number) => void }) {
  const e = lap.energy;
  return (
    <div className="grid gap-3 p-3 xl:grid-cols-[1.4fr_1fr]">
      <div className="min-w-0">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">
          Corners — apex radius & velocity (click to locate)
        </div>
        <div className="max-h-[340px] overflow-auto">
          <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-hud-panel text-hud-dim">
              <tr>
                {['#', 'Dir', 's apex [m]', 'R apex [m]', 'Angle [°]', 'Entry', 'Apex', 'Min', 'Exit [km/h]', 'Lat G'].map((h) => (
                  <th key={h} className="border-b border-hud-line px-2 py-1 text-right font-normal first:text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lap.corners.map((c) => (
                <tr key={c.index} className="cursor-pointer hover:bg-hud-panel2" onClick={() => onSelect(c.apexIndex)}>
                  <td className="px-2 py-0.5 text-hud-cyan">T{c.index}</td>
                  <td className="px-2 text-right">{c.direction}</td>
                  <td className="px-2 text-right">{fmt(c.sApex, 1)}</td>
                  <td className="px-2 text-right">{fmt(c.apexRadius, 1)}</td>
                  <td className="px-2 text-right">{fmt(Math.abs(c.turnAngleDeg), 0)}</td>
                  <td className="px-2 text-right">{fmt(kph(c.entrySpeed), 1)}</td>
                  <td className="px-2 text-right">{fmt(kph(c.apexSpeed), 1)}</td>
                  <td className="px-2 text-right text-hud-amber">{fmt(kph(c.minSpeed), 1)}</td>
                  <td className="px-2 text-right">{fmt(kph(c.exitSpeed), 1)}</td>
                  <td className="px-2 text-right">{fmt(c.peakLatG, 2)}</td>
                </tr>
              ))}
              {lap.corners.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-2 py-3 text-hud-dim">
                    No corners on this track.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">Sector splits</div>
          <DataTable
            head={['Sector', 'From [m]', 'To [m]', 'Time']}
            rows={lap.sectors.map((s) => [`S${s.index}`, fmt(s.s0, 0), fmt(s.s1, 0), fmtTime(s.time)])}
          />
        </div>
        {lap.timedWindows.length > 0 && (
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">Timed laps (FS rules)</div>
            <DataTable
              head={['Window', 'Time', 'Analytic']}
              rows={[
                ...lap.timedWindows.map((w) => [w.label, fmtTime(w.time), fmtTime(skid.lapTime)]),
                ['Skidpad result (avg)', fmtTime(lap.timedWindows.reduce((a, w) => a + w.time, 0) / lap.timedWindows.length), `${fmt(skid.ayG, 3)} G`],
              ]}
            />
          </div>
        )}
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">Energy balance (per lap)</div>
          <DataTable
            head={['Term', 'kJ']}
            rows={[
              ['Tractive work at wheels', fmt(e.driveWheelKJ, 1)],
              ['Aerodynamic drag', fmt(e.aeroKJ, 1)],
              ['Tire rolling resistance', fmt(e.rollingKJ, 1)],
              ['Friction brakes', fmt(e.frictionBrakeKJ, 1)],
              ['Regen captured at wheels', fmt(e.regenWheelKJ, 1)],
              ['Δ Kinetic energy', fmt(e.kineticKJ, 1)],
              ['Motor + inverter losses', fmt(e.motorInverterLossKJ, 1)],
              ['Gearbox losses', fmt(e.gearboxLossKJ, 1)],
              ['Accumulator I²R losses', fmt(e.batteryLossKJ, 1)],
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Kpi label="Full throttle" value={fmt(lap.fullThrottleFraction * 100, 1)} unit="% time" />
          <Kpi label="Braking" value={fmt(lap.brakingFraction * 100, 1)} unit="% time" />
        </div>
      </div>
    </div>
  );
}
