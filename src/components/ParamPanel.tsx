'use client';

import { useEffect, useState } from 'react';
import { evaluateCorneringBalance, GRAVITY, type PowertrainParams, type VehicleParams } from '@/lib/physics';
import type { LapResult } from '@/lib/solver';

export type VehicleKey =
  | 'mass'
  | 'frontWeightFraction'
  | 'wheelbase'
  | 'trackWidth'
  | 'cgHeight'
  | 'ClA'
  | 'CdA'
  | 'airDensity'
  | 'aeroBalanceFront'
  | 'rollingResistance'
  | 'wheelRadius'
  | 'wheelInertia'
  | 'rollStiffnessFront'
  | 'rollCenterFront'
  | 'rollCenterRear'
  | 'camberFront'
  | 'camberRear'
  | 'rideHeightSensitivity'
  | 'yawInertia';

export type PowertrainKey =
  | 'motorPeakTorque'
  | 'motorPeakPower'
  | 'motorMaxRpm'
  | 'gearRatio'
  | 'gearboxEfficiency'
  | 'batteryPowerLimit'
  | 'regenPowerLimit'
  | 'batteryVoltage'
  | 'batteryCapacityKWh';

interface FieldDef<K extends string> {
  key: K;
  label: string;
  unit: string;
  scale: number; // displayed = stored * scale
  step: number;
  min: number;
  max: number;
  digits: number;
}

export const VEHICLE_FIELDS: FieldDef<VehicleKey>[] = [
  { key: 'mass', label: 'Mass (incl. driver)', unit: 'kg', scale: 1, step: 0.1, min: 80, max: 1500, digits: 1 },
  { key: 'frontWeightFraction', label: 'Front weight', unit: '%', scale: 100, step: 0.1, min: 25, max: 75, digits: 1 },
  { key: 'wheelbase', label: 'Wheelbase', unit: 'mm', scale: 1000, step: 1, min: 1400, max: 3000, digits: 1 },
  { key: 'trackWidth', label: 'Track width', unit: 'mm', scale: 1000, step: 1, min: 800, max: 1800, digits: 1 },
  { key: 'cgHeight', label: 'CG height', unit: 'mm', scale: 1000, step: 1, min: 100, max: 650, digits: 1 },
  { key: 'ClA', label: 'Downforce Cl·A', unit: 'm²', scale: 1, step: 0.01, min: 0, max: 8, digits: 2 },
  { key: 'CdA', label: 'Drag Cd·A', unit: 'm²', scale: 1, step: 0.01, min: 0.1, max: 4, digits: 2 },
  { key: 'airDensity', label: 'Air density ρ', unit: 'kg/m³', scale: 1, step: 0.005, min: 0.9, max: 1.4, digits: 3 },
  { key: 'aeroBalanceFront', label: 'Aero balance front', unit: '%', scale: 100, step: 0.1, min: 10, max: 85, digits: 1 },
  { key: 'rideHeightSensitivity', label: 'Aero pitch sens.', unit: '%/G', scale: 100, step: 0.1, min: 0, max: 30, digits: 1 },
  { key: 'rollingResistance', label: 'Rolling resist. Crr', unit: '–', scale: 1, step: 0.001, min: 0.002, max: 0.06, digits: 3 },
  { key: 'wheelRadius', label: 'Loaded wheel radius', unit: 'mm', scale: 1000, step: 0.5, min: 120, max: 400, digits: 1 },
  { key: 'wheelInertia', label: 'Wheel inertia Iw', unit: 'kg·m²', scale: 1, step: 0.01, min: 0.05, max: 3.0, digits: 2 },
  { key: 'rollStiffnessFront', label: 'Front LLTD', unit: '%', scale: 100, step: 0.1, min: 20, max: 85, digits: 1 },
  { key: 'rollCenterFront', label: 'Roll center front', unit: 'mm', scale: 1000, step: 0.5, min: -50, max: 200, digits: 1 },
  { key: 'rollCenterRear', label: 'Roll center rear', unit: 'mm', scale: 1000, step: 0.5, min: -50, max: 220, digits: 1 },
  { key: 'camberFront', label: 'Static camber front', unit: 'deg', scale: 1, step: 0.05, min: -6, max: 3, digits: 2 },
  { key: 'camberRear', label: 'Static camber rear', unit: 'deg', scale: 1, step: 0.05, min: -6, max: 3, digits: 2 },
  { key: 'yawInertia', label: 'Yaw inertia Izz', unit: 'kg·m²', scale: 1, step: 0.1, min: 20, max: 2500, digits: 1 },
];

