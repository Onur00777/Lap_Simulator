'use client';

import { useEffect, useRef, useState } from 'react';
import { generateApexVcuDbc } from '@/lib/codegen/dbc-generator';
import type { Ist26OverlayPoint } from '@/lib/ist26-havuz/ist26-rwd-solver';
import {
  generateIst26VcuSafetyFirmware, INITIAL_VCU_FSM_RUNTIME, stepIst26VcuSafetyFsm,
  type ImuFaultMode, type VcuFaultInjectionInputs,
} from '@/lib/ist26-havuz/vcu-fault-machine';
import { downloadText } from '@/lib/ui/format';
import VcuStatus from './VcuStatus';

const NOMINAL: VcuFaultInjectionInputs = {
  appsPct: 45, appsDeviationPct: 1.5, brakePressureBar: 0, dcBusPowerKw: 24,
  inverterTempC: 40, motorTempC: 55, motorRpm: 2400, imuFaultMode: 'NOMINAL', prechargePct: 98, r2dArmed: true,
};

const SCENARIOS: { label: string; inputs: Partial<VcuFaultInjectionInputs> }[] = [
  { label: 'Gaz sensörü farkı', inputs: { appsDeviationPct: 14.5 } },
  { label: 'Gaz + fren', inputs: { appsPct: 35, brakePressureBar: 22, dcBusPowerKw: 3 } },
  { label: 'BSPD · SDC kesme', inputs: { appsPct: 0, brakePressureBar: 28, dcBusPowerKw: 14.5 } },
];

const ADVANCED = [
  { key: 'appsDeviationPct', label: 'Gaz sensörü farkı', unit: '%', min: 0, max: 30, step: 0.5 },
  { key: 'dcBusPowerKw', label: 'DC bara gücü', unit: 'kW', min: 0, max: 80, step: 0.5 },
  { key: 'inverterTempC', label: 'İnvertör sıcaklığı', unit: '°C', min: 25, max: 90, step: 1 },
  { key: 'motorTempC', label: 'Motor sıcaklığı', unit: '°C', min: 30, max: 135, step: 1 },
  { key: 'prechargePct', label: 'Ön şarj', unit: '%', min: 0, max: 100, step: 1 },
] as const;

function Slider({ label, value, unit, min = 0, max, step = 1, onChange }: {
  label: string; value: number; unit: string; min?: number; max: number; step?: number; onChange: (value: number) => void;
}) {
  return (
    <label className="block text-sm text-slate-300">
      <span className="flex justify-between gap-2">
        <span>{label}</span><span aria-hidden="true" className="font-mono text-xs tabular-nums text-slate-400">{value} {unit}</span>
      </span>
      <input type="range" aria-label={label} className="mt-1 w-full accent-cyan-400" value={value}
        min={min} max={max} step={step} onChange={(event) => onChange(event.target.valueAsNumber)} />
    </label>
  );
}

