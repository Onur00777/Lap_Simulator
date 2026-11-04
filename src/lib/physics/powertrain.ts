import { bilinear, interpUniform } from './numerics';
import { motorRpmFromSpeed, speedFromMotorRpm, type VehicleParams } from './vehicle';

/**
 * Dual rear-motor electric powertrain (one PMSM + planetary reduction per rear wheel).
 * Formula Student EV rules: accumulator output power is limited to 80 kW.
 */
export interface PowertrainParams {
  name: string;
  motorCount: number;
  motorPeakTorque: number; // Nm per motor
  motorPeakPower: number; // W per motor (mechanical, field-weakening corner)
  motorMaxRpm: number;
  gearRatio: number; // planetary reduction
  gearboxEfficiency: number;
  batteryPowerLimit: number; // W at accumulator terminals (rules: 80 kW)
  regenPowerLimit: number; // W electrical into the accumulator
  regenEnabled: boolean;
  batteryVoltage: number; // V nominal
  batteryResistance: number; // ohm, pack internal resistance
  batteryCapacityKWh: number;
  /** Loss model used to generate the efficiency lookup table. */
  losses: {
    copper: number; // W / Nm^2  (I^2 R, I ~ T)
    iron: number; // W / (rad/s)^1.5
    windage: number; // W / (rad/s)^2
    inverterFixed: number; // W
    inverterProportional: number; // fraction of shaft power
  };
}

export const DEFAULT_POWERTRAIN: PowertrainParams = {
  name: '2x AMK DD5-class 21 Nm / 20k rpm, 1:12 planetary',
  motorCount: 2,
  motorPeakTorque: 21,
  motorPeakPower: 40000,
  motorMaxRpm: 20000,
  gearRatio: 12,
  gearboxEfficiency: 0.97,
  batteryPowerLimit: 80000,
  regenPowerLimit: 40000,
  regenEnabled: true,
  batteryVoltage: 550,
  batteryResistance: 0.35,
  batteryCapacityKWh: 7.5,
  losses: {
    copper: 2.0,
    iron: 0.00626,
    windage: 3.4e-5,
    inverterFixed: 50,
    inverterProportional: 0.02,
  },
};

/** Total wheel torque at peak motor torque, e.g. 2 x 21 Nm x 12 = 504 Nm. */
export function peakWheelTorque(pt: PowertrainParams): number {
  return pt.motorCount * pt.motorPeakTorque * pt.gearRatio;
}

const rpmToRad = (rpm: number) => (rpm * 2 * Math.PI) / 60;

/** Motor + inverter loss [W] for one motor at (rpm, torque) from the analytical loss model. */
export function motorInverterLoss(pt: PowertrainParams, rpm: number, torque: number): number {
  const w = rpmToRad(Math.abs(rpm));
  const T = Math.abs(torque);
  const L = pt.losses;
  const pShaft = T * w;
  return L.copper * T * T + L.iron * Math.pow(w, 1.5) + L.windage * w * w + L.inverterFixed + L.inverterProportional * pShaft;
}

export interface EfficiencyMap {
  rpm: number[];
  torque: number[];
  /** eta[i][j] at (rpm[i], torque[j]) — combined motor + inverter efficiency. */
  eta: number[][];
}

/** Generates the motor/inverter efficiency lookup table on a (speed x torque) grid. */
export function buildEfficiencyMap(pt: PowertrainParams): EfficiencyMap {
  const rpm = [500, 1000, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000];
  const torque = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 21].map((t) => (t * pt.motorPeakTorque) / 21);
  const eta = rpm.map((n) =>
    torque.map((T) => {
      const pShaft = T * rpmToRad(n);
      const loss = motorInverterLoss(pt, n, T);
      return Math.max(0.5, pShaft / (pShaft + loss));
    }),
  );
  return { rpm, torque, eta };
}

/** Bilinear lookup of motor + inverter efficiency. */
export function lookupEfficiency(map: EfficiencyMap, rpm: number, torque: number): number {
  return bilinear(map.rpm, map.torque, map.eta, Math.abs(rpm), Math.abs(torque));
}

