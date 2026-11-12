'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PowertrainParams, VehicleParams } from '@/lib/physics';
import type { LapResult } from '@/lib/solver';
import { generateVcuBundle, type VcuBundle } from '@/lib/codegen';
import { generateApexVcuDbc } from '@/lib/codegen/dbc-generator';
import {
  INITIAL_VCU_FSM_RUNTIME,
  generateIst26VcuSafetyFirmware,
  stepIst26VcuSafetyFsm,
  type ImuFaultMode,
  type VcuFaultInjectionInputs,
  type VcuSafetyFsmRuntimeState,
} from '@/lib/ist26-havuz/vcu-fault-machine';
import VcuStatus from '../ist26-havuz/VcuStatus';
import { downloadText, fmt, kph } from '@/lib/ui/format';

interface CanCockpitDrawerProps {
  open: boolean;
  onClose: () => void;
  lap: LapResult;
  cursor: number | null;
  veh: VehicleParams;
  pt: PowertrainParams;
  bundle: VcuBundle | null;
}

type CanBusTab = 'fdcan1' | 'fdcan2' | 'all';

function toHexByte(n: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped.toString(16).toUpperCase().padStart(2, '0');
}

function encodeInt16LE(val: number): [string, string] {
  const v = Math.max(-32768, Math.min(32767, Math.round(val)));
  const u = v < 0 ? 65536 + v : v;
  return [toHexByte(u & 0xff), toHexByte((u >> 8) & 0xff)];
}

