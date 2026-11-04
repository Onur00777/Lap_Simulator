import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POWERTRAIN,
  DEFAULT_VEHICLE,
  GRAVITY,
  buildEfficiencyMap,
  downforce,
  longitudinalCoefficients,
  muLongitudinal,
  peakSlip,
  wheelLoads,
} from '@/lib/physics';
import { createContext, simulateLap } from '@/lib/solver';
import {
  SKIDPAD_LINE_RADIUS,
  buildAcceleration,
  buildCircle,
  buildSkidpad,
  getPresetTrack,
  simulateLaunch,
  skidpadSteadyState,
} from '@/lib/tracks';

const veh = DEFAULT_VEHICLE;
const pt = DEFAULT_POWERTRAIN;
const ctx = createContext(veh, pt);
const map = buildEfficiencyMap(pt);

const relErr = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/** Trapezoidal integral of f(i) over the time channel. */
function integrateOverTime(t: number[], f: (i: number) => number, n = t.length): number {
  let acc = 0;
  for (let i = 1; i < n; i++) acc += 0.5 * (f(i) + f(i - 1)) * (t[i] - t[i - 1]);
  return acc;
}

describe('Skidpad — analytical steady-state check', () => {
  const ss = skidpadSteadyState(veh, undefined, SKIDPAD_LINE_RADIUS);

  it('closed-form v^2 = mu m g / (m/R - 0.5 rho ClA mu) is self-consistent', () => {
    const m = veh.mass;
    const v2 = (ss.muEffective * m * GRAVITY) / (m / ss.radius - 0.5 * veh.airDensity * veh.ClA * ss.muEffective);
    expect(relErr(Math.sqrt(v2), ss.speed)).toBeLessThan(1e-9);
    // centripetal force equals friction-limited force on the aero-loaded car
    const Fc = (m * ss.speed ** 2) / ss.radius;
    const Fmu = ss.muEffective * (m * GRAVITY + downforce(veh, ss.speed));
    expect(relErr(Fc, Fmu)).toBeLessThan(1e-9);
  });

  it('produces a physically plausible FS skidpad result', () => {
    expect(ss.ayG).toBeGreaterThan(1.4);
    expect(ss.ayG).toBeLessThan(2.2);
    expect(ss.lapTime).toBeGreaterThan(4.2);
    expect(ss.lapTime).toBeLessThan(5.5);
  });

  it('QSS solver on a constant-radius circle matches the analytic lap time within 1 %', () => {
    for (const integrator of ['rk4', 'euler'] as const) {
      const lap = simulateLap(buildCircle(SKIDPAD_LINE_RADIUS, 0.25), ctx, { integrator });
      expect(relErr(lap.lapTime, ss.lapTime)).toBeLessThan(0.01);
      expect(relErr(lap.peakLatG, ss.ayG)).toBeLessThan(0.01);
    }
  });

  it('timed figure-of-eight laps (2nd right, 2nd left) match the analytic time within 1 %', () => {
    const lap = simulateLap(buildSkidpad(), ctx);
    expect(lap.timedWindows).toHaveLength(2);
    for (const w of lap.timedWindows) expect(relErr(w.time, ss.lapTime)).toBeLessThan(0.01);
  });

  it('more downforce gives a faster skidpad (aero sensitivity)', () => {
    const hi = skidpadSteadyState({ ...veh, ClA: veh.ClA + 1 });
    expect(hi.lapTime).toBeLessThan(ss.lapTime);
  });
});

describe('75 m acceleration — power ceiling & tire friction consistency', () => {
  const launch = simulateLaunch(veh, pt, map);

  it('timed 75 m run is between 3.4 s and 3.9 s', () => {
    expect(launch.time75).toBeGreaterThan(3.4);
    expect(launch.time75).toBeLessThan(3.9);
  });

  it('never exceeds the 80 kW accumulator ceiling', () => {
    const peak = Math.max(...launch.samples.map((s) => s.pElec));
    expect(peak).toBeLessThanOrEqual(pt.batteryPowerLimit * (1 + 1e-6));
    expect(peak).toBeGreaterThan(0.95 * pt.batteryPowerLimit); // the run does reach the power limit
  });

  it('respects the tire friction limit and traction-control slip limit', () => {
    for (const s of launch.samples) {
      const L = wheelLoads(veh, s.v, s.ax, 0);
      const FxMax = muLongitudinal(veh.tire, L.rl) * L.rl + muLongitudinal(veh.tire, L.rr) * L.rr;
      expect(s.fx).toBeLessThanOrEqual(FxMax * (1 + 1e-9));
    }
    const kPeak = peakSlip(longitudinalCoefficients(veh.tire, wheelLoads(veh, 0, 0, 0).rl));
    expect(launch.peakSlip).toBeLessThan(kPeak);
  });

  it('is slower than the ideal friction/power-limited bound and faster than a 50 % margin on it', () => {
    // bound: a(v) = min(mu_peak g, P_max * eta / (m v)), no drag, no rolling resistance
    const muMax = Math.max(muLongitudinal(veh.tire, 300), muLongitudinal(veh.tire, 1));
    const P = pt.batteryPowerLimit * 0.97;
    let x = 0;
    let v = 0;
    let t = 0;
    const dt = 1e-4;
    let tStart = NaN;
    while (x < 75.3) {
      const a = Math.min(muMax * GRAVITY, v > 0 ? P / (veh.mass * v) : Infinity);
      v += a * dt;
      x += v * dt;
      t += dt;
      if (Number.isNaN(tStart) && x >= 0.3) tStart = t;
    }
    const bound = t - tStart;
    expect(launch.time75).toBeGreaterThan(bound);
    expect(launch.time75).toBeLessThan(1.5 * bound);
  });

  it('agrees with the QSS forward integration on the same straight within 5 %', () => {
    const lap = simulateLap(buildAcceleration(), ctx);
    expect(relErr(lap.lapTime, launch.standingTime75)).toBeLessThan(0.05);
  });
});

