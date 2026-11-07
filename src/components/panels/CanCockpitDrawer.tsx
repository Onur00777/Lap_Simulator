'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PowertrainParams, VehicleParams } from '@/lib/physics';
import type { LapResult } from '@/lib/solver';
import type { VcuBundle } from '@/lib/codegen';
import {
  INITIAL_VCU_FSM_RUNTIME,
  generateIst26VcuSafetyFirmware,
  stepIst26VcuSafetyFsm,
  type ImuFaultMode,
  type VcuFaultInjectionInputs,
  type VcuSafetyFsmRuntimeState,
} from '@/lib/ist26-havuz/vcu-fault-machine';
import { DisclosureGroup } from '../ui';
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
      setVcuRuntime((prev) => stepIst26VcuSafetyFsm(prev, vcuInputs, dtMs));
    }, dtMs);
    return () => window.clearInterval(id);
  }, [open, vcuInputs]);

  const canFrames = useMemo(() => {
    const vKph = kph(ch.v[idx] ?? 0);
    const axG = ch.gLong[idx] ?? 0;
    const ayG = ch.gLat[idx] ?? 0;
    const trqCmdDeciNm = vcuRuntime.cascadiaTorqueCmdNm * 10;
    const rpm = vcuInputs.motorRpm;
    const vdcDeciV = pt.batteryVoltage * 10;
    const idcDeciA = ((vcuInputs.dcBusPowerKw * 1000) / Math.max(100, pt.batteryVoltage)) * 10;

    const [tL, tH] = encodeInt16LE(trqCmdDeciNm);
    const [rpmL, rpmH] = encodeInt16LE(rpm);
    const [vdcL, vdcH] = encodeInt16LE(vdcDeciV);
    const [idcL, idcH] = encodeInt16LE(idcDeciA);
    const [axL, axH] = encodeInt16LE(axG * 9.81 * 100);
    const [ayL, ayH] = encodeInt16LE(ayG * 9.81 * 100);
    const [vL, vH] = encodeInt16LE(vKph * 100);

    const invEnable = vcuRuntime.sdcRelayClosed && vcuRuntime.cascadiaTorqueCmdNm > 0;
    const faultMask =
      (vcuRuntime.appsImplausibilityLatched ? 1 : 0) |
      (vcuRuntime.brakePlausibilityLatched ? 2 : 0) |
      (vcuRuntime.bspdFaultSafeLatched ? 4 : 0);

    return [
      {
        bus: 'FDCAN1',
        id: '0x0C0',
        name: 'VCU_Cascadia_Cmd',
        rateHz: 500,
        dlc: 8,
        payload: `${tL} ${tH} 00 00 ${invEnable ? '01' : '00'} 00 ${toHexByte(faultMask)} 00`,
        decoded: `TrqCmd=${vcuRuntime.cascadiaTorqueCmdNm.toFixed(1)} Nm · EN=${invEnable ? 1 : 0}`,
      },
      {
        bus: 'FDCAN1',
        id: '0x0A5',
        name: 'Cascadia_Motor_Pos',
        rateHz: 200,
        dlc: 8,
        payload: `00 00 ${rpmL} ${rpmH} 64 00 00 00`,
        decoded: `Speed=${rpm} RPM · Freq=${(rpm / 12).toFixed(0)} Hz`,
      },
      {
        bus: 'FDCAN1',
        id: '0x0A7',
        name: 'Cascadia_Volt_Curr',
        rateHz: 100,
        dlc: 8,
        payload: `${vdcL} ${vdcH} ${idcL} ${idcH} ${toHexByte(vcuInputs.inverterTempC)} ${toHexByte(vcuInputs.motorTempC)} 00 00`,
        decoded: `Vdc=${pt.batteryVoltage.toFixed(0)}V · P=${vcuInputs.dcBusPowerKw.toFixed(1)}kW · Tinv=${vcuInputs.inverterTempC.toFixed(0)}°C`,
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

  return (
    <aside className="flex w-full shrink-0 flex-col rounded-xl border border-white/[0.07] bg-[#11141d]/95 backdrop-blur-xl xl:w-[350px]">
      {/* Drawer Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-200">
            CAN Cockpit & Embedded SIL
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close CAN Cockpit Drawer"
          className="rounded-md px-1.5 py-0.5 font-mono text-xs text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-200"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 divide-y divide-white/[0.06] overflow-y-auto">
        {/* 1. LIVE FDCAN1 / FDCAN2 BUS MONITOR */}
        <DisclosureGroup title="FDCAN1 / FDCAN2 Live Bus Monitor" badge="1.5 Mbps Dual-CAN" defaultOpen={true}>
          <div className="mb-2 flex items-center justify-between gap-1">
            <div className="inline-flex rounded-lg border border-white/[0.07] bg-[#090a0f]/90 p-0.5 font-mono text-[10px]">
              {(
                [
                  { id: 'all', label: 'ALL' },
                  { id: 'fdcan1', label: 'FDCAN1 (500k)' },
                  { id: 'fdcan2', label: 'FDCAN2 (1M)' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setBusTab(t.id)}
                  className={`rounded-md px-2 py-0.5 uppercase transition ${
                    busTab === t.id ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setSyncWithLap((s) => !s)}
              className={`rounded-md border px-2 py-0.5 font-mono text-[10px] transition ${
                syncWithLap
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/[0.08] bg-slate-900 text-slate-400'
              }`}
            >
              {syncWithLap ? '● Sync Cursor' : '○ Manual SIL'}
            </button>
          </div>

          <div className="space-y-1.5">
            {canFrames.map((f) => (
              <div
                key={f.id}
                className="rounded-lg border border-white/[0.05] bg-[#090a0f]/80 px-2.5 py-1.5 font-mono text-[10px] tabular-nums"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`rounded px-1 py-0.2 text-[9px] font-semibold ${
                        f.bus === 'FDCAN1'
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-cyan-500/15 text-cyan-300'
                      }`}
                    >
                      {f.bus}
                    </span>
                    <span className="font-semibold text-slate-200">{f.id}</span>
                    <span className="text-slate-400">{f.name}</span>
                  </div>
                  <span className="text-[9px] text-slate-500">{f.rateHz} Hz</span>
                </div>
                <div className="mt-0.5 tracking-wider text-cyan-300/90">{f.payload}</div>
                <div className="mt-0.5 text-[9px] text-slate-400">{f.decoded}</div>
              </div>
            ))}
          </div>
        </DisclosureGroup>

        {/* 2. FSAE VCU FAULT INJECTION & PLAUSIBILITY FSM */}
        <DisclosureGroup
          title="Fault Injection & FSAE Plausibility"
          badge={vcuRuntime.state.replace('VCU_STATE_', '')}
          defaultOpen={true}
        >
          {/* Active FSM State Banner */}
          <div className="mb-2.5 flex items-center justify-between rounded-lg border border-white/[0.07] bg-[#090a0f]/90 px-2.5 py-2 font-mono text-[10px] tabular-nums">
            <div>
              <div className="text-[9px] uppercase tracking-wider text-slate-400">Active VCU State</div>
              <div
                className={`text-xs font-bold ${
                  vcuRuntime.state.includes('FAULT')
                    ? 'text-rose-400'
                    : vcuRuntime.state.includes('DERATE')
                      ? 'text-amber-300'
                      : 'text-emerald-400'
                }`}
              >
                {vcuRuntime.state}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] text-slate-400">Cascadia Out</div>
              <div className="text-xs font-bold text-cyan-300">{vcuRuntime.cascadiaTorqueCmdNm.toFixed(1)} Nm</div>
            </div>
          </div>

          <div className="space-y-2 font-mono text-[10px] tabular-nums">
            <label className="block">
              <div className="flex justify-between text-slate-300">
                <span>APPS Pedal (%)</span>
                <span className="text-cyan-300">{vcuInputs.appsPct.toFixed(0)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={vcuInputs.appsPct}
                onChange={(e) => {
                  setSyncWithLap(false);
                  setVcuInputs((p) => ({ ...p, appsPct: Number(e.target.value) }));
                }}
                className="w-full accent-cyan-400"
              />
            </label>

            <label className="block">
              <div className="flex justify-between text-slate-300">
                <span>T 11.8.9 APPS Deviation (&gt;10% / 100ms)</span>
                <span className={vcuInputs.appsDeviationPct > 10 ? 'font-bold text-rose-400' : 'text-slate-400'}>
                  {vcuInputs.appsDeviationPct.toFixed(1)}% ({vcuRuntime.appsFaultTimerMs} ms)
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={25}
                step={0.5}
                value={vcuInputs.appsDeviationPct}
                onChange={(e) => {
                  setSyncWithLap(false);
                  setVcuInputs((p) => ({ ...p, appsDeviationPct: Number(e.target.value) }));
                }}
                className="w-full accent-rose-400"
              />
            </label>

            <label className="block">
              <div className="flex justify-between text-slate-300">
                <span>EV 2.3 / EV 2.5 Brake Pressure (bar)</span>
                <span className={vcuInputs.brakePressureBar >= 15 ? 'font-bold text-amber-300' : 'text-slate-400'}>
                  {vcuInputs.brakePressureBar.toFixed(1)} bar (BSPD {vcuRuntime.bspdFaultTimerMs} ms)
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={50}
                step={1}
                value={vcuInputs.brakePressureBar}
                onChange={(e) => {
                  setSyncWithLap(false);
                  setVcuInputs((p) => ({ ...p, brakePressureBar: Number(e.target.value) }));
                }}
                className="w-full accent-amber-400"
              />
            </label>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <label className="block">
                <div className="flex justify-between text-slate-400">
                  <span>Inverter °C</span>
                  <span className="text-slate-200">{vcuInputs.inverterTempC.toFixed(0)}°C</span>
                </div>
                <input
                  type="range"
                  min={25}
                  max={90}
                  value={vcuInputs.inverterTempC}
                  onChange={(e) => setVcuInputs((p) => ({ ...p, inverterTempC: Number(e.target.value) }))}
                  className="w-full accent-cyan-400"
                />
              </label>

              <label className="block">
                <div className="flex justify-between text-slate-400">
                  <span>IMU Mode</span>
                </div>
                <select
                  value={vcuInputs.imuFaultMode}
                  onChange={(e) => setVcuInputs((p) => ({ ...p, imuFaultMode: e.target.value as ImuFaultMode }))}
                  className="field mt-0.5 !py-0.5 text-[10px]"
                >
                  <option value="NOMINAL">NOMINAL</option>
                  <option value="HIGH_NOISE">HIGH_NOISE</option>
                  <option value="CAN_TIMEOUT_DROPOUT">CAN_TIMEOUT_DROPOUT</option>
                </select>
              </label>
            </div>

            <button
              type="button"
              onClick={() => {
                setVcuInputs((p) => ({
                  ...p,
                  appsPct: 3,
                  appsDeviationPct: 1.0,
                  brakePressureBar: 0,
                  inverterTempC: 42,
                  motorTempC: 58,
                  imuFaultMode: 'NOMINAL',
                }));
                setVcuRuntime(INITIAL_VCU_FSM_RUNTIME);
              }}
              className="mt-1 w-full rounded-lg border border-white/[0.08] bg-slate-900 py-1.5 text-center font-mono text-[10px] uppercase tracking-wider text-slate-300 transition hover:border-cyan-500/40 hover:text-cyan-300"
            >
              ↺ Clear Latches & Reset VCU FSM
            </button>
          </div>
        </DisclosureGroup>

        {/* 3. EMBEDDED VCU C CODEGEN EXPORT */}
        <DisclosureGroup title="Embedded VCU C Firmware Export" badge="MISRA-C:2012" defaultOpen={false}>
          <div className="space-y-1.5 font-mono text-[10px]">
            <p className="text-slate-400">
              Zero-heap static C99 firmware generated from active vehicle ({veh.name}) and FSAE plausibility rules:
            </p>
            <div className="grid grid-cols-1 gap-1.5 pt-1">
              {bundle && (
                <button
                  type="button"
                  onClick={() => bundle.files.forEach((f) => downloadText(f.name, f.content, 'text/x-c'))}
                  className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-slate-900/90 px-2.5 py-1.5 text-left text-cyan-300 transition hover:border-cyan-500/40"
                >
                  <span>⬇ vcu_dynamics_autogen (.h/.c)</span>
                  <span className="text-[9px] text-slate-500">5 files</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  downloadText(safetyFw.headerName, safetyFw.headerContent, 'text/x-c');
                  downloadText(safetyFw.sourceName, safetyFw.sourceContent, 'text/x-c');
                }}
                className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-slate-900/90 px-2.5 py-1.5 text-left text-emerald-300 transition hover:border-emerald-500/40"
              >
                <span>⬇ ist26_vcu_safety_fsm (.h/.c)</span>
                <span className="text-[9px] text-slate-500">1 kHz Task</span>
              </button>
            </div>
          </div>
        </DisclosureGroup>
      </div>
    </aside>
  );
}
