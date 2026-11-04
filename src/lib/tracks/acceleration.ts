import { clamp, rk4Step } from '../physics/numerics';
import { longitudinalCoefficients, longitudinalForce, peakSlip } from '../physics/tire';
import { lookupEfficiency, maxDrivePoint, type EfficiencyMap, type PowertrainParams } from '../physics/powertrain';
import { motorRpmFromSpeed, resistanceForce, wheelLoads, type VehicleParams } from '../physics/vehicle';
import { S, makeTrack, sampleSegments } from './geometry';
import type { Track } from './types';

export const ACCELERATION_LENGTH = 75;

export function buildAcceleration(ds = 0.25): Track {
  const geo = sampleSegments([S(ACCELERATION_LENGTH)], ds, false, { x: 0, y: 0, heading: 0 });
  return makeTrack(
    {
      id: 'acceleration',
      name: 'FS Acceleration',
      kind: 'acceleration',
      description: '75 m standing-start straight line',
      startSpeed: 0,
      sectors: [0, 25, 50, ACCELERATION_LENGTH],
    },
    geo,
    false,
  );
}

export interface LaunchOptions {
  tractionControl?: boolean;
  targetSlip?: number; // slip-ratio set point; default 90 % of the tire peak slip
  controlDt?: number; // VCU task period (s)
  substeps?: number; // RK4 plant sub-steps per control period
  distance?: number;
  /** FS rules: the car is staged with its front 0.30 m behind the start line; timing starts on crossing. */
  stagingOffset?: number;
  tMax?: number;
  kp?: number; // Nm per unit slip
  ki?: number; // Nm per (unit slip * s)
}

export interface LaunchSample {
  t: number;
  x: number;
  v: number;
  wheelSpeed: number; // rear wheel surface speed omega * r (m/s)
  slip: number;
  fx: number; // total rear tractive force (N)
  motorTorque: number; // per motor (Nm)
  torqueRequest: number; // driver request before TC (Nm)
  pElec: number; // W
  ax: number;
}

export interface LaunchResult {
  samples: LaunchSample[];
  /** Official timed run: start line (after the staging offset) to the 75 m finish line. */
  time75: number;
  /** Standing start from rest to 75 m of travel. */
  standingTime75: number;
  time0to100: number;
  trapSpeed: number; // m/s at the finish line
  peakSlip: number;
  targetSlip: number;
  energyKWh: number;
  peakPowerKW: number;
}

/**
 * Transient standing-start simulation, integrated with classical RK4.
 * State: [x, v, omega_rear]. Tire force from the Pacejka longitudinal curve on the slip ratio
 * kappa = (omega r - v) / max(v, v_eps). A discrete PI traction controller running at the VCU
 * task rate limits the slip to the set point.
 */
