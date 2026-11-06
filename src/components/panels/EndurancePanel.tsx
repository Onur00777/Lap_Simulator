'use client';

import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Area,
  Bar,
} from 'recharts';
import type { LateralModel, PowertrainParams, VehicleParams } from '@/lib/physics';
import { simulateEnduranceStint, type DeratingCause, type Integrator } from '@/lib/solver';
import type { Track } from '@/lib/tracks/types';
import { fmt, fmtTime } from '@/lib/ui/format';
import { Kpi, Segmented } from '../ui';

interface Props {
  track: Track;
  veh: VehicleParams;
  pt: PowertrainParams;
  model: LateralModel;
  integrator: Integrator;
  onApplyPowerCap?: (powerCapKW: number) => void;
}

const DERATING_BADGE: Record<DeratingCause, { label: string; cls: string }> = {
  none: { label: 'NOMINAL', cls: 'bg-hud-lime/15 text-hud-lime' },
  'cell-temp': { label: 'CELL TEMP (>55°C)', cls: 'bg-hud-amber/20 text-hud-amber' },
  'motor-temp': { label: 'MOTOR TEMP (>105°C)', cls: 'bg-hud-amber/20 text-hud-amber' },
  'cell-voltage': { label: 'CELL SAG (<3.22V)', cls: 'bg-hud-red/20 text-hud-red' },
  'low-soc': { label: 'LOW SoC (<15%)', cls: 'bg-hud-red/20 text-hud-red' },
};

