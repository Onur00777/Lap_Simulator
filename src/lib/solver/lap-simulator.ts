import {
  curveDriveForce,
  curveLimit,
  curveRegenForce,
  dragForce,
  GRAVITY,
  powerFlow,
  rearBrakeShare,
  rearTractionCapacity,
  rollingResistanceForce,
  totalBrakeCapacity,
  type DriveLimit,
} from '../physics';
import { detectCorners } from '../tracks/geometry';
import type { Corner, Track } from '../tracks/types';
import { ctxAyMax, ctxAySteady, type SimulationContext } from './context';

/**
 * Quasi-steady-state (QSS) point-mass lap time simulation.
 *
 *  Pass 1 — cornering limit:  v_lim(s) solves  v^2 |kappa| = ay_ss(v),
 *           ay_ss(v) = ay_max(v) sqrt(1 - (F_res / Fx_max)^2), ay_max from the Pacejka tires
 *           at aero-loaded, load-transferred wheel loads (=> mu (m g + 0.5 rho ClA v^2) / m).
 *  Pass 2 — braking: backward integration of d(v^2)/ds = 2 a_brake(v, kappa) from every
 *           cornering limit, a_brake from the 4-wheel friction ellipse + drag + rolling resistance.
 *  Pass 3 — traction: forward integration of d(v^2)/ds = 2 a_drive(v, kappa) with the motor
 *           torque / motor power / 80 kW accumulator limit and the rear-axle friction ellipse,
 *           capped by the braking envelope.
 *
 *  The ODEs are integrated in the v^2 domain (exact for constant acceleration) with explicit
 *  Euler or classical RK4 using linearly interpolated curvature inside each step.
 */

export type Integrator = 'euler' | 'rk4';

export interface SolverOptions {
  integrator?: Integrator;
  /** Initial speed for open tracks (m/s). Defaults to `track.startSpeed`. */
  startSpeed?: number;
  /** Fraction of the friction-limited braking/traction force the driver actually uses. */
  driverGripUsage?: number;
}

export type SegmentMode = 'brake' | 'full-throttle' | 'part-throttle' | 'cornering' | 'coast';

export interface LapChannels {
  s: number[];
  x: number[];
  y: number[];
  kappa: number[];
  vLimit: number[];
  vBrake: number[];
  vAccel: number[];
  v: number[];
  t: number[];
  ax: number[]; // m/s^2
  ay: number[]; // m/s^2
  gLong: number[];
  gLat: number[];
  gripUsage: number[]; // combined friction-ellipse utilisation 0..1
  throttle: number[]; // 0..1
  brake: number[]; // 0..1
  motorTorque: number[]; // Nm per motor
  motorRpm: number[];
  pWheelKW: number[];
  pElecKW: number[]; // + discharge / - regen
  energyKWh: number[]; // cumulative net accumulator energy
  heatKJ: number[]; // cumulative heat rejected to the cooling loop
  mode: SegmentMode[];
  driveLimit: (DriveLimit | 'traction' | '')[];
}

export interface EnergyBreakdown {
  netKWh: number; // discharge - regen at accumulator terminals
  dischargeKWh: number;
  regenKWh: number;
  kineticKJ: number; // change in kinetic energy over the run
  aeroKJ: number;
  rollingKJ: number;
  frictionBrakeKJ: number;
  /** Work done against the longitudinal grade. Zero when the lap returns to its start height. */
  gradeKJ: number;
  regenWheelKJ: number; // braking energy captured at the wheels by the motors
  driveWheelKJ: number; // positive tractive work at the contact patches
  gearboxLossKJ: number;
  motorInverterLossKJ: number;
  batteryLossKJ: number;
  coolingHeatKJ: number; // motor + inverter + gearbox losses -> water/oil cooling
}

export interface CornerResult extends Corner {
  apexSpeed: number;
  minSpeed: number;
  entrySpeed: number;
  exitSpeed: number;
  peakLatG: number;
}

export interface LapResult {
  trackId: string;
  trackName: string;
  closed: boolean;
  integrator: Integrator;
  lateralModel: string;
  lapTime: number;
  distance: number;
  avgSpeed: number;
  maxSpeed: number;
  minSpeed: number;
  peakLatG: number;
  peakLongG: number;
  peakBrakeG: number;
  fullThrottleFraction: number; // fraction of lap time
  brakingFraction: number;
  sectors: { index: number; s0: number; s1: number; time: number }[];
  timedWindows: { label: string; s0: number; s1: number; time: number }[];
  corners: CornerResult[];
  energy: EnergyBreakdown;
  channels: LapChannels;
  event: { laps: number; totalTime: number; totalEnergyKWh: number; totalHeatMJ: number };
}

