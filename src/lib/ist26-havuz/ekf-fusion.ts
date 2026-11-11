import { clamp, wrapAngle } from '../physics/numerics';
import { GRAVITY } from '../physics/vehicle';
import { IST26_RWD_PDF_SPEC } from './ist26-vehicle-spec';

type Vector3 = readonly [number, number, number];
type Corners<T> = readonly [T, T, T, T];

export interface FusionSample {
  timeS: number;
  /** Specific force in body axes (forward, left, up), including gravity at rest. */
  accelerationMps2: readonly [number | null, number | null, number | null];
  gyroRadPerS: readonly [number | null, number | null, number | null];
  wheelOmegaRadPerS: Corners<number | null>; // FL, FR, RL, RR
  roadWheelSteerRad: number | null;
  /** True on a received heartbeat, false while monitoring with no new frame, null when unavailable. */
  cascadiaHeartbeat?: boolean | null;
}

export interface FusionParams {
  cgToFrontM: number;
  cgToRearM: number;
  frontTrackM: number;
  rearTrackM: number;
  wheelRadiusM: number;
  massKg: number;
  rearCorneringStiffnessNPerRad: number;
  canTimeoutS: number;
}

const spec = IST26_RWD_PDF_SPEC;
const geometry = spec.massAndGeometry;
export const IST26_FUSION_PARAMS: FusionParams = {
  cgToFrontM: geometry.lF_M, cgToRearM: geometry.lR_M, frontTrackM: geometry.trackFrontM, rearTrackM: geometry.trackRearM,
  wheelRadiusM: geometry.loadedWheelRadiusM, massKg: geometry.totalMassKg,
  rearCorneringStiffnessNPerRad: 2 * spec.brakesAndTires.corneringStiffnessRearNPerDeg * 180 / Math.PI,
  canTimeoutS: 0.1,
};

export interface FusionEstimate {
  timeS: number;
  positionM: Vector3;
  bodyVelocityMps: Vector3;
  attitudeRad: Vector3;
  sideslipRad: number | null;
  wheelSlipRatio: Corners<number | null>;
  flags: { imuDropout: boolean; wheelDropout: boolean; steerDropout: boolean; sampleGap: boolean; canTimeout: boolean | null };
}

const N = 9;
const initialVariance = [1, 1, 0.1, 4, 0.5, 0.25, 0.03, 0.03, 0.2];
const processVariance = [0.005, 0.005, 0.005, 1.5, 1.4, 0.7, 0.002, 0.002, 0.006];
const zero = () => Array<number>(N).fill(0);
const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const available = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** Six rigid-body degrees of freedom, with translational velocity included in the covariance. */
function propagate(x: number[], accel: Vector3, gyro: Vector3, dt: number): number[] {
  const [px, py, pz, u, v, w, roll, pitch, yaw] = x;
  const [ax, ay, az] = accel;
  const [p, q, r] = gyro;
  const sr = Math.sin(roll), cr = Math.cos(roll), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const vz = sr * v + cr * w;
  const vy = cr * v - sr * w;
  const vx = cp * u + sp * vz;
  const omega = sr * q + cr * r;
  return [
    px + dt * (cy * vx - sy * vy), py + dt * (sy * vx + cy * vy), pz + dt * (-sp * u + cp * vz),
    u + dt * (ax + GRAVITY * sp + r * v - q * w),
    v + dt * (ay - GRAVITY * sr * cp + p * w - r * u),
    w + dt * (az - GRAVITY * cr * cp + q * u - p * v),
    wrapAngle(roll + dt * (p + omega * sp / Math.max(0.1, cp))),
    clamp(pitch + dt * (cr * q - sr * r), -1.45, 1.45),
    wrapAngle(yaw + dt * omega / Math.max(0.1, cp)),
  ];
}