export default function HavuzVcuPanel({ active, sample, playing, onTogglePlayback }: {
  active: boolean;
  sample?: Ist26OverlayPoint;
  playing: boolean;
  onTogglePlayback: () => void;
}) {
  const [inputs, setInputs] = useState(NOMINAL);
  const [runtime, setRuntime] = useState(INITIAL_VCU_FSM_RUNTIME);
  const [sync, setSync] = useState(false);
  const [preview, setPreview] = useState<'source' | 'header' | null>(null);
  const [firmware] = useState(generateIst26VcuSafetyFirmware);

  const effectiveInputs = sync && sample ? {
    ...inputs, motorRpm: sample.motorRpmSim,
    appsPct: Math.min(100, Math.max(0, Math.round(sample.torqueSimNm / 3.1))),
    dcBusPowerKw: Number((sample.dcCurrSimA * 342 / 1000).toFixed(1)),
  } : inputs;
  const latestInputs = useRef(effectiveInputs);
  useEffect(() => { latestInputs.current = effectiveInputs; }, [effectiveInputs]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      const sample = latestInputs.current;
      setRuntime((previous) => stepIst26VcuSafetyFsm(previous, sample, 25));
    }, 25);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;
  const update = (patch: Partial<VcuFaultInjectionInputs>) => {
    setSync(false);
    setInputs((current) => ({ ...current, ...effectiveInputs, ...patch }));
  };

  return (
    <section aria-labelledby="havuz-vcu-title" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="havuz-vcu-title" className="text-xl font-semibold text-white">VCU / SDC</h2>
          <p className="mt-1 text-sm text-slate-400">IST26 güvenlik simülasyonu</p>
        </div>
        <button type="button" className="rounded-md border border-white/10 px-3 py-2 text-sm hover:bg-white/5" onClick={() => {
          setSync(false);
          setInputs(NOMINAL);
          setRuntime(INITIAL_VCU_FSM_RUNTIME);
        }}>Simülasyonu sıfırla</button>
      </header>

      <VcuStatus runtime={runtime} />

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4 rounded-xl border border-white/10 bg-[#080a10] p-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Test senaryosu</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {SCENARIOS.map(({ label, inputs }) => (
                <button key={label} type="button" onClick={() => {
                  setSync(false);
                  setInputs({ ...NOMINAL, ...inputs });
                  setRuntime(INITIAL_VCU_FSM_RUNTIME);
                }}
                  className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm hover:border-cyan-400/40 hover:text-cyan-200">{label}</button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
            <Slider label="Gaz pedalı" unit="%" max={100} value={effectiveInputs.appsPct} onChange={(appsPct) => update({ appsPct })} />
            <Slider label="Fren basıncı" unit="bar" max={60} value={inputs.brakePressureBar} onChange={(brakePressureBar) => update({ brakePressureBar })} />
          </div>
          <button type="button" className="text-sm text-cyan-300 hover:text-cyan-100"
            onClick={() => update({ appsPct: 0, appsDeviationPct: NOMINAL.appsDeviationPct, brakePressureBar: 0, dcBusPowerKw: 0 })}>
            Pedalları bırak
          </button>
        </div>

        <div className="min-w-0 space-y-2">
          <details className="rounded-lg border border-white/10 px-3 py-2.5">
            <summary className="cursor-pointer text-sm font-medium text-slate-200">Gelişmiş kontroller</summary>
            <div className="mt-3 space-y-3">
              {ADVANCED.map(({ key, ...field }) => (
                <Slider key={key} {...field} value={effectiveInputs[key]} onChange={(value) => update({ [key]: value })} />
              ))}
              <label className="flex items-center justify-between gap-2 text-sm text-slate-300">
                IMU
                <select className="rounded border border-white/10 bg-slate-900 p-1" value={inputs.imuFaultMode}
                  onChange={(event) => update({ imuFaultMode: event.target.value as ImuFaultMode })}>
                  <option value="NOMINAL">Normal</option>
                  <option value="HIGH_NOISE">Yüksek gürültü</option>
                  <option value="CAN_TIMEOUT_DROPOUT">CAN zaman aşımı</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inputs.r2dArmed}
                onChange={(event) => update({ r2dArmed: event.target.checked })} /> Sürüş onayı (R2D)</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sync}
                onChange={(event) => setSync(event.target.checked)} /> Tur verisini kullan</label>
              {sync && <button type="button" className="btn" onClick={onTogglePlayback}>{playing ? 'Turu duraklat' : 'Turu oynat'}</button>}
            </div>
          </details>
          <details className="rounded-lg border border-white/10 px-3 py-2.5">
            <summary className="cursor-pointer text-sm font-medium text-slate-200">Tanılama</summary>
            <dl className="mt-3 space-y-2 font-mono text-xs tabular-nums text-slate-300">
              <div><dt className="text-slate-400">APPS zamanlayıcısı</dt><dd>{runtime.appsFaultTimerMs} / 100 ms</dd></div>
              <div><dt className="text-slate-400">BSPD zamanlayıcısı</dt><dd>{runtime.bspdFaultTimerMs} / 500 ms</dd></div>
              <div><dt className="text-slate-400">İstenen tork</dt><dd>{runtime.rawRequestedTorqueNm.toFixed(1)} Nm</dd></div>
              <div><dt className="text-slate-400">Termal / IMU sınırı</dt><dd>{Math.round(runtime.thermalDerateFactor * 100)}% / {Math.round(runtime.imuDerateFactor * 100)}%</dd></div>
              <div><dt className="text-slate-400">CAN 0x0C0</dt><dd>{runtime.cascadiaCanFrameHex}</dd></div>
            </dl>
          </details>
          <details className="rounded-lg border border-white/10 px-3 py-2.5">
            <summary className="cursor-pointer text-sm font-medium text-slate-200">Firmware ve CAN dosyaları</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={() => downloadText(firmware.sourceName, firmware.sourceContent, 'text/x-c')}>C dosyası</button>
              <button type="button" className="btn" onClick={() => downloadText(firmware.headerName, firmware.headerContent, 'text/x-c')}>Başlık (.h)</button>
              <button type="button" className="btn" onClick={() => downloadText('apex_vcu_bus.dbc', generateApexVcuDbc())}>CAN DBC</button>
              <button type="button" className="btn" aria-expanded={preview != null} onClick={() => setPreview(preview == null ? 'source' : null)}>Kod önizleme</button>
            </div>
            {preview && <>
              <label className="mt-3 block text-xs">Dosya
                <select className="ml-2 rounded bg-slate-900 p-1" value={preview} onChange={(event) => setPreview(event.target.value as 'header' | 'source')}>
                  <option value="source">.c</option><option value="header">.h</option>
                </select>
              </label>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/30 p-2 text-xs text-slate-300">{preview === 'header' ? firmware.headerContent : firmware.sourceContent}</pre>
            </>}
          </details>
        </div>
      </div>
    </section>
  );
}
