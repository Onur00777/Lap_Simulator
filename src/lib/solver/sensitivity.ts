import {
  buildEfficiencyMap,
  clamp,
  REFERENCE_TIRE_PRESSURE,
  speedFromMotorRpm,
  type LateralModel,
  type PowertrainParams,
  type VehicleParams,
} from '../physics';
import { buildTwoTrackEnvelope } from '../dynamics';
import type { Track } from '../tracks/types';
import { createContext } from './context';
import { simulateLap, type Integrator } from './lap-simulator';

export type SensitivityParamKey = 'mass' | 'ClA' | 'CdA' | 'lambdaMu' | 'cgHeight' | 'powerCap' | 'lltd';

export interface TornadoEntry {
  key: SensitivityParamKey;
  label: string;
  unit: string;
  baseValueDisplay: number;
  lowValueDisplay: number; // -10%
  highValueDisplay: number; // +10%
  /** Lap time change [ms] when parameter is decreased by 10% (t_low - t_base) * 1000. */
  deltaMsMinus10: number;
  /** Lap time change [ms] when parameter is increased by 10% (t_high - t_base) * 1000. */
  deltaMsPlus10: number;
  /** Total lap time swing |t_high - t_low| in [ms] for Tornado ranking. */
  swingMs: number;
  /** Energy change [Wh] at -10% and +10%. */
  deltaWhMinus10: number;
  deltaWhPlus10: number;
  /** Normalized engineering rule-of-thumb label, e.g. "-28.4 ms / -1 kg mass". */
  derivativeLabel: string;
  /** Exact Jacobian derivative in ms per engineering unit. */
  msPerUnit: number;
  /** Exact Jacobian derivative in Wh per engineering unit. */
  whPerUnit: number;
  engineeringUnitLabel: string;
  /** 5-point 1D sweep [-10%, -5%, 0%, +5%, +10%]. */
  sweep: { pct: number; valueDisplay: number; lapTimeS: number; deltaMs: number; energyWh: number }[];
}

export interface SensitivityReport {
  baseLapTimeS: number;
  baseEnergyWh: number;
  baseCoolingKJ: number;
  tornado: TornadoEntry[];
  computeTimeMs: number;
}

export type ContourPreset = 'aero' | 'mass-power' | 'cg-lltd';

export interface ContourGrid {
  preset: ContourPreset;
  xLabel: string;
  xUnit: string;
  yLabel: string;
  yUnit: string;
  xValues: number[];
  yValues: number[];
  baseX: number;
  baseY: number;
  /** lapTimeS[yIdx][xIdx] */
  lapTimeS: number[][];
  /** deltaMs[yIdx][xIdx] relative to baseline */
  deltaMs: number[][];
  /** energyWh[yIdx][xIdx] */
  energyWh: number[][];
  minLapTimeS: number;
  maxLapTimeS: number;
  minEnergyWh: number;
  maxEnergyWh: number;
  bestPoint: { x: number; y: number; lapTimeS: number; deltaMs: number; energyWh: number };
}

function evalSetup(
  track: Track,
  veh: VehicleParams,
  pt: PowertrainParams,
  model: LateralModel,
  integrator: Integrator,
  sharedMap = buildEfficiencyMap(pt),
): { lapTimeS: number; energyWh: number; coolingKJ: number } {
  const vTop = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio) + 2;
  const env =
    model === 'point-mass'
      ? undefined
      : buildTwoTrackEnvelope(veh, pt, vTop, model === 'two-track-tv' ? 'tv' : 'open', 1.0);
  const ctx = createContext(veh, pt, env);
  ctx.map = sharedMap;
  const lap = simulateLap(track, ctx, { integrator });
  return {
    lapTimeS: lap.lapTime,
    energyWh: lap.energy.netKWh * 1000,
    coolingKJ: lap.energy.coolingHeatKJ,
  };
}