interface AccelEval {
  a: number;
  limit: DriveLimit | 'traction';
}

/** Longitudinal force from the gradient, positive when the car is climbing. grade is rise/run. */
function gradeForce(mass: number, grade: number): number {
  return mass * GRAVITY * Math.sin(Math.atan(grade));
}

/** Max forward acceleration at speed v on curvature kappa (rear-axle traction + powertrain). */
function driveAccel(ctx: SimulationContext, v: number, kappa: number, usage: number, grade = 0): AccelEval {
  const { veh, curve } = ctx;
  const ay = v * v * Math.abs(kappa);
  const ayMax = ctxAyMax(ctx, v);
  const u = Math.min(1, ay / ayMax);
  const ell = Math.sqrt(1 - u * u);
  const Fres = dragForce(veh, v) + rollingResistanceForce(veh, v);
  const Fg = gradeForce(veh.mass, grade);
  const Fpt = curveDriveForce(curve, v);
  let ax = 0;
  let F = 0;
  let limit: DriveLimit | 'traction' = 'traction';
  for (let k = 0; k < 4; k++) {
    const Ftr = rearTractionCapacity(veh, v, ax, ay) * ell * usage;
    if (Fpt <= Ftr) {
      F = Fpt;
      limit = curveLimit(curve, v);
    } else {
      F = Ftr;
      limit = 'traction';
    }
    ax = (F - Fres - Fg) / veh.mass;
  }
  return { a: ax, limit };
}

/** Max deceleration (positive number) at speed v on curvature kappa. */
function brakeDecel(ctx: SimulationContext, v: number, kappa: number, usage: number, grade = 0): number {
  const { veh } = ctx;
  const ay = v * v * Math.abs(kappa);
  const ayMax = ctxAyMax(ctx, v);
  const u = Math.min(1, ay / ayMax);
  const ell = Math.sqrt(1 - u * u);
  const Fres = dragForce(veh, v) + rollingResistanceForce(veh, v);
  const Fg = gradeForce(veh.mass, grade);
  let d = 0;
  for (let k = 0; k < 4; k++) {
    const Fb = totalBrakeCapacity(veh, v, -d, ay) * ell * usage;
    d = (Fb + Fres + Fg) / veh.mass;
  }
  return d;
}

/** Longitudinal acceleration envelope at speed v while sustaining lateral acceleration ay (G-G-V). */
export function longitudinalEnvelope(ctx: SimulationContext, v: number, ay: number): { accel: number; decel: number } {
  const kappa = v > 0.1 ? ay / (v * v) : 0;
  return { accel: driveAccel(ctx, v, kappa, 1).a, decel: brakeDecel(ctx, v, kappa, 1) };
}

/** Pass 1: cornering speed limit for |kappa| by bisection on ay_ss(v) - v^2 |kappa|. */
export function corneringSpeedLimit(ctx: SimulationContext, kappa: number): number {
  const k = Math.abs(kappa);
  const vCap = ctx.vCap;
  if (k < 1e-7) return vCap;
  const g = (v: number) => ctxAySteady(ctx, v) - v * v * k;
  if (g(vCap) >= 0) return vCap;
  let lo = 0.1;
  let hi = vCap;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) >= 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** One integration step of d(v^2)/ds = 2 a(v, kappa(s), grade(s)) over distance h. */
function stepV2(
  integrator: Integrator,
  accel: (v: number, kappa: number, grade: number) => number,
  v0: number,
  k0: number,
  k1: number,
  h: number,
  g0 = 0,
  g1 = 0,
): number {
  const f = (frac: number, u: number) =>
    2 * accel(Math.sqrt(Math.max(u, 0)), k0 + (k1 - k0) * frac, g0 + (g1 - g0) * frac);
  const u0 = v0 * v0;
  if (integrator === 'euler') {
    return Math.sqrt(Math.max(0, u0 + h * f(0, u0)));
  }
  const q1 = f(0, u0);
  const q2 = f(0.5, u0 + 0.5 * h * q1);
  const q3 = f(0.5, u0 + 0.5 * h * q2);
  const q4 = f(1, u0 + h * q3);
  return Math.sqrt(Math.max(0, u0 + (h / 6) * (q1 + 2 * q2 + 2 * q3 + q4)));
}

