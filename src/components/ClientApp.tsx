'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { VehiclePresetId } from '@/lib/tracks';

const DarkLoadingFallback = () => (
  <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-[#090a0f] font-mono text-xs text-slate-400">
    <div className="flex items-baseline gap-1.5">
      <span className="text-base font-bold tracking-[0.22em] text-white">APEX</span>
      <span className="text-base font-light tracking-widest text-slate-400">LAPSIM</span>
    </div>
    <span className="text-[11px] text-cyan-400/80">Initializing Vehicle Dynamics & QSS Solver…</span>
  </div>
);

const Workbench = dynamic(() => import('@/components/Workbench'), {
  ssr: false,
  loading: DarkLoadingFallback,
});

const IST26HavuzWorkspace = dynamic(() => import('@/components/ist26-havuz/IST26HavuzWorkspace'), {
  ssr: false,
  loading: DarkLoadingFallback,
});

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
    <div className="flex min-h-screen flex-col bg-[#090a0f] text-slate-200">
      {/* When in IST26 Havuz SIL Lab, show the identical 50px Apple Pro Top Bar with the 2-state Workspace Switcher */}
      {workspaceMode === 'ist26-havuz-lab' && (
        <header className="sticky top-0 z-40 flex h-[50px] min-h-[50px] max-h-[50px] items-center justify-between gap-3 border-b border-white/[0.07] bg-[#090a0f]/85 px-4 font-mono text-xs backdrop-blur-xl">
          <div className="flex items-center gap-2.5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-bold tracking-[0.22em] text-white">APEX</span>
              <span className="text-sm font-light tracking-widest text-slate-400">LAPSIM</span>
            </div>

            {/* Identical 2-State Segmented Workspace Switcher */}
            <div
              className="inline-flex shrink-0 items-center rounded-lg border border-white/[0.1] bg-[#11141d] p-0.5 font-mono text-[10px]"
              role="navigation"
              aria-label="Çalışma Alanı Geçişi (Pist Simülatörü / İTÜ Havuz Lab)"
            >
              <button
                type="button"
                onClick={() => setWorkspaceMode('main-simulator')}
                title="Tıklayarak Ana Pist Simülatörüne (Körfez · FS · Havuz) geri dönün"
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium uppercase tracking-wider text-cyan-300/90 transition hover:bg-cyan-500/15 hover:text-cyan-200"
              >
                <span>←</span>
                <span>🏁 Pist Simülatörü&apos;ne Geç</span>
              </button>
              <span
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-950/60 px-2.5 font-semibold uppercase tracking-wider text-amber-300 shadow-sm"
                title="Şu an buradasınız: İTÜ Havuz Otoparkı Telemetri & SIL Laboratuvarı"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_#f59e0b]" />
                <span>🅿️ İTÜ Havuz Lab</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-[#11141d]/90 p-0.5">
            {VEHICLE_OPTIONS.map((v) => {
              const active = activePresetId === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setActivePresetId(v.id)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] uppercase tracking-wider transition ${
                    active
                      ? 'border border-white/[0.12] bg-slate-800/95 font-medium text-cyan-300 shadow-sm'
                      : 'border border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span>{v.title}</span>
                  <span className="hidden text-[9px] text-slate-500 sm:inline">{v.subtitle}</span>
                </button>
              );
            })}
          </div>
        </header>
      )}

      {/* Keep Main Workbench mounted so solver state & setup edits are preserved */}
      <div className={workspaceMode === 'main-simulator' ? 'block flex-1' : 'hidden'}>
        <Workbench
          externalPresetId={activePresetId}
          onPresetIdChange={setActivePresetId}
          onOpenHavuzLab={() => setWorkspaceMode('ist26-havuz-lab')}
        />
      </div>

      {workspaceMode === 'ist26-havuz-lab' && (
        <div className="flex-1">
          <IST26HavuzWorkspace activePresetId={activePresetId} onSelectPresetId={setActivePresetId} />
        </div>
      )}
    </div>
  );
}
