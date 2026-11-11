'use client';

import { useMemo, useState } from 'react';
import type { SetupJacobianEntry } from '@/lib/solver/sensitivity';

const signed = (value: number, digits: number) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

export default function SensitivityTornadoChart({ entries }: { entries: SetupJacobianEntry[] }) {
  const ranked = useMemo(() => [...entries].sort((a, b) => Math.min(a.lowDeltaMs, a.highDeltaMs) - Math.min(b.lowDeltaMs, b.highDeltaMs)), [entries]);
  const [selectedKey, select] = useState<SetupJacobianEntry['key'] | null>(null);
  const selected = ranked.find((entry) => entry.key === selectedKey) ?? ranked[0];
  if (!selected) return null;

  const maxMs = Math.max(1, ...ranked.flatMap((entry) => [Math.abs(entry.lowDeltaMs), Math.abs(entry.highDeltaMs)]));
  const perturbations = (entry: SetupJacobianEntry) => [
    { label: 'Lower', value: entry.lowValue, ms: entry.lowDeltaMs, wh: entry.lowDeltaWh, color: '#67e8f9' },
    { label: 'Higher', value: entry.highValue, ms: entry.highDeltaMs, wh: entry.highDeltaWh, color: '#c4b5fd' },
  ];

  return (
    <section aria-label="Setup sensitivity tornado" className="m-3 rounded-lg border border-white/10 bg-[#080a10] p-3 font-mono text-xs text-slate-200">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-white">Setup sensitivity · Δ lap time</h3>
        <p className="flex gap-3 text-[10px]"><span className="text-cyan-300">Lower input</span><span className="text-violet-300">Higher input</span></p>
      </header>
      <div className="ml-[min(39%,10rem)] flex justify-between px-2 text-[10px] tabular-nums text-slate-400"><span>−{maxMs.toFixed(1)} ms</span><span>0</span><span>+{maxMs.toFixed(1)} ms</span></div>
      {ranked.map((entry) => (
        <button key={entry.key} type="button" aria-pressed={entry.key === selected.key} onClick={() => select(entry.key)} className="grid w-full grid-cols-[min(39%,10rem)_1fr] items-center rounded px-2 py-1 text-left hover:bg-white/5 focus-visible:outline-cyan-400 aria-pressed:bg-white/10">
          <span className="pr-2">{entry.label}</span>
          <span className="relative block h-5 border-b border-white/5" title={perturbations(entry).map((point) => `${point.label}: ${signed(point.ms, 1)} ms`).join(' · ')}>
            <span className="absolute inset-y-0 left-1/2 w-px bg-white/35" />
            {perturbations(entry).map((point, i) => <span key={point.label} className="absolute h-1.5 rounded-sm" style={{
              top: 3 + 8 * i, left: `${50 + Math.min(0, point.ms / maxMs * 50)}%`, width: `${Math.abs(point.ms / maxMs) * 50}%`, background: point.color,
            }} />)}
          </span>
        </button>
      ))}
      <div aria-live="polite" className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-white/10 pt-2 text-[11px] tabular-nums text-slate-400">
        <span className="text-slate-200">{selected.label} · {signed(selected.msPerUnit, 2)} ms/{selected.unit}</span>
        {perturbations(selected).map((point) => <span key={point.label}>{point.value.toFixed(2)} {selected.unit} · {signed(point.ms, 2)} ms · {signed(point.wh, 2)} Wh</span>)}
      </div>
    </section>
  );
}
