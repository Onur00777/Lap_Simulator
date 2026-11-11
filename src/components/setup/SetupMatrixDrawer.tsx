'use client';

import type { ReactNode } from 'react';
import type { SetupComparison } from '@/lib/solver/setup-matrix';
import { KORFEZ_PRESETS, type VehiclePresetId } from '@/lib/tracks';

export default function SetupMatrixDrawer({ entries, referenceId, onReference, onSnapshot, onClose }: {
  entries: SetupComparison[];
  referenceId: VehiclePresetId;
  onReference: (id: VehiclePresetId) => void;
  onSnapshot: () => void;
  onClose: () => void;
}) {
  const number = (value: number | null, delta: number | null, digits: number, preferred?: 'higher' | 'lower') => {
    if (value == null) return '—';
    const favorable = delta != null && (preferred === 'higher' ? delta > 0 : delta < 0);
    const tone = !preferred || delta === 0 ? 'text-slate-400' : favorable ? 'text-emerald-300' : 'text-rose-300';
    return <>{value.toFixed(digits)}{delta != null && <span className={`ml-2 text-[10px] ${tone}`}>{delta > 0 ? '+' : ''}{delta.toFixed(digits)}</span>}</>;
  };
  const metrics: { label: string; render: (entry: SetupComparison) => ReactNode }[] = [
    { label: 'Lap time [s]', render: ({ id, metrics, deltaToActive }) => number(metrics.lapTimeS, id === 'A' ? null : deltaToActive.lapTimeS, 3, 'lower') },
    { label: 'Net energy [kWh/lap]', render: ({ id, metrics, deltaToActive }) => number(metrics.netEnergyKWh, id === 'A' ? null : deltaToActive.netEnergyKWh, 3, 'lower') },
    { label: 'Corner Kᵤₛ [°/G]', render: ({ id, metrics, deltaToActive }) => number(metrics.understeerDegPerG, id === 'A' ? null : deltaToActive.understeerDegPerG, 2) },
  ];
  entries[0]?.metrics.sectors.forEach(({ index }, i) => {
    metrics.push(
      { label: `Sector ${index} [s]`, render: ({ id, metrics, deltaToActive }) => number(metrics.sectors[i].timeS, id === 'A' ? null : deltaToActive.sectors[i].timeS, 3, 'lower') },
      { label: `Sector ${index} apex [km/h]`, render: ({ id, metrics, deltaToActive }) => number(metrics.sectors[i].apexSpeedKph, id === 'A' ? null : deltaToActive.sectors[i].apexSpeedKph, 1, 'higher') },
    );
  });

  return (
    <aside aria-label="Setup Matrix" className="fixed inset-y-12 right-0 z-40 w-[min(100vw,56rem)] overflow-auto border-l border-white/10 bg-[#080a10]/95 p-4 text-slate-200 shadow-2xl backdrop-blur-xl">
      <header className="flex items-center justify-between gap-3 pb-3">
        <h2 className="font-semibold">Setup Matrix</h2>
        <button type="button" onClick={onClose} aria-label="Close Setup Matrix" className="rounded px-2 py-1 hover:bg-white/10">✕</button>
      </header>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <label className="flex items-center gap-2 text-slate-400">Reference vehicle
          <select value={referenceId} onChange={(event) => onReference(event.target.value as VehiclePresetId)} className="rounded border border-white/10 bg-slate-950 p-1.5 text-slate-200">
            {KORFEZ_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={onSnapshot} className="rounded border border-cyan-700/60 bg-cyan-900/30 px-2 py-1.5 text-cyan-200">Snapshot active as ghost</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-white/10 bg-white/[0.025]">
        <table className="min-w-[36rem] w-full text-left font-mono text-xs tabular-nums">
          <thead className="bg-white/[0.04]">
            <tr>
              <th scope="col" className="p-2.5 text-slate-400">Metric</th>
              {entries.map((entry, i) => (
                <th key={entry.id} scope="col" className="p-2.5">
                  <span className="text-cyan-300">{entry.id} · {['Active', 'Ghost', 'Reference'][i]}</span>
                  <span className="mt-1 block font-normal text-slate-400">{entry.name}</span>
                  {entry.paretoOptimal && <span className="mt-1 block text-[10px] font-normal text-emerald-300">Time–energy Pareto</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map(({ label, render }) => (
              <tr key={label} className="border-t border-white/[0.07]">
                <th scope="row" className="whitespace-nowrap p-2.5 font-normal text-slate-400">{label}</th>
                {entries.map((entry) => <td key={entry.id} className="whitespace-nowrap p-2.5">{render(entry)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
