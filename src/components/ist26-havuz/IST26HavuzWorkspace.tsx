'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  DEFAULT_IST26_CALIBRATION,
  Ist26CalibrationParams,
} from '@/lib/ist26-havuz/ist26-vehicle-spec';
import {
  HAVUZ_LOG_ENTRIES,
  HAVUZ_REAL_TELEMETRY_BY_LOG,
  HAVUZ_TRAJECTORY_CLOUD,
  HavuzLogEntry,
  HavuzRealTelemetrySample,
} from '@/lib/ist26-havuz/precomputed-logs';
import {
  ColumnMappingConfig,
  DEFAULT_IST26_COLUMN_MAP,
  getSortedHavuzLogs,
  processRawIst26Csv,
} from '@/lib/ist26-havuz/log-scorer';
import { buildHavuzExtractedCircuit } from '@/lib/ist26-havuz/havuz-track-extractor';
import { exportMotecTelemetry, exportTrackGeoJson, exportTrackSvg } from '@/lib/export/telemetry-exporters';
import { generateApexVcuDbc } from '@/lib/codegen/dbc-generator';
import type { FusionLogResult } from './havuz-fusion.worker';
import {
  AutoFitResult,
  autoFitIst26ToTelemetry,
  simulateIst26OnHavuz,
} from '@/lib/ist26-havuz/ist26-rwd-solver';
import {
  INITIAL_VCU_FSM_RUNTIME,
  ImuFaultMode,
  Ist26VcuState,
  VcuFaultInjectionInputs,
  VcuSafetyFsmRuntimeState,
  generateIst26VcuSafetyFirmware,
  stepIst26VcuSafetyFsm,
} from '@/lib/ist26-havuz/vcu-fault-machine';

type StageTab = 'map' | 'simulation' | 'logs' | 'vcu';

const LAB_VIEWS: { id: StageTab; label: string }[] = [
  { id: 'map', label: 'Pist' },
  { id: 'simulation', label: 'Simülasyon' },
  { id: 'logs', label: 'Kayıtlar' },
  { id: 'vcu', label: 'VCU / SDC' },
];
type LogFilter = 'all' | 'Temiz' | 'Kısmi' | 'Bozuk' | 'auto';

