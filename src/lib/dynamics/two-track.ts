import {
  cgLocation,
  combinedLateralScale,
  GRAVITY,
  goldenMax,
  peakLateralForce,
  peakLongitudinalForce,
  pointMassLateralLimit,
  wheelLoads,
  type LateralEnvelope,
  type PowertrainParams,
  type VehicleParams,
} from '../physics';

/**
 * Steady-state two-track (4-wheel) cornering balance.
 *
 * In steady cornering the axle lateral forces must satisfy force and yaw-moment equilibrium:
 *     Fy_f + Fy_r = m ay
 *     a Fy_f - b Fy_r + Mz = 0
 *  => Fy_f = (m ay b - Mz) / L,   Fy_r = (m ay a + Mz) / L
 * where Mz = dFx * t is the direct yaw moment produced by a differential rear force split
 * (outer wheel +dFx, inner wheel -dFx). Each rear tire's lateral capacity shrinks on the friction
 * ellipse:  Fy_max,i * sqrt(1 - (Fx_i / Fx_max,i)^2).
 *
 *  - Open differential: dFx = 0 -> the first axle to saturate limits ay (here: the front, due to
 *    the front-biased lateral load transfer distribution).
 *  - Torque vectoring: dFx is chosen to minimise the worst axle utilisation (minimax), which
 *    re-balances the axles and raises the achievable lateral acceleration.
 */

export type DiffMode = 'open' | 'tv';

export interface AxleBalance {
  ay: number;
  dFx: number; // N, per-wheel differential force (outer +, inner -)
  Mz: number; // Nm direct yaw moment
  frontUtil: number;
  rearUtil: number;
  maxUtil: number;
}

/** Per-wheel differential force limit from the motor torque ceiling. */
export function maxDifferentialForce(veh: VehicleParams, pt: PowertrainParams): number {
  return (pt.motorPeakTorque * pt.gearRatio * pt.gearboxEfficiency) / veh.wheelRadius;
}

function utilisation(veh: VehicleParams, v: number, ay: number, dFx: number): { uf: number; ur: number } {
  const { a, b } = cgLocation(veh);
  const L = veh.wheelbase;
  const W = wheelLoads(veh, v, 0, ay);
  const t = veh.tire;
  const Cf = peakLateralForce(t, W.fl) + peakLateralForce(t, W.fr);
  // ay > 0 : left turn, outer = right wheel (rr)
  const outer = W.rr;
  const inner = W.rl;
  const Cr =
    peakLateralForce(t, outer) * combinedLateralScale(dFx, peakLongitudinalForce(t, outer)) +
    peakLateralForce(t, inner) * combinedLateralScale(-dFx, peakLongitudinalForce(t, inner));
  const Mz = dFx * veh.trackWidth;
  const Fyf = (veh.mass * ay * b - Mz) / L;
  const Fyr = (veh.mass * ay * a + Mz) / L;
  return { uf: Cf > 0 ? Fyf / Cf : Infinity, ur: Cr > 0 ? Fyr / Cr : Infinity };
}

/** Axle utilisation at (v, ay) for the given differential mode, with the optimal dFx for TV. */
export function axleBalance(veh: VehicleParams, pt: PowertrainParams, v: number, ay: number, mode: DiffMode): AxleBalance {
  if (mode === 'open') {
    const { uf, ur } = utilisation(veh, v, ay, 0);
    return { ay, dFx: 0, Mz: 0, frontUtil: uf, rearUtil: ur, maxUtil: Math.max(uf, ur) };
  }
  const lim = maxDifferentialForce(veh, pt);
  const cost = (d: number) => {
    const { uf, ur } = utilisation(veh, v, ay, d);
    return -Math.max(uf, ur);
  };
  const best = goldenMax(cost, -lim, lim, 1e-3, 80);
  const { uf, ur } = utilisation(veh, v, ay, best.x);
  return { ay, dFx: best.x, Mz: best.x * veh.trackWidth, frontUtil: uf, rearUtil: ur, maxUtil: Math.max(uf, ur) };
}

/** Maximum steady-state lateral acceleration of the 2-track model at speed v. */
export function twoTrackLateralLimit(
  veh: VehicleParams,
  pt: PowertrainParams,
  v: number,
  mode: DiffMode,
): { ayMax: number; balance: AxleBalance } {
  let lo = 0;
  let hi = pointMassLateralLimit(veh, v) * 1.0001;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    if (axleBalance(veh, pt, v, mid, mode).maxUtil <= 1) lo = mid;
    else hi = mid;
  }
  return { ayMax: lo, balance: axleBalance(veh, pt, v, lo, mode) };
}

export function buildTwoTrackEnvelope(
  veh: VehicleParams,
  pt: PowertrainParams,
  vMax: number,
  mode: DiffMode,
  dv = 0.5,
): LateralEnvelope {
  const n = Math.ceil(vMax / dv) + 2;
  const ayMax: number[] = [];
  const dFxOpt: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = twoTrackLateralLimit(veh, pt, i * dv, mode);
    ayMax.push(r.ayMax);
    dFxOpt.push(r.balance.dFx);
  }
  return { model: mode === 'open' ? 'two-track-open' : 'two-track-tv', v0: 0, dv, ayMax, dFxOpt };
}

/** Lateral limit comparison curves for plotting (g units). */
export function sampleEnvelopes(veh: VehicleParams, pt: PowertrainParams, vMax: number, n = 30) {
  const out: { v: number; kph: number; pointMass: number; open: number; tv: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const v = 1 + ((vMax - 1) * i) / n;
    out.push({
      v,
      kph: v * 3.6,
      pointMass: pointMassLateralLimit(veh, v) / GRAVITY,
      open: twoTrackLateralLimit(veh, pt, v, 'open').ayMax / GRAVITY,
      tv: twoTrackLateralLimit(veh, pt, v, 'tv').ayMax / GRAVITY,
    });
  }
  return out;
}