export interface SetupJacobianEntry {
  key: 'aeroBalance' | 'gearRatio' | 'frontRollStiffness' | 'mass' | 'tirePressure';
  label: string;
  unit: string;
  baseValue: number;
  lowValue: number;
  highValue: number;
  lowDeltaMs: number;
  highDeltaMs: number;
  lowDeltaWh: number;
  highDeltaWh: number;
  msPerUnit: number;
  whPerUnit: number;
}

export function computeSetupJacobian(
  track: Track,
  veh: VehicleParams,
  pt: PowertrainParams,
  model: LateralModel = 'point-mass',
  integrator: Integrator = 'rk4',
): SetupJacobianEntry[] {
  const map = buildEfficiencyMap(pt);
  const baseline = evalSetup(track, veh, pt, model, integrator, map);
  const evaluate = (v: VehicleParams, p = pt) => evalSetup(track, v, p, model, integrator, map);
  const pressure = veh.tire.pressureBar ?? veh.tire.pressureGrip?.referenceBar ?? REFERENCE_TIRE_PRESSURE.referenceBar;
  const balance = veh.aeroBalanceFront * 100;
  const roll = veh.rollStiffnessFront * 100;
  const specs: {
    key: SetupJacobianEntry['key']; label: string; unit: string; base: number;
    low: number; high: number; run: (value: number) => typeof baseline;
  }[] = [
    {
      key: 'aeroBalance', label: 'Front aero balance', unit: 'pp', base: balance,
      low: clamp(balance - 2, 0, 100), high: clamp(balance + 2, 0, 100),
      run: (value) => {
        const aero = veh.rideHeightAero;
        const delta = (value - balance) / 100;
        const rideHeightAero = aero ? { ...aero, map: { ...aero.map, frontFraction: aero.map.frontFraction.map((row) => row.map((cell) => clamp(cell + delta, 0, 1))) } } : undefined;
        return evaluate({ ...veh, aeroBalanceFront: value / 100, rideHeightAero });
      },
    },
    { key: 'gearRatio', label: 'Final drive', unit: 'ratio', base: pt.gearRatio, low: pt.gearRatio * 0.95, high: pt.gearRatio * 1.05, run: (gearRatio) => evaluate(veh, { ...pt, gearRatio }) },
    { key: 'frontRollStiffness', label: 'Front roll stiffness share', unit: 'pp', base: roll, low: clamp(roll * 0.95, 0, 100), high: clamp(roll * 1.05, 0, 100), run: (value) => evaluate({ ...veh, rollStiffnessFront: value / 100 }) },
    { key: 'mass', label: 'Vehicle mass', unit: 'kg', base: veh.mass, low: Math.max(1, veh.mass - 10), high: veh.mass + 10, run: (mass) => evaluate({ ...veh, mass }) },
    { key: 'tirePressure', label: 'Tire pressure', unit: 'bar', base: pressure, low: Math.max(0.1, pressure - 0.2), high: pressure + 0.2, run: (pressureBar) => evaluate({ ...veh, tire: { ...veh.tire, pressureBar } }) },
  ];

  return specs.map((spec) => {
    const low = spec.run(spec.low);
    const high = spec.run(spec.high);
    const span = spec.high - spec.low;
    return {
      key: spec.key, label: spec.label, unit: spec.unit, baseValue: spec.base, lowValue: spec.low, highValue: spec.high,
      lowDeltaMs: 1000 * (low.lapTimeS - baseline.lapTimeS), highDeltaMs: 1000 * (high.lapTimeS - baseline.lapTimeS),
      lowDeltaWh: low.energyWh - baseline.energyWh, highDeltaWh: high.energyWh - baseline.energyWh,
      msPerUnit: span > 0 ? 1000 * (high.lapTimeS - low.lapTimeS) / span : 0,
      whPerUnit: span > 0 ? (high.energyWh - low.energyWh) / span : 0,
    };
  });
}

/**
 * Runs a 1D ±10% parametric sensitivity sweep across all 7 key vehicle parameters
 * and ranks them for a Jacobian Tornado Chart.
 */
