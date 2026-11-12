'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { VehiclePresetId } from '@/lib/tracks';
import WorkspaceGuideModal from '@/components/navigation/WorkspaceGuideModal';

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

const VEHICLE_OPTIONS: { id: VehiclePresetId; title: string }[] = [
  { id: 'ist26-rwd', title: 'IST26 RWD' },
  { id: 'ist27-twotrack', title: 'IST27 TwoTrackSim' },
  { id: 'ist27', title: 'IST27 Baseline' },
  { id: 'tpsc', title: 'TPSC Reference' },
];

export default function ClientApp() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('main-simulator');
  const [activePresetId, setActivePresetId] = useState<VehiclePresetId>('ist27-twotrack');
  const [showGuideModal, setShowGuideModal] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-[#090a0f] text-slate-200">
      {workspaceMode === 'ist26-havuz-lab' && (
        <header className="sticky top-0 z-40 border-b border-white/10 bg-[#080a10]/95 backdrop-blur-xl">
          <div className="mx-auto flex min-h-14 max-w-[1440px] flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <button type="button" onClick={() => setWorkspaceMode('main-simulator')}
                className="rounded-md px-2 py-1.5 text-sm text-slate-400 hover:bg-white/5 hover:text-white">
                ← Pist simülatörü
              </button>
              <h1 className="text-sm font-semibold text-white">İTÜ Havuz Lab</h1>
            </div>
            <div className="flex items-center gap-2">
              <select aria-label="Simülasyon aracı" value={activePresetId}
                onChange={(event) => setActivePresetId(event.target.value as VehiclePresetId)}
                className="max-w-[65vw] rounded-md border border-white/10 bg-slate-900 px-2 py-1.5 text-sm">
                {VEHICLE_OPTIONS.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
              </select>
              <button type="button" onClick={() => setShowGuideModal(true)}
                className="rounded-md px-2 py-1.5 text-sm text-slate-400 hover:bg-white/5 hover:text-white">
                Rehber
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Keep Main Workbench mounted so solver state & setup edits are preserved */}
      <div className={workspaceMode === 'main-simulator' ? 'block flex-1' : 'hidden'}>
        <Workbench
          shortcutsEnabled={workspaceMode === 'main-simulator' && !showGuideModal}
          externalPresetId={activePresetId}
          onPresetIdChange={setActivePresetId}
          onOpenHavuzLab={() => setWorkspaceMode('ist26-havuz-lab')}
          onOpenGuide={() => setShowGuideModal(true)}
        />
      </div>

      {workspaceMode === 'ist26-havuz-lab' && (
        <div className="flex-1">
          <IST26HavuzWorkspace activePresetId={activePresetId} onSelectPresetId={setActivePresetId} />
        </div>
      )}

      <WorkspaceGuideModal
        isOpen={showGuideModal}
        onClose={() => setShowGuideModal(false)}
        currentWorkspace={workspaceMode}
        onSelectWorkspace={setWorkspaceMode}
      />
    </div>
  );
}
