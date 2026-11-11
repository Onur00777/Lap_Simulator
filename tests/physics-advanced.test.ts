import { describe, expect, it } from 'vitest';
import { sampleRideHeightAero, type RideHeightAeroMap } from '@/lib/physics/aero';
import { blendBraking, DEFAULT_ROTOR, rotorFrictionScale, stepBrakeRotors } from '@/lib/physics/brakes';
import { buildEfficiencyMap, DEFAULT_POWERTRAIN } from '@/lib/physics/powertrain';
import {
  combinedTireForces, DEFAULT_TIRE, DEFAULT_TIRE_THERMAL, lateralForce, longitudinalForce,
  peakLateralForce, peakLongitudinalForce, stepTireThermal, tireThermalGrip,
} from '@/lib/physics/tire';
import { DEFAULT_VEHICLE, GRAVITY, vehicleAero, wheelLoads } from '@/lib/physics/vehicle';

const aeroMap: RideHeightAeroMap = {
  frontHeightsM: [0.02, 0.06], rearHeightsM: [0.02, 0.06],
  clA: [[4, 5], [3, 4]], cdA: [[1, 1.2], [1.1, 1.3]], frontFraction: [[0.55, 0.6], [0.4, 0.45]],
};

describe('Advanced tire, aero and brake models', () => {
  it('recovers both pure-slip curves and stays inside the combined force ellipse', () => {
    const load = 750;
    const tire = DEFAULT_TIRE;
    expect(combinedTireForces(tire, -0.08, 0, load).fx).toBeCloseTo(longitudinalForce(tire, -0.08, load), 10);
    expect(combinedTireForces(tire, 0, 0.07, load).fy).toBeCloseTo(lateralForce(tire, 0.07, load), 10);
    for (const kappa of [-1, -0.1, 0, 0.12, 0.9]) {
      for (const alpha of [-0.3, -0.08, 0, 0.15, 0.45]) {
        const { fx, fy } = combinedTireForces(tire, kappa, alpha, load, 0.05);
        expect(Math.hypot(fx / peakLongitudinalForce(tire, load), fy / peakLateralForce(tire, load))).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
    const camberOnly = combinedTireForces(tire, 0, 0, load, 0.05);
    expect(camberOnly.fy).toBeCloseTo(tire.camberThrustPerRad! * load * 0.05);
    expect(camberOnly.mz).toBeLessThan(0);
    expect(combinedTireForces(tire, 0.1, 0.1, 0)).toEqual({ fx: 0, fy: 0, mz: 0 });
  });

  it('conserves heat between tire nodes and reduces grip outside the working window', () => {
    const params = { ...DEFAULT_TIRE_THERMAL, coreCoolingWPerK: 0, surfaceCoolingWPerK: 0, speedCoolingWPerKPerMps: 0 };
    const initial = { coreC: 40, surfaceC: 40 };
    const next = stepTireThermal(initial, { ambientC: 20, speedMps: 0, slipPowerW: 300 }, 10, params);
    const storedJ = (next.coreC - 40) * params.coreCapacityJPerK + (next.surfaceC - 40) * params.surfaceCapacityJPerK;
    expect(storedJ).toBeCloseTo(300 * 10 * params.slipHeatFraction, 8);
    expect(next.surfaceC).toBeGreaterThan(next.coreC);
    const cooled = stepTireThermal(next, { ambientC: 20, speedMps: 20, slipPowerW: 0 }, 3600);
    expect(cooled.surfaceC).toBeGreaterThanOrEqual(20);
    expect(cooled.coreC).toBeLessThan(next.coreC);
    expect(tireThermalGrip({ coreC: 85, surfaceC: 85 })).toBe(1);
    expect(tireThermalGrip({ coreC: 115, surfaceC: 115 })).toBeLessThan(0.6);
  });

  it('interpolates the aero surface, shifts the CoP at stall, and conserves vertical load', () => {
    expect(sampleRideHeightAero(aeroMap, 0.04, 0.04).clA).toBeCloseTo(4);
    const edge = sampleRideHeightAero(aeroMap, 0.02, 0.04);
    const stalled = sampleRideHeightAero(aeroMap, 0.01, 0.04);
    expect(stalled.clA).toBeLessThan(edge.clA);
    expect(stalled.frontFraction).toBeGreaterThan(edge.frontFraction);
    const vehicle = {
      ...DEFAULT_VEHICLE,
      rideHeightAero: { map: aeroMap, staticFrontM: 0.033, staticRearM: 0.045, frontWheelRateNPerM: 18000, rearWheelRateNPerM: 18000 },
    };
    for (const ax of [-18, 0, 12]) {
      for (const ay of [-40, 0, 40]) {
        const aero = vehicleAero(vehicle, 25, ax);
        const { fl, fr, rl, rr } = wheelLoads(vehicle, 25, ax, ay);
        expect(Math.min(fl, fr, rl, rr)).toBeGreaterThanOrEqual(0);
        expect(fl + fr + rl + rr).toBeCloseTo(vehicle.mass * GRAVITY + aero.downforceN, 10);
        expect(aero.centerOfPressureFromFrontM).toBeCloseTo(vehicle.wheelbase * (1 - aero.frontFraction));
      }
    }
  });

  it('heats only loaded rotors, dissipates heat without overshooting, and fades after 550 °C', () => {
    const initial = { fl: 30, fr: 30, rl: 30, rr: 30 };
    const hydraulic = { fl: 500, fr: 0, rl: 0, rr: 0 };
    const insulated = { ...DEFAULT_ROTOR, stillAirWPerM2K: 0, speedCoolingWPerM2KPerMps: 0, emissivity: 0 };
    const hot = stepBrakeRotors(initial, hydraulic, 10, 30, 10, insulated);
    expect((hot.fl - initial.fl) * insulated.heatCapacityJPerK).toBeCloseTo(500 * 10 * 10 * insulated.heatToRotorFraction, 6);
    expect(hot.fr).toBe(30);
    const cooled = stepBrakeRotors(hot, { ...hydraulic, fl: 0 }, 30, 30, 6000);
    expect(cooled.fl).toBeGreaterThanOrEqual(30);
    expect(cooled.fl).toBeLessThan(hot.fl);
    expect(rotorFrictionScale(550)).toBe(1);
    expect(rotorFrictionScale(800)).toBeLessThan(0.4);
  });

  it('limits charging near maximum pack voltage and migrates hydraulic bias as the front fades', () => {
    const powertrain = DEFAULT_POWERTRAIN;
    const efficiency = buildEfficiencyMap(powertrain);
    const capacity = { fl: 1000, fr: 1000, rl: 1000, rr: 1000 };
    const input = {
      requestedForceN: 2000, frontBias: 0.6, speedMps: 20, tireCapacityN: capacity,
      coldHydraulicCapacityN: capacity, rotorTemperaturesC: { fl: 25, fr: 25, rl: 25, rr: 25 },
    };
    const cool = blendBraking(DEFAULT_VEHICLE, powertrain, efficiency, input);
    const hot = blendBraking(DEFAULT_VEHICLE, powertrain, efficiency, {
      ...input, rotorTemperaturesC: { ...input.rotorTemperaturesC, fl: 850, fr: 850 },
      battery: { openCircuitVoltage: 600, maxChargeVoltage: 600, maxChargeCurrent: 120, resistanceOhm: 0.35 },
    });
    expect(cool.regenN).toBeGreaterThan(0);
    expect(hot.regenN).toBe(0);
    expect(hot.hydraulicFrontBias).toBeLessThan(cool.hydraulicFrontBias);
    expect(Object.values(hot.hydraulicN).reduce((a, b) => a + b) + hot.regenN + hot.unmetForceN).toBeCloseTo(input.requestedForceN);
  });
});
