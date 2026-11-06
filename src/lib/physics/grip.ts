import { interpUniform } from './numerics';
import { peakLateralForce, peakLongitudinalForce } from './tire';
import { downforce, GRAVITY, resistanceForce, wheelLoads, type VehicleParams } from './vehicle';

/**
 * Vehicle-level grip capacities derived from the Pacejka tire peaks evaluated at the
 * quasi-static wheel loads (static + aero + load transfer + camber modifier).
 */

/** Peak lateral force multiplier from static camber relative to nominal optimal camber. */
export function camberPeakFactor(camberDeg: number, nominalOptDeg: number): number {
  const d = camberDeg - nominalOptDeg;
  if (Math.abs(d) < 1e-6) return 1.0;
  return Math.max(0.85, Math.min(1.04, 1.0 - 0.008 * d * d - 0.003 * d));
}

/** Sum of peak lateral forces of all four tires at (v, ax, ay). */
export function totalLateralCapacity(veh: VehicleParams, v: number, ax: number, ay: number): number {
  const { front, rear } = axleLateralCapacity(veh, v, ax, ay);
  return front + rear;
}

/** Axle-wise lateral capacities (front, rear). */
export function axleLateralCapacity(veh: VehicleParams, v: number, ax: number, ay: number): { front: number; rear: number } {
  const L = wheelLoads(veh, v, ax, ay);
  const t = veh.tire;
  const kf = camberPeakFactor(veh.camberFront ?? -1.8, -1.8);
  const kr = camberPeakFactor(veh.camberRear ?? -1.2, -1.2);
  return {
    front: (peakLateralForce(t, L.fl) + peakLateralForce(t, L.fr)) * kf,
    rear: (peakLateralForce(t, L.rl) + peakLateralForce(t, L.rr)) * kr,
  };
}

/** Rear (driven) axle peak longitudinal force at (v, ax, ay). */
export function rearTractionCapacity(veh: VehicleParams, v: number, ax: number, ay: number): number {
  const L = wheelLoads(veh, v, ax, ay);
  return peakLongitudinalForce(veh.tire, L.rl) + peakLongitudinalForce(veh.tire, L.rr);
}

/** Four-wheel peak braking force at (v, ax, ay) — ideal brake balance assumed. */
export function totalBrakeCapacity(veh: VehicleParams, v: number, ax: number, ay: number): number {
  const L = wheelLoads(veh, v, ax, ay);
  const t = veh.tire;
  return (
    peakLongitudinalForce(t, L.fl) + peakLongitudinalForce(t, L.fr) + peakLongitudinalForce(t, L.rl) + peakLongitudinalForce(t, L.rr)
  );
}

/** Rear-axle share of vertical load while braking at deceleration `decel` (ideal brake distribution). */
export function rearBrakeShare(veh: VehicleParams, v: number, decel: number, ay: number): number {
  const L = wheelLoads(veh, v, -decel, ay);
  const tot = L.fl + L.fr + L.rl + L.rr;
  return tot > 0 ? (L.rl + L.rr) / tot : 0.5;
}

/**
 * Point-mass lateral limit ay_max(v): fixed point of ay = sum_i D_y(Fz_i(ay)) / m. The iteration
 * is a contraction because load sensitivity makes total grip a weakly decreasing function of ay.
 */
export function pointMassLateralLimit(veh: VehicleParams, v: number): number {
  let ay = veh.tire.lateral.a2 * GRAVITY;
  for (let k = 0; k < 60; k++) {
    const next = totalLateralCapacity(veh, v, 0, ay) / veh.mass;
    if (Math.abs(next - ay) < 1e-7) return next;
    ay = next;
  }
  return ay;
}

/** Effective friction coefficient implied by a lateral limit: mu = m ay / (m g + 0.5 rho ClA v^2). */
export function effectiveMu(veh: VehicleParams, v: number, ayMax: number): number {
  return (veh.mass * ayMax) / (veh.mass * GRAVITY + downforce(veh, v));
}

/**
 * Steady-state cornering limit at speed v. The driven rear axle must supply drag + rolling
 * resistance, which consumes part of the friction ellipse:
 *   ay_ss = ay_max * sqrt(1 - (F_res / Fx_max,rear)^2)
 */
export function steadyStateLateralLimit(veh: VehicleParams, ayMax: number, v: number): number {
  const Fres = resistanceForce(veh, v);
  let ay = ayMax;
  for (let k = 0; k < 40; k++) {
    const r = Math.min(1, Fres / Math.max(1e-6, rearTractionCapacity(veh, v, 0, ay)));
    const next = ayMax * Math.sqrt(1 - r * r);
    if (Math.abs(next - ay) < 1e-9) return next;
    ay = next;
  }
  return ay;
}

export type LateralModel = 'point-mass' | 'two-track-open' | 'two-track-tv';

/** Lateral acceleration capacity tabulated against speed. */
export interface LateralEnvelope {
  model: LateralModel;
  v0: number;
  dv: number;
  ayMax: number[];
  /** Optional direct-yaw-moment rear force split (N, outer minus inner / 2) at the limit. */
  dFxOpt?: number[];
}

export function buildPointMassEnvelope(veh: VehicleParams, vMax: number, dv = 0.5): LateralEnvelope {
  const n = Math.ceil(vMax / dv) + 2;
  const ayMax: number[] = [];
  for (let i = 0; i < n; i++) ayMax.push(pointMassLateralLimit(veh, i * dv));
  return { model: 'point-mass', v0: 0, dv, ayMax };
}

export function envelopeAyMax(env: LateralEnvelope, v: number): number {
  return interpUniform(env.v0, env.dv, env.ayMax, v);
}