export default function CanCockpitDrawer({
  open,
  onClose,
  lap,
  cursor,
  veh,
  pt,
  bundle,
}: CanCockpitDrawerProps) {
  const [busTab, setBusTab] = useState<CanBusTab>('all');
  const [syncWithLap, setSyncWithLap] = useState(true);

  const [vcuInputs, setVcuInputs] = useState<VcuFaultInjectionInputs>({
    appsPct: 68,
    appsDeviationPct: 1.8,
    brakePressureBar: 0.0,
    dcBusPowerKw: 42.0,
    inverterTempC: 44.0,
    motorTempC: 62.0,
    motorRpm: 3200,
    imuFaultMode: 'NOMINAL',
    prechargePct: 98.0,
    r2dArmed: true,
  });

  const [vcuRuntime, setVcuRuntime] = useState<VcuSafetyFsmRuntimeState>(INITIAL_VCU_FSM_RUNTIME);
  const safetyFw = useMemo(() => generateIst26VcuSafetyFirmware(), []);
  const latestInputs = useRef(vcuInputs);
  useEffect(() => { latestInputs.current = vcuInputs; }, [vcuInputs]);

  const idx = cursor != null && cursor >= 0 && cursor < lap.channels.s.length ? cursor : 0;
  const ch = lap.channels;

  // Synchronize live CAN signals from active lap cursor when syncWithLap is active
  useEffect(() => {
    if (!syncWithLap) return;
    const thrPct = Math.round((ch.throttle[idx] ?? 0) * 100);
    const brkBar = Number(((ch.brake[idx] ?? 0) * 45).toFixed(1));
    const rpm = Math.round(ch.motorRpm[idx] ?? 2500);
    const pKw = Number(Math.max(0, ch.pElecKW[idx] ?? 25).toFixed(1));
    setVcuInputs((prev) => ({
      ...prev,
      appsPct: thrPct,
      brakePressureBar: brkBar,
      motorRpm: rpm,
      dcBusPowerKw: pKw,
    }));
  }, [idx, syncWithLap, ch]);

  // 25 ms deterministic step for FSAE fault timers (T 11.8.9 100ms APPS, EV 2.5 500ms Soft-BSPD)
  useEffect(() => {
    if (!open) return;
    const dtMs = 25;
    const id = window.setInterval(() => {
      const inputs = latestInputs.current;
      setVcuRuntime((prev) => stepIst26VcuSafetyFsm(prev, inputs, dtMs));
    }, dtMs);
    return () => window.clearInterval(id);
  }, [open]);

  const canFrames = useMemo(() => {
    const vKph = kph(ch.v[idx] ?? 0);
    const axG = ch.gLong[idx] ?? 0;
    const ayG = ch.gLat[idx] ?? 0;
    const rpm = vcuInputs.motorRpm;
    const vdcDeciV = pt.batteryVoltage * 10;
    const idcDeciA = ((vcuInputs.dcBusPowerKw * 1000) / Math.max(100, pt.batteryVoltage)) * 10;

    const [rpmL, rpmH] = encodeInt16LE(rpm);
    const [freqL, freqH] = encodeInt16LE((rpm / 12) * 10);
    const [vdcL, vdcH] = encodeInt16LE(vdcDeciV);
    const [idcL, idcH] = encodeInt16LE(idcDeciA);
    const [igbtL, igbtH] = encodeInt16LE(vcuInputs.inverterTempC * 10);
    const [axL, axH] = encodeInt16LE(axG * 9.81 * 100);
    const [ayL, ayH] = encodeInt16LE(ayG * 9.81 * 100);
    const [vL, vH] = encodeInt16LE(vKph * 100);

    const invEnable = vcuRuntime.cascadiaCanFrameHex.split(' ')[5] === '01';

    return [
      {
        bus: 'FDCAN1',
        id: '0x0C0',
        name: 'VCU_Cascadia_Cmd',
        rateHz: 100,
        dlc: 8,
        payload: vcuRuntime.cascadiaCanFrameHex,
        decoded: `TrqCmd=${vcuRuntime.cascadiaTorqueCmdNm.toFixed(1)} Nm · EN=${invEnable ? 1 : 0}`,
      },
      {
        bus: 'FDCAN1',
        id: '0x0A5',
        name: 'Cascadia_Motor_Pos',
        rateHz: 100,
        dlc: 8,
        payload: `00 00 ${rpmL} ${rpmH} ${freqL} ${freqH} 00 00`,
        decoded: `Speed=${rpm} RPM · Freq=${(rpm / 12).toFixed(0)} Hz`,
      },
      {
        bus: 'FDCAN1',
        id: '0x0A7',
        name: 'Cascadia_Voltage',
        rateHz: 100,
        dlc: 8,
        payload: `${vdcL} ${vdcH} 00 00 00 00 00 00`,
        decoded: `Vdc=${pt.batteryVoltage.toFixed(0)} V`,
      },
      {
        bus: 'FDCAN1', id: '0x0A6', name: 'Cascadia_Current', rateHz: 100, dlc: 8,
        payload: `00 00 00 00 00 00 ${idcL} ${idcH}`,
        decoded: `Idc=${(idcDeciA / 10).toFixed(1)} A`,
      },
      {
        bus: 'FDCAN1', id: '0x0A0', name: 'Cascadia_IGBT_Temperatures', rateHz: 10, dlc: 8,
        payload: `${igbtL} ${igbtH} 00 00 00 00 00 00`,
        decoded: `IGBT A=${vcuInputs.inverterTempC.toFixed(1)} °C`,
      },
      {
        bus: 'FDCAN2',
        id: '0x181',
        name: 'IMU_6DOF_Accel_Yaw',
        rateHz: 400,
        dlc: 8,
        payload: `${axL} ${axH} ${ayL} ${ayH} 00 00 ${vcuInputs.imuFaultMode === 'NOMINAL' ? '01' : 'FE'} 00`,
        decoded: `ax=${fmt(axG, 2)}G · ay=${fmt(ayG, 2)}G · Status=${vcuInputs.imuFaultMode}`,
      },
      {
        bus: 'FDCAN2',
        id: '0x201',
        name: 'WSS_4Corner_Speed',
        rateHz: 200,
        dlc: 8,
        payload: `${vL} ${vH} ${vL} ${vH} ${vL} ${vH} ${vL} ${vH}`,
        decoded: `v_chassis=${fmt(vKph, 1)} km/h · Fz_min=${fmt(lap.minInnerWheelLoadN, 0)} N`,
      },
      {
        bus: 'FDCAN2',
        id: '0x210',
        name: 'PedalBox_APPS_BPS',
        rateHz: 500,
        dlc: 8,
        payload: `${toHexByte(vcuInputs.appsPct)} ${toHexByte(Math.max(0, vcuInputs.appsPct - vcuInputs.appsDeviationPct))} ${toHexByte(vcuInputs.brakePressureBar)} 00 00 00 00 00`,
        decoded: `APPS=${vcuInputs.appsPct.toFixed(0)}% (Δ${vcuInputs.appsDeviationPct.toFixed(1)}%) · Brk=${vcuInputs.brakePressureBar.toFixed(1)} bar`,
      },
    ].filter((f) => busTab === 'all' || f.bus.toLowerCase() === busTab);
  }, [ch, idx, vcuRuntime, vcuInputs, pt.batteryVoltage, lap.minInnerWheelLoadN, busTab]);

  if (!open) return null;

  const update = (patch: Partial<VcuFaultInjectionInputs>) => {
    setSyncWithLap(false);
    setVcuInputs((current) => ({ ...current, ...patch }));
  };

  return (
    <aside role="dialog" aria-label="CAN / VCU"
      className="studio-drawer fixed inset-y-0 right-0 z-50 flex w-[460px] max-w-[100vw] flex-col border-l border-white/10 bg-[#080a10]/95 shadow-2xl backdrop-blur-xl">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 p-4">
        <div>
          <h2 className="font-semibold text-white">CAN / VCU</h2>
          <p className="mt-0.5 text-xs text-slate-400">IST26 güvenlik simülasyonu</p>
        </div>
        <button type="button" onClick={onClose} aria-label="CAN / VCU panelini kapat" className="btn">Kapat</button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <VcuStatus runtime={vcuRuntime} />

        <section aria-label="Pedal kontrolleri" className="space-y-3 rounded-xl border border-white/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" className="accent-cyan-400" checked={syncWithLap}
                onChange={(event) => setSyncWithLap(event.target.checked)} />
              Tur verisini kullan
            </label>
            <button type="button" className="text-sm text-cyan-300 hover:text-white" onClick={() => {
              update({ appsPct: 3, appsDeviationPct: 1, brakePressureBar: 0, inverterTempC: 42, motorTempC: 58, imuFaultMode: 'NOMINAL' });
              setVcuRuntime(INITIAL_VCU_FSM_RUNTIME);
            }}>Sıfırla</button>
          </div>

          <div className="grid gap-3">
            {([
              { key: 'appsPct', label: 'Gaz pedalı', unit: '%', max: 100 },
              { key: 'brakePressureBar', label: 'Fren basıncı', unit: 'bar', max: 50 },
            ] as const).map(({ key, label, unit, max }) => {
              return (
                <label key={key} className="block text-sm text-slate-300">
                  <span className="flex justify-between gap-2">{label}<span aria-hidden="true" className="tabular-nums text-slate-400">{vcuInputs[key]} {unit}</span></span>
                  <input type="range" min={0} max={max} value={vcuInputs[key]} className="mt-1 w-full accent-cyan-400"
                    onChange={(event) => update({ [key]: event.target.valueAsNumber })} />
                </label>
              );
            })}
          </div>
        </section>

        <details className="rounded-lg border border-white/10 px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">Hata ve sensör ayarları</summary>
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1 text-sm text-slate-300">
              <span className="flex justify-between gap-2">Gaz sensörü farkı <span className="tabular-nums text-slate-400">{vcuInputs.appsDeviationPct}%</span></span>
              <input type="range" min={0} max={25} step={0.5} value={vcuInputs.appsDeviationPct} className="accent-cyan-400"
                onChange={(event) => update({ appsDeviationPct: event.target.valueAsNumber })} />
            </label>
            <label className="grid gap-1 text-sm text-slate-300">
              <span className="flex justify-between gap-2">İnvertör sıcaklığı <span className="tabular-nums text-slate-400">{vcuInputs.inverterTempC} °C</span></span>
              <input type="range" min={25} max={90} value={vcuInputs.inverterTempC} className="accent-cyan-400"
                onChange={(event) => update({ inverterTempC: event.target.valueAsNumber })} />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm text-slate-300">
              IMU
              <select value={vcuInputs.imuFaultMode} onChange={(event) => update({ imuFaultMode: event.target.value as ImuFaultMode })}
                className="rounded border border-white/10 bg-slate-900 px-2 py-1">
                <option value="NOMINAL">Normal</option>
                <option value="HIGH_NOISE">Yüksek gürültü</option>
                <option value="CAN_TIMEOUT_DROPOUT">CAN zaman aşımı</option>
              </select>
            </label>
            <p className="text-xs tabular-nums text-slate-400">APPS {vcuRuntime.appsFaultTimerMs}/100 ms · BSPD {vcuRuntime.bspdFaultTimerMs}/500 ms</p>
          </div>
        </details>

        <details className="rounded-lg border border-white/10 px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">CAN mesajları</summary>
          <label className="mt-3 flex items-center justify-between text-sm text-slate-300">
            Veri yolu
            <select value={busTab} onChange={(event) => setBusTab(event.target.value as CanBusTab)}
              className="rounded border border-white/10 bg-slate-900 px-2 py-1">
              <option value="all">Tümü</option><option value="fdcan1">FDCAN1</option><option value="fdcan2">FDCAN2</option>
            </select>
          </label>
          <div className="mt-2 divide-y divide-white/10">
            {canFrames.map((frame) => (
              <details key={frame.id} className="py-2 text-xs">
                <summary className="cursor-pointer break-words text-slate-300">
                  <span className="font-mono text-cyan-300">{frame.id}</span> {frame.name}
                </summary>
                <p className="mt-2 font-mono tabular-nums text-slate-300">{frame.payload}</p>
                <p className="mt-1 text-slate-400">{frame.bus} · {frame.rateHz} Hz · {frame.decoded}</p>
              </details>
            ))}
          </div>
        </details>

        <details className="rounded-lg border border-white/10 px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium">Firmware ve CAN dosyaları</summary>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn"
              onClick={() => (bundle ?? generateVcuBundle(veh, pt)).files.forEach((file) => downloadText(file.name, file.content, 'text/x-c'))}>VCU kalibrasyonu</button>
            <button type="button" className="btn" onClick={() => {
              downloadText(safetyFw.headerName, safetyFw.headerContent, 'text/x-c');
              downloadText(safetyFw.sourceName, safetyFw.sourceContent, 'text/x-c');
            }}>Güvenlik FSM</button>
            <button type="button" className="btn" onClick={() => downloadText('apex_vcu_bus.dbc', generateApexVcuDbc())}>CAN DBC</button>
          </div>
        </details>
      </div>
    </aside>
  );
}
