import {
  cgLocation,
  clamp,
  combinedLateralScale,
  dragForce,
  GRAVITY,
  lateralForce,
  peakLongitudinalForce,
  rk4Step,
  rollingResistanceForce,
  wheelLoads,
  type PowertrainParams,
  type VehicleParams,
} from '../physics';
import { tvInitialState, tvStep, yawRateTarget, type TVControllerParams } from './yaw-controller';

/**
 * Transient nonlinear two-track model (planar, 3 DOF + load-transfer lag), integrated with RK4.
 *
 * States: [vx, vy, r, ay_f, ax_f]
 *   m (vx' - r vy) = sum Fx_body - F_drag - F_roll
 *   m (vy' + r vx) = sum Fy_body
 *   Izz r'          = sum (x_i Fy_i - y_i Fx_i)
 *   tau ay_f'       = ay - ay_f      (roll / pitch dynamics lag of the load transfer)
 * Tire forces: Pacejka lateral curve at each wheel's slip angle and vertical load, rear lateral
 * force reduced on the friction ellipse by the motor-driven longitudinal force.
 * The VCU (speed-hold + optional torque vectoring PI) runs as a discrete task at `ctrl.dt`.
 */

export interface ManeuverSpec {
  kind: 'step' | 'ramp';
  speed: number; // m/s, held by a longitudinal speed controller
  steerFinal: number; // rad, road-wheel angle
  steerStart?: number; // s, start of the steering input
  steerRiseTime?: number; // s, step: steering ramp-in time; ramp: total ramp duration
  duration: number; // s
}

export interface TransientSample {
  t: number;
  vx: number;
  vy: number;
  r: number;
  rRef: number;
  ay: number;
  ayG: number;
  betaDeg: number;
  steerDeg: number;
  mz: number;
  torqueRL: number;
  torqueRR: number;
  understeerDeg: number; // delta - L r / vx
}

export interface TransientResult {
  samples: TransientSample[];
  tv: boolean;
}

const LOAD_TAU = 0.05;

export function simulateTransient(
  veh: VehicleParams,
  pt: PowertrainParams,
  spec: ManeuverSpec,
  tvEnabled: boolean,
  ctrl: TVControllerParams,
): TransientResult {
  const { a, b } = cgLocation(veh);
  const tw = veh.trackWidth;
  const m = veh.mass;
  const pos = {
    fl: [a, tw / 2],
    fr: [a, -tw / 2],
    rl: [-b, tw / 2],
    rr: [-b, -tw / 2],
  } as const;
  const toForce = (T: number) => (T * pt.gearRatio * pt.gearboxEfficiency) / veh.wheelRadius;
  const t0 = spec.steerStart ?? 0.1;
  const rise = spec.steerRiseTime ?? (spec.kind === 'step' ? 0.08 : spec.duration - t0);
  const steerAt = (t: number) => {
    if (t <= t0) return 0;
    return spec.steerFinal * Math.min(1, (t - t0) / rise);
  };

  let steer = 0;
  let tRL = 0;
  let tRR = 0;

  const forces = (y: readonly number[]) => {
    const [vx, vy, r, ayF, axF] = y;
    const W = wheelLoads(veh, vx, axF, ayF);
    const wheel = (key: 'fl' | 'fr' | 'rl' | 'rr', delta: number, Fx: number, Fz: number) => {
      const [xi, yi] = pos[key];
      const u = vx - r * yi;
      const w = vy + r * xi;
      const alpha = delta - Math.atan2(w, Math.max(u, 0.1));
      const FxMax = peakLongitudinalForce(veh.tire, Fz);
      const FxC = clamp(Fx, -0.98 * FxMax, 0.98 * FxMax); // traction control / ABS clamp
      const Fy = lateralForce(veh.tire, alpha, Fz) * combinedLateralScale(FxC, FxMax);
      const c = Math.cos(delta);
      const s = Math.sin(delta);
      const Fxb = FxC * c - Fy * s;
      const Fyb = FxC * s + Fy * c;
      return { Fxb, Fyb, Mz: xi * Fyb - yi * Fxb };
    };
    const fl = wheel('fl', steer, 0, W.fl);
    const fr = wheel('fr', steer, 0, W.fr);
    const rl = wheel('rl', 0, toForce(tRL), W.rl);
    const rr = wheel('rr', 0, toForce(tRR), W.rr);
    const Fx = fl.Fxb + fr.Fxb + rl.Fxb + rr.Fxb - dragForce(veh, vx) - rollingResistanceForce(veh, vx);
    const Fy = fl.Fyb + fr.Fyb + rl.Fyb + rr.Fyb;
    const Mz = fl.Mz + fr.Mz + rl.Mz + rr.Mz;
    return { ax: Fx / m, ay: Fy / m, Mz };
  };

  const deriv = (_t: number, y: readonly number[]) => {
    const [vx, vy, r, ayF, axF] = y;
    const F = forces(y);
    return [F.ax + r * vy, F.ay - r * vx, F.Mz / veh.yawInertia, (F.ay - ayF) / LOAD_TAU, (F.ax - axF) / LOAD_TAU];
  };

  const dt = ctrl.dt;
  const sub = 2;
  let y = [spec.speed, 0, 0, 0, 0];
  const state = tvInitialState();
  const samples: TransientSample[] = [];
  const steps = Math.round(spec.duration / dt);
  for (let k = 0; k <= steps; k++) {
    const t = k * dt;
    steer = steerAt(t);
    const [vx, vy, r] = y;
    // longitudinal speed hold: feed-forward resistance + proportional speed error
    const Fdem = dragForce(veh, vx) + rollingResistanceForce(veh, vx) + m * 3.0 * (spec.speed - vx);
    const Treq = clamp((Fdem * veh.wheelRadius) / (pt.gearRatio * pt.gearboxEfficiency), -2 * pt.motorPeakTorque, 2 * pt.motorPeakTorque);
    let mz = 0;
    let rRef = yawRateTarget(ctrl, vx, steer);
    if (tvEnabled) {
      const out = tvStep(ctrl, state, { vx, steer, yawRate: r, torqueRequest: Treq });
      tRL = out.torqueRL;
      tRR = out.torqueRR;
      mz = out.mz;
      rRef = out.yawRateRef;
    } else {
      tRL = tRR = 0.5 * Treq;
    }
    const ay = forces(y).ay;
    if (k % 5 === 0) {
      samples.push({
        t,
        vx,
        vy,
        r,
        rRef,
        ay,
        ayG: ay / GRAVITY,
        betaDeg: (Math.atan2(vy, vx) * 180) / Math.PI,
        steerDeg: (steer * 180) / Math.PI,
        mz,
        torqueRL: tRL,
        torqueRR: tRR,
        understeerDeg: ((steer - (veh.wheelbase * r) / Math.max(vx, 0.1)) * 180) / Math.PI,
      });
    }
    for (let j = 0; j < sub; j++) y = rk4Step(deriv, t + (j * dt) / sub, y, dt / sub);
  }
  return { samples, tv: tvEnabled };
}

