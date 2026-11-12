'use client';

import { useEffect, useRef } from 'react';
import type { WorkspaceMode } from '@/components/ClientApp';

export interface WorkspaceGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentWorkspace: WorkspaceMode;
  onSelectWorkspace: (mode: WorkspaceMode) => void;
}

const WORKSPACES: { id: WorkspaceMode; title: string; description: string }[] = [
  { id: 'main-simulator', title: 'Pist simülatörü', description: 'Pist seç, araç ayarlarını değiştir ve turu incele.' },
  { id: 'ist26-havuz-lab', title: 'İTÜ Havuz Lab', description: 'Havuz pistini ve sürüş kayıtlarını incele, simülasyonları karşılaştır ve VCU / SDC senaryolarını dene.' },
];

export default function WorkspaceGuideModal({ isOpen, onClose, currentWorkspace, onSelectWorkspace }: WorkspaceGuideModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  return (
    <dialog ref={dialogRef} aria-labelledby="workspace-guide-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="w-[min(92vw,32rem)] max-w-none rounded-xl border border-white/10 bg-[#0c1019] p-0 text-slate-200 shadow-2xl backdrop:bg-black/65">
      <div className="space-y-4 p-4 sm:p-5">
        <header className="flex items-center justify-between gap-3">
          <h2 id="workspace-guide-title" className="text-lg font-semibold text-white">Çalışma alanları</h2>
          <button type="button" onClick={onClose} className="btn">Kapat</button>
        </header>
        <div className="space-y-2">
          {WORKSPACES.map(({ id, title, description }) => (
            <div key={id} className="rounded-lg border border-white/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-white">{title}</h3>
                {currentWorkspace === id ? <span className="text-xs text-cyan-300">Açık</span> : (
                  <button type="button" aria-label={title + ' alanına geç'} className="btn"
                    onClick={() => { onSelectWorkspace(id); onClose(); }}>Aç</button>
                )}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
