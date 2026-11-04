import {
  GRAVITY,
  speedFromMotorRpm,
  steadyStateLateralLimit,
  type PowertrainParams,
  type VehicleParams,
} from '../physics';
import { createContext, simulateLap, type Integrator, type LapResult } from '../solver';
import type { Track } from '../tracks/types';
import { axleBalance, buildTwoTrackEnvelope, maxDifferentialForce, sampleEnvelopes, twoTrackLateralLimit } from './two-track';
import { rampMetrics, simulateTransient, stepMetrics, type RampMetrics, type StepMetrics } from './transient';
import { defaultTVParams, type TVControllerParams } from './yaw-controller';

export interface TorqueAllocation {
  s: number[];
  mz: number[]; // Nm
  wheelTorqueRL: number[]; // Nm at the wheel
  wheelTorqueRR: number[];
  dFx: number[]; // N per wheel
  peakOuterWheelTorque: number;
  peakInnerWheelTorque: number; // most negative inner torque (regen on inner wheel)
  peakMz: number;
}

export interface TVAnalysis {
  envelopeCurves: ReturnType<typeof sampleEnvelopes>;
  lap: {
    pointMass: number;
    open: number;
    tv: number;
    deltaTv: number; // tv - open (negative = faster)
    deltaPct: number;
    energyOpenKWh: number;
    energyTvKWh: number;
  };
  corners: { index: number; direction: 'L' | 'R'; radius: number; apexOpen: number; apexTv: number; gain: number }[];
  step: { open: StepMetrics; tv: StepMetrics; series: { t: number; rOpen: number; rTv: number; rRef: number; mz: number }[] };
  ramp: {
    open: RampMetrics;
    tv: RampMetrics;
    series: { steerDeg: number; ayOpen: number; ayTv: number }[];
    usSeries: { ayG: number; usOpen?: number; usTv?: number }[];
  };
  allocation: TorqueAllocation;
  controller: TVControllerParams;
  testSpeed: number;
  tvLap: LapResult;
  openLap: LapResult;
}

export interface TVAnalysisOptions {
  integrator?: Integrator;
  testSpeed?: number; // m/s for the step / ramp manoeuvres
  stepSteerDeg?: number;
  rampSteerDeg?: number;
  controller?: Partial<TVControllerParams>;
}

/** Steady-state optimal (axle-balancing) torque split along a solved lap. */
export function allocateAlongLap(veh: VehicleParams, pt: PowertrainParams, lap: LapResult, stride = 2): TorqueAllocation {
  const ch = lap.channels;
  const wheelLimit = pt.motorPeakTorque * pt.gearRatio;
  const out: TorqueAllocation = {
    s: [],
    mz: [],
    wheelTorqueRL: [],
    wheelTorqueRR: [],
    dFx: [],
    peakOuterWheelTorque: 0,
    peakInnerWheelTorque: 0,
    peakMz: 0,
  };
  for (let i = 0; i < ch.s.length; i += stride) {
    const v = ch.v[i];
    const ay = ch.ay[i];
    const bal = axleBalance(veh, pt, v, Math.abs(ay), 'tv');
    const dir = Math.sign(ay) || 1; // + left turn: outer = right
    const baseWheel = ch.motorTorque[i] * pt.gearRatio * (ch.motorTorque[i] >= 0 ? pt.gearboxEfficiency : 1 / pt.gearboxEfficiency);
    const dT = bal.dFx * veh.wheelRadius;
    const tOuter = Math.max(-wheelLimit, Math.min(wheelLimit, baseWheel + dT));
    const tInner = Math.max(-wheelLimit, Math.min(wheelLimit, baseWheel - dT));
    const tRR = dir > 0 ? tOuter : tInner;
    const tRL = dir > 0 ? tInner : tOuter;
    out.s.push(ch.s[i]);
    out.mz.push(dir * bal.Mz);
    out.dFx.push(bal.dFx);
    out.wheelTorqueRL.push(tRL);
    out.wheelTorqueRR.push(tRR);
    out.peakOuterWheelTorque = Math.max(out.peakOuterWheelTorque, tOuter);
    out.peakInnerWheelTorque = Math.min(out.peakInnerWheelTorque, tInner);
    out.peakMz = Math.max(out.peakMz, Math.abs(bal.Mz));
  }
  return out;
}

