import { bilinear, clamp } from './numerics';

export interface AeroCoefficients {
  clA: number;
  cdA: number;
  frontFraction: number;
}

export interface RideHeightAeroMap {
  frontHeightsM: number[];
  rearHeightsM: number[];
  /** Rows represent front height, columns represent rear height. */
  clA: number[][];
  cdA: number[][];
  frontFraction: number[][];
}

export interface AeroRideHeightSetup {
  map: RideHeightAeroMap;
  staticFrontM: number;
  staticRearM: number;
  frontWheelRateNPerM: number;
  rearWheelRateNPerM: number;
}

export function sampleRideHeightAero(
  map: RideHeightAeroMap,
  frontHeightM: number,
  rearHeightM: number,
): AeroCoefficients {
  const sample = (values: number[][]) => bilinear(map.frontHeightsM, map.rearHeightsM, values, frontHeightM, rearHeightM);
  const frontFraction = clamp(sample(map.frontFraction), 0, 1);
  const clearanceLoss = clamp((0.02 - frontHeightM) / 0.02, 0, 1);
  // Blend the stall continuously from 20 mm to zero clearance and account for its rearward loss of suction.
  const frontScale = 1 - 0.25 * clearanceLoss;
  const rearScale = 1 - 0.70 * clearanceLoss;
  const totalScale = frontFraction * frontScale + (1 - frontFraction) * rearScale;
  return {
    clA: Math.max(0, sample(map.clA)) * totalScale,
    cdA: Math.max(0, sample(map.cdA)) * (1 + 0.18 * clearanceLoss),
    frontFraction: frontFraction * frontScale / totalScale,
  };
}

export function aerodynamicLoads(coefficients: AeroCoefficients, airDensity: number, speed: number, wheelbase: number) {
  const q = 0.5 * airDensity * speed * speed;
  return {
    downforceN: q * coefficients.clA,
    dragN: q * coefficients.cdA,
    frontFraction: coefficients.frontFraction,
    centerOfPressureFromFrontM: (1 - coefficients.frontFraction) * wheelbase,
  };
}
