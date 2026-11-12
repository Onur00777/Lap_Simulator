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
import HavuzVcuPanel from './HavuzVcuPanel';
import type { FusionLogResult } from './havuz-fusion.worker';
import {
  AutoFitResult,
  autoFitIst26ToTelemetry,
  simulateIst26OnHavuz,
} from '@/lib/ist26-havuz/ist26-rwd-solver';

type StageTab = 'map' | 'simulation' | 'logs' | 'vcu';

const LAB_VIEWS: { id: StageTab; label: string }[] = [
  { id: 'map', label: 'Pist' },
  { id: 'simulation', label: 'Simülasyon' },
  { id: 'logs', label: 'Kayıtlar' },
  { id: 'vcu', label: 'VCU / SDC' },
];
type LogFilter = 'all' | 'Temiz' | 'Kısmi' | 'Bozuk' | 'auto';

const TELEMETRY_SIGNALS = [
  { label: 'Hız', unit: 'm/s', real: 'vxReal', simulated: 'vxSim', rmse: 'rmseVxMs' },
  { label: 'Boylamsal ivme', unit: 'm/s²', real: 'axReal', simulated: 'axSim', rmse: 'rmseAxMs2' },
  { label: 'Yanal ivme', unit: 'm/s²', real: 'ayReal', simulated: 'aySim', rmse: 'rmseAyMs2' },
  { label: 'Yaw hızı', unit: 'rad/s', real: 'yawRateReal', simulated: 'yawRateSim', rmse: 'rmseYawRateRadS' },
  { label: 'Motor torku', unit: 'Nm', real: 'torqueRealNm', simulated: 'torqueSimNm', rmse: 'rmseTorqueNm' },
  { label: 'DC akımı', unit: 'A', real: 'dcCurrRealA', simulated: 'dcCurrSimA', rmse: 'rmseDcCurrA' },
] as const;

