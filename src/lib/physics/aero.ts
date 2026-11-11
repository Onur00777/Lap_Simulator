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

export function parseAeroRideHeightSetup(text: string): AeroRideHeightSetup {
  const data: unknown = JSON.parse(text);
  if (data == null || typeof data !== 'object') throw new Error('The aero setup must be a JSON object.');
  const setup = data as AeroRideHeightSetup;
  const within = (value: unknown, low: number, high: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
  const axis = (values: unknown): values is number[] => Array.isArray(values) && values.length >= 2 && values.length <= 128 &&
    values.every((value, i) => within(value, 0, 2) && (i === 0 || value > values[i - 1]));
  const map = setup.map;
  if (!map || !axis(map.frontHeightsM) || !axis(map.rearHeightsM)) {
    throw new Error('Use ascending front and rear ride-height grids with 2–128 points per axis, in metres.');
  }
  const table = (value: unknown, max: number) => Array.isArray(value) && value.length === map.frontHeightsM.length &&
    value.every((row) => Array.isArray(row) && row.length === map.rearHeightsM.length && row.every((item) => within(item, 0, max)));
  if (!table(map.clA, 100) || !table(map.cdA, 100) || !table(map.frontFraction, 1)) {
    throw new Error('ClA, CdA and frontFraction tables must match both ride-height axes. Front fractions must be 0–1.');
  }
  if (!within(setup.staticFrontM, 0, 2) || !within(setup.staticRearM, 0, 2)
    || !within(setup.frontWheelRateNPerM, 1, 1e7) || !within(setup.rearWheelRateNPerM, 1, 1e7)) {
    throw new Error('Enter static ride heights in metres and positive wheel rates in N/m.');
  }
  return setup;
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