export default function EndurancePanel({ track, veh, pt, model, integrator, onApplyPowerCap }: Props) {
  const [lapsCount, setLapsCount] = useState<number>(17);
  const [ambientTempC, setAmbientTempC] = useState<number>(28);
  const [initialSocPct, setInitialSocPct] = useState<number>(100);

  const stint = useMemo(
    () =>
      simulateEnduranceStint(track, veh, pt, {
        laps: lapsCount,
        ambientTempC,
        initialSoc: initialSocPct / 100,
        model,
        integrator,
      }),
    [track, veh, pt, lapsCount, ambientTempC, initialSocPct, model, integrator],
  );

  const opt = stint.optimalCap;
  const currentCapKW = Math.round(pt.batteryPowerLimit / 1000);

  return (
    <div className="space-y-4 p-3 font-mono text-xs">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hud-line pb-2.5">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-hud-cyan">
            22 km Multi-Lap Endurance Battery Sag & Thermal Derating Simulator
          </div>
          <div className="text-[10px] text-hud-dim">
            Sequential {stint.laps}-lap state integration · V_ocv(SoC) + I²R_pack(T, SoC) voltage sag · Lump-capacitance cell & motor/inverter thermal balance · VCU derating
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-hud-dim">Stint:</span>
            <Segmented
              options={[
                { value: '10', label: '10 Laps' },
                { value: '17', label: '17 Laps (22 km)' },
                { value: '22', label: '22 Laps' },
              ]}
              value={String(lapsCount)}
              onChange={(v) => setLapsCount(Number(v))}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-hud-dim">Ambient:</span>
            <Segmented
              options={[
                { value: '22', label: '22°C' },
                { value: '28', label: '28°C' },
                { value: '35', label: '35°C Hot' },
              ]}
              value={String(ambientTempC)}
              onChange={(v) => setAmbientTempC(Number(v))}
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-hud-dim">Start SoC:</span>
            <Segmented
              options={[
                { value: '100', label: '100%' },
                { value: '92', label: '92%' },
                { value: '85', label: '85%' },
              ]}
              value={String(initialSocPct)}
              onChange={(v) => setInitialSocPct(Number(v))}
            />
          </div>
        </div>
      </div>

      {/* DNF Alert Banner if applicable */}
      {stint.dnf && (
        <div className="flex items-center justify-between rounded border border-hud-red/60 bg-hud-red/10 px-3 py-2 text-[11px] text-hud-red">
          <span>
            <strong>⚠ ENDURANCE DNF ALERT:</strong> {stint.dnfReason} (Completed {stint.completedLaps}/{stint.laps} laps)
          </span>
          {onApplyPowerCap && (
            <button
              type="button"
              className="btn border-hud-lime text-hud-lime hover:bg-hud-lime/15"
              onClick={() => onApplyPowerCap(opt.optimalPowerCapKW)}
            >
              Apply Safe Optimal Cap ({opt.optimalPowerCapKW} kW)
            </button>
          )}
        </div>
      )}

      {/* Top Stint KPI Strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi
          label={`${stint.laps}-Lap Stint Time`}
          value={stint.dnf ? `DNF (L${stint.completedLaps})` : fmtTime(stint.totalTimeS)}
          sub={`Dist ${fmt(stint.totalDistanceKm, 2)} km · Naive ${fmtTime(stint.naiveTotalTimeS)}`}
          accent={stint.dnf ? 'text-hud-red' : 'text-hud-cyan'}
        />
        <Kpi
          label="Sag & Derate Loss"
          value={`+${fmt(stint.sagPenaltyS, 2)}`}
          unit="s"
          sub={`${stint.deratedLapCount} of ${stint.laps} laps VCU-derated`}
          accent={stint.sagPenaltyS > 5 ? 'text-hud-amber' : 'text-hud-lime'}
        />
        <Kpi
          label="Final SoC / Energy"
          value={fmt(stint.finalSocPct, 1)}
          unit="%"
          sub={`Used ${fmt(stint.totalNetEnergyKWh, 2)} / ${fmt(pt.batteryCapacityKWh, 2)} kWh`}
          accent={stint.finalSocPct < 12 ? 'text-hud-red' : 'text-hud-lime'}
        />
        <Kpi
          label="Min Load Voltage"
          value={fmt(stint.minTerminalVoltageV, 0)}
          unit="V"
          sub={`Min cell ${fmt(stint.minCellVoltageV, 2)} V (cutoff 3.10 V)`}
          accent={stint.minCellVoltageV < 3.2 ? 'text-hud-amber' : 'text-hud-text'}
        />
        <Kpi
          label="Peak Cell / Motor T"
          value={`${fmt(stint.peakCellTempC, 1)}° / ${fmt(stint.peakMotorTempC, 1)}°`}
          unit="C"
          sub={`Limits: Cell 58°C · Motor 110°C`}
          accent={stint.peakCellTempC > 55 || stint.peakMotorTempC > 105 ? 'text-hud-amber' : 'text-hud-text'}
        />
        <div className="flex flex-col justify-between rounded border border-hud-cyan/50 bg-hud-panel2 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-hud-cyan">Optimal kW Cap Finder</span>
            <span className="rounded bg-hud-cyan/20 px-1.5 py-0.5 text-[9px] font-bold text-hud-cyan">
              {opt.optimalPowerCapKW} kW
            </span>
          </div>
          <div className="my-0.5 font-mono text-sm font-semibold text-hud-lime">
            {fmtTime(opt.optimalTotalTimeS)}{' '}
            {opt.timeSavedVsNominalS > 0.05 && (
              <span className="text-[10px] text-hud-cyan">(-{fmt(opt.timeSavedVsNominalS, 2)}s)</span>
            )}
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-[9px] text-hud-dim">
              End SoC {fmt(opt.finalSocPct, 1)}% · T_cell {fmt(opt.peakCellTempC, 1)}°C
            </span>
            {onApplyPowerCap && currentCapKW !== opt.optimalPowerCapKW && (
              <button
                type="button"
                className="btn !px-1.5 !py-0.5 text-[9px] border-hud-cyan text-hud-cyan hover:bg-hud-cyan/15"
                onClick={() => onApplyPowerCap(opt.optimalPowerCapKW)}
              >
                Apply {opt.optimalPowerCapKW} kW
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2x2 Charts Grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Chart 1: Lap Time & Effective Power Cap Evolution */}
        <div className="rounded border border-hud-line bg-hud-panel2/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-hud-text">
              1. Lap Time (s) & Effective VCU Power Cap (kW)
            </span>
            <span className="text-[10px] text-hud-dim">Lap 1 → Lap {stint.laps}</span>
          </div>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={stint.lapHistory} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="#1d2636" strokeDasharray="3 3" />
                <XAxis dataKey="lap" tick={{ fill: '#7c8aa5', fontSize: 10 }} tickFormatter={(v) => `L${v}`} />
                <YAxis
                  yAxisId="time"
                  domain={['auto', 'auto']}
                  tick={{ fill: '#00e5ff', fontSize: 10 }}
                  tickFormatter={(v) => `${Number(v).toFixed(1)}s`}
                />
                <YAxis
                  yAxisId="kw"
                  orientation="right"
                  domain={[0, Math.max(90, stint.nominalPowerCapKW + 10)]}
                  tick={{ fill: '#ffb300', fontSize: 10 }}
                  tickFormatter={(v) => `${v}kW`}
                />
                <Tooltip
                  contentStyle={{ background: '#0b0f17', border: '1px solid #263248', fontSize: 11 }}
                  formatter={(val: number, name: string) => [
                    name.includes('Time') ? `${Number(val).toFixed(3)} s` : `${Number(val).toFixed(1)} kW`,
                    name,
                  ]}
                  labelFormatter={(l) => `Lap ${l}`}
                />
                <Bar yAxisId="kw" dataKey="effectivePowerCapKW" name="Effective Power Cap" fill="#ffb300" fillOpacity={0.22} />
                <Line
                  yAxisId="time"
                  type="monotone"
                  dataKey="lapTimeS"
                  name="Lap Time"
                  stroke="#00e5ff"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#00e5ff' }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: SoC (%) & Pack Terminal Voltage Sag (V) */}
        <div className="rounded border border-hud-line bg-hud-panel2/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-hud-text">
              2. Accumulator SoC (%) & Terminal Voltage Sag (V)
            </span>
            <span className="text-[10px] text-hud-dim">V_ocv(SoC) vs Min V_term under peak load</span>
          </div>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={stint.lapHistory} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="#1d2636" strokeDasharray="3 3" />
                <XAxis dataKey="lap" tick={{ fill: '#7c8aa5', fontSize: 10 }} tickFormatter={(v) => `L${v}`} />
                <YAxis
                  yAxisId="soc"
                  domain={[0, 100]}
                  tick={{ fill: '#a8ff3e', fontSize: 10 }}
                  tickFormatter={(v) => `${v}%`}
                />
                <YAxis
                  yAxisId="volt"
                  orientation="right"
                  domain={['auto', 'auto']}
                  tick={{ fill: '#a78bfa', fontSize: 10 }}
                  tickFormatter={(v) => `${Math.round(v)}V`}
                />
                <Tooltip
                  contentStyle={{ background: '#0b0f17', border: '1px solid #263248', fontSize: 11 }}
                  labelFormatter={(l) => `Lap ${l}`}
                />
                <Area
                  yAxisId="soc"
                  type="monotone"
                  dataKey="socEndPct"
                  name="End-of-Lap SoC (%)"
                  stroke="#a8ff3e"
                  fill="#a8ff3e"
                  fillOpacity={0.14}
                />
                <Line
                  yAxisId="volt"
                  type="monotone"
                  dataKey="ocvStartV"
                  name="Open-Circuit V_ocv (V)"
                  stroke="#7c8aa5"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  dot={false}
                />
                <Line
                  yAxisId="volt"
                  type="monotone"
                  dataKey="terminalVoltageMinV"
                  name="Min Terminal V_pack (V)"
                  stroke="#a78bfa"
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: '#a78bfa' }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 3: Cell, Motor & Coolant Temperatures (°C) */}
        <div className="rounded border border-hud-line bg-hud-panel2/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-hud-text">
              3. Thermal Evolution: Cell, Motor & Coolant (°C)
            </span>
            <span className="text-[10px] text-hud-dim">VCU Derating knees: Cell 58°C · Motor 110°C</span>
          </div>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={stint.lapHistory} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="#1d2636" strokeDasharray="3 3" />
                <XAxis dataKey="lap" tick={{ fill: '#7c8aa5', fontSize: 10 }} tickFormatter={(v) => `L${v}`} />
                <YAxis
                  domain={[20, Math.max(120, Math.ceil(stint.peakMotorTempC + 10))]}
                  tick={{ fill: '#7c8aa5', fontSize: 10 }}
                  tickFormatter={(v) => `${v}°C`}
                />
                <Tooltip
                  contentStyle={{ background: '#0b0f17', border: '1px solid #263248', fontSize: 11 }}
                  labelFormatter={(l) => `Lap ${l}`}
                />
                <ReferenceLine y={58} stroke="#ff4d6d" strokeDasharray="3 3" label={{ value: 'Cell 58°C', fill: '#ff4d6d', fontSize: 9 }} />
                <ReferenceLine y={110} stroke="#ffb300" strokeDasharray="3 3" label={{ value: 'Motor 110°C', fill: '#ffb300', fontSize: 9 }} />
                <Line type="monotone" dataKey="cellTempC" name="Cell Temp (°C)" stroke="#ff4d6d" strokeWidth={2} dot={{ r: 2.5 }} />
                <Line type="monotone" dataKey="motorTempC" name="Motor/Inv Temp (°C)" stroke="#ffb300" strokeWidth={2} dot={{ r: 2.5 }} />
                <Line type="monotone" dataKey="coolantTempC" name="Coolant Temp (°C)" stroke="#00e5ff" strokeWidth={1.6} strokeDasharray="4 2" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 4: Optimal Endurance Power Cap Sweep */}
        <div className="rounded border border-hud-line bg-hud-panel2/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-hud-text">
              4. Automated Power Cap Finder (36 kW → 80 kW Sweep)
            </span>
            <span className="text-[10px] text-hud-lime">
              Sweet spot: {opt.optimalPowerCapKW} kW ({fmtTime(opt.optimalTotalTimeS)})
            </span>
          </div>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={opt.sweep} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="#1d2636" strokeDasharray="3 3" />
                <XAxis dataKey="powerCapKW" tick={{ fill: '#7c8aa5', fontSize: 10 }} tickFormatter={(v) => `${v}kW`} />
                <YAxis
                  yAxisId="time"
                  domain={['auto', 'auto']}
                  tick={{ fill: '#00e5ff', fontSize: 10 }}
                  tickFormatter={(v) => `${Math.round(v)}s`}
                />
                <YAxis
                  yAxisId="soc"
                  orientation="right"
                  domain={[0, 100]}
                  tick={{ fill: '#a8ff3e', fontSize: 10 }}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{ background: '#0b0f17', border: '1px solid #263248', fontSize: 11 }}
                  labelFormatter={(l) => `Power Limit: ${l} kW`}
                />
                <ReferenceLine
                  x={opt.optimalPowerCapKW}
                  yAxisId="time"
                  stroke="#a8ff3e"
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  label={{ value: `OPT ${opt.optimalPowerCapKW}kW`, fill: '#a8ff3e', fontSize: 9 }}
                />
                <Line
                  yAxisId="time"
                  type="monotone"
                  dataKey="totalTimeS"
                  name="Total Stint Time (s)"
                  stroke="#00e5ff"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
                <Line
                  yAxisId="soc"
                  type="monotone"
                  dataKey="finalSocPct"
                  name="Final SoC (%)"
                  stroke="#a8ff3e"
                  strokeWidth={1.6}
                  strokeDasharray="4 2"
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Lap-by-Lap Breakdown Table */}
      <div className="rounded border border-hud-line bg-hud-panel2/40">
        <div className="flex items-center justify-between border-b border-hud-line px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-hud-text">
            Lap-by-Lap Accumulator & Thermal State Log
          </span>
          <span className="text-[10px] text-hud-dim">
            Pack nominal {fmt(pt.batteryVoltage, 0)} V · Capacity {fmt(pt.batteryCapacityKWh, 2)} kWh · 132s LiPo reference
          </span>
        </div>
        <div className="max-h-[280px] overflow-auto">
          <table className="w-full border-collapse text-left font-mono text-[11px]">
            <thead className="sticky top-0 bg-hud-panel text-[10px] uppercase text-hud-dim">
              <tr className="border-b border-hud-line">
                <th className="px-2.5 py-1.5">Lap</th>
                <th className="px-2.5 py-1.5">Dist</th>
                <th className="px-2.5 py-1.5">Lap Time</th>
                <th className="px-2.5 py-1.5">SoC (Start→End)</th>
                <th className="px-2.5 py-1.5">V_ocv / V_min</th>
                <th className="px-2.5 py-1.5">Cell Min</th>
                <th className="px-2.5 py-1.5">R_pack</th>
                <th className="px-2.5 py-1.5">T_cell / T_mot</th>
                <th className="px-2.5 py-1.5">Net Energy</th>
                <th className="px-2.5 py-1.5">Eff. Cap</th>
                <th className="px-2.5 py-1.5">VCU Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-line/50">
              {stint.lapHistory.map((row) => {
                const badge = DERATING_BADGE[row.deratingCause];
                return (
                  <tr key={row.lap} className={row.dnf ? 'bg-hud-red/10' : 'hover:bg-hud-panel2/70'}>
                    <td className="px-2.5 py-1.5 font-semibold text-hud-cyan">L{row.lap}</td>
                    <td className="px-2.5 py-1.5 text-hud-dim">{fmt(row.distanceCumKm, 2)} km</td>
                    <td className="px-2.5 py-1.5 font-semibold text-hud-text">{fmt(row.lapTimeS, 3)} s</td>
                    <td className="px-2.5 py-1.5">
                      {fmt(row.socStartPct, 1)}% → <span className="text-hud-lime">{fmt(row.socEndPct, 1)}%</span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {fmt(row.ocvStartV, 0)}V / <span className="text-hud-violet">{fmt(row.terminalVoltageMinV, 0)}V</span>
                    </td>
                    <td className={`px-2.5 py-1.5 ${row.minCellVoltageV < 3.22 ? 'text-hud-red font-bold' : 'text-hud-text'}`}>
                      {fmt(row.minCellVoltageV, 2)} V
                    </td>
                    <td className="px-2.5 py-1.5 text-hud-dim">{fmt(row.packResistanceOhm * 1000, 1)} mΩ</td>
                    <td className="px-2.5 py-1.5">
                      <span className={row.cellTempC > 55 ? 'text-hud-amber font-bold' : ''}>{fmt(row.cellTempC, 1)}°</span> /{' '}
                      <span className={row.motorTempC > 105 ? 'text-hud-amber font-bold' : ''}>{fmt(row.motorTempC, 1)}°C</span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {fmt(row.netEnergyWh, 1)} Wh <span className="text-[9px] text-hud-dim">(-{fmt(row.regenWh, 0)} reg)</span>
                    </td>
                    <td className="px-2.5 py-1.5 font-semibold text-hud-amber">
                      {fmt(row.effectivePowerCapKW, 1)} kW
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${badge.cls}`}>
                        {row.dnf ? 'DNF (DEPLETED)' : badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