describe('Energy conservation — ∫ P_batt dt = ΔKE + aero + rolling (+ powertrain & brake losses)', () => {
  it('holds for the 75 m acceleration run (QSS) within 1 %', () => {
    const lap = simulateLap(buildAcceleration(), ctx);
    const ch = lap.channels;
    const n = ch.s.length;
    // battery energy: per-segment power (stored at the segment start node) times segment time
    let Ebatt = 0;
    for (let i = 0; i < n - 1; i++) Ebatt += ch.pElecKW[i] * 1000 * (ch.t[i + 1] - ch.t[i]);
    // independent mechanical terms from the speed trace
    const dKE = 0.5 * veh.mass * (ch.v[n - 1] ** 2 - ch.v[0] ** 2);
    const Eaero = integrateOverTime(ch.t, (i) => 0.5 * veh.airDensity * veh.CdA * ch.v[i] ** 3);
    const Eroll = integrateOverTime(ch.t, (i) => veh.rollingResistance * (veh.mass * GRAVITY + downforce(veh, ch.v[i])) * ch.v[i]);
    const losses = (lap.energy.motorInverterLossKJ + lap.energy.gearboxLossKJ) * 1000;
    expect(relErr(Ebatt, dKE + Eaero + Eroll + losses)).toBeLessThan(0.01);
    // wheel-level balance (battery minus powertrain losses)
    expect(relErr(Ebatt - losses, dKE + Eaero + Eroll)).toBeLessThan(0.01);
    expect(Eaero).toBeGreaterThan(0);
    expect(Eroll).toBeGreaterThan(0);
  });

  it('holds for a closed endurance lap (ΔKE = 0, braking and regen included) within 2 %', () => {
    const lap = simulateLap(getPresetTrack('endurance'), ctx);
    const ch = lap.channels;
    const n = ch.s.length;
    const lapT = [...ch.t, lap.lapTime];
    const vv = [...ch.v, ch.v[0]];
    let Enet = 0;
    for (let i = 0; i < n; i++) Enet += ch.pElecKW[i] * 1000 * (lapT[i + 1] - lapT[i]);
    const Eaero = integrateOverTime(lapT, (i) => 0.5 * veh.airDensity * veh.CdA * vv[i] ** 3);
    const Eroll = integrateOverTime(lapT, (i) => veh.rollingResistance * (veh.mass * GRAVITY + downforce(veh, vv[i])) * vv[i]);
    const e = lap.energy;
    const rhs = Eaero + Eroll + (e.frictionBrakeKJ + e.motorInverterLossKJ + e.gearboxLossKJ) * 1000;
    expect(relErr(Enet, rhs)).toBeLessThan(0.02);
    expect(Math.abs(e.kineticKJ)).toBeLessThan(1e-6);
    expect(relErr(Enet / 3.6e6, e.netKWh)).toBeLessThan(1e-9);
    expect(e.regenKWh).toBeGreaterThan(0);
  });

  it('transient RK4 launch: accumulator energy covers kinetic + aero + rolling with a realistic efficiency', () => {
    const launch = simulateLaunch(veh, pt, map, { stagingOffset: 0 });
    const s = launch.samples;
    const t = s.map((p) => p.t);
    const last = s[s.length - 1];
    const dKE = 0.5 * veh.mass * last.v ** 2;
    const Eaero = integrateOverTime(t, (i) => 0.5 * veh.airDensity * veh.CdA * s[i].v ** 3);
    const Eroll = integrateOverTime(t, (i) => veh.rollingResistance * (veh.mass * GRAVITY + downforce(veh, s[i].v)) * s[i].v);
    const Ebatt = launch.energyKWh * 3.6e6;
    const eta = (dKE + Eaero + Eroll) / Ebatt;
    expect(eta).toBeGreaterThan(0.78);
    expect(eta).toBeLessThan(0.97);
  });
});