export const POWERTRAIN_FIELDS: FieldDef<PowertrainKey>[] = [
  { key: 'motorPeakTorque', label: 'Motor peak torque', unit: 'Nm', scale: 1, step: 0.1, min: 2, max: 500, digits: 1 },
  { key: 'motorPeakPower', label: 'Motor peak power', unit: 'kW', scale: 0.001, step: 0.1, min: 5, max: 250, digits: 1 },
  { key: 'motorMaxRpm', label: 'Motor max speed', unit: 'rpm', scale: 1, step: 100, min: 2000, max: 30000, digits: 0 },
  { key: 'gearRatio', label: 'Planetary ratio', unit: ':1', scale: 1, step: 0.05, min: 1.5, max: 25, digits: 2 },
  { key: 'gearboxEfficiency', label: 'Gearbox efficiency', unit: '%', scale: 100, step: 0.1, min: 80, max: 100, digits: 1 },
  { key: 'batteryPowerLimit', label: 'Accumulator limit', unit: 'kW', scale: 0.001, step: 0.5, min: 10, max: 300, digits: 1 },
  { key: 'regenPowerLimit', label: 'Regen limit', unit: 'kW', scale: 0.001, step: 0.5, min: 0, max: 150, digits: 1 },
  { key: 'batteryVoltage', label: 'Pack nominal V', unit: 'V', scale: 1, step: 1, min: 100, max: 900, digits: 1 },
  { key: 'batteryCapacityKWh', label: 'Pack capacity', unit: 'kWh', scale: 1, step: 0.1, min: 1, max: 100, digits: 2 },
];

function formatDisplay(val: number, digits: number): string {
  const rounded = Number(val.toFixed(4));
  const fixed = val.toFixed(digits);
  if (Math.abs(Number(fixed) - rounded) > 1e-5) {
    return String(rounded);
  }
  return fixed;
}

function parseLocaleNumber(raw: string): number {
  const normalized = raw.trim().replace(/,/g, '.');
  if (normalized === '' || normalized === '-' || normalized === '.' || normalized === '-.') return NaN;
  return Number(normalized);
}

