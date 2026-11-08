'use client';

import React, { useEffect } from 'react';
import type { WorkspaceMode } from '@/components/ClientApp';

export interface WorkspaceGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentWorkspace: WorkspaceMode;
  onSelectWorkspace: (mode: WorkspaceMode) => void;
}

export default function WorkspaceGuideModal({
  isOpen,
  onClose,
  currentWorkspace,
  onSelectWorkspace,
}: WorkspaceGuideModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-guide-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog Card */}
      <div className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl border border-white/15 bg-[#0b0e17]/95 p-6 font-mono text-xs shadow-2xl backdrop-blur-2xl">
        {/* Header */}
        <div className="mb-5 flex items-start justify-between border-b border-white/10 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-300 text-base">
                🧭
              </span>
              <h2 id="workspace-guide-title" className="text-sm font-semibold tracking-wide text-white">
                ApexLapSim — Çalışma Alanları & Geçiş Rehberi
              </h2>
            </div>
            <p className="mt-1 font-sans text-xs text-slate-400">
              ApexLapSim 2 ana bağımsız çalışma alanından oluşur. İstediğiniz an üst bardaki butonlardan veya buradan geçiş yapabilirsiniz.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
            aria-label="Kapat"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 2 Workspace Comparison Cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Card 1: Pist Simülatörü */}
          <div
            className={`flex flex-col justify-between rounded-xl border p-4.5 transition ${
              currentWorkspace === 'main-simulator'
                ? 'border-cyan-500/60 bg-cyan-950/20 shadow-[0_0_24px_rgba(34,211,238,0.15)] ring-1 ring-cyan-500/40'
                : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
            }`}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-mono text-sm font-bold text-white">
                  <span>🏎️</span>
                  <span>PİST SİMÜLATÖRÜ</span>
                </span>
                {currentWorkspace === 'main-simulator' ? (
                  <span className="flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee]" />
                    ŞU AN BURADASINIZ
                  </span>
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-400">
                    Tıklayarak Geçin
                  </span>
                )}
              </div>

              <p className="mt-2.5 font-sans text-xs leading-relaxed text-slate-300">
                Formula Student & Körfez yarış pistlerinde quasi-steady-state ve 2-izli tork vektörleme simülasyonu.
              </p>

              <div className="mt-3.5 space-y-1.5 font-mono text-[11px] text-slate-300">
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span>
                  <span>Körfez, FS Endurance, Skidpad, Acceleration</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span>
                  <span>Out-In-Out Apex Yarış Çizgisi Optimizasyonu</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span>
                  <span>60 FPS Canlı Telemetri & Dairesel G-Force Crosshair</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400">✓</span>
                  <span>Araç Parametreleri, CAN Monitörü & GG Polar Çekmeceleri</span>
                </div>
              </div>
            </div>

            <div className="mt-5 border-t border-white/[0.08] pt-3.5">
              {currentWorkspace === 'main-simulator' ? (
                <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 py-2 font-mono text-xs font-medium text-cyan-300">
                  <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                  <span>Şu an bu çalışma alanındasınız</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onSelectWorkspace('main-simulator');
                    onClose();
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/60 bg-cyan-500/20 py-2 font-mono text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/30 shadow-lg shadow-cyan-950/50"
                >
                  <span>🏎️ Pist Simülatörüne Geç</span>
                  <span>→</span>
                </button>
              )}
            </div>
          </div>

          {/* Card 2: İTÜ Havuz Lab */}
          <div
            className={`flex flex-col justify-between rounded-xl border p-4.5 transition ${
              currentWorkspace === 'ist26-havuz-lab'
                ? 'border-amber-500/60 bg-amber-950/20 shadow-[0_0_24px_rgba(245,158,11,0.15)] ring-1 ring-amber-500/40'
                : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
            }`}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-mono text-sm font-bold text-white">
                  <span>🅿️</span>
                  <span>İTÜ HAVUZ LAB</span>
                </span>
                {currentWorkspace === 'ist26-havuz-lab' ? (
                  <span className="flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_#f59e0b]" />
                    ŞU AN BURADASINIZ
                  </span>
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-slate-400">
                    Tıklayarak Geçin
                  </span>
                )}
              </div>

              <p className="mt-2.5 font-sans text-xs leading-relaxed text-slate-300">
                İTÜ Formula Student IST26 RWD aracının gerçek otopark test telemetri kayıtları ve yazılım laboratuvarı.
              </p>

              <div className="mt-3.5 space-y-1.5 font-mono text-[11px] text-slate-300">
                <div className="flex items-center gap-2">
                  <span className="text-amber-400">✓</span>
                  <span>Stage 1: 8 Adet Gerçek CSV Telemetri Kaydı & Puanlama</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-amber-400">✓</span>
                  <span>Stage 2: Otomatik Pist Çıkarıcı & Yörünge Haritası</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-amber-400">✓</span>
                  <span>Stage 3: Cascadia İnvertör Simülasyonu & L1 Kalibrasyon</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-amber-400">✓</span>
                  <span>Stage 4: VCU Güvenlik FSM & MISRA-C Kod Üretimi</span>
                </div>
              </div>
            </div>

            <div className="mt-5 border-t border-white/[0.08] pt-3.5">
              {currentWorkspace === 'ist26-havuz-lab' ? (
                <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 py-2 font-mono text-xs font-medium text-amber-300">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                  <span>Şu an bu çalışma alanındasınız</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onSelectWorkspace('ist26-havuz-lab');
                    onClose();
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/60 bg-amber-500/20 py-2 font-mono text-xs font-semibold text-amber-200 transition hover:bg-amber-500/30 shadow-lg shadow-amber-950/50"
                >
                  <span>🅿️ İTÜ Havuz Lab'a Geç</span>
                  <span>→</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer Quick Tip */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3 font-sans text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-base">💡</span>
            <span>
              <strong className="text-slate-200">İpucu:</strong> Üst barda yer alan sekmelerden dilediğiniz an iki çalışma alanı arasında geçiş yapabilirsiniz. Araç ayarlarınız ve çözücü verileri kaybolmaz.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-white/10 bg-white/10 px-3.5 py-1.5 font-mono text-xs font-medium text-white hover:bg-white/20 transition"
          >
            Anladım
          </button>
        </div>
      </div>
    </div>
  );
}