export function runSensitivitySweep(
  track: Track,
  veh: VehicleParams,
  pt: PowertrainParams,
  model: LateralModel = 'point-mass',
  integrator: Integrator = 'rk4',
): SensitivityReport {
  const t0 = performance.now();
  const map = buildEfficiencyMap(pt);
  const base = evalSetup(track, veh, pt, model, integrator, map);
  // For LLTD sensitivity, use 2-track open if point-mass is selected so lateral load transfer axle balance is captured
  const lltdBase = model === 'point-mass' ? evalSetup(track, veh, pt, 'two-track-open', integrator, map) : base;

  const specs: {
    key: SensitivityParamKey;
    label: string;
    unit: string;
    baseDisplay: number;
    engStepDisplay: number;
    engUnitLabel: string;
    apply: (scale: number) => { v: VehicleParams; p: PowertrainParams; m: LateralModel; ref: typeof base };
  }[] = [
    {
      key: 'mass',
      label: 'Mass (incl. driver)',
      unit: 'kg',
      baseDisplay: veh.mass,
      engStepDisplay: -1,
      engUnitLabel: '−1 kg mass',
      apply: (s) => ({ v: { ...veh, mass: veh.mass * s }, p: pt, m: model, ref: base }),
    },
    {
      key: 'ClA',
      label: 'Downforce Cl·A',
      unit: 'm²',
      baseDisplay: veh.ClA,
      engStepDisplay: 0.1,
      engUnitLabel: '+0.1 m² Cl·A',
      apply: (s) => ({ v: { ...veh, ClA: Math.max(0.05, veh.ClA * s) }, p: pt, m: model, ref: base }),
    },
    {
      key: 'CdA',
      label: 'Drag Cd·A',
      unit: 'm²',
      baseDisplay: veh.CdA,
      engStepDisplay: -0.1,
      engUnitLabel: '−0.1 m² Cd·A',
      apply: (s) => ({ v: { ...veh, CdA: Math.max(0.1, veh.CdA * s) }, p: pt, m: model, ref: base }),
    },
    {
      key: 'lambdaMu',
      label: 'Tire Grip Scaling λμ',
      unit: '–',
      baseDisplay: veh.tire.lambdaMu,
      engStepDisplay: 0.05,
      engUnitLabel: '+0.05 λμ grip',
      apply: (s) => ({
        v: { ...veh, tire: { ...veh.tire, lambdaMu: veh.tire.lambdaMu * s } },
        p: pt,
        m: model,
        ref: base,
      }),
    },
    {
      key: 'cgHeight',
      label: 'CG Height h_cg',
      unit: 'mm',
      baseDisplay: veh.cgHeight * 1000,
      engStepDisplay: -10,
      engUnitLabel: '−10 mm CG height',
      apply: (s) => ({ v: { ...veh, cgHeight: veh.cgHeight * s }, p: pt, m: model, ref: base }),
    },
    {
      key: 'powerCap',
      label: 'Accumulator Power Cap',
      unit: 'kW',
      baseDisplay: pt.batteryPowerLimit / 1000,
      engStepDisplay: 5,
      engUnitLabel: '+5 kW power cap',
      apply: (s) => ({
        v: veh,
        p: { ...pt, batteryPowerLimit: pt.batteryPowerLimit * s },
        m: model,
        ref: base,
      }),
    },
    {
      key: 'lltd',
      label: 'Front Roll Stiffness (LLTD)',
      unit: '%',
      baseDisplay: veh.rollStiffnessFront * 100,
      engStepDisplay: -1,
      engUnitLabel: '−1.0% front LLTD',
      apply: (s) => ({
        v: { ...veh, rollStiffnessFront: Math.max(0.25, Math.min(0.85, veh.rollStiffnessFront * s)) },
        p: pt,
        m: model === 'point-mass' ? 'two-track-open' : model,
        ref: lltdBase,
      }),
    },
  ];

  const pcts = [-10, -5, 0, 5, 10];
  const tornado: TornadoEntry[] = specs.map((sp) => {
    const sweep = pcts.map((pct) => {
      const scale = 1 + pct / 100;
      const cfg = sp.apply(scale);
      const res = pct === 0 ? cfg.ref : evalSetup(track, cfg.v, cfg.p, cfg.m, integrator, map);
      return {
        pct,
        valueDisplay: sp.baseDisplay * scale,
        lapTimeS: res.lapTimeS,
        deltaMs: (res.lapTimeS - cfg.ref.lapTimeS) * 1000,
        energyWh: res.energyWh,
      };
    });

    const minus10 = sweep[0];
    const plus10 = sweep[4];
    const refRes = sp.apply(1).ref;
    const deltaMsMinus10 = minus10.deltaMs;
    const deltaMsPlus10 = plus10.deltaMs;
    const deltaWhMinus10 = minus10.energyWh - refRes.energyWh;
    const deltaWhPlus10 = plus10.energyWh - refRes.energyWh;

    const totalDisplaySpan = plus10.valueDisplay - minus10.valueDisplay;
    const dMsPerDisplay = totalDisplaySpan !== 0 ? (deltaMsPlus10 - deltaMsMinus10) / totalDisplaySpan : 0;
    const dWhPerDisplay = totalDisplaySpan !== 0 ? (deltaWhPlus10 - deltaWhMinus10) / totalDisplaySpan : 0;

    const msPerUnit = dMsPerDisplay * sp.engStepDisplay;
    const whPerUnit = dWhPerDisplay * sp.engStepDisplay;

    const signMs = msPerUnit >= 0 ? '+' : '−';
    const derivativeLabel = `${signMs}${Math.abs(msPerUnit).toFixed(1)} ms / ${sp.engUnitLabel}`;

    return {
      key: sp.key,
      label: sp.label,
      unit: sp.unit,
      baseValueDisplay: sp.baseDisplay,
      lowValueDisplay: minus10.valueDisplay,
      highValueDisplay: plus10.valueDisplay,
      deltaMsMinus10,
      deltaMsPlus10,
      swingMs: Math.abs(deltaMsPlus10 - deltaMsMinus10),
      deltaWhMinus10,
      deltaWhPlus10,
      derivativeLabel,
      msPerUnit,
      whPerUnit,
      engineeringUnitLabel: sp.engUnitLabel,
      sweep,
    };
  });

  tornado.sort((a, b) => b.swingMs - a.swingMs);

  return {
    baseLapTimeS: base.lapTimeS,
    baseEnergyWh: base.energyWh,
    baseCoolingKJ: base.coolingKJ,
    tornado,
    computeTimeMs: performance.now() - t0,
  };
}

