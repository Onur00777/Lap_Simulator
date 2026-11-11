import type { TireTemperatures, TireThermalInput, TireThermalParams } from './types';

/**
 * Pacejka pure-slip curves with a slip-vector coupling for combined forces.
 *
 *   Y(x) = D sin( C atan( B x - E (B x - atan(B x)) ) ) + Sv,   x = slip + Sh
 *
 * Lateral   (x = slip angle alpha [rad]):
 *   C = a0
 *   D = (a1 Fz + a2) Fz                  -> mu_y(Fz) = a1 Fz + a2   (load sensitivity, Fz in kN)
 *   BCD = a3 sin(2 atan(Fz / a4))        -> cornering stiffness [N/rad]
 *   E = a6 Fz + a7
 *
 * Longitudinal (x = slip ratio kappa [-]):
 *   C = b0
 *   D = (b1 Fz + b2) Fz
 *   BCD = (b3 Fz^2 + b4 Fz) exp(-b5 Fz)  -> slip stiffness [N/unit slip]
 *   E = b6 Fz^2 + b7 Fz + b8
 *
 * Fz is converted to kN inside the coefficient expressions; D is returned in N.
 * `lambdaMu` is the usual road-surface scaling between TTC rig data and track asphalt.
 */

export interface PacejkaLateral {
  a0: number; // shape factor C
  a1: number; // load sensitivity of mu [1/kN]
  a2: number; // mu at zero load [-]
  a3: number; // max cornering stiffness [N/rad]
  a4: number; // load at max cornering stiffness [kN]
  a6: number; // curvature factor E, load dependency [1/kN]
  a7: number; // curvature factor E, constant [-]
  sh: number; // horizontal shift [rad]
  sv: number; // vertical shift [N]
}

export interface PacejkaLongitudinal {
  b0: number;
  b1: number; // [1/kN]
  b2: number; // [-]
  b3: number; // [N/kN^2]
  b4: number; // [N/kN]
  b5: number; // [1/kN]
  b6: number;
  b7: number;
  b8: number;
}

export interface TireParams {
  name: string;
  lateral: PacejkaLateral;
  longitudinal: PacejkaLongitudinal;
  lambdaMu: number; // road friction scaling
  muFloor: number; // minimum friction coefficient (guards extreme loads)
  nominalLoad: number; // N, reference load for reporting
  camberThrustPerRad?: number; // lateral friction increment per radian of camber
  pneumaticTrailM?: number; // low-slip trail at nominal load [m]
}

/** 16x7.5-10 FS racing slick, coefficients fitted to typical TTC round 8 trends. */
export const DEFAULT_TIRE: TireParams = {
  name: 'FS Slick 16x7.5-10 (R25B-class)',
  lateral: {
    a0: 1.45,
    a1: -0.2,
    a2: 1.7,
    a3: 22000,
    a4: 1.0,
    a6: -0.15,
    a7: -0.25,
    sh: 0,
    sv: 0,
  },
  longitudinal: {
    b0: 1.65,
    b1: -0.18,
    b2: 1.8,
    b3: 0,
    b4: 28000,
    b5: 0.1,
    b6: 0,
    b7: -0.1,
    b8: 0,
  },
  lambdaMu: 1.0,
  muFloor: 0.4,
  nominalLoad: 750,
  camberThrustPerRad: 0.7,
  pneumaticTrailM: 0.028,
};

/** Reference thermal capacities and conductances for one Formula Student slick. */
export const DEFAULT_TIRE_THERMAL: TireThermalParams = {
  coreCapacityJPerK: 4800,
  surfaceCapacityJPerK: 220,
  coreSurfaceConductanceWPerK: 22,
  coreCoolingWPerK: 2,
  surfaceCoolingWPerK: 8,
  speedCoolingWPerKPerMps: 0.65,
  slipHeatFraction: 0.82,
};

/** Inelastic contact work per second, using tire-frame slip velocities [m/s]. */
export function tireSlipPowerW(fx: number, fy: number, slipVx: number, slipVy: number): number {
  return Math.abs(fx * slipVx) + Math.abs(fy * slipVy);
}

