'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { VehiclePresetId } from '@/lib/tracks';

const Workbench = dynamic(() => import('@/components/Workbench'), { ssr: false });
const IST26HavuzWorkspace = dynamic(() => import('@/components/ist26-havuz/IST26HavuzWorkspace'), { ssr: false });

export type WorkspaceMode = 'main-simulator' | 'ist26-havuz-lab';

const VEHICLE_OPTIONS: { id: VehiclePresetId; title: string; subtitle: string }[] = [
  { id: 'ist26-rwd', title: 'IST26 RWD', subtitle: '3.2:1 · CASCADIA' },
  { id: 'ist27-twotrack', title: 'IST27 TWOTRACKSIM', subtitle: '11.8:1 · SAVED' },
  { id: 'ist27', title: 'IST27 BASELINE', subtitle: '80 KW EV' },
  { id: 'tpsc', title: 'TPSC REFERENCE', subtitle: '220+ KM/H' },
];

export default function ClientApp() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('main-simulator');
  const [activePresetId, setActivePresetId] = useState<VehiclePresetId>('ist27-twotrack');

  return (
    <div className="flex min-h-screen flex-col bg-[#05070b]">
      {/* PRIMARY STEP 1 BAR: WORKSPACE SELECTOR (PIST vs HAVUZ) + VEHICLE SELECTOR */}
      <div className="z-40 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/90 bg-[#04060a] px-4 py-2 font-mono text-xs">
        {/* LEFT: STEP 1 — ÇALIŞMA ALANI SEÇİMİ (PİST Mİ HAVUZ MU?) */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">1. ÇALIŞMA ALANI:</span>
          <div className="inline-flex items-center rounded border border-slate-800 bg-[#070a10] p-0.5">
            <button
              type="button"
              onClick={() => setWorkspaceMode('main-simulator')}
              className={`inline-flex h-7 items-center gap-2 rounded-[3px] px-3 text-[11px] font-semibold uppercase tracking-wider transition ${
                workspaceMode === 'main-simulator'
                  ? 'border border-cyan-500/50 bg-cyan-950/70 text-cyan-300 shadow-[0_0_12px_rgba(0,240,255,0.15)]'
                  : 'border border-transparent text-slate-400 hover:bg-slate-900/70 hover:text-slate-200'
              }`}
            >
              <span>🏁</span>
              <span>Pist Simülatörü (Körfez · FS · Havuz)</span>
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode('ist26-havuz-lab')}
              className={`inline-flex h-7 items-center gap-2 rounded-[3px] px-3 text-[11px] font-semibold uppercase tracking-wider transition ${
                workspaceMode === 'ist26-havuz-lab'
                  ? 'border border-amber-500/50 bg-amber-950/70 text-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.18)]'
                  : 'border border-transparent text-slate-400 hover:bg-slate-900/70 hover:text-slate-200'
              }`}
            >
              <span>🅿️</span>
              <span>İTÜ Havuz Otoparkı Lab (Telemetri & SIL)</span>
            </button>
          </div>
        </div>

        {/* RIGHT: STEP 2 — ARAÇ SEÇİMİ (HER İKİ ÇALIŞMA ALANINDA DA KOŞTURULABİLİR) */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">2. AKTİF ARAÇ:</span>
          <div className="inline-flex flex-wrap items-center gap-1 rounded border border-slate-800 bg-[#070a10] p-0.5">
            {VEHICLE_OPTIONS.map((v) => {
              const active = activePresetId === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setActivePresetId(v.id)}
                  className={`inline-flex h-7 items-center gap-2 rounded-[3px] px-2.5 text-[11px] uppercase tracking-wider transition ${
                    active
                      ? 'border border-cyan-500/50 bg-cyan-950/75 font-semibold text-cyan-300 shadow-[0_0_10px_rgba(0,240,255,0.14)]'
                      : 'border border-transparent text-slate-300 hover:bg-slate-900/80 hover:text-cyan-300'
                  }`}
                >
                  <span>{v.title}</span>
                  <span className={`text-[9px] ${active ? 'text-cyan-400/90' : 'text-slate-500'}`}>{v.subtitle}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Keep both workspaces mounted or toggle cleanly so state is never lost */}
      <div className={workspaceMode === 'main-simulator' ? 'block flex-1' : 'hidden'}>
        <Workbench externalPresetId={activePresetId} onPresetIdChange={setActivePresetId} />
      </div>
      {workspaceMode === 'ist26-havuz-lab' && (
        <div className="flex-1">
          <IST26HavuzWorkspace activePresetId={activePresetId} onSelectPresetId={setActivePresetId} />
        </div>
      )}
    </div>
  );
}
