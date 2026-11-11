import { clamp } from './numerics';
import { maxRegenForce, type EfficiencyMap, type PowertrainParams, type RegenBatteryState } from './powertrain';
import type { VehicleParams } from './vehicle';

const CORNERS = ['fl', 'fr', 'rl', 'rr'] as const;
export type BrakeCorners = Record<(typeof CORNERS)[number], number>;

export interface RotorParams {
  heatCapacityJPerK: number;
  surfaceAreaM2: number;
  emissivity: number;
  stillAirWPerM2K: number;
  speedCoolingWPerM2KPerMps: number;
  heatToRotorFraction: number;
}

export const DEFAULT_ROTOR: RotorParams = {
  heatCapacityJPerK: 650,
  surfaceAreaM2: 0.065,
  emissivity: 0.75,
  stillAirWPerM2K: 13,
  speedCoolingWPerM2KPerMps: 3.2,
  heatToRotorFraction: 0.88,
};

export function rotorFrictionScale(temperatureC: number): number {
  return 0.28 + 0.72 * Math.exp(-((Math.max(0, temperatureC - 550) / 155) ** 2));
}

/** Advance four independent rotor energy balances with implicit convection and radiation. */
export function stepBrakeRotors(
  state: BrakeCorners,
  hydraulicForceN: BrakeCorners,
  speedMps: number,
  ambientC: number,
  dt: number,
  rotor: RotorParams = DEFAULT_ROTOR,
): BrakeCorners {
  if (!(dt > 0)) return state;
  const speed = Math.abs(speedMps);
  const convection = rotor.surfaceAreaM2 * (rotor.stillAirWPerM2K + rotor.speedCoolingWPerM2KPerMps * speed);
  const radiation = rotor.surfaceAreaM2 * rotor.emissivity * 5.670374419e-8;
  const ambientK = ambientC + 273.15;
  const advance = (temperatureC: number, forceN: number) => {
    const initialK = temperatureC + 273.15;
    const heatW = Math.max(0, forceN) * speed * rotor.heatToRotorFraction;
    const adiabaticK = initialK + dt * heatW / rotor.heatCapacityJPerK;
    let lo = Math.min(initialK, ambientK);
    let hi = Math.max(ambientK, adiabaticK);
    for (let i = 0; i < 40; i++) {
      const t = (lo + hi) / 2;
      const heatLossW = convection * (t - ambientK) + radiation * (t ** 4 - ambientK ** 4);
      if (t + dt * heatLossW / rotor.heatCapacityJPerK > adiabaticK) hi = t;
      else lo = t;
    }
    return (lo + hi) / 2 - 273.15;
  };
  return {
    fl: advance(state.fl, hydraulicForceN.fl), fr: advance(state.fr, hydraulicForceN.fr),
    rl: advance(state.rl, hydraulicForceN.rl), rr: advance(state.rr, hydraulicForceN.rr),
  };
}

export interface BrakeBlendInput {
  requestedForceN: number;
  frontBias: number;
  speedMps: number;
  tireCapacityN: BrakeCorners;
  coldHydraulicCapacityN: BrakeCorners;
  rotorTemperaturesC: BrakeCorners;
  battery?: RegenBatteryState;
}

export function blendBraking(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, input: BrakeBlendInput) {
  const { tireCapacityN: grip, coldHydraulicCapacityN: cold, rotorTemperaturesC: rotor } = input;
  const demand = Math.max(0, input.requestedForceN);
  const bias = clamp(input.frontBias, 0, 1);
  const regenN = Math.max(0, Math.min(
    demand * (1 - bias), 2 * Math.min(grip.rl, grip.rr),
    maxRegenForce(veh, pt, map, input.speedMps, input.battery),
  ));
  const frontCap = [Math.min(grip.fl, cold.fl * rotorFrictionScale(rotor.fl)), Math.min(grip.fr, cold.fr * rotorFrictionScale(rotor.fr))];
  const rearCap = [Math.min(grip.rl - regenN / 2, cold.rl * rotorFrictionScale(rotor.rl)), Math.min(grip.rr - regenN / 2, cold.rr * rotorFrictionScale(rotor.rr))];
  const frontMax = frontCap[0] + frontCap[1];
  const rearMax = rearCap[0] + rearCap[1];
  const hydraulicDemand = Math.min(demand - regenN, frontMax + rearMax);
  const frontN = clamp(demand * bias, Math.max(0, hydraulicDemand - rearMax), Math.min(frontMax, hydraulicDemand));
  const rearN = hydraulicDemand - frontN;
  const fl = frontMax > 0 ? frontN * frontCap[0] / frontMax : 0;
  const rl = rearMax > 0 ? rearN * rearCap[0] / rearMax : 0;
  return {
    hydraulicN: { fl, fr: frontN - fl, rl, rr: rearN - rl },
    regenN,
    hydraulicFrontBias: hydraulicDemand > 0 ? frontN / hydraulicDemand : bias,
    unmetForceN: demand - regenN - hydraulicDemand,
  };
}