export interface StepMetrics {
  yawRateSteady: number; // rad/s
  ayGSteady: number;
  riseTime: number; // s, 10 % -> 90 % of steady yaw rate
  delay50: number; // s, steering onset -> 50 % yaw rate
  overshootPct: number;
  betaSteadyDeg: number;
}

export function stepMetrics(res: TransientResult, steerStart: number): StepMetrics {
  const s = res.samples;
  const tEnd = s[s.length - 1].t;
  const tail = s.filter((p) => p.t > tEnd - 0.3);
  const rss = tail.reduce((acc, p) => acc + p.r, 0) / tail.length;
  const crossing = (level: number) => {
    for (let i = 1; i < s.length; i++) {
      if (s[i - 1].r < level && s[i].r >= level) {
        return s[i - 1].t + ((level - s[i - 1].r) / (s[i].r - s[i - 1].r)) * (s[i].t - s[i - 1].t);
      }
    }
    return NaN;
  };
  const t10 = crossing(0.1 * rss);
  const t50 = crossing(0.5 * rss);
  const t90 = crossing(0.9 * rss);
  const rMax = Math.max(...s.map((p) => p.r));
  return {
    yawRateSteady: rss,
    ayGSteady: tail.reduce((acc, p) => acc + p.ayG, 0) / tail.length,
    riseTime: t90 - t10,
    delay50: t50 - steerStart,
    overshootPct: Math.max(0, (rMax / rss - 1) * 100),
    betaSteadyDeg: tail.reduce((acc, p) => acc + p.betaDeg, 0) / tail.length,
  };
}

export interface RampMetrics {
  understeerGradientDegPerG: number; // linear-range slope of (delta - L r / v) vs ay (0.2-0.8 g)
  limitGradientDegPerG: number; // near-limit (mid-corner) slope, 0.8-1.5 g
  maxAyG: number;
  understeerAtLimitDeg: number;
}

function understeerSlope(res: TransientResult, lo: number, hi: number): number {
  const pts = res.samples.filter((p) => p.ayG >= lo && p.ayG <= hi);
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sx += p.ayG;
    sy += p.understeerDeg;
    sxx += p.ayG * p.ayG;
    sxy += p.ayG * p.understeerDeg;
  }
  const n = pts.length;
  return n > 2 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : NaN;
}

export function rampMetrics(res: TransientResult): RampMetrics {
  let maxAy = 0;
  let usAtMax = 0;
  for (const p of res.samples) {
    if (p.ayG > maxAy) {
      maxAy = p.ayG;
      usAtMax = p.understeerDeg;
    }
  }
  return {
    understeerGradientDegPerG: understeerSlope(res, 0.2, 0.8),
    limitGradientDegPerG: understeerSlope(res, 0.8, Math.min(1.5, 0.95 * maxAy)),
    maxAyG: maxAy,
    understeerAtLimitDeg: usAtMax,
  };
}