const CALIBRATION_FIELDS = [
  { key: 'lambdaMu', label: 'Tutunma çarpanı', min: 0.5, max: 1.2, step: 0.01 },
  { key: 'corneringStiffnessNPerDeg', label: 'Viraj sertliği (N/°)', min: 340, max: 620, step: 1 },
  { key: 'cdA', label: 'CdA (m²)', min: 1.1, max: 2.05, step: 0.01 },
  { key: 'drivetrainEfficiency', label: 'Aktarma verimi', min: 0.78, max: 0.98, step: 0.005 },
] as const;

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
  const [signalIndex, setSignalIndex] = useState(0);

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

  const signal = TELEMETRY_SIGNALS[signalIndex];
  const availableLogs = [...new Set([...Object.keys(HAVUZ_REAL_TELEMETRY_BY_LOG), ...Object.keys(customTelemetryMap)])];
  const activeNode = circuit.nodes[cursorIdx] ?? circuit.nodes[0];
  const activeOverlayPt = simResult.points[cursorIdx] ?? simResult.points[0];

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
        {activeStage === 'simulation' && (
          <section aria-labelledby="havuz-sim-title" className="min-w-0 space-y-4">
            <header className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="havuz-sim-title" className="text-xl font-semibold text-white">Simülasyon</h2>
                <p className="mt-1 text-sm tabular-nums text-slate-400">
                  Tur: {simResult.metrics.simLapTimeS.toFixed(2)} sn simülasyon · {simResult.metrics.realLapTimeS.toFixed(2)} sn kayıt
                </p>
              </div>
              <label className="grid min-w-0 max-w-full gap-1 text-xs text-slate-400">
                Karşılaştırılan kayıt
                <select value={selectedLogId} onChange={(event) => { setSelectedLogId(event.target.value); setAutoFitResult(null); }}
                  className="max-w-full truncate rounded-md border border-white/10 bg-slate-900 px-2 py-1.5 text-sm text-slate-200">
                  {availableLogs.map((id) => <option key={id} value={id}>{id.split('/').at(-1)}</option>)}
                </select>
              </label>
            </header>
            <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="min-w-0 rounded-xl border border-white/10 bg-[#080a10] p-3 sm:p-4">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <label className="grid gap-1 text-xs text-slate-400">Grafik kanalı
                    <select value={signalIndex} onChange={(event) => setSignalIndex(Number(event.target.value))}
                      className="rounded-md border border-white/10 bg-slate-900 px-2 py-1.5 text-sm text-slate-200">
                      {TELEMETRY_SIGNALS.map(({ label, unit }, index) => <option key={label} value={index}>{label} ({unit})</option>)}
                    </select>
                  </label>
                  <span className="text-xs tabular-nums text-slate-400">RMSE {simResult.metrics[signal.rmse].toFixed(2)} {signal.unit}</span>
                </div>
                <div className="mt-3 h-[clamp(240px,42vh,450px)]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={simResult.points}>
                      <CartesianGrid stroke="#1e293b" strokeDasharray="3 4" />
                      <XAxis dataKey="s" type="number" stroke="#94a3b8" tick={{ fontSize: 11 }} unit=" m" />
                      <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                      <Tooltip isAnimationActive={false} labelFormatter={(value) => Number(value).toFixed(1) + ' m'}
                        contentStyle={{ backgroundColor: '#0c1019', borderColor: '#334155', fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line dataKey={signal.real} name="Kayıt" stroke="#94a3b8" strokeDasharray="5 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Line dataKey={signal.simulated} name="Simülasyon" stroke="#22d3ee" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                <details className="rounded-lg border border-white/10 px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-slate-200">Araç karşılaştırması</summary>
                  <ul className="mt-2 divide-y divide-white/10">
                    {multiVehicleComparison.map((vehicle) => (
                      <li key={vehicle.id}>
                        <button type="button" aria-pressed={activePresetId === vehicle.id} onClick={() => onSelectPresetId?.(vehicle.id)}
                          className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm text-slate-400 hover:text-white aria-pressed:text-cyan-200">
                          <span>{vehicle.name}</span>
                          <span className="shrink-0 font-mono text-xs">{vehicle.simLapTimeS.toFixed(2)} sn</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
                <details className="rounded-lg border border-white/10 px-3 py-2.5">
                  <summary className="cursor-pointer text-sm font-medium text-slate-200">Kalibrasyon</summary>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className="btn" onClick={handleRunAutoFit}>Otomatik kalibre et</button>
                    <button type="button" className="btn" onClick={handleResetIst26Cal}>Varsayılana dön</button>
                  </div>
                  {autoFitResult && <p role="status" className="mt-2 text-xs text-cyan-200">Hata azalması: %{autoFitResult.improvementPct}</p>}
                  <div className="mt-3 grid gap-2">
                    {CALIBRATION_FIELDS.map(({ key, label, ...limits }) => (
                      <label key={key} className="text-xs text-slate-400">
                        <span className="flex justify-between gap-2">{label}<span className="tabular-nums text-slate-200">{ist26Cal[key]}</span></span>
                        <input type="range" {...limits} value={ist26Cal[key]} className="w-full accent-cyan-400"
                          onChange={(event) => {
                            const value = event.target.valueAsNumber;
                            setIst26Cal((current) => ({ ...current, [key]: value }));
                            setAutoFitResult(null);
                          }} />
                      </label>
                    ))}
                  </div>
                </details>
                <button type="button" className="btn" disabled={simResult.points.length === 0}
                  onClick={() => downloadTextFile('havuz-telemetry-motec.csv', exportMotecTelemetry(simResult), 'text/csv')}>MoTeC CSV indir</button>
              </div>
            </div>
            {fusionPanel}
            <details className="rounded-lg border border-white/10 px-3 py-2.5">
              <summary className="cursor-pointer text-sm font-medium text-slate-200">IST26 araç parametreleri</summary>
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
            </details>
          </section>
        )}

        <HavuzVcuPanel active={activeStage === 'vcu'} sample={activeOverlayPt} playing={lapPlaying}
          onTogglePlayback={() => setLapPlaying((playing) => !playing)} />
      </div>
    </div>
  );
}