/** Motor torque envelope: constant torque up to the base speed, constant power beyond. */
export function motorTorqueLimit(pt: PowertrainParams, rpm: number): number {
  const n = Math.abs(rpm);
  if (n >= pt.motorMaxRpm) return 0;
  const w = rpmToRad(n);
  if (w < 1e-6) return pt.motorPeakTorque;
  return Math.min(pt.motorPeakTorque, pt.motorPeakPower / w);
}

export type DriveLimit = 'motor-torque' | 'motor-power' | 'battery-power' | 'max-rpm';

export interface DrivePoint {
  force: number; // N total at the contact patches
  motorTorque: number; // Nm per motor
  motorRpm: number;
  pMech: number; // W total shaft power
  pElec: number; // W total DC power
  limitedBy: DriveLimit;
}

/**
 * Maximum tractive force the powertrain can deliver at speed v, honouring motor torque,
 * motor power and the accumulator power ceiling (solved by bisection through the efficiency map).
 */
export function maxDrivePoint(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, v: number): DrivePoint {
  const rpm = motorRpmFromSpeed(veh, Math.max(v, 0), pt.gearRatio);
  const w = rpmToRad(rpm);
  const toForce = (T: number) => (pt.motorCount * T * pt.gearRatio * pt.gearboxEfficiency) / veh.wheelRadius;
  if (rpm >= pt.motorMaxRpm) {
    return { force: 0, motorTorque: 0, motorRpm: rpm, pMech: 0, pElec: 0, limitedBy: 'max-rpm' };
  }
  const Tlim = motorTorqueLimit(pt, rpm);
  const pElecOf = (T: number) => (pt.motorCount * T * w) / lookupEfficiency(map, rpm, T);
  let T = Tlim;
  let limitedBy: DriveLimit = Tlim < pt.motorPeakTorque ? 'motor-power' : 'motor-torque';
  if (pElecOf(Tlim) > pt.batteryPowerLimit) {
    let lo = 0;
    let hi = Tlim;
    for (let k = 0; k < 50; k++) {
      const mid = 0.5 * (lo + hi);
      if (pElecOf(mid) > pt.batteryPowerLimit) hi = mid;
      else lo = mid;
    }
    T = lo;
    limitedBy = 'battery-power';
  }
  return {
    force: toForce(T),
    motorTorque: T,
    motorRpm: rpm,
    pMech: pt.motorCount * T * w,
    pElec: pElecOf(T),
    limitedBy,
  };
}

/**
 * Maximum braking force that the rear motors can absorb by regeneration at speed v, limited by
 * motor torque and the accumulator charge power ceiling.
 */
export function maxRegenForce(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, v: number): number {
  if (!pt.regenEnabled || v <= 0.5) return 0;
  const rpm = motorRpmFromSpeed(veh, v, pt.gearRatio);
  const w = rpmToRad(rpm);
  const Tlim = motorTorqueLimit(pt, rpm);
  const pOf = (T: number) => pt.motorCount * T * w * lookupEfficiency(map, rpm, T);
  let T = Tlim;
  if (pOf(Tlim) > pt.regenPowerLimit) {
    let lo = 0;
    let hi = Tlim;
    for (let k = 0; k < 50; k++) {
      const mid = 0.5 * (lo + hi);
      if (pOf(mid) > pt.regenPowerLimit) hi = mid;
      else lo = mid;
    }
    T = lo;
  }
  return (pt.motorCount * T * pt.gearRatio) / (pt.gearboxEfficiency * veh.wheelRadius);
}

export interface PowerFlow {
  motorTorque: number; // Nm per motor (negative = generating)
  motorRpm: number;
  pWheel: number; // W at the contact patches (F * v)
  pMech: number; // W total motor shaft power
  pElec: number; // W total DC power at accumulator terminals (+ discharge, - charge)
  lossGearbox: number; // W
  lossMotorInverter: number; // W  -> rejected to the water cooling loop
  lossBattery: number; // W  I^2 R heat in the pack
}