export function createVehicleFusion(params: FusionParams = IST26_FUSION_PARAMS) {
  let x = zero();
  let covariance = initialVariance.map((variance, i) => zero().map((_, j) => i === j ? variance : 0));
  let prevTime: number | null = null;
  let canStart: number | null = null;
  let lastHeartbeat: number | null = null;

  const observe = (z: number, h: number[], variance: number, gate = Infinity) => {
    const residual = z - dot(h, x);
    const ph = covariance.map((row) => dot(row, h));
    const innovation = dot(h, ph) + variance;
    if (residual ** 2 > gate ** 2 * innovation) return;
    x = x.map((value, i) => value + ph[i] * residual / innovation);
    covariance = covariance.map((row, i) => row.map((value, j) => value - ph[i] * ph[j] / innovation));
  };

  return (sample: FusionSample): FusionEstimate => {
    const { timeS, accelerationMps2, gyroRadPerS, wheelOmegaRadPerS, cascadiaHeartbeat } = sample;
    if (!Number.isFinite(timeS) || (prevTime != null && timeS < prevTime)) throw new RangeError('Fusion timestamps must be finite and nondecreasing.');
    const firstSample = prevTime == null;
    const elapsed = prevTime == null ? 0 : timeS - prevTime;
    const dt = Math.min(0.1, elapsed);
    const accel: Vector3 = [
      available(accelerationMps2[0]) ? accelerationMps2[0] : -GRAVITY * Math.sin(x[7]),
      available(accelerationMps2[1]) ? accelerationMps2[1] : GRAVITY * Math.sin(x[6]) * Math.cos(x[7]),
      available(accelerationMps2[2]) ? accelerationMps2[2] : GRAVITY * Math.cos(x[6]) * Math.cos(x[7]),
    ];
    const gyro: Vector3 = gyroRadPerS.map((value) => available(value) ? value : 0) as unknown as Vector3;
    const imuDropout = !accelerationMps2.every(available) || !gyroRadPerS.every(available);
    const sampleGap = elapsed > 0.1;
    if (dt > 0) {
      const next = propagate(x, accel, gyro, dt);
      const jacobian = Array.from({ length: N }, () => zero());
      const eps = 1e-5;
      for (let j = 0; j < N; j++) {
        const perturbed = x.slice();
        perturbed[j] += eps;
        const shifted = propagate(perturbed, accel, gyro, dt);
        for (let i = 0; i < N; i++) jacobian[i][j] = (i >= 6 ? wrapAngle(shifted[i] - next[i]) : shifted[i] - next[i]) / eps;
      }
      const left = jacobian.map((row) => row.map((_, col) => row.reduce((sum, value, k) => sum + value * covariance[k][col], 0)));
      const uncertainty = (imuDropout ? 4 : 1) * Math.min(1, elapsed);
      covariance = left.map((row, i) => jacobian.map((jacobianRow, j) => dot(row, jacobianRow) + (i === j ? processVariance[i] * uncertainty : 0)));
      x = next;
    }
    prevTime = timeS;

    const yawRate = gyro[2];
    const steerDropout = !available(sample.roadWheelSteerRad);
    const steer = available(sample.roadWheelSteerRad) ? clamp(sample.roadWheelSteerRad, -0.8, 0.8) : 0;
    const wheelSpeeds = wheelOmegaRadPerS.map((omega) => available(omega) ? omega * params.wheelRadiusM : null);
    const geometry = [
      [params.cgToFrontM, params.frontTrackM / 2, steer], [params.cgToFrontM, -params.frontTrackM / 2, steer],
      [-params.cgToRearM, params.rearTrackM / 2, 0], [-params.cgToRearM, -params.rearTrackM / 2, 0],
    ];
    const wheelEquations = geometry.map(([a, b, angle]) => ({ h: [0, 0, 0, Math.cos(angle), Math.sin(angle), 0, 0, 0, 0], offset: yawRate * (a * Math.sin(angle) - b * Math.cos(angle)) }));
    const frontSpeedEstimates = wheelSpeeds.slice(0, 2).flatMap((speed, i) => {
      const { h, offset } = wheelEquations[i];
      return speed == null ? [] : [(speed - offset - h[4] * x[4]) / h[3]];
    });
    const frontSpeed = frontSpeedEstimates.length > 0
      ? frontSpeedEstimates.reduce((sum, speed) => sum + speed, 0) / frontSpeedEstimates.length
      : null;
    wheelSpeeds.forEach((speed, i) => {
      if (speed == null) return;
      const equation = wheelEquations[i];
      const axleDisagreement = frontSpeed != null && i >= 2 ? Math.abs(speed - equation.offset - frontSpeed) : 0;
      const variance = i < 2 ? steerDropout ? 0.40 : 0.06 : 0.65 + 8 * axleDisagreement ** 2;
      observe(speed - equation.offset, equation.h, variance, firstSample ? Infinity : 5);
    });

    const stationary = wheelSpeeds.every((speed) => speed != null && Math.abs(speed) < 0.12) && Math.abs(yawRate) < 0.06;
    if (stationary) {
      observe(0, [0, 0, 0, 1, 0, 0, 0, 0, 0], 0.001);
      observe(0, [0, 0, 0, 0, 1, 0, 0, 0, 0], 0.001);
      if (!imuDropout && Math.abs(Math.hypot(...accel) - GRAVITY) < 0.4) {
        observe(Math.atan2(accel[1], accel[2]), [0, 0, 0, 0, 0, 0, 1, 0, 0], 0.003);
        observe(Math.atan2(-accel[0], Math.hypot(accel[1], accel[2])), [0, 0, 0, 0, 0, 0, 0, 1, 0], 0.003);
      }
    } else if (Math.abs(x[3]) > 1 && available(accelerationMps2[1]) && available(gyroRadPerS[2])) {
      // Rear lateral slip from quasi-static yaw balance, as a soft constraint on body sideslip.
      const ay = accel[1] - GRAVITY * Math.sin(x[6]) * Math.cos(x[7]);
      const rearForce = params.massKg * ay * params.cgToFrontM / (params.cgToFrontM + params.cgToRearM);
      const rearSlip = clamp(rearForce / params.rearCorneringStiffnessNPerRad, -0.22, 0.22);
      observe(params.cgToRearM * yawRate - Math.abs(x[3]) * Math.tan(rearSlip), [0, 0, 0, 0, 1, 0, 0, 0, 0], 0.12 + 0.02 * ay ** 2, 5);
    }
    // Soft vertical contact constraint on the parking-lot surface.
    observe(0, [0, 0, 0, -Math.sin(x[7]), Math.sin(x[6]) * Math.cos(x[7]), Math.cos(x[6]) * Math.cos(x[7]), 0, 0, 0], 0.06);

    if (cascadiaHeartbeat != null) canStart ??= timeS;
    if (cascadiaHeartbeat === true) lastHeartbeat = timeS;
    const canReference = lastHeartbeat ?? canStart;
    const wheelSlip = (i: number) => {
      const speed = wheelSpeeds[i];
      const equation = wheelEquations[i];
      const rollingSpeed = dot(equation.h, x) + equation.offset;
      return speed == null || Math.abs(rollingSpeed) < 0.5 ? null : (speed - rollingSpeed) / Math.abs(rollingSpeed);
    };
    return {
      timeS, positionM: [x[0], x[1], x[2]], bodyVelocityMps: [x[3], x[4], x[5]], attitudeRad: [x[6], x[7], x[8]],
      sideslipRad: Math.abs(x[3]) < 0.5 ? null : Math.atan2(x[4], Math.abs(x[3])),
      wheelSlipRatio: [wheelSlip(0), wheelSlip(1), wheelSlip(2), wheelSlip(3)],
      flags: { imuDropout, wheelDropout: wheelSpeeds.some((speed) => speed == null), steerDropout, sampleGap, canTimeout: canReference == null ? null : timeS - canReference > params.canTimeoutS },
    };
  };
}