/**
 * Computes a 2D Iso-Lap-Time & Iso-Energy grid across two selected vehicle design axes.
 */
export function computeContourGrid(
  track: Track,
  veh: VehicleParams,
  pt: PowertrainParams,
  preset: ContourPreset = 'aero',
  model: LateralModel = 'point-mass',
  integrator: Integrator = 'rk4',
  gridSize = 7,
): ContourGrid {
  const map = buildEfficiencyMap(pt);
  const base = evalSetup(track, veh, pt, model, integrator, map);

  let xLabel = 'Downforce Cl·A';
  let xUnit = 'm²';
  let yLabel = 'Drag Cd·A';
  let yUnit = 'm²';
  let baseX = veh.ClA;
  let baseY = veh.CdA;
  let xSpan: [number, number] = [Math.max(0.4, veh.ClA * 0.65), Math.min(5.8, veh.ClA * 1.35)];
  let ySpan: [number, number] = [Math.max(0.4, veh.CdA * 0.65), Math.min(2.4, veh.CdA * 1.35)];

  if (preset === 'mass-power') {
    xLabel = 'Vehicle Mass';
    xUnit = 'kg';
    yLabel = 'Accumulator Power Limit';
    yUnit = 'kW';
    baseX = veh.mass;
    baseY = pt.batteryPowerLimit / 1000;
    xSpan = [Math.max(150, Math.round(veh.mass * 0.8)), Math.min(360, Math.round(veh.mass * 1.2))];
    ySpan = [Math.max(30, Math.round((pt.batteryPowerLimit / 1000) * 0.6)), Math.min(110, Math.round((pt.batteryPowerLimit / 1000) * 1.25))];
  } else if (preset === 'cg-lltd') {
    xLabel = 'CG Height h_cg';
    xUnit = 'mm';
    yLabel = 'Front LLTD';
    yUnit = '%';
    baseX = veh.cgHeight * 1000;
    baseY = veh.rollStiffnessFront * 100;
    xSpan = [Math.max(170, Math.round(baseX * 0.78)), Math.min(360, Math.round(baseX * 1.22))];
    ySpan = [38, 66];
  }

  const xValues = Array.from({ length: gridSize }, (_, i) => xSpan[0] + ((xSpan[1] - xSpan[0]) * i) / (gridSize - 1));
  const yValues = Array.from({ length: gridSize }, (_, j) => ySpan[0] + ((ySpan[1] - ySpan[0]) * j) / (gridSize - 1));

  const lapTimeS: number[][] = [];
  const deltaMs: number[][] = [];
  const energyWh: number[][] = [];

  let minLapTimeS = Infinity;
  let maxLapTimeS = -Infinity;
  let minEnergyWh = Infinity;
  let maxEnergyWh = -Infinity;
  let bestPoint = { x: baseX, y: baseY, lapTimeS: base.lapTimeS, deltaMs: 0, energyWh: base.energyWh };

  const evalModel: LateralModel = preset === 'cg-lltd' && model === 'point-mass' ? 'two-track-open' : model;
  const refForGrid = preset === 'cg-lltd' && model === 'point-mass' ? evalSetup(track, veh, pt, 'two-track-open', integrator, map) : base;

  for (let j = 0; j < gridSize; j++) {
    const yv = yValues[j];
    const rowT: number[] = [];
    const rowD: number[] = [];
    const rowE: number[] = [];
    for (let i = 0; i < gridSize; i++) {
      const xv = xValues[i];
      let vMod = veh;
      let pMod = pt;
      if (preset === 'aero') {
        vMod = { ...veh, ClA: xv, CdA: yv };
      } else if (preset === 'mass-power') {
        vMod = { ...veh, mass: xv };
        pMod = { ...pt, batteryPowerLimit: yv * 1000 };
      } else {
        vMod = { ...veh, cgHeight: xv / 1000, rollStiffnessFront: yv / 100 };
      }
      const res = evalSetup(track, vMod, pMod, evalModel, integrator, map);
      const dMs = (res.lapTimeS - refForGrid.lapTimeS) * 1000;
      rowT.push(res.lapTimeS);
      rowD.push(dMs);
      rowE.push(res.energyWh);

      if (res.lapTimeS < minLapTimeS) {
        minLapTimeS = res.lapTimeS;
        bestPoint = { x: xv, y: yv, lapTimeS: res.lapTimeS, deltaMs: dMs, energyWh: res.energyWh };
      }
      if (res.lapTimeS > maxLapTimeS) maxLapTimeS = res.lapTimeS;
      if (res.energyWh < minEnergyWh) minEnergyWh = res.energyWh;
      if (res.energyWh > maxEnergyWh) maxEnergyWh = res.energyWh;
    }
    lapTimeS.push(rowT);
    deltaMs.push(rowD);
    energyWh.push(rowE);
  }

  return {
    preset,
    xLabel,
    xUnit,
    yLabel,
    yUnit,
    xValues,
    yValues,
    baseX,
    baseY,
    lapTimeS,
    deltaMs,
    energyWh,
    minLapTimeS,
    maxLapTimeS,
    minEnergyWh,
    maxEnergyWh,
    bestPoint,
  };
}