export function simulateLap(track: Track, ctx: SimulationContext, opts: SolverOptions = {}): LapResult {
  const integrator = opts.integrator ?? 'rk4';
  const usage = opts.driverGripUsage ?? 1;
  const { veh, pt, map, curve } = ctx;
  const N = track.s.length;
  const closed = track.closed;
  const nSeg = closed ? N : N - 1;
  const ds = track.ds;
  const kap = track.kappa;
  const next = (i: number) => (closed ? (i + 1) % N : i + 1);
  const prev = (i: number) => (closed ? (i - 1 + N) % N : i - 1);

  // ---------------- Pass 1: cornering limit ----------------
  const vLimit = kap.map((k) => corneringSpeedLimit(ctx, k));

  const gradeAt = (i: number) => track.grade?.[i] ?? 0;
  const fwdAccel = (v: number, k: number, g: number) => driveAccel(ctx, v, k, usage, g).a;
  const bwdDecel = (v: number, k: number, g: number) => brakeDecel(ctx, v, k, usage, g);

  // ---------------- Pass 2: braking (backward) ----------------
  const vBrake = new Array<number>(N);
  if (closed) {
    let i0 = 0;
    for (let i = 1; i < N; i++) if (vLimit[i] < vLimit[i0]) i0 = i;
    vBrake[i0] = vLimit[i0];
    let i = i0;
    for (let c = 0; c < N - 1; c++) {
      const j = prev(i);
      const vb = stepV2(integrator, bwdDecel, vBrake[i], kap[i], kap[j], ds, gradeAt(i), gradeAt(j));
      vBrake[j] = Math.min(vLimit[j], vb);
      i = j;
    }
  } else {
    vBrake[N - 1] = vLimit[N - 1];
    for (let i = N - 1; i > 0; i--) {
      const vb = stepV2(integrator, bwdDecel, vBrake[i], kap[i], kap[i - 1], ds, gradeAt(i), gradeAt(i - 1));
      vBrake[i - 1] = Math.min(vLimit[i - 1], vb);
    }
  }

  // ---------------- Pass 3: traction (forward), capped by the braking envelope ----------------
  const vAccel = new Array<number>(N);
  const v = new Array<number>(N);
  if (closed) {
    let i0 = 0;
    for (let i = 1; i < N; i++) if (vBrake[i] < vBrake[i0]) i0 = i;
    v[i0] = vBrake[i0];
    vAccel[i0] = vLimit[i0];
    let i = i0;
    for (let c = 0; c < N - 1; c++) {
      const j = next(i);
      const va = stepV2(integrator, fwdAccel, v[i], kap[i], kap[j], ds, gradeAt(i), gradeAt(j));
      vAccel[j] = Math.min(vLimit[j], va);
      v[j] = Math.min(vBrake[j], va);
      i = j;
    }
  } else {
    const v0 = Math.min(opts.startSpeed ?? track.startSpeed, vBrake[0]);
    v[0] = v0;
    vAccel[0] = v0;
    for (let i = 0; i < N - 1; i++) {
      const va = stepV2(integrator, fwdAccel, v[i], kap[i], kap[i + 1], ds, gradeAt(i), gradeAt(i + 1));
      vAccel[i + 1] = Math.min(vLimit[i + 1], va);
      v[i + 1] = Math.min(vBrake[i + 1], va);
    }
  }

  // ---------------- Post-processing: forces, power flow, energy ----------------
  const ch: LapChannels = {
    s: track.s.slice(),
    x: track.x.slice(),
    y: track.y.slice(),
    kappa: kap.slice(),
    vLimit,
    vBrake,
    vAccel,
    v,
    t: new Array(N).fill(0),
    ax: new Array(N).fill(0),
    ay: new Array(N).fill(0),
    gLong: new Array(N).fill(0),
    gLat: new Array(N).fill(0),
    gripUsage: new Array(N).fill(0),
    throttle: new Array(N).fill(0),
    brake: new Array(N).fill(0),
    motorTorque: new Array(N).fill(0),
    motorRpm: new Array(N).fill(0),
    pWheelKW: new Array(N).fill(0),
    pElecKW: new Array(N).fill(0),
    energyKWh: new Array(N).fill(0),
    heatKJ: new Array(N).fill(0),
    mode: new Array(N).fill('coast'),
    driveLimit: new Array(N).fill(''),
  };
  const E = {
    discharge: 0,
    regen: 0,
    aero: 0,
    rolling: 0,
    friction: 0,
    grade: 0,
    regenWheel: 0,
    driveWheel: 0,
    gearbox: 0,
    motorInv: 0,
    battery: 0,
    kinetic: 0,
  };
  let time = 0;
  let fullThrottleTime = 0;
  let brakeTime = 0;
  const segTime = new Array<number>(nSeg);

  for (let i = 0; i < nSeg; i++) {
    const j = next(i);
    const v0 = v[i];
    const v1 = v[j];
    const vm = 0.5 * (v0 + v1);
    const dt = vm > 1e-9 ? ds / vm : 0;
    segTime[i] = dt;
    const ax = (v1 * v1 - v0 * v0) / (2 * ds);
    const kSeg = 0.5 * (kap[i] + kap[j]);
    const ay = vm * vm * kSeg;
    const Fdrag = dragForce(veh, vm);
    const Froll = rollingResistanceForce(veh, vm);
    const gSeg = 0.5 * (gradeAt(i) + gradeAt(j));
    const Fg = gradeForce(veh.mass, gSeg);
    const Ftire = veh.mass * ax + Fdrag + Froll + Fg;
    const ayMax = ctxAyMax(ctx, vm);
    let mode: SegmentMode = 'coast';
    let throttle = 0;
    let brake = 0;
    let flow;
    let driveLimit: LapChannels['driveLimit'][number] = '';
    if (Ftire > 1) {
      flow = powerFlow(veh, pt, map, vm, Ftire);
      const da = driveAccel(ctx, vm, kSeg, usage, gSeg);
      const Favail = da.a * veh.mass + Fdrag + Froll + Fg;
      throttle = Math.min(1, Ftire / Math.max(1, curveDriveForce(curve, vm)));
      const latUse = Math.abs(ay) / ayMax;
      if (Ftire >= 0.98 * Favail) {
        mode = latUse > 0.6 ? 'cornering' : 'full-throttle';
        driveLimit = da.limit;
      } else {
        mode = latUse > 0.9 ? 'cornering' : 'part-throttle';
      }
      E.driveWheel += Ftire * ds;
      if (mode === 'full-throttle') fullThrottleTime += dt;
    } else if (Ftire < -1) {
      const Fb = -Ftire;
      const decel = Fb / veh.mass;
      const share = rearBrakeShare(veh, vm, decel, ay);
      const Fregen = Math.min(Fb * share, curveRegenForce(curve, vm));
      flow = powerFlow(veh, pt, map, vm, -Fregen);
      E.friction += (Fb - Fregen) * ds;
      E.regenWheel += Fregen * ds;
      const Fmax = totalBrakeCapacity(veh, vm, -decel, ay);
      brake = Math.min(1, Fb / Math.max(1, Fmax));
      mode = brake > 0.05 ? 'brake' : 'coast';
      if (mode === 'brake') brakeTime += dt;
    } else {
      flow = powerFlow(veh, pt, map, vm, 0);
      mode = Math.abs(ay) / ayMax > 0.9 ? 'cornering' : 'coast';
    }
    const pElec = flow.pElec;
    if (pElec >= 0) E.discharge += pElec * dt;
    else E.regen += -pElec * dt;
    E.aero += Fdrag * ds;
    E.rolling += Froll * ds;
    E.grade += Fg * ds;
    E.gearbox += flow.lossGearbox * dt;
    E.motorInv += flow.lossMotorInverter * dt;
    E.battery += flow.lossBattery * dt;
    E.kinetic += veh.mass * ax * ds;

    // combined grip usage on the friction ellipse
    const FxCap = Ftire >= 0 ? rearTractionCapacity(veh, vm, ax, ay) : totalBrakeCapacity(veh, vm, ax, ay);
    const gx = Ftire / Math.max(1, FxCap);
    const gy = Math.abs(ay) / ayMax;

    ch.t[i] = time;
    ch.ax[i] = ax;
    ch.ay[i] = ay;
    ch.gLong[i] = ax / GRAVITY;
    ch.gLat[i] = ay / GRAVITY;
    ch.gripUsage[i] = Math.min(1.2, Math.sqrt(gx * gx + gy * gy));
    ch.throttle[i] = throttle;
    ch.brake[i] = brake;
    ch.motorTorque[i] = flow.motorTorque;
    ch.motorRpm[i] = flow.motorRpm;
    ch.pWheelKW[i] = flow.pWheel / 1000;
    ch.pElecKW[i] = pElec / 1000;
    ch.energyKWh[i] = (E.discharge - E.regen) / 3.6e6;
    ch.heatKJ[i] = (E.motorInv + E.gearbox) / 1000;
    ch.mode[i] = mode;
    ch.driveLimit[i] = driveLimit;
    time += dt;
  }
  if (!closed) {
    const L = N - 1;
    ch.t[L] = time;
    for (const key of ['ax', 'ay', 'gLong', 'gLat', 'gripUsage', 'throttle', 'brake', 'motorTorque', 'motorRpm', 'pWheelKW', 'pElecKW'] as const) {
      ch[key][L] = ch[key][L - 1];
    }
    ch.energyKWh[L] = (E.discharge - E.regen) / 3.6e6;
    ch.heatKJ[L] = (E.motorInv + E.gearbox) / 1000;
    ch.mode[L] = ch.mode[L - 1];
  }
  const lapTime = time;

  // sectors
  const sectors = [];
  for (let k = 0; k < track.sectors.length - 1; k++) {
    const s0 = track.sectors[k];
    const s1 = track.sectors[k + 1];
    let st = 0;
    for (let i = 0; i < nSeg; i++) {
      const sm = track.s[i] + 0.5 * ds;
      if (sm >= s0 && sm < s1) st += segTime[i];
    }
    sectors.push({ index: k + 1, s0, s1, time: st });
  }
  const timeAt = (sq: number) => {
    const idx = Math.min(nSeg - 1, Math.max(0, Math.floor(sq / ds)));
    const frac = (sq - idx * ds) / ds;
    return ch.t[idx] + frac * segTime[idx];
  };
  const timedWindows = (track.timedWindows ?? []).map((w) => ({ ...w, time: timeAt(w.s1) - timeAt(w.s0) }));

  // corners
  const corners: CornerResult[] = detectCorners(track).map((c) => {
    const i0 = Math.round(c.sStart / ds);
    const i1 = Math.round(c.sEnd / ds);
    let vmin = Infinity;
    let peakLat = 0;
    for (let i = i0; i <= i1 && i < N; i++) {
      vmin = Math.min(vmin, v[i]);
      peakLat = Math.max(peakLat, Math.abs(ch.gLat[i]));
    }
    return {
      ...c,
      apexSpeed: v[c.apexIndex],
      minSpeed: vmin,
      entrySpeed: v[Math.min(i0, N - 1)],
      exitSpeed: v[Math.min(i1, N - 1)],
      peakLatG: peakLat,
    };
  });

  let maxV = 0;
  let minV = Infinity;
  let peakLat = 0;
  let peakLong = 0;
  let peakBrake = 0;
  for (let i = 0; i < N; i++) {
    maxV = Math.max(maxV, v[i]);
    minV = Math.min(minV, v[i]);
    peakLat = Math.max(peakLat, Math.abs(ch.gLat[i]));
    peakLong = Math.max(peakLong, ch.gLong[i]);
    peakBrake = Math.max(peakBrake, -ch.gLong[i]);
  }
  const distance = closed ? N * ds : (N - 1) * ds;
  const netKWh = (E.discharge - E.regen) / 3.6e6;
  const energy: EnergyBreakdown = {
    netKWh,
    dischargeKWh: E.discharge / 3.6e6,
    regenKWh: E.regen / 3.6e6,
    kineticKJ: E.kinetic / 1000,
    aeroKJ: E.aero / 1000,
    rollingKJ: E.rolling / 1000,
    frictionBrakeKJ: E.friction / 1000,
    gradeKJ: E.grade / 1000,
    regenWheelKJ: E.regenWheel / 1000,
    driveWheelKJ: E.driveWheel / 1000,
    gearboxLossKJ: E.gearbox / 1000,
    motorInverterLossKJ: E.motorInv / 1000,
    batteryLossKJ: E.battery / 1000,
    coolingHeatKJ: (E.motorInv + E.gearbox) / 1000,
  };
  const laps = track.laps;
  return {
    trackId: track.id,
    trackName: track.name,
    closed,
    integrator,
    lateralModel: ctx.env.model,
    lapTime,
    distance,
    avgSpeed: distance / lapTime,
    maxSpeed: maxV,
    minSpeed: minV,
    peakLatG: peakLat,
    peakLongG: peakLong,
    peakBrakeG: peakBrake,
    fullThrottleFraction: fullThrottleTime / lapTime,
    brakingFraction: brakeTime / lapTime,
    sectors,
    timedWindows,
    corners,
    energy,
    channels: ch,
    event: {
      laps,
      totalTime: lapTime * laps,
      totalEnergyKWh: netKWh * laps,
      totalHeatMJ: (energy.coolingHeatKJ * laps) / 1000,
    },
  };
}
