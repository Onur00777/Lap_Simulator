import { blendBraking, stepBrakeRotors, type BrakeCorners } from '../physics/brakes';
import { totalBrakeCapacity } from '../physics/grip';
import { clamp } from '../physics/numerics';
import {
  combinedLateralScale, combinedTireForces, lateralCoefficients, longitudinalCoefficients,
  stepTireThermal, tireSlipPowerW, tireThermalGrip, type MFCoefficients,
} from '../physics/tire';
import type { TireTemperatures } from '../physics/types';
import type { SimulationContext } from './context';
import { packInternalResistance, packOpenCircuitVoltage } from './endurance-stint';
import type { LapResult } from './lap-simulator';

const CORNERS = ['fl', 'fr', 'rl', 'rr'] as const;
const cornerValues = (value: number): BrakeCorners => ({ fl: value, fr: value, rl: value, rr: value });

export interface ThermalReplayOptions {
  ambientC?: number;
  initialTireC?: number;
  initialRotorC?: number;
  initialSoc?: number;
  hydraulicFrontBias?: number;
  frontRotorTorqueNm?: number;
  rearRotorTorqueNm?: number;
}

/** Replay a solved speed trace to predict the effect of temperature on contact grip and brake allocation. */
export function replayLapThermals(lap: LapResult, ctx: SimulationContext, options: ThermalReplayOptions = {}) {
  const { veh, pt, map } = ctx;
  const ch = lap.channels;
  const ambient = options.ambientC ?? 25;
  const initialTireC = options.initialTireC ?? 80;
  const initialRotorC = options.initialRotorC ?? 100;
  const tires: Record<(typeof CORNERS)[number], TireTemperatures> = {
    fl: { coreC: initialTireC, surfaceC: initialTireC }, fr: { coreC: initialTireC, surfaceC: initialTireC },
    rl: { coreC: initialTireC, surfaceC: initialTireC }, rr: { coreC: initialTireC, surfaceC: initialTireC },
  };
  let rotors = cornerValues(initialRotorC);
  const frontCapacity = (options.frontRotorTorqueNm ?? 400) / veh.wheelRadius;
  const rearCapacity = (options.rearRotorTorqueNm ?? 320) / veh.wheelRadius;
  const hydraulicCapacity = { fl: frontCapacity, fr: frontCapacity, rl: rearCapacity, rr: rearCapacity };
  const maxChargeVoltage = packOpenCircuitVoltage(pt, 1);
  const maxChargeCurrent = pt.regenPowerLimit / Math.max(1, pt.batteryVoltage);
  const inverseSlip = (forceN: number, c: MFCoefficients, grip: number) => {
    if (c.B <= 0 || c.D <= 0) return 0;
    const normalized = clamp(forceN / (c.D * grip), -0.98, 0.98);
    return Math.tan(Math.asin(normalized) / c.C) / c.B;
  };

  const rows = ch.s.map((s, i) => {
    const t0 = ch.t[i];
    const dt = Math.max(0, (ch.t[i + 1] ?? lap.lapTime) - t0);
    const v = (ch.v[i] + (ch.v[i + 1] ?? (lap.closed ? ch.v[0] : ch.v[i]))) / 2;
    const fz = { fl: ch.fzFL[i], fr: ch.fzFR[i], rl: ch.fzRL[i], rr: ch.fzRR[i] };
    const lateralDemand = cornerValues(0);
    const tireCapacity = cornerValues(0);
    const longitudinal = cornerValues(0);
    const frictionBrake = ch.brake[i] > 0;
    let regenN = 0;
    let unmetBrakeN = 0;

    for (const corner of CORNERS) {
      const front = corner.startsWith('f');
      const axleLoad = front ? fz.fl + fz.fr : fz.rl + fz.rr;
      const axleDemand = veh.mass * ch.ay[i] * (front ? veh.frontWeightFraction : 1 - veh.frontWeightFraction);
      lateralDemand[corner] = axleLoad > 0 ? axleDemand * fz[corner] / axleLoad : 0;
      const grip = tireThermalGrip(tires[corner]);
      const x = longitudinalCoefficients(veh.tire, fz[corner]);
      const y = lateralCoefficients(veh.tire, fz[corner]);
      tireCapacity[corner] = x.D * grip * combinedLateralScale(lateralDemand[corner], y.D * grip);
    }

    let hydraulicN = cornerValues(0);
    if (frictionBrake && dt > 0) {
      const soc = clamp((options.initialSoc ?? 0.85) - ch.energyKWh[i] / Math.max(0.01, pt.batteryCapacityKWh), 0, 1);
      const blend = blendBraking(veh, pt, map, {
        requestedForceN: ch.brake[i] * totalBrakeCapacity(veh, v, -Math.abs(ch.ax[i]), ch.ay[i]),
        frontBias: options.hydraulicFrontBias ?? 0.55,
        speedMps: v, tireCapacityN: tireCapacity, coldHydraulicCapacityN: hydraulicCapacity,
        rotorTemperaturesC: rotors,
        battery: { openCircuitVoltage: packOpenCircuitVoltage(pt, soc), maxChargeVoltage, maxChargeCurrent,
          resistanceOhm: packInternalResistance(pt, ambient, soc) },
      });
      ({ hydraulicN, regenN, unmetForceN: unmetBrakeN } = blend);
      for (const corner of CORNERS) longitudinal[corner] = -(hydraulicN[corner] + (corner.startsWith('r') ? regenN / 2 : 0));
    } else if (ch.pWheelKW[i] > 0 && v > 0.5) {
      const rearGripN = tireCapacity.rl + tireCapacity.rr;
      const driveN = Math.min(ch.pWheelKW[i] * 1000 / v, rearGripN);
      if (rearGripN > 0) {
        longitudinal.rl = driveN * tireCapacity.rl / rearGripN;
        longitudinal.rr = driveN - longitudinal.rl;
      }
    }

    for (const corner of CORNERS) {
      const grip = tireThermalGrip(tires[corner]);
      const x = longitudinalCoefficients(veh.tire, fz[corner]);
      const y = lateralCoefficients(veh.tire, fz[corner]);
      const slipRatio = inverseSlip(longitudinal[corner], x, grip);
      const slipAngle = inverseSlip(lateralDemand[corner], y, grip);
      const camber = (corner.startsWith('f') ? veh.camberFront : veh.camberRear) * Math.PI / 180;
      const forces = combinedTireForces(veh.tire, slipRatio, slipAngle, fz[corner], corner.endsWith('l') ? camber : -camber, tires[corner]);
      tires[corner] = stepTireThermal(tires[corner], {
        ambientC: ambient, speedMps: v, slipPowerW: tireSlipPowerW(forces.fx, forces.fy, slipRatio * v, Math.tan(slipAngle) * v),
      }, dt);
    }
    rotors = stepBrakeRotors(rotors, hydraulicN, v, ambient, dt);
    return {
      s, t: t0 + dt, rotorFL: rotors.fl, rotorFR: rotors.fr, rotorRL: rotors.rl, rotorRR: rotors.rr,
      surfaceC: Math.max(...CORNERS.map((corner) => tires[corner].surfaceC)),
      coreC: Math.max(...CORNERS.map((corner) => tires[corner].coreC)),
      minTireGrip: Math.min(...CORNERS.map((corner) => tireThermalGrip(tires[corner]))),
      regenKW: regenN * v / 1000, unmetBrakeN,
    };
  });
  return { rows, tires, rotors };
}