export function analyzeTorqueVectoring(
  veh: VehicleParams,
  pt: PowertrainParams,
  track: Track,
  opts: TVAnalysisOptions = {},
): TVAnalysis {
  const integrator = opts.integrator ?? 'rk4';
  const vTop = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio) + 2;
  const ctxPM = createContext(veh, pt);
  const ctxOpen = createContext(veh, pt, buildTwoTrackEnvelope(veh, pt, vTop, 'open'));
  const ctxTV = createContext(veh, pt, buildTwoTrackEnvelope(veh, pt, vTop, 'tv'));
  const lapPM = simulateLap(track, ctxPM, { integrator });
  const lapOpen = simulateLap(track, ctxOpen, { integrator });
  const lapTV = simulateLap(track, ctxTV, { integrator });

  const corners = lapOpen.corners.map((c, k) => {
    const tvC = lapTV.corners[k];
    return {
      index: c.index,
      direction: c.direction,
      radius: c.apexRadius,
      apexOpen: c.minSpeed,
      apexTv: tvC ? tvC.minSpeed : c.minSpeed,
      gain: (tvC ? tvC.minSpeed : c.minSpeed) - c.minSpeed,
    };
  });

  // transient manoeuvres
  const vTest = opts.testSpeed ?? 15;
  const ayLimTV = steadyStateLateralLimit(veh, twoTrackLateralLimit(veh, pt, vTest, 'tv').ayMax, vTest);
  const controller: TVControllerParams = { ...defaultTVParams(veh, pt, ayLimTV), ...(opts.controller ?? {}) };
  const deg = Math.PI / 180;
  const stepSpec = { kind: 'step' as const, speed: vTest, steerFinal: (opts.stepSteerDeg ?? 3.5) * deg, steerStart: 0.1, duration: 1.6 };
  const stepOpen = simulateTransient(veh, pt, stepSpec, false, controller);
  const stepTV = simulateTransient(veh, pt, stepSpec, true, controller);
  const rampSpec = {
    kind: 'ramp' as const,
    speed: vTest,
    steerFinal: (opts.rampSteerDeg ?? 10) * deg,
    steerStart: 0.1,
    steerRiseTime: 8,
    duration: 8.1,
  };
  const rampOpen = simulateTransient(veh, pt, rampSpec, false, controller);
  const rampTV = simulateTransient(veh, pt, rampSpec, true, controller);

  const stepSeries = stepOpen.samples
    .map((p, i) => ({ t: p.t, rOpen: p.r, rTv: stepTV.samples[i]?.r ?? NaN, rRef: stepTV.samples[i]?.rRef ?? NaN, mz: stepTV.samples[i]?.mz ?? 0 }))
    .filter((_, i) => i % 2 === 0);
  const rampSeries = rampOpen.samples
    .map((p, i) => ({ steerDeg: p.steerDeg, ayOpen: p.ayG, ayTv: rampTV.samples[i]?.ayG ?? NaN }))
    .filter((_, i) => i % 20 === 0);
  const usSeries = [
    ...rampOpen.samples.filter((_, i) => i % 20 === 0).map((p) => ({ ayG: p.ayG, usOpen: p.understeerDeg })),
    ...rampTV.samples.filter((_, i) => i % 20 === 0).map((p) => ({ ayG: p.ayG, usTv: p.understeerDeg })),
  ].sort((x, y) => x.ayG - y.ayG);

  return {
    envelopeCurves: sampleEnvelopes(veh, pt, vTop - 2, 24),
    lap: {
      pointMass: lapPM.lapTime,
      open: lapOpen.lapTime,
      tv: lapTV.lapTime,
      deltaTv: lapTV.lapTime - lapOpen.lapTime,
      deltaPct: ((lapTV.lapTime - lapOpen.lapTime) / lapOpen.lapTime) * 100,
      energyOpenKWh: lapOpen.energy.netKWh,
      energyTvKWh: lapTV.energy.netKWh,
    },
    corners,
    step: { open: stepMetrics(stepOpen, stepSpec.steerStart), tv: stepMetrics(stepTV, stepSpec.steerStart), series: stepSeries },
    ramp: { open: rampMetrics(rampOpen), tv: rampMetrics(rampTV), series: rampSeries, usSeries },
    allocation: allocateAlongLap(veh, pt, lapTV),
    controller,
    testSpeed: vTest,
    tvLap: lapTV,
    openLap: lapOpen,
  };
}

export { maxDifferentialForce, GRAVITY };
