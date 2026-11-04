import {
  longitudinalCoefficients,
  longitudinalForce,
  maxDrivePoint,
  maxRegenForce,
  peakSlip,
  speedFromMotorRpm,
  wheelLoads,
  type EfficiencyMap,
  type PowertrainParams,
  type VehicleParams,
} from '../physics';

/**
 * Driver torque map: accelerator pedal travel [%] x vehicle speed [km/h] -> motor torque request
 * [Nm per motor]. Derived from the simulated limits:
 *   T_avail(v) = min( motor torque/power envelope incl. 80 kW accumulator limit,
 *                     traction torque at the TC slip set point (Pacejka Fx at kappa*, rear loads
 *                     with longitudinal load transfer) )
 *   T(p, v)    = T_avail(v) * (p / 100)^gamma               (progressive pedal)
 *   T(0, v)    = -T_coast(v)                                 (lift-off regen above fade-in speed)
 */

export interface TorqueMapOptions {
  pedalPct?: number[];
  speedKph?: number[];
  pedalGamma?: number;
  coastRegenTorque?: number; // Nm per motor at 0 % pedal (lift-off regen)
  coastRegenFadeKph?: [number, number]; // regen fades in between these speeds
  slipTarget?: number; // TC slip ratio set point; default 90 % of peak slip
}

export interface TorqueMap {
  pedalPct: number[];
  speedKph: number[];
  torque: number[][]; // [pedal][speed], Nm per motor
  availableTorque: number[]; // Nm per motor per speed column (100 % pedal)
  tractionTorque: number[]; // Nm per motor traction limit per speed column
  limitedBy: ('traction' | 'motor' | 'battery' | 'rpm')[];
  pedalGamma: number;
  slipTarget: number;
  coastRegenTorque: number;
  maxSpeedKph: number;
}

/** Rear-axle tractive force at the slip set point with self-consistent longitudinal load transfer. */
export function tractionForceAtSlip(veh: VehicleParams, v: number, slip: number): number {
  let ax = 0;
  let F = 0;
  for (let k = 0; k < 20; k++) {
    const L = wheelLoads(veh, v, ax, 0);
    F = longitudinalForce(veh.tire, slip, L.rl) + longitudinalForce(veh.tire, slip, L.rr);
    ax = F / veh.mass;
  }
  return F;
}

export function buildTorqueMap(veh: VehicleParams, pt: PowertrainParams, map: EfficiencyMap, opts: TorqueMapOptions = {}): TorqueMap {
  const pedalPct = opts.pedalPct ?? [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const speedKph = opts.speedKph ?? [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];
  const gamma = opts.pedalGamma ?? 1.4;
  const coast = opts.coastRegenTorque ?? 4;
  const [fade0, fade1] = opts.coastRegenFadeKph ?? [8, 20];
  const staticRear = wheelLoads(veh, 0, 0, 0).rl;
  const slip = opts.slipTarget ?? 0.9 * peakSlip(longitudinalCoefficients(veh.tire, staticRear));
  const vMaxKph = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio) * 3.6;
  const toMotorTorque = (Fwheel: number) => (Fwheel * veh.wheelRadius) / (pt.motorCount * pt.gearRatio * pt.gearboxEfficiency);

  const availableTorque: number[] = [];
  const tractionTorque: number[] = [];
  const limitedBy: TorqueMap['limitedBy'] = [];
  const regenTorque: number[] = [];
  for (const kph of speedKph) {
    const v = kph / 3.6;
    if (kph >= vMaxKph) {
      availableTorque.push(0);
      tractionTorque.push(0);
      limitedBy.push('rpm');
      regenTorque.push(0);
      continue;
    }
    const dp = maxDrivePoint(veh, pt, map, v);
    const Ttr = toMotorTorque(tractionForceAtSlip(veh, v, slip));
    tractionTorque.push(Ttr);
    if (Ttr < dp.motorTorque) {
      availableTorque.push(Ttr);
      limitedBy.push('traction');
    } else {
      availableTorque.push(dp.motorTorque);
      limitedBy.push(dp.limitedBy === 'battery-power' ? 'battery' : 'motor');
    }
    const regenMaxMotor = (maxRegenForce(veh, pt, map, v) * veh.wheelRadius * pt.gearboxEfficiency) / (pt.motorCount * pt.gearRatio);
    const fade = Math.max(0, Math.min(1, (kph - fade0) / (fade1 - fade0)));
    regenTorque.push(Math.min(coast, regenMaxMotor) * fade);
  }
  const torque = pedalPct.map((p) =>
    speedKph.map((_, j) => {
      if (p <= 0) return -regenTorque[j];
      return availableTorque[j] * Math.pow(p / 100, gamma);
    }),
  );
  return {
    pedalPct,
    speedKph,
    torque,
    availableTorque,
    tractionTorque,
    limitedBy,
    pedalGamma: gamma,
    slipTarget: slip,
    coastRegenTorque: coast,
    maxSpeedKph: vMaxKph,
  };
}

/** Reference implementation of the generated C bilinear lookup (identical clamping & indexing). */
export function torqueMapLookup(tm: TorqueMap, pedal: number, speedKph: number): number {
  const findIndex = (axis: number[], x: number) => {
    let i = 0;
    while (i < axis.length - 2 && x >= axis[i + 1]) i++;
    return i;
  };
  const clampAxis = (axis: number[], x: number) => Math.min(Math.max(x, axis[0]), axis[axis.length - 1]);
  const p = clampAxis(tm.pedalPct, pedal);
  const s = clampAxis(tm.speedKph, speedKph);
  const i = findIndex(tm.pedalPct, p);
  const j = findIndex(tm.speedKph, s);
  const tp = (p - tm.pedalPct[i]) / (tm.pedalPct[i + 1] - tm.pedalPct[i]);
  const ts = (s - tm.speedKph[j]) / (tm.speedKph[j + 1] - tm.speedKph[j]);
  const q00 = tm.torque[i][j];
  const q01 = tm.torque[i][j + 1];
  const q10 = tm.torque[i + 1][j];
  const q11 = tm.torque[i + 1][j + 1];
  const r0 = q00 + (q01 - q00) * ts;
  const r1 = q10 + (q11 - q10) * ts;
  return r0 + (r1 - r0) * tp;
}