/** Backward Euler on the two coupled thermal balances, conserving the heat exchanged between nodes. */
export function stepTireThermal(
  state: TireTemperatures,
  input: TireThermalInput,
  dt: number,
  params: TireThermalParams = DEFAULT_TIRE_THERMAL,
): TireTemperatures {
  if (!(dt > 0)) return state;
  const { ambientC, speedMps, slipPowerW } = input;
  const coupling = params.coreSurfaceConductanceWPerK;
  const surfaceCooling = params.surfaceCoolingWPerK + params.speedCoolingWPerKPerMps * Math.abs(speedMps);
  const coreInertia = params.coreCapacityJPerK / dt;
  const surfaceInertia = params.surfaceCapacityJPerK / dt;
  const a = coreInertia + coupling + params.coreCoolingWPerK;
  const d = surfaceInertia + coupling + surfaceCooling;
  const core = coreInertia * (state.coreC - ambientC);
  const surface = surfaceInertia * (state.surfaceC - ambientC) + Math.max(0, slipPowerW) * params.slipHeatFraction;
  const determinant = a * d - coupling * coupling;

  return {
    coreC: ambientC + (d * core + coupling * surface) / determinant,
    surfaceC: ambientC + (a * surface + coupling * core) / determinant,
  };
}

/** Temperature scale with a 75–95 °C working window and steeper hot-side falloff. */
export function tireThermalGrip(temperature: TireTemperatures): number {
  const effectiveC = 0.85 * temperature.surfaceC + 0.15 * temperature.coreC;
  const deviation = effectiveC < 75 ? (75 - effectiveC) / 53 : Math.max(0, effectiveC - 95) / 18;
  return 0.34 + 0.66 * Math.exp(-deviation * deviation);
}

/** The Magic Formula kernel. */
export function magicFormula(x: number, B: number, C: number, D: number, E: number): number {
  const Bx = B * x;
  return D * Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
}

export interface MFCoefficients {
  B: number;
  C: number;
  D: number;
  E: number;
}

/** Load-dependent lateral friction coefficient mu_y(Fz). */
export function muLateral(tire: TireParams, Fz: number): number {
  const fz = Math.max(Fz, 0) / 1000;
  const p = tire.lateral;
  return Math.max(tire.muFloor, (p.a1 * fz + p.a2) * tire.lambdaMu);
}

/** Load-dependent longitudinal friction coefficient mu_x(Fz). */
export function muLongitudinal(tire: TireParams, Fz: number): number {
  const fz = Math.max(Fz, 0) / 1000;
  const p = tire.longitudinal;
  return Math.max(tire.muFloor, (p.b1 * fz + p.b2) * tire.lambdaMu);
}

export function lateralCoefficients(tire: TireParams, Fz: number): MFCoefficients {
  const p = tire.lateral;
  const fz = Math.max(Fz, 1e-3) / 1000;
  const C = p.a0;
  const D = muLateral(tire, Fz) * Math.max(Fz, 0);
  const BCD = p.a3 * Math.sin(2 * Math.atan(fz / p.a4));
  const B = D > 1e-9 ? BCD / (C * D) : 0;
  const E = Math.min(1, p.a6 * fz + p.a7);
  return { B, C, D, E };
}

export function longitudinalCoefficients(tire: TireParams, Fz: number): MFCoefficients {
  const p = tire.longitudinal;
  const fz = Math.max(Fz, 1e-3) / 1000;
  const C = p.b0;
  const D = muLongitudinal(tire, Fz) * Math.max(Fz, 0);
  const BCD = (p.b3 * fz * fz + p.b4 * fz) * Math.exp(-p.b5 * fz);
  const B = D > 1e-9 ? BCD / (C * D) : 0;
  const E = Math.min(1, p.b6 * fz * fz + p.b7 * fz + p.b8);
  return { B, C, D, E };
}

/** Pure-slip lateral force Fy [N] for slip angle alpha [rad] and vertical load Fz [N]. */
export function lateralForce(tire: TireParams, alpha: number, Fz: number): number {
  if (Fz <= 0) return 0;
  const { B, C, D, E } = lateralCoefficients(tire, Fz);
  return magicFormula(alpha + tire.lateral.sh, B, C, D, E) + tire.lateral.sv;
}

/** Pure-slip longitudinal force Fx [N] for slip ratio kappa [-] and vertical load Fz [N]. */
export function longitudinalForce(tire: TireParams, kappa: number, Fz: number): number {
  if (Fz <= 0) return 0;
  const { B, C, D, E } = longitudinalCoefficients(tire, Fz);
  return magicFormula(kappa, B, C, D, E);
}

export interface TireContactForces {
  fx: number; // longitudinal force [N]
  fy: number; // lateral force [N]
  mz: number; // aligning moment about the contact patch [Nm]
}