function downloadTextFile(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

import type { VehiclePresetId } from '@/lib/tracks';

export interface IST26HavuzWorkspaceProps {
  activePresetId?: VehiclePresetId;
  onSelectPresetId?: (id: VehiclePresetId) => void;
}

export default function IST26HavuzWorkspace({
  activePresetId = 'ist26-rwd',
  onSelectPresetId,
}: IST26HavuzWorkspaceProps = {}) {
  const [activeStage, setActiveStage] = useState<StageTab>('map');
  const [showPdfSpecModal, setShowPdfSpecModal] = useState(false);

  // ==========================================================================
  // STAGE 1 STATE: LOG SCORER, COLUMN MAPPER & UPLOADED LOGS
  // ==========================================================================
  const [logs, setLogs] = useState<HavuzLogEntry[]>(() => getSortedHavuzLogs(HAVUZ_LOG_ENTRIES));
  const [customTelemetryMap, setCustomTelemetryMap] = useState<Record<string, HavuzRealTelemetrySample[]>>({});
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [colMap, setColMap] = useState<ColumnMappingConfig>(DEFAULT_IST26_COLUMN_MAP);
  const [showColMapper, setShowColMapper] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState<string>('23_08/23_08_2026-11.31.49.csv');
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const fusionWorkers = useRef(new Map<string, Worker>());
  const [fusionByLog, setFusionByLog] = useState<Record<string, { result?: FusionLogResult; error?: string }>>({});
  useEffect(() => {
    const workers = fusionWorkers.current;
    return () => { workers.forEach((worker) => worker.terminate()); workers.clear(); };
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (logFilter === 'all') return true;
      if (logFilter === 'auto') return l.autoSelected;
      return l.status === logFilter;
    });
  }, [logs, logFilter]);

  const logStats = useMemo(() => {
    const clean = logs.filter((l) => l.status === 'Temiz').length;
    const partial = logs.filter((l) => l.status === 'Kısmi').length;
    const broken = logs.filter((l) => l.status === 'Bozuk').length;
    const autoCount = logs.filter((l) => l.autoSelected).length;
    const totalDistKm = logs.reduce((a, l) => a + l.distanceM, 0) / 1000;
    return { total: logs.length, clean, partial, broken, autoCount, totalDistKm };
  }, [logs]);

  const handleUploadLogCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const { entry, samples } = processRawIst26Csv(file.name, text, colMap);
      setLogs((prev) => getSortedHavuzLogs([entry, ...prev.filter((x) => x.id !== entry.id)]));
      if (samples.length > 0) {
        setCustomTelemetryMap((prev) => ({ ...prev, [entry.id]: samples }));
        setSelectedLogId(entry.id);
        fusionWorkers.current.get(entry.id)?.terminate();
        const worker = new Worker(new URL('./havuz-fusion.worker.ts', import.meta.url));
        fusionWorkers.current.set(entry.id, worker);
        setFusionByLog((previous) => ({ ...previous, [entry.id]: {} }));
        const finish = (outcome: { result?: FusionLogResult; error?: string }) => {
          if (fusionWorkers.current.get(entry.id) !== worker) return;
          setFusionByLog((previous) => ({ ...previous, [entry.id]: outcome }));
          worker.terminate();
          fusionWorkers.current.delete(entry.id);
        };
        worker.onmessage = (message: MessageEvent<{ result?: FusionLogResult; error?: string }>) => finish(message.data);
        worker.onerror = () => finish({ error: 'EKF arka plan işlemi tamamlanamadı.' });
        worker.postMessage({ csv: text });
      }
    };
    reader.readAsText(file);
  };

  // ==========================================================================
  // STAGE 2 STATE: İTÜ HAVUZ OTOPARKI TRACK EXTRACTOR & HEATMAP CANVAS
  // ==========================================================================
  const [coneHalfWidthM, setConeHalfWidthM] = useState<number>(1.5);
  const [showHeatmap, setShowHeatmap] = useState<boolean>(false);
  const [showCloudTraces, setShowCloudTraces] = useState<boolean>(false);
  const [showOutliers, setShowOutliers] = useState<boolean>(false);
  const [showCones, setShowCones] = useState<boolean>(true);
  const [lapPlaying, setLapPlaying] = useState<boolean>(false);
  const [cursorIdx, setCursorIdx] = useState<number>(0);

  const circuit = useMemo(() => buildHavuzExtractedCircuit(coneHalfWidthM), [coneHalfWidthM]);

  useEffect(() => {
    if (!lapPlaying || (activeStage !== 'map' && activeStage !== 'vcu')) return;
    const timer = window.setInterval(() => {
      setCursorIdx((prev) => (prev + 1) % circuit.nodes.length);
    }, 65);
    return () => window.clearInterval(timer);
  }, [activeStage, lapPlaying, circuit.nodes.length]);

  // ==========================================================================
  // STAGE 3 STATE: MULTI-VEHICLE HAVUZ SIMULATION OVERLAY & SOFT-L1 AUTO-FIT
  // ==========================================================================
  const [ist26Cal, setIst26Cal] = useState<Ist26CalibrationParams>(DEFAULT_IST26_CALIBRATION);
  const [autoFitResult, setAutoFitResult] = useState<AutoFitResult | null>(null);

  // Read saved IST27 TwoTrackSim parameters from localStorage if present
  const savedTwoTrackOverride = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    try {
      const raw = window.localStorage.getItem('apexlapsim.preset.ist27-twotrack.v1');
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      return {
        vehicleParams: parsed?.vehPatch ?? {},
        powertrainParams: { gearRatio: 11.8, ...(parsed?.ptPatch ?? {}) },
      };
    } catch {
      return undefined;
    }
  }, [activePresetId]);

  const simResult = useMemo(() => {
    const customSamples = customTelemetryMap[selectedLogId];
    return simulateIst26OnHavuz(selectedLogId, ist26Cal, circuit.nodes, customSamples, {
      presetId: activePresetId,
      ...(activePresetId === 'ist27-twotrack' ? savedTwoTrackOverride : {}),
    });
  }, [selectedLogId, ist26Cal, circuit.nodes, customTelemetryMap, activePresetId, savedTwoTrackOverride]);

  // Multi-vehicle benchmark on İTÜ Havuz Otoparkı (IST26 RWD vs IST27 TwoTrackSim vs IST27 Baseline vs TPSC)
  const multiVehicleComparison = useMemo(() => {
    const customSamples = customTelemetryMap[selectedLogId];
    const presets: Array<{ id: VehiclePresetId; name: string; spec: string }> = [
      { id: 'ist26-rwd', name: 'IST26 RWD (Cascadia)', spec: '335.5 kg · 1 Motor · 3.2:1' },
      { id: 'ist27-twotrack', name: 'IST27 TwoTrackSim', spec: 'Kayıtlı Veri · 2 Motor · 11.8:1' },
      { id: 'ist27', name: 'IST27 Baseline', spec: '230 kg · 80 kW EV · 12.0:1' },
      { id: 'tpsc', name: 'TPSC Reference', spec: '1050 kg · 230 kW · 3.6:1' },
    ];
    return presets.map((p) => {
      const res = simulateIst26OnHavuz(selectedLogId, ist26Cal, circuit.nodes, customSamples, {
        presetId: p.id,
        ...(p.id === 'ist27-twotrack' ? savedTwoTrackOverride : {}),
      });
      return {
        ...p,
        simLapTimeS: res.metrics.simLapTimeS,
        maxVxKph: Number(((res.metrics.maxVxMs ?? 12.5) * 3.6).toFixed(1)),
        maxAyG: res.metrics.maxAyG ?? 1.25,
        peakWheelTorqueNm: res.metrics.peakWheelTorqueNm ?? 942.4,
        rmseVxMs: res.metrics.rmseVxMs,
      };
    });
  }, [selectedLogId, ist26Cal, circuit.nodes, customTelemetryMap, savedTwoTrackOverride]);

  const handleRunAutoFit = () => {
    const customSamples = customTelemetryMap[selectedLogId];
    const res = autoFitIst26ToTelemetry(selectedLogId, ist26Cal, circuit.nodes, customSamples, {
      presetId: activePresetId,
      ...(activePresetId === 'ist27-twotrack' ? savedTwoTrackOverride : {}),
    });
    setIst26Cal(res.fittedCalibration);
    setAutoFitResult(res);
  };

  const handleResetIst26Cal = () => {
    setIst26Cal(DEFAULT_IST26_CALIBRATION);
    setAutoFitResult(null);
  };
  const fusion = fusionByLog[selectedLogId];
  const fusionPanel = useMemo(() => fusion && (
    <details className="mt-3 rounded border border-slate-800 p-3 text-xs text-slate-300">
      <summary className="cursor-pointer font-mono font-bold text-cyan-200">6-DOF EKF · β ve arka tekerlek kayması</summary>
      {fusion.error && <p className="mt-2 text-amber-300">{fusion.error}</p>}
      {!fusion.error && !fusion.result && <p role="status" className="mt-2">Sensör kayıtları işleniyor…</p>}
      {fusion.result && (
        <>
          <p className="mt-2 font-mono tabular-nums">{fusion.result.sampleCount} örnek · {fusion.result.imuDropouts} IMU eksik · {fusion.result.wheelDropouts} tekerlek hızı eksik · CAN sayaç zaman aşımı {fusion.result.canTimeouts ?? '—'}</p>
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={fusion.result.rows}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="time" type="number" unit=" s" tick={{ fontSize: 10 }} tickFormatter={(value: number) => value.toFixed(0)} />
              <YAxis yAxisId="beta" unit="°" tick={{ fontSize: 10 }} width={43} />
              <YAxis yAxisId="slip" unit="%" orientation="right" tick={{ fontSize: 10 }} width={44} />
              <Tooltip isAnimationActive={false} labelFormatter={(value) => `${Number(value).toFixed(2)} s`} />
              <Legend />
              <Line yAxisId="beta" dataKey="beta" name="β [°]" stroke="#22d3ee" dot={false} isAnimationActive={false} />
              <Line yAxisId="slip" dataKey="slipRL" name="RL [%]" stroke="#a78bfa" dot={false} isAnimationActive={false} />
              <Line yAxisId="slip" dataKey="slipRR" name="RR [%]" stroke="#fb923c" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </details>
  ), [fusion]);

  // ==========================================================================
  // STAGE 4 STATE: FSAE VCU FAULT INJECTION & CASCADIA PLAUSIBILITY FSM
  // ==========================================================================
  const [vcuInputs, setVcuInputs] = useState<VcuFaultInjectionInputs>({
    appsPct: 64,
    appsDeviationPct: 2.0,
    brakePressureBar: 0.0,
    dcBusPowerKw: 38.0,
    inverterTempC: 42.0,
    motorTempC: 58.0,
    motorRpm: 2850,
    imuFaultMode: 'NOMINAL',
    prechargePct: 98.0,
    r2dArmed: true,
  });

  const [vcuRuntime, setVcuRuntime] = useState<VcuSafetyFsmRuntimeState>(INITIAL_VCU_FSM_RUNTIME);
  const [syncVcuWithLapCursor, setSyncVcuWithLapCursor] = useState<boolean>(false);
  const [codePreviewTab, setCodePreviewTab] = useState<'header' | 'source'>('source');

  const firmwareFiles = useMemo(() => generateIst26VcuSafetyFirmware(), []);

  // Sync motor RPM / throttle from active lap node when syncVcuWithLapCursor is enabled
  useEffect(() => {
    if (!syncVcuWithLapCursor) return;
    const pt = simResult.points[cursorIdx];
    if (!pt) return;
    setVcuInputs((prev) => ({
      ...prev,
      motorRpm: pt.motorRpmSim,
      appsPct: Math.min(100, Math.max(0, Math.round((pt.torqueSimNm / 310) * 100))),
      dcBusPowerKw: Number(((pt.dcCurrSimA * 342) / 1000).toFixed(1)),
    }));
  }, [cursorIdx, syncVcuWithLapCursor, simResult.points]);

  // 25 ms (40 Hz) deterministic real-time step for the VCU Fault State Machine timers (100 ms APPS, 500 ms BSPD)
  useEffect(() => {
    const dtMs = 25;
    const id = window.setInterval(() => {
      setVcuRuntime((prev) => stepIst26VcuSafetyFsm(prev, vcuInputs, dtMs));
    }, dtMs);
    return () => window.clearInterval(id);
  }, [vcuInputs]);

  const handleHardResetVcuFsm = () => {
    setVcuInputs({
      appsPct: 45,
      appsDeviationPct: 1.5,
      brakePressureBar: 0.0,
      dcBusPowerKw: 24.0,
      inverterTempC: 40.0,
      motorTempC: 55.0,
      motorRpm: 2400,
      imuFaultMode: 'NOMINAL',
      prechargePct: 98.0,
      r2dArmed: true,
    });
    setVcuRuntime(INITIAL_VCU_FSM_RUNTIME);
  };

  // Compute SVG viewBox bounds for the İTÜ Havuz Otoparkı canvas
  const mapBounds = useMemo(() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of circuit.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 7.5;
    return {
      minX: minX - pad,
      minY: minY - pad,
      width: Math.max(20, maxX - minX + 2 * pad),
      height: Math.max(15, maxY - minY + 2 * pad),
    };
  }, [circuit.nodes]);

  const activeNode = circuit.nodes[cursorIdx] ?? circuit.nodes[0];
  const activeOverlayPt = simResult.points[cursorIdx] ?? simResult.points[0];

  const fsmStatesOrder: Array<{ id: Ist26VcuState; short: string; sub: string }> = [
    { id: 'VCU_STATE_INIT', short: 'INIT', sub: 'LV & CAN Boot' },
    { id: 'VCU_STATE_PRECHARGE', short: 'PRECHARGE', sub: 'HV Bus <95%' },
    { id: 'VCU_STATE_READY', short: 'READY', sub: 'Wait R2D' },
    { id: 'VCU_STATE_DRIVE', short: 'DRIVE', sub: '310 Nm Nominal' },
    { id: 'VCU_STATE_DERATE', short: 'DERATE', sub: 'Temp / IMU Limit' },
    { id: 'VCU_STATE_FAULT_LATCHED', short: 'FAULT_LATCHED', sub: 'APPS / EV 2.3 (0 Nm)' },
    { id: 'VCU_STATE_FAULT_SAFE', short: 'FAULT_SAFE', sub: 'BSPD / SDC Open' },
  ];

  return (
    <div className="min-h-screen bg-[#05070b] text-slate-200">
      <nav aria-label="Havuz Lab bölümleri" className="mx-auto flex max-w-[1440px] flex-wrap gap-1 border-b border-white/10 px-3 py-2 sm:px-5">
        {LAB_VIEWS.map(({ id, label }) => (
          <button key={id} type="button" aria-current={activeStage === id ? 'page' : undefined}
            onClick={() => setActiveStage(id)}
            className={`rounded-md px-3 py-2 text-sm transition ${activeStage === id ? 'bg-white/10 font-medium text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'}`}>
            {label}
          </button>
        ))}
      </nav>

      <div className="mx-auto max-w-[1440px] min-w-0 px-3 py-4 sm:px-5">
        {/* =================================================================== */}
        {/* STAGE 1: OTOMATİK LOG TARAYICI, KALİTE PUANLAMA & ÖN-TEMİZLEME       */}
        {/* =================================================================== */}
        {(activeStage === 'logs') && (
          <section className="rounded-md border border-slate-800 bg-[#080c14] p-4 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-cyan-500/20 px-2 py-0.5 font-mono text-xs font-bold text-cyan-400">
                    AŞAMA 1
                  </span>
                  <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-slate-100">
                    Otomatik Log Tarayıcı, Kalite Puanlama (Log Scorer) & Ön-Temizleme (./logs)
                  </h2>
                </div>
                <p className="mt-1 font-mono text-xs text-slate-400">
                  Zero-Velocity Clamping (v_x &lt; 0.5 m/s dondurma) · Kısa Kayıt (&lt;15 sn veya &lt;50 m) Elemesi · 5-Nokta Medyan + Savitzky-Golay Spin/Spike Filtresi
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowColMapper((o) => !o)}
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-slate-200 transition hover:border-cyan-500/50 hover:text-cyan-300"
                >
                  ⚙ Esnek Sütun Eşleştirici (Column Mapper)
                </button>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleUploadLogCsv}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => uploadInputRef.current?.click()}
                  className="rounded border border-emerald-500/50 bg-emerald-950/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-emerald-300 transition hover:bg-emerald-900/60"
                >
                  + Yeni IST26 CSV Log Yükle
                </button>
              </div>
            </div>

            {/* Summary KPI Cards */}
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="rounded border border-slate-800 bg-slate-950/70 p-2.5 font-mono">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Taranan ./logs Dosyası</div>
                <div className="mt-1 text-lg font-bold text-slate-100">{logStats.total} Dosya</div>
                <div className="text-[11px] text-slate-500">18_08, 19_08, 20_09, 21_09, 23_08, xlsx</div>
              </div>
              <div className="rounded border border-emerald-500/30 bg-emerald-950/20 p-2.5 font-mono">
                <div className="text-[10px] uppercase tracking-wider text-emerald-400">Temiz Loglar (Skor ≥ 75)</div>
                <div className="mt-1 text-lg font-bold text-emerald-300">{logStats.clean} Temiz</div>
                <div className="text-[11px] text-emerald-500/80">{logStats.autoCount} tanesi otomatik seçildi</div>
              </div>
              <div className="rounded border border-amber-500/30 bg-amber-950/20 p-2.5 font-mono">
                <div className="text-[10px] uppercase tracking-wider text-amber-400">Kısmi Loglar (IMU Kapalı)</div>
                <div className="mt-1 text-lg font-bold text-amber-300">{logStats.partial} Kısmi</div>
                <div className="text-[11px] text-amber-500/80">Teker hızı & Cascadia mevcut</div>
              </div>
              <div className="rounded border border-red-500/30 bg-red-950/20 p-2.5 font-mono">
                <div className="text-[10px] uppercase tracking-wider text-red-400">Bozuk / Kısa (&lt;15s / &lt;50m)</div>
                <div className="mt-1 text-lg font-bold text-red-300">{logStats.broken} Elenen</div>
                <div className="text-[11px] text-red-500/80">Otomatik olarak pistten dışlandı</div>
              </div>
              <div className="rounded border border-cyan-500/30 bg-cyan-950/20 p-2.5 font-mono">
                <div className="text-[10px] uppercase tracking-wider text-cyan-400">Toplam Aktif Mesafe</div>
                <div className="mt-1 text-lg font-bold text-cyan-300">{logStats.totalDistKm.toFixed(2)} km</div>
                <div className="text-[11px] text-cyan-500/80">43 Tam Havuz Otoparkı Turu</div>
              </div>
            </div>

            {/* Flexible Column Mapper Drawer */}
            {showColMapper && (
              <div className="mt-3 rounded border border-cyan-500/40 bg-[#060a12] p-3 font-mono text-xs">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-bold uppercase tracking-wider text-cyan-400">
                    Esnek Sütun Eşleştirici (Otomatik Tanınan & Manuel Düzenlenebilir IST26 Kanalları)
                  </span>
                  <button
                    type="button"
                    onClick={() => setColMap(DEFAULT_IST26_COLUMN_MAP)}
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-cyan-500"
                  >
                    Varsayılana Sıfırla
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {(Object.keys(colMap) as Array<keyof ColumnMappingConfig>).map((key) => (
                    <label key={key} className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-slate-400">{key}</span>
                      <input
                        type="text"
                        value={colMap[key]}
                        onChange={(e) => setColMap((prev) => ({ ...prev, [key]: e.target.value }))}
                        className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-cyan-300 outline-none focus:border-cyan-500"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Filter Bar */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-mono text-xs">
                {(
                  [
                    { id: 'all', label: `Tümü (${logs.length})` },
                    { id: 'auto', label: `★ Otomatik Seçilen (${logStats.autoCount})` },
                    { id: 'Temiz', label: `Temiz (${logStats.clean})` },
                    { id: 'Kısmi', label: `Kısmi (${logStats.partial})` },
                    { id: 'Bozuk', label: `Bozuk (${logStats.broken})` },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setLogFilter(f.id)}
                    className={`rounded px-2.5 py-1 transition ${
                      logFilter === f.id
                        ? 'border border-cyan-500/50 bg-cyan-950/70 text-cyan-300'
                        : 'border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <span className="font-mono text-xs text-slate-400">
                Aktif Overlay Logu: <strong className="text-amber-300">{selectedLogId}</strong>
              </span>
            </div>

            {/* Log Scorer Table */}
            <div className="mt-2 max-h-80 overflow-y-auto rounded border border-slate-800">
              <table className="w-full border-collapse text-left font-mono text-xs">
                <thead className="sticky top-0 bg-[#0b101b] text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="p-2">Dosya (./logs)</th>
                    <th className="p-2">Kalite Skoru</th>
                    <th className="p-2">Durum</th>
                    <th className="p-2 text-right">Aktif Sürüş</th>
                    <th className="p-2 text-right">Mesafe</th>
                    <th className="p-2 text-right">Tahmini Tur</th>
                    <th className="p-2 text-right">Maks Hız / RPM</th>
                    <th className="p-2 text-right">Kırpılan / Spike</th>
                    <th className="p-2">Sensör & Tanı</th>
                    <th className="p-2 text-right">İşlem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {filteredLogs.map((l) => {
                    const isSelected = l.id === selectedLogId;
                    const canOverlay = Boolean(HAVUZ_REAL_TELEMETRY_BY_LOG[l.id] || customTelemetryMap[l.id]);
                    return (
                      <tr
                        key={l.id}
                        className={`transition ${
                          isSelected ? 'bg-cyan-950/40' : 'hover:bg-slate-900/60'
                        }`}
                      >
                        <td className="p-2 font-medium text-slate-200">
                          <div className="flex items-center gap-1.5">
                            {l.autoSelected && (
                              <span title="Otomatik Seçilen Yüksek Kaliteli Log" className="text-amber-400">
                                ★
                              </span>
                            )}
                            <span>{l.relativePath}</span>
                          </div>
                        </td>
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-16 overflow-hidden rounded bg-slate-800">
                              <div
                                className={`h-full ${
                                  l.qualityScore >= 75
                                    ? 'bg-emerald-400'
                                    : l.qualityScore >= 40
                                      ? 'bg-amber-400'
                                      : 'bg-red-500'
                                }`}
                                style={{ width: `${l.qualityScore}%` }}
                              />
                            </div>
                            <span className="font-bold tabular-nums">{l.qualityScore}/100</span>
                          </div>
                        </td>
                        <td className="p-2">
                          <span
                            className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                              l.status === 'Temiz'
                                ? 'border border-emerald-500/40 bg-emerald-950/60 text-emerald-300'
                                : l.status === 'Kısmi'
                                  ? 'border border-amber-500/40 bg-amber-950/60 text-amber-300'
                                  : 'border border-red-500/40 bg-red-950/60 text-red-300'
                            }`}
                          >
                            {l.status}
                          </span>
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {l.activeDrivingTimeS.toFixed(1)} sn
                          <span className="block text-[10px] text-slate-500">
                            toplam {l.totalDurationS.toFixed(0)}s
                          </span>
                        </td>
                        <td className="p-2 text-right tabular-nums">{l.distanceM.toFixed(0)} m</td>
                        <td className="p-2 text-right tabular-nums font-semibold text-cyan-300">
                          {l.estimatedLaps.toFixed(2)} tur
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {l.maxSpeedKmh.toFixed(1)} km/h
                          <span className="block text-[10px] text-slate-500">
                            {l.maxMotorRpm} RPM · {l.maxTorqueNm} Nm
                          </span>
                        </td>
                        <td className="p-2 text-right tabular-nums text-[11px] text-slate-400">
                          {l.zeroVelClampedRows} satır
                          <span className="block text-[10px] text-slate-500">
                            {l.spikesFiltered} spike filtrelendi
                          </span>
                        </td>
                        <td className="p-2 text-[11px] text-slate-400">{l.statusReason}</td>
                        <td className="p-2 text-right">
                          {canOverlay ? (
                            <button
                              type="button"
                              onClick={() => setSelectedLogId(l.id)}
                              className={`rounded px-2.5 py-1 text-[11px] font-semibold uppercase transition ${
                                isSelected
                                  ? 'border border-amber-400 bg-amber-500/20 text-amber-300'
                                  : 'border border-cyan-500/40 bg-cyan-950/50 text-cyan-300 hover:bg-cyan-900/60'
                              }`}
                            >
                              {isSelected ? '✓ Seçili' : 'Overlay Seç'}
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-600">Elenen</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* =================================================================== */}
        {/* STAGE 2: "EN ÇOK GİDİLEN YOL PİSTİMİZDİR" — İTÜ HAVUZ OTOPARKI      */}
        {/* =================================================================== */}
        {activeStage === 'map' && (
          <section aria-labelledby="havuz-map-title" className="min-w-0">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="havuz-map-title" className="text-xl font-semibold text-white">Havuz pisti</h2>
                <p className="mt-1 text-sm tabular-nums text-slate-400">
                  {circuit.totalLengthM.toFixed(1)} m · {circuit.corners.length} viraj · {circuit.sectors.length} sektör
                </p>
              </div>
              <button type="button" onClick={() => setLapPlaying((playing) => !playing)}
                className="rounded-md bg-cyan-400 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-300">
                {lapPlaying ? 'Duraklat' : 'Turu oynat'}
              </button>
            </div>

            <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="min-w-0 rounded-xl border border-white/10 bg-[#080a10] p-2 sm:p-3">
                <svg
                  viewBox={`${mapBounds.minX} ${mapBounds.minY} ${mapBounds.width} ${mapBounds.height}`}
                  role="img" aria-label="Havuz pisti haritası"
                  className="h-[clamp(260px,52vh,530px)] w-full rounded-lg bg-[#05070b]"
                >
                  {/* Coordinate Grid Lines (every 5 meters) */}
                  {Array.from({ length: 18 }, (_, i) => -40 + i * 5).map((gx) => (
                    <line
                      key={`gx-${gx}`}
                      x1={gx}
                      y1={mapBounds.minY}
                      x2={gx}
                      y2={mapBounds.minY + mapBounds.height}
                      stroke="#0f172a"
                      strokeWidth={0.12}
                    />
                  ))}
                  {Array.from({ length: 12 }, (_, i) => -25 + i * 5).map((gy) => (
                    <line
                      key={`gy-${gy}`}
                      x1={mapBounds.minX}
                      y1={gy}
                      x2={mapBounds.minX + mapBounds.width}
                      y2={gy}
                      stroke="#0f172a"
                      strokeWidth={0.12}
                    />
                  ))}

                  {/* 1. 2D KDE Trajectory Heatmap Cells */}
                  {showHeatmap &&
                    circuit.heatmapCells.map((cell, idx) => (
                      <circle
                        key={`hm-${idx}`}
                        cx={cell.x}
                        cy={cell.y}
                        r={1.35}
                        fill={
                          cell.density > 0.65
                            ? 'rgba(249, 115, 22, 0.28)'
                            : cell.density > 0.35
                              ? 'rgba(234, 179, 8, 0.18)'
                              : 'rgba(6, 182, 212, 0.11)'
                        }
                      />
                    ))}

                  {/* 2. Valid Trajectory Cloud Traces */}
                  {showCloudTraces &&
                    HAVUZ_TRAJECTORY_CLOUD.filter((t) => !t.isOutlier).map((tr) => (
                      <polyline
                        key={tr.id}
                        fill="none"
                        stroke="rgba(56, 189, 248, 0.22)"
                        strokeWidth={0.18}
                        points={tr.points.map(([x, y]) => `${x},${y}`).join(' ')}
                      />
                    ))}

                  {/* 3. Spatial Outliers / Spin Traces (Rejected by KDE Clustering) */}
                  {showOutliers &&
                    HAVUZ_TRAJECTORY_CLOUD.filter((t) => t.isOutlier).map((tr) => (
                      <polyline
                        key={tr.id}
                        fill="none"
                        stroke="rgba(239, 68, 68, 0.72)"
                        strokeWidth={0.25}
                        strokeDasharray="0.6 0.4"
                        points={tr.points.map(([x, y]) => `${x},${y}`).join(' ')}
                      />
                    ))}

                  {/* 4. Left Blue Cones (+1.5m) & Right Yellow Cones (-1.5m) */}
                  {showCones && (
                    <>
                      <polygon
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth={0.22}
                        strokeDasharray="0.5 0.35"
                        points={circuit.nodes.map((n) => `${n.leftConeX},${n.leftConeY}`).join(' ')}
                      />
                      <polygon
                        fill="none"
                        stroke="#eab308"
                        strokeWidth={0.22}
                        strokeDasharray="0.5 0.35"
                        points={circuit.nodes.map((n) => `${n.rightConeX},${n.rightConeY}`).join(' ')}
                      />
                      {circuit.nodes
                        .filter((_, idx) => idx % 3 === 0)
                        .map((n, idx) => (
                          <g key={`cones-${idx}`}>
                            <circle cx={n.leftConeX} cy={n.leftConeY} r={0.26} fill="#3b82f6" />
                            <circle cx={n.rightConeX} cy={n.rightConeY} r={0.26} fill="#facc15" />
                          </g>
                        ))}
                    </>
                  )}

                  {/* Periodic spline centerline and sector gates */}
                  <polygon
                    fill="none"
                    stroke="#00f0ff"
                    strokeWidth={0.38}
                    points={circuit.nodes.map((n) => `${n.x},${n.y}`).join(' ')}
                  />
                  {circuit.sectors.map(({ s, x, y }, i) => (
                    <g key={s}>
                      <circle cx={x} cy={y} r={0.65} fill="#fbbf24" />
                      <text x={x + 0.9} y={y - 0.6} fill="#fde68a" fontSize={1.55}>S{i + 1}</text>
                    </g>
                  ))}
                  {circuit.corners.map((corner) => {
                    const apex = circuit.nodes[corner.apexIndex];
                    return <text key={corner.index} x={apex.x + 0.8} y={apex.y + 1.5} fill="#e2e8f0" fontSize={1.35}>T{corner.index}</text>;
                  })}

                  {/* Start/Finish Line */}
                  {circuit.nodes[0] && (
                    <line
                      x1={circuit.nodes[0].leftConeX}
                      y1={circuit.nodes[0].leftConeY}
                      x2={circuit.nodes[0].rightConeX}
                      y2={circuit.nodes[0].rightConeY}
                      stroke="#10b981"
                      strokeWidth={0.45}
                    />
                  )}

                  {/* Active IST26 Vehicle Marker */}
                  {activeNode && (
                    <g>
                      <circle cx={activeNode.x} cy={activeNode.y} r={1.1} fill="rgba(245, 158, 11, 0.28)" />
                      <circle cx={activeNode.x} cy={activeNode.y} r={0.55} fill="#f59e0b" stroke="#ffffff" strokeWidth={0.15} />
                    </g>
                  )}
                </svg>

                <div className="px-2 pb-1 pt-3">
                  <label className="block text-xs tabular-nums text-slate-400">
                    Tur konumu · {activeNode?.s.toFixed(1)} m · {((activeOverlayPt?.vxSim ?? 0) * 3.6).toFixed(0)} km/sa
                    <input type="range" min={0} max={circuit.nodes.length - 1} value={cursorIdx}
                      onChange={(event) => { setLapPlaying(false); setCursorIdx(event.target.valueAsNumber); }}
                      className="mt-1 block w-full accent-cyan-400" />
                  </label>
                </div>
              </div>

              <div className="min-w-0 space-y-2">
                <details className="rounded-lg border border-white/10 px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-slate-200">Harita katmanları</summary>
                  <div className="mt-3 grid gap-2 text-sm text-slate-300">
                    {[
                      { label: 'Koniler', enabled: showCones, change: setShowCones },
                      { label: 'Sürüş izleri', enabled: showCloudTraces, change: setShowCloudTraces },
                      { label: 'Yoğunluk haritası', enabled: showHeatmap, change: setShowHeatmap },
                      { label: 'Elenen izler', enabled: showOutliers, change: setShowOutliers },
                    ].map(({ label, enabled, change }) => (
                      <label key={label} className="flex items-center gap-2">
                        <input type="checkbox" checked={enabled} onChange={(event) => change(event.target.checked)} className="accent-cyan-400" />
                        {label}
                      </label>
                    ))}
                    <label className="mt-2 text-xs tabular-nums text-slate-400">
                      Koni yarı genişliği · {coneHalfWidthM.toFixed(2)} m
                      <input type="range" min={1.1} max={2.4} step={0.05} value={coneHalfWidthM}
                        onChange={(event) => setConeHalfWidthM(event.target.valueAsNumber)} className="block w-full accent-cyan-400" />
                    </label>
                  </div>
                </details>
                <details className="rounded-lg border border-white/10 px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-slate-200">Pist geometrisi</summary>
                  <p className="mt-2 text-xs text-slate-400">En dar viraj {circuit.minCornerRadiusM} m · {circuit.validTracesCount} sürüş izi · {circuit.rejectedPointCount} elenen nokta</p>
                  <div className="h-52 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={circuit.nodes}>
                        <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                        <XAxis dataKey="s" stroke="#64748b" tick={{ fontSize: 10 }} unit="m" />
                        <YAxis stroke="#64748b" tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#07090e', borderColor: '#334155', fontSize: 11 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="kappa"
                          name="κ(s) [1/m]"
                          stroke="#00f0ff"
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </details>
                <details className="rounded-lg border border-white/10 px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-slate-200">Pisti indir</summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn" title="Yaklaşık WGS84 konumu"
                      onClick={() => downloadTextFile('havuz-track.geojson', exportTrackGeoJson(circuit, { latitude: 41.1016, longitude: 29.0258, rotationDeg: 0 }), 'application/geo+json')}>GeoJSON</button>
                    <button type="button" className="btn" onClick={() => downloadTextFile('havuz-track.svg', exportTrackSvg(circuit), 'image/svg+xml')}>SVG</button>
                  </div>
                </details>
              </div>
            </div>
          </section>
        )}

        {/* =================================================================== */}
        {/* STAGE 3: IST26 REAL TELEMETRY OVERLAY & AUTO-FIT KALİBRASYON MOTORU */}
        {/* =================================================================== */}
        {(activeStage === 'simulation') && (
          <section className="rounded-md border border-slate-800 bg-[#080c14] p-4 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-emerald-500/20 px-2 py-0.5 font-mono text-xs font-bold text-emerald-400">
                    AŞAMA 3
                  </span>
                  <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-slate-100">
                    IST26 Real Telemetry Overlay & Auto-Fit (soft_l1 Least-Squares) Kalibrasyon Motoru
                  </h2>
                </div>
                <p className="mt-1 font-mono text-xs text-slate-400">
                  Gerçek Log (Kesikli Çizgi) vs Sanal IST26 Tek Motor + Cascadia İnvertör Modeli (Düz Çizgi) · Sadece İzole IST26 Profilini Günceller
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <select
                  aria-label="Overlay Log Seçimi"
                  value={selectedLogId}
                  onChange={(e) => setSelectedLogId(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-cyan-300 outline-none"
                >
                  {Object.keys(HAVUZ_REAL_TELEMETRY_BY_LOG).map((id) => (
                    <option key={id} value={id} className="bg-[#07090e] text-slate-200">
                      Log: {id}
                    </option>
                  ))}
                  {Object.keys(customTelemetryMap).map((id) => (
                    <option key={id} value={id} className="bg-[#07090e] text-emerald-300">
                      Yüklenen: {id}
                    </option>
                  ))}
                </select>

                <button type="button" className="rounded border border-slate-700 px-2.5 py-1.5 text-cyan-200" disabled={simResult.points.length === 0} onClick={() => downloadTextFile('havuz-telemetry-motec.csv', exportMotecTelemetry(simResult), 'text/csv')}>MoTeC CSV</button>

                <button
                  type="button"
                  onClick={handleRunAutoFit}
                  className="rounded border border-amber-500/60 bg-amber-950/70 px-3.5 py-1.5 font-bold uppercase tracking-wider text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.25)] transition hover:bg-amber-900/80"
                >
                  ⚡ Otomatik Otopark Asfaltı Kalibrasyonu (soft_l1 Auto-Fit)
                </button>
                <button
                  type="button"
                  onClick={handleResetIst26Cal}
                  className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-300 hover:border-cyan-500/50"
                >
                  PDF Nominal Değerlere Dön
                </button>
              </div>
            </div>

        <details className="mt-4 rounded-lg border border-white/10 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-200">Araç karşılaştırması</summary>
        <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {multiVehicleComparison.map((v) => {
            const isSel = activePresetId === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelectPresetId?.(v.id)}
                className={`flex items-center justify-between rounded border px-3 py-2 text-left font-mono transition ${
                  isSel
                    ? 'border-cyan-500/60 bg-cyan-950/40 shadow-[0_0_12px_rgba(0,240,255,0.12)]'
                    : 'border-slate-800/90 bg-[#060910] hover:border-slate-700 hover:bg-slate-900/50'
                }`}
              >
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-bold uppercase ${isSel ? 'text-cyan-300' : 'text-slate-200'}`}>
                      {v.name}
                    </span>
                    {isSel && (
                      <span className="rounded bg-cyan-500/20 px-1.5 py-0.2 text-[9px] font-bold uppercase text-cyan-300">
                        AKTİF
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400">{v.spec}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-amber-300">{v.simLapTimeS.toFixed(2)} s</div>
                  <div className="text-[10px] text-slate-400">
                    {v.maxVxKph} km/h · {v.maxAyG}G
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        </details>
        <button type="button" onClick={() => setShowPdfSpecModal((open) => !open)}
          aria-expanded={showPdfSpecModal} className="mt-3 text-sm text-slate-400 hover:text-white">
          IST26 araç parametreleri {showPdfSpecModal ? '−' : '+'}
        </button>
        {showPdfSpecModal && (
          <div className="mt-3 grid grid-cols-1 gap-3 rounded border border-cyan-500/30 bg-[#060911] p-3 font-mono text-xs md:grid-cols-3">
            <div className="space-y-1 border-r border-slate-800/80 pr-3">
              <div className="font-bold uppercase tracking-wider text-cyan-400">
                1. Kütle, Geometri & Atalet (PDF S.1–2)
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Toplam / Yaylı Kütle:</span>
                <span className="text-amber-300">335.50 kg / 295.64 kg</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>QSS Efektif Kütle (mEff):</span>
                <span>375.966 kg (mRot: 40.466 kg)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Ağırlık Dağılımı / Wf, Wr:</span>
                <span>%47.9 Ön (788.3 N) / %52.1 Arka (857.4 N)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Dingil Mesafesi L (lF / lR):</span>
                <span>1600 mm (833.6 mm / 766.4 mm)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>İz Genişliği (Ön / Arka) & hCg:</span>
                <span>1280 / 1260 mm · hCg = 247.17 mm</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Ataletler (Ixx / Iyy / Izz):</span>
                <span>33.31 / 115.90 / 129.00 kg·m²</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Front LLTD & Roll Center (F/R):</span>
                <span>%38.31 · RC 31.42 / 36.50 mm</span>
              </div>
            </div>

            <div className="space-y-1 border-r border-slate-800/80 pr-3">
              <div className="font-bold uppercase tracking-wider text-cyan-400">
                2. Tek Motor RWD & Cascadia PM100DX (PDF S.1 & S.3)
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Mimari & Redüksiyon (G):</span>
                <span className="text-amber-300">1 Motor (Arka) · 3.2:1 · η=0.95</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Tepe Tork & Maks. Güç:</span>
                <span>310.0 Nm (0–900 RPM) · 80.0 kW</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Devir Kesici (rpmCut / Ham):</span>
                <span>6000 RPM (Ham tablo: 10000 RPM)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Tepe Arka Aks Torku:</span>
                <span>942.4 Nm efektif (992.0 Nm ham)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Drexler Salisbury LSD:</span>
                <span>50°/40° rampa · %42 Drive / %60 Coast · 27.5 Nm</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Regen Durumu:</span>
                <span>Kapalı (False / 0 kW)</span>
              </div>
            </div>

            <div className="space-y-1">
              <div className="font-bold uppercase tracking-wider text-cyan-400">
                3. Aero, Hoosier MF6.1 Lastik & Fren (PDF S.1 & S.3)
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Downforce Cl*A & Drag Cd*A:</span>
                <span>4.14 m² / 1.58 m² (%48.2 Ön Aero)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Yüklü Lastik Yarıçapı (Re):</span>
                <span className="text-amber-300">205.0 mm (Nominal: 205.74 mm)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Hoosier 43075 MF6.1 (12/10 psi):</span>
                <span>Kamber -1.7° Ön / -1.4° Arka</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Viraj Sertliği Ca (Ön / Arka):</span>
                <span>481.2 N/deg / 496.7 N/deg</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Fren Torku (Ön / Arka):</span>
                <span>400 / 320 Nm teker başı (%55 Ön Bias)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Direksiyon Oranı & Simit Açısı:</span>
                <span>4.54:1 · ±126 deg</span>
              </div>
            </div>
          </div>
        )}
            {fusionPanel}
            {/* Calibration Sliders + RMSE Metrics Row */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
              {/* 4 Calibration Parameters (Isolated IST26 Only) */}
              <div className="space-y-2.5 rounded border border-slate-800 bg-slate-950/80 p-3 font-mono text-xs lg:col-span-5">
                <div className="flex items-center justify-between">
                  <span className="font-bold uppercase tracking-wider text-amber-300">
                    İzole IST26 Kalibrasyon Parametreleri
                  </span>
                  {autoFitResult && (
                    <span className="rounded bg-emerald-950/80 border border-emerald-500/40 px-2 py-0.5 text-[10px] text-emerald-300">
                      ✓ Auto-Fit: %{autoFitResult.improvementPct} Hata Azalması ({autoFitResult.iterations} iter)
                    </span>
                  )}
                </div>

                <div>
                  <div className="flex justify-between">
                    <span>Pacejka Sürtünme Çarpanı (λ_μ):</span>
                    <span className="font-bold text-cyan-300">{ist26Cal.lambdaMu.toFixed(3)} (PDF: 1.000)</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={1.2}
                    step={0.01}
                    value={ist26Cal.lambdaMu}
                    onChange={(e) => setIst26Cal((p) => ({ ...p, lambdaMu: Number(e.target.value) }))}
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between">
                    <span>Viraj Sertliği (C_α) [N/deg]:</span>
                    <span className="font-bold text-cyan-300">
                      {ist26Cal.corneringStiffnessNPerDeg.toFixed(1)} N/deg (PDF: 489.0)
                    </span>
                  </div>
                  <input
                    type="range"
                    min={340}
                    max={620}
                    step={2}
                    value={ist26Cal.corneringStiffnessNPerDeg}
                    onChange={(e) =>
                      setIst26Cal((p) => ({ ...p, corneringStiffnessNPerDeg: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between">
                    <span>Aerodinamik Sürükleme (Cd·A) [m²]:</span>
                    <span className="font-bold text-cyan-300">{ist26Cal.cdA.toFixed(3)} m² (PDF: 1.580)</span>
                  </div>
                  <input
                    type="range"
                    min={1.05}
                    max={2.1}
                    step={0.01}
                    value={ist26Cal.cdA}
                    onChange={(e) => setIst26Cal((p) => ({ ...p, cdA: Number(e.target.value) }))}
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between">
                    <span>RWD + Cascadia Aktarma Verimi (η):</span>
                    <span className="font-bold text-cyan-300">
                      {ist26Cal.drivetrainEfficiency.toFixed(3)} (PDF: 0.950)
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.78}
                    max={0.98}
                    step={0.005}
                    value={ist26Cal.drivetrainEfficiency}
                    onChange={(e) =>
                      setIst26Cal((p) => ({ ...p, drivetrainEfficiency: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>
              </div>

              {/* Live RMSE Metrics Grid */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:col-span-7 font-mono">
                <div className="rounded border border-slate-800 bg-slate-950/70 p-2.5">
                  <div className="text-[10px] uppercase text-slate-400">Hız RMSE (v_x)</div>
                  <div className="mt-1 text-lg font-bold text-cyan-300">{simResult.metrics.rmseVxMs} m/s</div>
                  <div className="text-[11px] text-slate-500">
                    Tur: Sim {simResult.metrics.simLapTimeS}s vs Real {simResult.metrics.realLapTimeS}s
                  </div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-2.5">
                  <div className="text-[10px] uppercase text-slate-400">Boylamsal İvme RMSE (a_x)</div>
                  <div className="mt-1 text-lg font-bold text-emerald-300">{simResult.metrics.rmseAxMs2} m/s²</div>
                  <div className="text-[11px] text-slate-500">İvmelenme & frenleme zarfı</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-2.5">
                  <div className="text-[10px] uppercase text-slate-400">Yanal İvme RMSE (a_y)</div>
                  <div className="mt-1 text-lg font-bold text-amber-300">{simResult.metrics.rmseAyMs2} m/s²</div>
                  <div className="text-[11px] text-slate-500">Otopark asfaltı yanal tutunma</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-2.5">
                  <div className="text-[10px] uppercase text-slate-400">Yaw Rate RMSE (ψ̇)</div>
                  <div className="mt-1 text-lg font-bold text-purple-300">{simResult.metrics.rmseYawRateRadS} rad/s</div>
                  <div className="text-[11px] text-slate-500">Drexler LSD + C_α dengesi</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-2.5">
                  <div className="text-[10px] uppercase text-slate-400">Cascadia Tork RMSE</div>
                  <div className="mt-1 text-lg font-bold text-orange-300">{simResult.metrics.rmseTorqueNm} Nm</div>
                  <div className="text-[11px] text-slate-500">Tek motor mil torku (maks 310 Nm)</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-2.5">
                  <div className="text-[10px] uppercase text-slate-400">DC Bara Akımı RMSE & Soft-L1</div>
                  <div className="mt-1 text-lg font-bold text-rose-300">{simResult.metrics.rmseDcCurrA} A</div>
                  <div className="text-[11px] text-slate-500">
                    Soft-L1 Kayıp: {simResult.metrics.compositeSoftL1Cost}
                  </div>
                </div>
              </div>
            </div>

            {/* 6 Synchronized Overlay Charts (Real = Dashed vs Simulation = Solid) */}
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {/* 1. vx */}
              <div className="rounded border border-slate-800 bg-[#05080f] p-3">
                <div className="mb-1 font-mono text-xs font-bold text-slate-200">
                  1. Hız v_x(s) [m/s] — RMSE: {simResult.metrics.rmseVxMs} m/s
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={simResult.points}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="s" stroke="#64748b" tick={{ fontSize: 10 }} unit="m" />
                      <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#07090e', borderColor: '#334155', fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line
                        type="monotone"
                        dataKey="vxReal"
                        name="Gerçek Log v_x (Kesikli)"
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        strokeWidth={1.6}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="vxSim"
                        name="IST26 Sim v_x (Düz)"
                        stroke="#00f0ff"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 2. ax */}
              <div className="rounded border border-slate-800 bg-[#05080f] p-3">
                <div className="mb-1 font-mono text-xs font-bold text-slate-200">
                  2. Boylamsal İvme a_x(s) [m/s²] — RMSE: {simResult.metrics.rmseAxMs2} m/s²
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={simResult.points}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="s" stroke="#64748b" tick={{ fontSize: 10 }} unit="m" />
                      <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#07090e', borderColor: '#334155', fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line
                        type="monotone"
                        dataKey="axReal"
                        name="Gerçek IMU a_x (Kesikli)"
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        strokeWidth={1.6}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="axSim"
                        name="IST26 Sim a_x (Düz)"
                        stroke="#10b981"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 3. ay */}
              <div className="rounded border border-slate-800 bg-[#05080f] p-3">
                <div className="mb-1 font-mono text-xs font-bold text-slate-200">
                  3. Yanal İvme a_y(s) [m/s²] — RMSE: {simResult.metrics.rmseAyMs2} m/s²
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={simResult.points}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="s" stroke="#64748b" tick={{ fontSize: 10 }} unit="m" />
                      <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#07090e', borderColor: '#334155', fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line
                        type="monotone"
                        dataKey="ayReal"
                        name="Gerçek IMU a_y (Kesikli)"
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        strokeWidth={1.6}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="aySim"
                        name="IST26 Sim a_y (Düz)"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 4. Yaw rate */}
              <div className="rounded border border-slate-800 bg-[#05080f] p-3">
                <div className="mb-1 font-mono text-xs font-bold text-slate-200">
                  4. Yaw Rate ψ̇(s) [rad/s] — RMSE: {simResult.metrics.rmseYawRateRadS} rad/s
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={simResult.points}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="s" stroke="#64748b" tick={{ fontSize: 10 }} unit="m" />
                      <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#07090e', borderColor: '#334155', fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line
                        type="monotone"
                        dataKey="yawRateReal"
                        name="Gerçek Gyro ψ̇ (Kesikli)"
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        strokeWidth={1.6}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="yawRateSim"
                        name="IST26 Sim ψ̇ (Düz)"
                        stroke="#c084fc"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 5. Cascadia Motor Torque */}
              <div className="rounded border border-slate-800 bg-[#05080f] p-3">
                <div className="mb-1 font-mono text-xs font-bold text-slate-200">
                  5. Cascadia Tek Motor Torku [Nm] — RMSE: {simResult.metrics.rmseTorqueNm} Nm
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={simResult.points}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="s" stroke="#64748b" tick={{ fontSize: 10 }} unit="m" />
                      <YAxis stroke="#64748b" tick={{ fontSize: 10 }} domain={[0, 320]} />
                      <Tooltip contentStyle={{ backgroundColor: '#07090e', borderColor: '#334155', fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line
                        type="monotone"
                        dataKey="torqueRealNm"
                        name="Gerçek INV_TORQUE_EST (Kesikli)"
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        strokeWidth={1.6}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="torqueSimNm"
                        name="IST26 Sim Tork (Düz)"
                        stroke="#fb923c"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 6. Cascadia DC Bus Current */}
              <div className="rounded border border-slate-800 bg-[#05080f] p-3">
                <div className="mb-1 font-mono text-xs font-bold text-slate-200">
                  6. Cascadia DC Bara Akımı I_DC [A] — RMSE: {simResult.metrics.rmseDcCurrA} A
                </div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={simResult.points}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                      <XAxis dataKey="s" stroke="#64748b" tick={{ fontSize: 10 }} unit="m" />
                      <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#07090e', borderColor: '#334155', fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line
                        type="monotone"
                        dataKey="dcCurrRealA"
                        name="Gerçek INV_DCBUS_CURRENT (Kesikli)"
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        strokeWidth={1.6}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="dcCurrSimA"
                        name="IST26 Sim I_DC (Düz)"
                        stroke="#f43f5e"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* =================================================================== */}
        {/* STAGE 4: FSAE VCU FAULT INJECTION & CASCADIA PLAUSIBILITY FSM       */}
        {/* =================================================================== */}
        {(activeStage === 'vcu') && (
          <section className="rounded-md border border-slate-800 bg-[#080c14] p-4 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-rose-500/20 px-2 py-0.5 font-mono text-xs font-bold text-rose-400">
                    AŞAMA 4
                  </span>
                  <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-slate-100">
                    VCU Safety & Fault Injection Cockpit (EV 2.3 / T 11.8.9 / EV 2.5) + MISRA-C Firmware Generator
                  </h2>
                </div>
                <p className="mt-1 font-mono text-xs text-slate-400">
                  Canlı 7-Durumlu VCU FSM · APPS &gt;%10 Sapma (100 ms Mandal) · APPS &gt;%25 + Fren Kesici · Soft-BSPD (&gt;5 kW + Fren 500 ms SDC Açma) · Cascadia CAN 0x0C0
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <button
                  type="button"
                  onClick={() => setSyncVcuWithLapCursor((s) => !s)}
                  className={`rounded border px-2.5 py-1.5 transition ${
                    syncVcuWithLapCursor
                      ? 'border-cyan-500/60 bg-cyan-950/60 text-cyan-300'
                      : 'border-slate-700 bg-slate-900 text-slate-300'
                  }`}
                >
                  {syncVcuWithLapCursor ? '🔗 Pist Turuyla Senkron: AÇIK' : '🔗 Pist Turuyla Senkronize Et'}
                </button>
                <button
                  type="button"
                  onClick={handleHardResetVcuFsm}
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-200 hover:border-amber-400 hover:text-amber-300"
                >
                  ↺ VCU Mandal & SDC Sıfırla (Reset)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    downloadTextFile(firmwareFiles.headerName, firmwareFiles.headerContent, 'text/x-c');
                    downloadTextFile(firmwareFiles.sourceName, firmwareFiles.sourceContent, 'text/x-c');
                  }}
                  className="rounded border border-emerald-500/60 bg-emerald-950/70 px-3.5 py-1.5 font-bold uppercase tracking-wider text-emerald-300 hover:bg-emerald-900/70"
                >
                  ⬇ SIL C99 Firmware İndir (.h & .c)
                </button>
                <button
                  type="button"
                  onClick={() => downloadTextFile('apex_vcu_bus.dbc', generateApexVcuDbc(), 'text/plain')}
                  className="rounded border border-cyan-500/50 bg-cyan-950/60 px-3 py-1.5 text-cyan-200 hover:border-cyan-300"
                >
                  CAN DBC İndir
                </button>
              </div>
            </div>

            {/* Live 7-State Diagram Pipeline */}
            <div className="mt-4 rounded border border-slate-800 bg-[#05080f] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                <span className="font-bold uppercase tracking-wider text-slate-300">
                  Canlı VCU Durum Diyagramı (State Machine):{' '}
                  <strong className="text-amber-300">{vcuRuntime.state}</strong>
                </span>
                <span className="rounded border border-slate-800 bg-slate-900/90 px-2.5 py-0.5 text-[11px] text-cyan-300">
                  CAN ID 0x0C0 Payload: [{vcuRuntime.cascadiaCanFrameHex}] · SDC Rölesi:{' '}
                  <strong className={vcuRuntime.sdcRelayClosed ? 'text-emerald-400' : 'text-red-400'}>
                    {vcuRuntime.sdcRelayClosed ? 'KAPALI (HV AKTİF)' : 'AÇIK (KESİLDİ!)'}
                  </strong>
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {fsmStatesOrder.map((st, idx) => {
                  const active = vcuRuntime.state === st.id;
                  const isFault = st.id === 'VCU_STATE_FAULT_LATCHED' || st.id === 'VCU_STATE_FAULT_SAFE';
                  const isDerate = st.id === 'VCU_STATE_DERATE';
                  return (
                    <div
                      key={st.id}
                      className={`relative rounded border p-2.5 font-mono transition ${
                        active
                          ? isFault
                            ? 'border-red-500 bg-red-950/70 text-red-200 shadow-[0_0_16px_rgba(239,68,68,0.45)]'
                            : isDerate
                              ? 'border-amber-400 bg-amber-950/70 text-amber-200 shadow-[0_0_14px_rgba(245,158,11,0.35)]'
                              : 'border-cyan-400 bg-cyan-950/70 text-cyan-200 shadow-[0_0_14px_rgba(0,240,255,0.35)]'
                          : 'border-slate-800/80 bg-slate-950/60 text-slate-500'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px]">
                        <span>S{idx}</span>
                        {active && <span className="h-2 w-2 animate-ping rounded-full bg-current" />}
                      </div>
                      <div className="mt-1 text-xs font-bold">{st.short}</div>
                      <div className="mt-0.5 text-[10px] opacity-80">{st.sub}</div>
                    </div>
                  );
                })}
              </div>

              {/* Status Banner */}
              <div
                className={`mt-3 flex flex-wrap items-center justify-between rounded border px-3 py-2 font-mono text-xs font-bold ${
                  vcuRuntime.state === 'VCU_STATE_FAULT_SAFE' || vcuRuntime.state === 'VCU_STATE_FAULT_LATCHED'
                    ? 'border-red-500/60 bg-red-950/50 text-red-300'
                    : vcuRuntime.state === 'VCU_STATE_DERATE'
                      ? 'border-amber-500/60 bg-amber-950/50 text-amber-300'
                      : 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                }`}
              >
                <span>{vcuRuntime.activeBanner}</span>
                <span>
                  İstenen Ham Tork: {vcuRuntime.rawRequestedTorqueNm.toFixed(1)} Nm →{' '}
                  <strong className="underline">
                    Cascadia Komutu: {vcuRuntime.cascadiaTorqueCmdNm.toFixed(1)} Nm
                  </strong>
                </span>
              </div>
            </div>

            {/* Fault Injection Controls + MISRA-C Code Preview */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
              {/* Interactive Fault Injection Controls */}
              <div className="space-y-3 lg:col-span-6 font-mono text-xs">
                {/* 1. APPS & Rule T 11.8.9 (>10% Deviation for 100 ms) */}
                <div className="rounded border border-slate-800 bg-slate-950/80 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-cyan-400">
                      1. Çift APPS & %10 Sapma Enjeksiyonu (Kural T 11.8.9 — 100 ms)
                    </span>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setVcuInputs((p) => ({ ...p, appsDeviationPct: 14.5, appsPct: Math.max(40, p.appsPct) }))}
                        className="rounded border border-red-500/50 bg-red-950/60 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-900/60"
                      >
                        ⚡ %14.5 Sapma Enjekte Et
                      </button>
                      <button
                        type="button"
                        onClick={() => setVcuInputs((p) => ({ ...p, appsDeviationPct: 1.5, appsPct: 3.0 }))}
                        className="rounded border border-emerald-500/50 bg-emerald-950/60 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-900/60"
                      >
                        Gazı &lt;%5 İndir (Mandal Çöz)
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between">
                      <span>Gaz Pedalı Konumu (APPS):</span>
                      <span className="font-bold text-slate-200">%{vcuInputs.appsPct.toFixed(0)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={vcuInputs.appsPct}
                      onChange={(e) => setVcuInputs((p) => ({ ...p, appsPct: Number(e.target.value) }))}
                      className="w-full accent-cyan-400"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between">
                      <span>APPS1 vs APPS2 Sapma Oranı (|APPS1 - APPS2|):</span>
                      <span
                        className={`font-bold ${
                          vcuInputs.appsDeviationPct > 10 ? 'text-red-400' : 'text-emerald-400'
                        }`}
                      >
                        %{vcuInputs.appsDeviationPct.toFixed(1)} (Eşik: %10.0)
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={25}
                      step={0.5}
                      value={vcuInputs.appsDeviationPct}
                      onChange={(e) => setVcuInputs((p) => ({ ...p, appsDeviationPct: Number(e.target.value) }))}
                      className="w-full accent-rose-500"
                    />
                  </div>

                  {/* 100 ms Visual Progress Bar */}
                  <div>
                    <div className="flex justify-between text-[11px]">
                      <span>T 11.8.9 Zamanlayıcı (100 ms sonunda STATE_FAULT_LATCHED):</span>
                      <span className="font-bold text-amber-300">
                        {vcuRuntime.appsFaultTimerMs.toFixed(0)} / 100 ms{' '}
                        {vcuRuntime.appsImplausibilityLatched ? '(MANDALLANDI!)' : ''}
                      </span>
                    </div>
                    <div className="mt-1 h-2.5 w-full overflow-hidden rounded bg-slate-800">
                      <div
                        className={`h-full transition-all duration-75 ${
                          vcuRuntime.appsImplausibilityLatched ? 'bg-red-500' : 'bg-amber-400'
                        }`}
                        style={{ width: `${Math.min(100, vcuRuntime.appsFaultTimerMs)}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* 2. EV 2.3 APPS + Brake Plausibility & EV 2.5 Soft-BSPD (500 ms) */}
                <div className="rounded border border-slate-800 bg-slate-950/80 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-amber-400">
                      2. APPS + Fren Plausibility (EV 2.3) & Soft-BSPD (EV 2.5 — 500 ms)
                    </span>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setVcuInputs((p) => ({ ...p, brakePressureBar: 22, appsPct: 35, dcBusPowerKw: 3.0 }))
                        }
                        className="rounded border border-amber-500/50 bg-amber-950/60 px-2 py-0.5 text-[10px] text-amber-300"
                      >
                        EV 2.3 Tetikle (Fren + APPS %35)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setVcuInputs((p) => ({ ...p, brakePressureBar: 28, dcBusPowerKw: 14.5 }))
                        }
                        className="rounded border border-red-500/50 bg-red-950/60 px-2 py-0.5 text-[10px] text-red-300"
                      >
                        EV 2.5 Soft-BSPD Tetikle (&gt;5 kW)
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between">
                        <span>Ön Fren Basıncı:</span>
                        <span className="font-bold">{vcuInputs.brakePressureBar.toFixed(0)} bar (Sert ≥ 8)</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={50}
                        step={1}
                        value={vcuInputs.brakePressureBar}
                        onChange={(e) => setVcuInputs((p) => ({ ...p, brakePressureBar: Number(e.target.value) }))}
                        className="w-full accent-amber-400"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between">
                        <span>Cascadia DC Güç Çekişi:</span>
                        <span className="font-bold">{vcuInputs.dcBusPowerKw.toFixed(1)} kW (Eşik &gt;5 kW)</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={80}
                        step={0.5}
                        value={vcuInputs.dcBusPowerKw}
                        onChange={(e) => setVcuInputs((p) => ({ ...p, dcBusPowerKw: Number(e.target.value) }))}
                        className="w-full accent-rose-500"
                      />
                    </div>
                  </div>

                  {/* 500 ms Soft-BSPD Progress Bar */}
                  <div>
                    <div className="flex justify-between text-[11px]">
                      <span>EV 2.5 Soft-BSPD Zamanlayıcı (500 ms sonunda SDC Rölesi Açılır):</span>
                      <span className="font-bold text-rose-300">
                        {vcuRuntime.bspdFaultTimerMs.toFixed(0)} / 500 ms{' '}
                        {vcuRuntime.bspdFaultSafeLatched ? '(SDC AÇILDI — FAULT_SAFE!)' : ''}
                      </span>
                    </div>
                    <div className="mt-1 h-2.5 w-full overflow-hidden rounded bg-slate-800">
                      <div
                        className="h-full bg-rose-500 transition-all duration-75"
                        style={{ width: `${Math.min(100, (vcuRuntime.bspdFaultTimerMs / 500) * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* 3. Cascadia Inverter & Motor Thermal Derating + IMU Fault */}
                <div className="rounded border border-slate-800 bg-slate-950/80 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-purple-400">
                      3. Cascadia İnvertör / Motor Termal Derating & IMU Hata Enjeksiyonu
                    </span>
                    <span className="text-[11px] text-amber-300">
                      Termal Çarpan: %{(vcuRuntime.thermalDerateFactor * 100).toFixed(0)} · IMU Çarpan: %
                      {(vcuRuntime.imuDerateFactor * 100).toFixed(0)}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between">
                        <span>Cascadia IGBT Sıcaklığı:</span>
                        <span className="font-bold">{vcuInputs.inverterTempC.toFixed(0)} °C (60–85°C)</span>
                      </div>
                      <input
                        type="range"
                        min={25}
                        max={90}
                        step={1}
                        value={vcuInputs.inverterTempC}
                        onChange={(e) => setVcuInputs((p) => ({ ...p, inverterTempC: Number(e.target.value) }))}
                        className="w-full accent-orange-400"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between">
                        <span>RWD Motor Sıcaklığı:</span>
                        <span className="font-bold">{vcuInputs.motorTempC.toFixed(0)} °C (95–130°C)</span>
                      </div>
                      <input
                        type="range"
                        min={30}
                        max={135}
                        step={1}
                        value={vcuInputs.motorTempC}
                        onChange={(e) => setVcuInputs((p) => ({ ...p, motorTempC: Number(e.target.value) }))}
                        className="w-full accent-orange-400"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <span>IMU Sensör Durumu:</span>
                    <div className="flex gap-1.5">
                      {(
                        [
                          { id: 'NOMINAL', label: 'NOMINAL (%100)' },
                          { id: 'HIGH_NOISE', label: 'YÜKSEK GÜRÜLTÜ (%75 Derate)' },
                          { id: 'CAN_TIMEOUT_DROPOUT', label: 'CAN KOPMASI (%50 Derate)' },
                        ] as Array<{ id: ImuFaultMode; label: string }>
                      ).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setVcuInputs((p) => ({ ...p, imuFaultMode: m.id }))}
                          className={`rounded border px-2 py-0.5 text-[10px] transition ${
                            vcuInputs.imuFaultMode === m.id
                              ? 'border-purple-400 bg-purple-950/70 text-purple-200'
                              : 'border-slate-800 bg-slate-900 text-slate-400'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* MISRA-C / C99 Firmware Preview */}
              <div className="flex flex-col rounded border border-slate-800 bg-[#05080f] p-3 lg:col-span-6">
                <div className="mb-2 flex items-center justify-between font-mono text-xs">
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCodePreviewTab('source')}
                      className={`rounded px-2.5 py-1 ${
                        codePreviewTab === 'source'
                          ? 'border border-cyan-500/50 bg-cyan-950/70 text-cyan-300'
                          : 'bg-slate-900 text-slate-400'
                      }`}
                    >
                      {firmwareFiles.sourceName}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCodePreviewTab('header')}
                      className={`rounded px-2.5 py-1 ${
                        codePreviewTab === 'header'
                          ? 'border border-cyan-500/50 bg-cyan-950/70 text-cyan-300'
                          : 'bg-slate-900 text-slate-400'
                      }`}
                    >
                      {firmwareFiles.headerName}
                    </button>
                  </div>
                  <span className="text-[11px] text-emerald-400">
                    MISRA-C:2012 · stdint.h / stdbool.h · Sıfır Dinamik Bellek
                  </span>
                </div>

                <pre className="max-h-[410px] flex-1 overflow-auto rounded border border-slate-900 bg-[#030509] p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                  {codePreviewTab === 'header' ? firmwareFiles.headerContent : firmwareFiles.sourceContent}
                </pre>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
