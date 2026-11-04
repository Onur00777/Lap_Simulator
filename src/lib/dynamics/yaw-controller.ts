import { clamp } from '../physics/numerics';
import type { PowertrainParams } from '../physics/powertrain';
import type { VehicleParams } from '../physics/vehicle';

/**
 * Direct yaw moment control (DYC) for a dual rear-motor car.
 *
 * Reference: the steady-state yaw rate of a vehicle with the target understeer gradient K_us,
 *     r_ref = v * delta / (L + K_us * v^2),
 * saturated at the friction-limited yaw rate |r| <= ay_lim / v.
 *
 * Feedback: discrete PI on the yaw-rate error with conditional-integration anti-windup.
 * Allocation: Mz = dFx * t  ->  dT_motor = Mz * r_w / (t * G * eta); outer motor +dT, inner -dT.
 *
 * This file is the reference implementation of the generated firmware (vcu_torque_vectoring.c):
 * both run the identical arithmetic so the simulation predicts the ECU behaviour.
 */

export interface TVControllerParams {
  wheelbase: number; // m
  trackWidth: number; // m
  wheelRadius: number; // m
  gearRatio: number;
  gearboxEfficiency: number;
  understeerTarget: number; // rad / (m/s^2)
  ayLimit: number; // m/s^2 used to saturate the yaw-rate reference
  /** Optional speed-scheduled lateral limit (from the simulated TV envelope); overrides ayLimit. */
  ayLimitTable?: { speed: number[]; ay: number[] };
  kp: number; // Nm / (rad/s)
  ki: number; // Nm / rad
  mzLimit: number; // Nm
  motorTorqueLimit: number; // Nm per motor
  minSpeed: number; // m/s, TV disabled below
  dt: number; // s, task period
}

export interface TVState {
  integrator: number; // Nm (integral contribution)
}

export interface TVInputs {
  vx: number; // m/s
  steer: number; // rad, front road-wheel angle
  yawRate: number; // rad/s
  torqueRequest: number; // Nm, total motor torque request (sum of both motors)
}

export interface TVOutputs {
  torqueRL: number; // Nm motor torque
  torqueRR: number;
  mz: number; // Nm, commanded yaw moment
  yawRateRef: number;
  yawRateError: number;
  saturated: boolean;
}

export function defaultTVParams(veh: VehicleParams, pt: PowertrainParams, ayLimit = 1.6 * 9.81): TVControllerParams {
  const dFxMax = (pt.motorPeakTorque * pt.gearRatio * pt.gearboxEfficiency) / veh.wheelRadius;
  return {
    wheelbase: veh.wheelbase,
    trackWidth: veh.trackWidth,
    wheelRadius: veh.wheelRadius,
    gearRatio: pt.gearRatio,
    gearboxEfficiency: pt.gearboxEfficiency,
    understeerTarget: 0, // neutral steer up to the friction limit
    ayLimit,
    kp: 3000,
    ki: 6000,
    mzLimit: dFxMax * veh.trackWidth,
    motorTorqueLimit: pt.motorPeakTorque,
    minSpeed: 3.0,
    dt: 0.001,
  };
}

/** Lateral acceleration limit used for yaw-rate saturation (table lookup with end clamping). */
export function ayLimitAt(p: TVControllerParams, v: number): number {
  const tab = p.ayLimitTable;
  if (!tab || tab.speed.length < 2) return p.ayLimit;
  const n = tab.speed.length;
  if (v <= tab.speed[0]) return tab.ay[0];
  if (v >= tab.speed[n - 1]) return tab.ay[n - 1];
  let i = 0;
  while (i < n - 2 && v >= tab.speed[i + 1]) i++;
  const f = (v - tab.speed[i]) / (tab.speed[i + 1] - tab.speed[i]);
  return tab.ay[i] + f * (tab.ay[i + 1] - tab.ay[i]);
}

/** Steady-state yaw-rate reference with friction saturation. */
export function yawRateTarget(p: TVControllerParams, vx: number, steer: number): number {
  const v = Math.max(vx, 0.1);
  const rLin = (v * steer) / (p.wheelbase + p.understeerTarget * v * v);
  const rMax = (0.95 * ayLimitAt(p, v)) / v;
  return clamp(rLin, -rMax, rMax);
}

export function tvInitialState(): TVState {
  return { integrator: 0 };
}

/** One controller step. Mutates `state`. */
export function tvStep(p: TVControllerParams, state: TVState, inp: TVInputs): TVOutputs {
  const base = 0.5 * inp.torqueRequest;
  if (inp.vx < p.minSpeed) {
    state.integrator = 0;
    const t = clamp(base, -p.motorTorqueLimit, p.motorTorqueLimit);
    return { torqueRL: t, torqueRR: t, mz: 0, yawRateRef: 0, yawRateError: 0, saturated: false };
  }
  const rRef = yawRateTarget(p, inp.vx, inp.steer);
  const err = rRef - inp.yawRate;
  const integCandidate = state.integrator + p.ki * err * p.dt;
  const mzUnsat = p.kp * err + integCandidate;
  const mz = clamp(mzUnsat, -p.mzLimit, p.mzLimit);
  const saturatedMz = mzUnsat > p.mzLimit || mzUnsat < -p.mzLimit;
  // conditional integration: only accept the integrator update if it does not deepen saturation
  if (!saturatedMz || Math.sign(err) !== Math.sign(mzUnsat)) {
    state.integrator = clamp(integCandidate, -p.mzLimit, p.mzLimit);
  }
  const dT = (mz * p.wheelRadius) / (p.trackWidth * p.gearRatio * p.gearboxEfficiency);
  const rrRaw = base + dT;
  const rlRaw = base - dT;
  const tRR = clamp(rrRaw, -p.motorTorqueLimit, p.motorTorqueLimit);
  const tRL = clamp(rlRaw, -p.motorTorqueLimit, p.motorTorqueLimit);
  const motorSat = Math.abs(rrRaw) > p.motorTorqueLimit || Math.abs(rlRaw) > p.motorTorqueLimit;
  return {
    torqueRL: tRL,
    torqueRR: tRR,
    mz,
    yawRateRef: rRef,
    yawRateError: err,
    saturated: saturatedMz || motorSat,
  };
}