function NumField<K extends string>({ def, value, onChange }: { def: FieldDef<K>; value: number; onChange: (k: K, v: number) => void }) {
  const display = formatDisplay(value * def.scale, def.digits);
  const [text, setText] = useState(display);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setText(display);
    }
  }, [display, focused]);

  const commit = (s: string) => {
    const x = parseLocaleNumber(s);
    if (Number.isFinite(x)) {
      const clamped = Math.min(def.max, Math.max(def.min, x));
      onChange(def.key, clamped / def.scale);
      setText(formatDisplay(clamped, def.digits));
    } else {
      setText(display);
    }
  };

  return (
    <label className="grid grid-cols-[1fr_84px] items-center gap-2 py-[3px]">
      <span className="truncate text-[11px] text-hud-dim">
        {def.label} <span className="text-hud-dim/60">[{def.unit}]</span>
      </span>
      <input
        className="field text-right"
        type="text"
        inputMode="decimal"
        value={text}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const trimmed = raw.trim();
          // Don't eagerly commit if user is mid-decimal (e.g. "11." or "11," or "11.0")
          if (trimmed.endsWith('.') || trimmed.endsWith(',')) return;
          const x = parseLocaleNumber(trimmed);
          if (Number.isFinite(x) && x >= def.min && x <= def.max) {
            onChange(def.key, x / def.scale);
          }
        }}
        onBlur={(e) => {
          setFocused(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

export function VehicleForm({
  veh,
  onChange,
  lambdaMu,
  onLambdaMu,
  lap,
}: {
  veh: VehicleParams;
  onChange: (k: VehicleKey, v: number) => void;
  lambdaMu: number;
  onLambdaMu: (v: number) => void;
  lap?: LapResult;
}) {
  const bal1G = evaluateCorneringBalance(veh, 20, 0, 1.2 * GRAVITY);
  const kusCorner = lap ? lap.cornerUndersteerDegPerG : bal1G.understeerDegPerG;
  const siAvg = lap ? lap.avgStabilityIndex : bal1G.stabilityIndex;
  const hasLift = lap ? lap.hasWheelLift : bal1G.wheelLift;

  return (
    <div className="px-3 py-2">
      {VEHICLE_FIELDS.map((f) => (
        <NumField key={f.key} def={f} value={veh[f.key] ?? 0} onChange={onChange} />
      ))}
      <NumField
        def={{ key: 'lambdaMu', label: 'Tire grip scale λμ', unit: '–', scale: 1, step: 0.01, min: 0.5, max: 1.5, digits: 2 }}
        value={lambdaMu}
        onChange={(_, v) => onLambdaMu(v)}
      />
      <div className="mt-2 rounded border border-hud-line bg-hud-bg/70 p-2 font-mono text-[10px]">
        <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-hud-cyan">
          <span>LLTD & Roll Balance</span>
          <span>{kusCorner >= 0 ? 'Understeer' : 'Oversteer'}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-hud-dim">
          <span>Understeer K_us</span>
          <span className={`text-right tabular-nums ${kusCorner >= 0 ? 'text-hud-cyan' : 'text-hud-amber'}`}>
            {kusCorner >= 0 ? '+' : ''}
            {kusCorner.toFixed(2)} deg/G
          </span>
          <span>Stability Index</span>
          <span className={`text-right tabular-nums ${siAvg >= 0 ? 'text-hud-lime' : 'text-hud-red'}`}>
            {siAvg >= 0 ? '+' : ''}
            {(siAvg * 100).toFixed(1)} %
          </span>
          {lap && (
            <>
              <span>Min inner Fz</span>
              <span className="text-right tabular-nums text-hud-text">{lap.minInnerWheelLoadN.toFixed(0)} N</span>
            </>
          )}
        </div>
        {hasLift && (
          <div className="mt-1.5 flex items-center justify-between rounded border border-hud-red/60 bg-hud-red/15 px-2 py-1 text-[10px] font-bold text-hud-red">
            <span>⚠ Inner Wheel Lift!</span>
            <span>{lap ? `${lap.wheelLiftCount} pts (0 N)` : 'Fz_in = 0 N'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function PowertrainForm({
  pt,
  onChange,
  onRegen,
}: {
  pt: PowertrainParams;
  onChange: (k: PowertrainKey, v: number) => void;
  onRegen: (on: boolean) => void;
}) {
  return (
    <div className="px-3 py-2">
      {POWERTRAIN_FIELDS.map((f) => (
        <NumField key={f.key} def={f} value={pt[f.key]} onChange={onChange} />
      ))}
      <label className="mt-1 flex items-center justify-between py-1 text-[11px] text-hud-dim">
        Regenerative braking
        <input type="checkbox" className="accent-cyan-400" checked={pt.regenEnabled} onChange={(e) => onRegen(e.target.checked)} />
      </label>
      <div className="mt-1 font-mono text-[10px] text-hud-dim">
        Peak wheel torque {(pt.motorCount * pt.motorPeakTorque * pt.gearRatio).toFixed(1)} Nm · {pt.motorCount} motors
      </div>
    </div>
  );
}