export function simulateLaunch(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, opts: LaunchOptions = {}): LaunchResult {
  const tc = opts.tractionControl ?? true;
  const staticRear = wheelLoads(veh, 0, 0, 0).rl;
  const kPeak = peakSlip(longitudinalCoefficients(veh.tire, staticRear));
  const target = opts.targetSlip ?? 0.9 * kPeak;
  const dtC = opts.controlDt ?? 0.001;
  const sub = opts.substeps ?? 5;
  const h = dtC / sub;
  const dist = opts.distance ?? ACCELERATION_LENGTH;
  const stage = opts.stagingOffset ?? 0.3;
  const tMax = opts.tMax ?? 8;
  const kp = opts.kp ?? 120;
  const ki = opts.ki ?? 2500;
  const vEps = 1.0;
  const r = veh.wheelRadius;
  const m = veh.mass;
  const J = veh.wheelInertia;
  const G = pt.gearRatio;
  const eta = pt.gearboxEfficiency;

  let axPrev = 0;
  let Tcmd = 0;
  let integ = pt.motorPeakTorque;

  const slipOf = (v: number, w: number) => (w * r - v) / Math.max(v, vEps);
  const tireFx = (v: number, w: number) => {
    const L = wheelLoads(veh, v, axPrev, 0);
    const k = slipOf(v, w);
    return longitudinalForce(veh.tire, k, L.rl) + longitudinalForce(veh.tire, k, L.rr);
  };
  // y = [x, v, omega]
  const f = (_t: number, y: readonly number[]) => {
    const v = y[1];
    const w = y[2];
    const Fx = tireFx(v, w);
    let a = (Fx - resistanceForce(veh, v)) / m;
    if (v <= 0 && a < 0) a = 0;
    const wDot = (Tcmd * G * eta - (Fx / 2) * r) / J;
    return [v, a, wDot];
  };

  let y = [0, 0, 0];
  let t = 0;
  const samples: LaunchSample[] = [];
  let time75 = NaN;
  let standing75 = NaN;
  let tStart = stage > 0 ? NaN : 0;
  let time100 = NaN;
  let trap = NaN;
  let energy = 0;
  let peakSlipSeen = 0;
  let peakP = 0;
  const v100 = 100 / 3.6;

  while (t < tMax) {
    const [, v, w] = y;
    const slip = slipOf(v, w);
    const drv = maxDrivePoint(veh, pt, map, Math.max(w * r, 0));
    const Treq = drv.motorTorque;
    if (tc) {
      const e = target - slip;
      integ = clamp(integ + ki * e * dtC, 0, pt.motorPeakTorque);
      const Ttc = integ + kp * e;
      if (Ttc > Treq) integ = Math.min(integ, Treq); // back-calculation anti-windup
      Tcmd = clamp(Math.min(Treq, Ttc), 0, pt.motorPeakTorque);
    } else {
      Tcmd = Treq;
    }
    const rpm = motorRpmFromSpeed(veh, Math.max(w * r, 0), G);
    const pMech = pt.motorCount * Tcmd * ((rpm * 2 * Math.PI) / 60);
    const pElec = pMech > 0 ? pMech / lookupEfficiency(map, rpm, Tcmd) : 0;
    const Fx = tireFx(v, w);
    const ax = (Fx - resistanceForce(veh, v)) / m;
    samples.push({ t, x: y[0], v, wheelSpeed: w * r, slip, fx: Fx, motorTorque: Tcmd, torqueRequest: Treq, pElec, ax });
    peakSlipSeen = Math.max(peakSlipSeen, slip);
    peakP = Math.max(peakP, pElec);

    const yPrev = y;
    const tPrev = t;
    for (let k = 0; k < sub; k++) {
      y = rk4Step(f, t, y, h);
      t += h;
    }
    axPrev = (y[1] - yPrev[1]) / dtC;
    energy += pElec * dtC;

    if (Number.isNaN(time100) && yPrev[1] < v100 && y[1] >= v100) {
      time100 = tPrev + ((v100 - yPrev[1]) / (y[1] - yPrev[1])) * dtC;
    }
    const crossing = (d: number) => tPrev + ((d - yPrev[0]) / (y[0] - yPrev[0])) * dtC;
    if (Number.isNaN(tStart) && yPrev[0] < stage && y[0] >= stage) tStart = crossing(stage);
    if (Number.isNaN(standing75) && yPrev[0] < dist && y[0] >= dist) standing75 = crossing(dist);
    if (yPrev[0] < dist + stage && y[0] >= dist + stage) {
      const frac = (dist + stage - yPrev[0]) / (y[0] - yPrev[0]);
      time75 = tPrev + frac * dtC - tStart;
      trap = yPrev[1] + frac * (y[1] - yPrev[1]);
      break;
    }
  }
  return {
    samples,
    time75,
    standingTime75: standing75,
    time0to100: time100,
    trapSpeed: trap,
    peakSlip: peakSlipSeen,
    targetSlip: target,
    energyKWh: energy / 3.6e6,
    peakPowerKW: peakP / 1000,
  };
}
