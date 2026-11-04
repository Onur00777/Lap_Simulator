'use client';

import { useEffect, useState } from 'react';
import type { PowertrainParams, VehicleParams } from '@/lib/physics';

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
  | 'rollStiffnessFront'
  | 'yawInertia';

export type PowertrainKey = 'motorPeakTorque' | 'motorPeakPower' | 'motorMaxRpm' | 'gearRatio' | 'batteryPowerLimit' | 'regenPowerLimit';

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
  { key: 'mass', label: 'Mass (incl. driver)', unit: 'kg', scale: 1, step: 1, min: 120, max: 400, digits: 0 },
  { key: 'frontWeightFraction', label: 'Front weight', unit: '%', scale: 100, step: 0.5, min: 30, max: 70, digits: 1 },
  { key: 'wheelbase', label: 'Wheelbase', unit: 'mm', scale: 1000, step: 5, min: 1525, max: 2000, digits: 0 },
  { key: 'trackWidth', label: 'Track width', unit: 'mm', scale: 1000, step: 5, min: 900, max: 1500, digits: 0 },
  { key: 'cgHeight', label: 'CG height', unit: 'mm', scale: 1000, step: 5, min: 150, max: 400, digits: 0 },
  { key: 'ClA', label: 'Downforce Cl·A', unit: 'm²', scale: 1, step: 0.1, min: 0, max: 6, digits: 2 },
  { key: 'CdA', label: 'Drag Cd·A', unit: 'm²', scale: 1, step: 0.05, min: 0.3, max: 3, digits: 2 },
  { key: 'airDensity', label: 'Air density ρ', unit: 'kg/m³', scale: 1, step: 0.005, min: 0.9, max: 1.4, digits: 3 },
  { key: 'aeroBalanceFront', label: 'Aero balance front', unit: '%', scale: 100, step: 1, min: 20, max: 70, digits: 0 },
  { key: 'rollingResistance', label: 'Rolling resist. Crr', unit: '–', scale: 1, step: 0.001, min: 0.005, max: 0.04, digits: 3 },
  { key: 'wheelRadius', label: 'Loaded wheel radius', unit: 'mm', scale: 1000, step: 1, min: 150, max: 270, digits: 0 },
  { key: 'rollStiffnessFront', label: 'LLTD front', unit: '%', scale: 100, step: 1, min: 30, max: 75, digits: 0 },
  { key: 'yawInertia', label: 'Yaw inertia Izz', unit: 'kg·m²', scale: 1, step: 5, min: 50, max: 250, digits: 0 },
];

export const POWERTRAIN_FIELDS: FieldDef<PowertrainKey>[] = [
  { key: 'motorPeakTorque', label: 'Motor peak torque', unit: 'Nm', scale: 1, step: 0.5, min: 5, max: 60, digits: 1 },
  { key: 'motorPeakPower', label: 'Motor peak power', unit: 'kW', scale: 0.001, step: 1, min: 10, max: 80, digits: 0 },
  { key: 'motorMaxRpm', label: 'Motor max speed', unit: 'rpm', scale: 1, step: 500, min: 6000, max: 25000, digits: 0 },
  { key: 'gearRatio', label: 'Planetary ratio', unit: ':1', scale: 1, step: 0.1, min: 4, max: 18, digits: 1 },
  { key: 'batteryPowerLimit', label: 'Accumulator limit', unit: 'kW', scale: 0.001, step: 1, min: 20, max: 120, digits: 0 },
  { key: 'regenPowerLimit', label: 'Regen limit', unit: 'kW', scale: 0.001, step: 1, min: 0, max: 80, digits: 0 },
];

function NumField<K extends string>({ def, value, onChange }: { def: FieldDef<K>; value: number; onChange: (k: K, v: number) => void }) {
  const display = (value * def.scale).toFixed(def.digits);
  const [text, setText] = useState(display);
  useEffect(() => setText(display), [display]);
  const commit = (s: string) => {
    const x = Number(s);
    if (Number.isFinite(x)) {
      const clamped = Math.min(def.max, Math.max(def.min, x));
      onChange(def.key, clamped / def.scale);
      setText(clamped.toFixed(def.digits));
    } else setText(display);
  };
  return (
    <label className="grid grid-cols-[1fr_84px] items-center gap-2 py-[3px]">
      <span className="truncate text-[11px] text-hud-dim">
        {def.label} <span className="text-hud-dim/60">[{def.unit}]</span>
      </span>
      <input
        className="field text-right"
        type="number"
        step={def.step}
        min={def.min}
        max={def.max}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const x = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(x) && x >= def.min && x <= def.max) onChange(def.key, x / def.scale);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
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
}: {
  veh: VehicleParams;
  onChange: (k: VehicleKey, v: number) => void;
  lambdaMu: number;
  onLambdaMu: (v: number) => void;
}) {
  return (
    <div className="px-3 py-2">
      {VEHICLE_FIELDS.map((f) => (
        <NumField key={f.key} def={f} value={veh[f.key]} onChange={onChange} />
      ))}
      <NumField
        def={{ key: 'lambdaMu', label: 'Tire grip scale λμ', unit: '–', scale: 1, step: 0.01, min: 0.5, max: 1.3, digits: 2 }}
        value={lambdaMu}
        onChange={(_, v) => onLambdaMu(v)}
      />
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
        Peak wheel torque {(pt.motorCount * pt.motorPeakTorque * pt.gearRatio).toFixed(0)} Nm · {pt.motorCount} motors
      </div>
    </div>
  );
}