/** Combined-slip Magic Formula using the brief's cosine/sine slip-vector weights. */
export function combinedTireForces(
  tire: TireParams,
  slipRatio: number,
  slipAngleRad: number,
  verticalLoadN: number,
  camberRad = 0,
  temperatures?: TireTemperatures,
): TireContactForces {
  if (verticalLoadN <= 0) return { fx: 0, fy: 0, mz: 0 };

  const x = longitudinalCoefficients(tire, verticalLoadN);
  const y = lateralCoefficients(tire, verticalLoadN);
  const thermalGrip = temperatures ? tireThermalGrip(temperatures) : 1;
  x.D *= thermalGrip;
  y.D *= thermalGrip;
  // Scale each slip by its curve's slope so small combined slips recover the pure-slip stiffnesses.
  const sx = x.B * slipRatio;
  const sy = y.B * (slipAngleRad + tire.lateral.sh);
  const slip = Math.hypot(sx, sy);
  const wx = slip > 0 ? sx / slip : 0;
  const wy = slip > 0 ? sy / slip : 0;
  const fx = wx * magicFormula(slip, 1, x.C, x.D, x.E);
  const lateralSlipForce = wy * magicFormula(slip, 1, y.C, y.D, y.E);
  const camberThrust = (tire.camberThrustPerRad ?? 0) * camberRad * verticalLoadN;
  const remainingLateral = y.D * combinedLateralScale(fx, x.D);
  const fy = Math.max(-remainingLateral, Math.min(remainingLateral, lateralSlipForce + camberThrust + tire.lateral.sv));
  const trail = (tire.pneumaticTrailM ?? 0) * Math.sqrt(tire.nominalLoad / Math.max(tire.nominalLoad, verticalLoadN));
  const aligningTrail = trail / (1 + slip * slip);
  return { fx, fy, mz: -aligningTrail * fy };
}

/** Peak (saturated) lateral force, i.e. the D coefficient. */
export function peakLateralForce(tire: TireParams, Fz: number): number {
  return Fz <= 0 ? 0 : muLateral(tire, Fz) * Fz;
}

/** Peak longitudinal force. */
export function peakLongitudinalForce(tire: TireParams, Fz: number): number {
  return Fz <= 0 ? 0 : muLongitudinal(tire, Fz) * Fz;
}

/**
 * Slip value at which the Magic Formula reaches its peak. With E < 1 the peak satisfies
 * C * atan(Bx - E(Bx - atan(Bx))) = pi/2; solved here by bisection on the inner argument.
 */
export function peakSlip({ B, C, E }: MFCoefficients): number {
  if (B <= 0 || C <= 1) return Infinity;
  const target = Math.tan(Math.PI / (2 * C));
  const g = (x: number) => {
    const Bx = B * x;
    return Bx - E * (Bx - Math.atan(Bx)) - target;
  };
  let lo = 0;
  let hi = 1;
  while (g(hi) < 0 && hi < 100) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Combined slip by the friction ellipse: given an applied longitudinal force Fx, the remaining
 * lateral capacity is scaled by sqrt(1 - (Fx / Fx_max)^2).
 */
export function combinedLateralScale(Fx: number, FxMax: number): number {
  if (FxMax <= 0) return 0;
  const r = Fx / FxMax;
  return r >= 1 || r <= -1 ? 0 : Math.sqrt(1 - r * r);
}

/** Lateral force under combined slip (friction ellipse weighting of the pure-slip curve). */
export function combinedLateralForce(tire: TireParams, alpha: number, Fz: number, Fx: number): number {
  return lateralForce(tire, alpha, Fz) * combinedLateralScale(Fx, peakLongitudinalForce(tire, Fz));
}

/**
 * Inverse of the lateral curve on its stable (pre-peak) branch: the slip angle that produces
 * the requested lateral force. Saturates at the peak slip angle when |Fy| >= D.
 */
export function slipAngleForForce(tire: TireParams, Fy: number, Fz: number): number {
  const coeffs = lateralCoefficients(tire, Fz);
  const aPeak = peakSlip(coeffs);
  const sign = Math.sign(Fy) || 1;
  const target = Math.abs(Fy);
  if (target >= coeffs.D) return sign * aPeak;
  let lo = 0;
  let hi = aPeak;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (magicFormula(mid, coeffs.B, coeffs.C, coeffs.D, coeffs.E) < target) lo = mid;
    else hi = mid;
  }
  return sign * 0.5 * (lo + hi);
}

/** Sample a force-slip curve for plotting. */
export function sampleLateralCurve(tire: TireParams, Fz: number, alphaMaxDeg = 15, n = 61) {
  const out: { alphaDeg: number; Fy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const deg = -alphaMaxDeg + (2 * alphaMaxDeg * i) / (n - 1);
    out.push({ alphaDeg: deg, Fy: lateralForce(tire, (deg * Math.PI) / 180, Fz) });
  }
  return out;
}