/** Converts a commanded total wheel force (+ drive / - regen) into the full electrical power flow. */
export function powerFlow(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, v: number, wheelForce: number): PowerFlow {
  const rpm = motorRpmFromSpeed(veh, Math.max(v, 0), pt.gearRatio);
  const w = rpmToRad(rpm);
  const pWheel = wheelForce * v;
  let motorTorque: number;
  let pMech: number;
  let pElec: number;
  if (wheelForce >= 0) {
    motorTorque = (wheelForce * veh.wheelRadius) / (pt.motorCount * pt.gearRatio * pt.gearboxEfficiency);
    pMech = pt.motorCount * motorTorque * w;
    pElec = pMech > 0 ? pMech / lookupEfficiency(map, rpm, motorTorque) : 0;
  } else {
    motorTorque = (wheelForce * veh.wheelRadius * pt.gearboxEfficiency) / (pt.motorCount * pt.gearRatio);
    pMech = pt.motorCount * motorTorque * w;
    pElec = pMech * lookupEfficiency(map, rpm, motorTorque);
  }
  const current = pElec / pt.batteryVoltage;
  return {
    motorTorque,
    motorRpm: rpm,
    pWheel,
    pMech,
    pElec,
    lossGearbox: Math.abs(pMech - pWheel),
    lossMotorInverter: Math.abs(pElec - pMech),
    lossBattery: current * current * pt.batteryResistance,
  };
}

/** Pre-tabulated powertrain envelope on a uniform speed grid for fast lookups inside the solvers. */
export interface PowertrainCurve {
  v0: number;
  dv: number;
  vMax: number; // speed at max motor rpm
  driveForce: number[];
  regenForce: number[];
  limitedBy: DriveLimit[];
}

export function buildPowertrainCurve(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, dv = 0.1): PowertrainCurve {
  const vMax = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio);
  const n = Math.ceil(vMax / dv) + 2;
  const driveForce: number[] = [];
  const regenForce: number[] = [];
  const limitedBy: DriveLimit[] = [];
  for (let i = 0; i < n; i++) {
    const v = i * dv;
    const dp = maxDrivePoint(veh, pt, map, Math.min(v, vMax - 1e-6));
    driveForce.push(v >= vMax ? 0 : dp.force);
    limitedBy.push(v >= vMax ? 'max-rpm' : dp.limitedBy);
    regenForce.push(maxRegenForce(veh, pt, map, Math.min(v, vMax - 1e-6)));
  }
  return { v0: 0, dv, vMax, driveForce, regenForce, limitedBy };
}

export function curveDriveForce(c: PowertrainCurve, v: number): number {
  if (v >= c.vMax) return 0;
  return interpUniform(c.v0, c.dv, c.driveForce, v);
}

export function curveRegenForce(c: PowertrainCurve, v: number): number {
  return interpUniform(c.v0, c.dv, c.regenForce, Math.min(v, c.vMax));
}

export function curveLimit(c: PowertrainCurve, v: number): DriveLimit {
  const i = Math.max(0, Math.min(c.limitedBy.length - 1, Math.round(v / c.dv)));
  return c.limitedBy[i];
}

/** Sampled motor curves for plotting: torque & power vs rpm, with battery limit applied. */
export function sampleMotorCurve(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, n = 41) {
  const out: { rpm: number; torque: number; powerKW: number; elecKW: number; wheelTorque: number }[] = [];
  for (let i = 0; i < n; i++) {
    const rpm = (pt.motorMaxRpm * i) / (n - 1);
    const v = speedFromMotorRpm(veh, Math.min(rpm, pt.motorMaxRpm - 1), pt.gearRatio);
    const dp = maxDrivePoint(veh, pt, map, v);
    out.push({
      rpm,
      torque: dp.motorTorque,
      powerKW: dp.pMech / 1000,
      elecKW: dp.pElec / 1000,
      wheelTorque: dp.motorTorque * pt.motorCount * pt.gearRatio,
    });
  }
  return out;
}
