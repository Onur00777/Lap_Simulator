import { describe, expect, it } from 'vitest';
import { DEFAULT_POWERTRAIN as pt, DEFAULT_VEHICLE as veh, pointMassLateralLimit, speedFromMotorRpm } from '@/lib/physics';
import { buildTwoTrackEnvelope, analyzeTorqueVectoring, tvInitialState, tvStep, defaultTVParams } from '@/lib/dynamics';
import { createContext, simulateLap } from '@/lib/solver';
import { getPresetTrack } from '@/lib/tracks';

const autocross = getPresetTrack('autocross');
const vTop = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio) + 2;

describe('QSS lap solver', () => {
  const ctx = createContext(veh, pt);
  const lap = simulateLap(autocross, ctx);

  it('speed never exceeds the cornering limit and respects the motor rpm ceiling', () => {
    lap.channels.v.forEach((v, i) => expect(v).toBeLessThanOrEqual(lap.channels.vLimit[i] + 1e-9));
    expect(lap.maxSpeed).toBeLessThanOrEqual(ctx.curve.vMax);
  });

  it('accelerations stay inside the friction envelope', () => {
    expect(lap.peakLatG).toBeLessThan(3.2);
    expect(lap.peakBrakeG).toBeLessThan(4);
    expect(lap.peakLongG).toBeLessThan(1.2);
    lap.channels.gripUsage.forEach((u) => expect(u).toBeLessThan(1.01));
  });

  it('RK4 and Euler agree within 1 % and sector times sum to the lap time', () => {
    const eu = simulateLap(autocross, ctx, { integrator: 'euler' });
    expect(Math.abs(eu.lapTime - lap.lapTime) / lap.lapTime).toBeLessThan(0.01);
    const sum = lap.sectors.reduce((a, s) => a + s.time, 0);
    expect(sum).toBeCloseTo(lap.lapTime, 6);
  });

  it('responds in the physically expected direction to parameter changes', () => {
    const grippy = simulateLap(autocross, createContext({ ...veh, tire: { ...veh.tire, lambdaMu: 1.1 } }, pt));
    const heavy = simulateLap(autocross, createContext({ ...veh, mass: veh.mass + 30 }, pt));
    const weak = simulateLap(autocross, createContext(veh, { ...pt, batteryPowerLimit: 40000 }));
    expect(grippy.lapTime).toBeLessThan(lap.lapTime);
    expect(heavy.lapTime).toBeGreaterThan(lap.lapTime);
    expect(weak.lapTime).toBeGreaterThan(lap.lapTime);
  });
});

describe('Torque vectoring', () => {
  it('lateral limits are ordered: open diff <= TV <= point-mass', () => {
    const open = buildTwoTrackEnvelope(veh, pt, vTop, 'open', 2);
    const tv = buildTwoTrackEnvelope(veh, pt, vTop, 'tv', 2);
    open.ayMax.forEach((a, i) => {
      expect(a).toBeLessThanOrEqual(tv.ayMax[i] + 1e-6);
      expect(tv.ayMax[i]).toBeLessThanOrEqual(pointMassLateralLimit(veh, i * 2) * (1 + 1e-4));
    });
  });

  it('TV reduces lap time, sharpens yaw response and reduces near-limit understeer', () => {
    const a = analyzeTorqueVectoring(veh, pt, autocross);
    expect(a.lap.deltaTv).toBeLessThan(0);
    expect(a.lap.tv).toBeGreaterThanOrEqual(a.lap.pointMass - 1e-6);
    expect(a.step.tv.riseTime).toBeLessThan(a.step.open.riseTime);
    expect(a.step.tv.overshootPct).toBeLessThan(10);
    expect(a.ramp.tv.limitGradientDegPerG).toBeLessThan(a.ramp.open.limitGradientDegPerG);
    expect(a.ramp.tv.maxAyG).toBeGreaterThan(a.ramp.open.maxAyG);
    expect(a.allocation.peakOuterWheelTorque).toBeGreaterThan(0);
    expect(a.allocation.peakInnerWheelTorque).toBeLessThan(0);
  });

  it('PI controller saturates and allocates a positive yaw moment to the outer wheel', () => {
    const p = defaultTVParams(veh, pt);
    const s = tvInitialState();
    const out = tvStep(p, s, { vx: 15, steer: 0.08, yawRate: 0.2, torqueRequest: 20 });
    expect(out.mz).toBeGreaterThan(0);
    expect(out.torqueRR).toBeGreaterThan(out.torqueRL);
    expect(Math.abs(out.torqueRR)).toBeLessThanOrEqual(p.motorTorqueLimit);
    const low = tvStep(p, tvInitialState(), { vx: 1, steer: 0.3, yawRate: 0, torqueRequest: 10 });
    expect(low.mz).toBe(0);
    expect(low.torqueRL).toBe(low.torqueRR);
  });
});
