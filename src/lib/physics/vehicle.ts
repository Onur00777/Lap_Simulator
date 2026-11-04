import { DEFAULT_TIRE, type TireParams } from './tire';

export const GRAVITY = 9.81;

/**
 * Vehicle parameter registry. All values are SI (kg, m, N, s) unless the name says otherwise.
 */
export interface VehicleParams {
  name: string;
  mass: number; // kg, including driver
  frontWeightFraction: number; // static fraction of weight on the front axle
  wheelbase: number; // m
  trackWidth: number; // m
  cgHeight: number; // m
  ClA: number; // m^2, downforce coefficient x frontal area
  CdA: number; // m^2, drag coefficient x frontal area
  airDensity: number; // kg/m^3
  aeroBalanceFront: number; // fraction of downforce acting on the front axle
  rollingResistance: number; // Crr [-]
  wheelRadius: number; // m, loaded radius
  yawInertia: number; // kg m^2
  wheelInertia: number; // kg m^2 per driven wheel incl. reflected rotor + gearbox inertia
  rollStiffnessFront: number; // front share of lateral load transfer (LLTD)
  tire: TireParams;
}

export const DEFAULT_VEHICLE: VehicleParams = {
  name: 'ApexLapSim FS-EV (RWD dual motor)',
  mass: 230,
  frontWeightFraction: 0.47,
  wheelbase: 1.53,
  trackWidth: 1.2,
  cgHeight: 0.26,
  ClA: 3.2,
  CdA: 1.1,
  airDensity: 1.225,
  aeroBalanceFront: 0.45,
  rollingResistance: 0.015,
  wheelRadius: 0.2,
  yawInertia: 110,
  wheelInertia: 0.3,
  rollStiffnessFront: 0.55,
  tire: DEFAULT_TIRE,
};

/** Longitudinal CG location: a = CG to front axle, b = CG to rear axle. */
export function cgLocation(p: VehicleParams): { a: number; b: number } {
  const b = p.wheelbase * p.frontWeightFraction;
  return { a: p.wheelbase - b, b };
}

export function downforce(p: VehicleParams, v: number): number {
  return 0.5 * p.airDensity * p.ClA * v * v;
}

export function dragForce(p: VehicleParams, v: number): number {
  return 0.5 * p.airDensity * p.CdA * v * v;
}

export function rollingResistanceForce(p: VehicleParams, v: number): number {
  return p.rollingResistance * (p.mass * GRAVITY + downforce(p, v));
}

/** Total longitudinal resistance (aero drag + rolling resistance). */
export function resistanceForce(p: VehicleParams, v: number): number {
  return dragForce(p, v) + rollingResistanceForce(p, v);
}

export interface WheelLoads {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

/**
 * Quasi-static vertical wheel loads.
 *  - ax > 0 is acceleration (load moves rearwards), ay > 0 is a left turn (load moves to the right).
 *  - Lateral load transfer per axle: dFz = m * ay * h * share / t.
 * Loads are clamped at zero (wheel lift).
 */
export function wheelLoads(p: VehicleParams, v: number, ax: number, ay: number): WheelLoads {
  const W = p.mass * GRAVITY;
  const DF = downforce(p, v);
  const longTransfer = (p.mass * ax * p.cgHeight) / p.wheelbase;
  const front = W * p.frontWeightFraction + DF * p.aeroBalanceFront - longTransfer;
  const rear = W * (1 - p.frontWeightFraction) + DF * (1 - p.aeroBalanceFront) + longTransfer;
  const latTotal = (p.mass * ay * p.cgHeight) / p.trackWidth;
  const dF = latTotal * p.rollStiffnessFront;
  const dR = latTotal * (1 - p.rollStiffnessFront);
  return {
    fl: Math.max(0, front / 2 - dF),
    fr: Math.max(0, front / 2 + dF),
    rl: Math.max(0, rear / 2 - dR),
    rr: Math.max(0, rear / 2 + dR),
  };
}

/** Top speed limited by the motor speed ceiling (single-speed reduction). */
export function speedFromMotorRpm(p: VehicleParams, rpm: number, gearRatio: number): number {
  return ((rpm * 2 * Math.PI) / 60 / gearRatio) * p.wheelRadius;
}

export function motorRpmFromSpeed(p: VehicleParams, v: number, gearRatio: number): number {
  return ((v / p.wheelRadius) * gearRatio * 60) / (2 * Math.PI);
}

export function cloneVehicle(p: VehicleParams, patch: Partial<VehicleParams> = {}): VehicleParams {
  return { ...p, ...patch, tire: patch.tire ? { ...p.tire, ...patch.tire } : p.tire };
}
