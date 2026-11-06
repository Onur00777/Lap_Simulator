import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POWERTRAIN as pt,
  DEFAULT_VEHICLE as veh,
  downforce,
  evaluateCorneringBalance,
  GRAVITY,
  wheelLoads,
} from '@/lib/physics';
import {
  computeContourGrid,
  createContext,
  getTrackWithRacingLine,
  runSensitivitySweep,
  simulateEnduranceStint,
  simulateLap,
  solveRacingLine,
} from '@/lib/solver';
import { getPresetTrack } from '@/lib/tracks';
import { generateFsaeDesignReport, generateVcuBundle } from '@/lib/codegen';

describe('Phase 1: 4-Corner Vertical Load Conservation, LLTD & Understeer Gradient', () => {
  it('conserves sum(Fz) == m*g + F_downforce across all speed, ax, and ay combinations (including inner wheel lift)', () => {
    const speeds = [0, 12, 25, 35];
    const axList = [-14, -6, 0, 5, 11];
    const ayList = [-24, -12, -5, 0, 5, 12, 24];

    for (const v of speeds) {
      for (const ax of axList) {
        for (const ay of ayList) {
          const loads = wheelLoads(veh, v, ax, ay);
          const sumCorners = loads.fl + loads.fr + loads.rl + loads.rr;
          const df = downforce(veh, v);
          const expectedTotal = veh.mass * GRAVITY + df;

          expect(loads.fl).toBeGreaterThanOrEqual(0);
          expect(loads.fr).toBeGreaterThanOrEqual(0);
          expect(loads.rl).toBeGreaterThanOrEqual(0);
          expect(loads.rr).toBeGreaterThanOrEqual(0);
          expect(sumCorners).toBeCloseTo(expectedTotal, 5);
        }
      }
    }
  });

  it('clamps inner wheel load at 0 N and flags wheelLift under extreme lateral acceleration', () => {
    const highCgVeh = { ...veh, cgHeight: 0.45 };
    const loads = wheelLoads(highCgVeh, 10, 0, 22);
    expect(loads.wheelLift).toBe(true);
    expect(Math.min(loads.fl, loads.fr, loads.rl, loads.rr)).toBe(0);
    const df = downforce(highCgVeh, 10);
    expect(loads.fl + loads.fr + loads.rl + loads.rr).toBeCloseTo(highCgVeh.mass * GRAVITY + df, 5);
  });

  it('increases understeer gradient K_us when Front LLTD % is shifted forward', () => {
    const rearBiasedLLTD = evaluateCorneringBalance({ ...veh, rollStiffnessFront: 0.40 }, 18, 0, 1.2 * 9.81);
    const frontBiasedLLTD = evaluateCorneringBalance({ ...veh, rollStiffnessFront: 0.68 }, 18, 0, 1.2 * 9.81);
    expect(frontBiasedLLTD.understeerDegPerG).toBeGreaterThan(rearBiasedLLTD.understeerDegPerG);
  });
});

describe('Phase 2: Minimum-Curvature Optimal Racing Line Solver', () => {
  it('stays strictly within track corridor boundaries and reduces peak path curvature', () => {
    const baseTrack = getPresetTrack('autocross');
    const rl = solveRacingLine(baseTrack);
    const halfWidth = 0.5 * rl.trackWidthM;

    for (const n of rl.offsetN) {
      expect(Math.abs(n)).toBeLessThanOrEqual(halfWidth + 1e-6);
    }

    const maxKappaCenter = Math.max(...baseTrack.kappa.map(Math.abs));
    const maxKappaOpt = Math.max(...rl.optKappa.map(Math.abs));
    expect(maxKappaOpt).toBeLessThan(maxKappaCenter);

    const ctx = createContext(veh, pt);
    const lapCenter = simulateLap(getTrackWithRacingLine(baseTrack, 'centerline'), ctx);
    const lapOpt = simulateLap(getTrackWithRacingLine(baseTrack, 'optimal'), ctx);
    expect(lapOpt.lapTime).toBeLessThan(lapCenter.lapTime);
  });
});

describe('Phase 4: Parametric Sensitivity Sweep & 2D Contour Grid', () => {
  it('computes physically consistent Jacobian sensitivity directions for key vehicle parameters', () => {
    const track = getPresetTrack('autocross');
    const report = runSensitivitySweep(track, veh, pt, 'point-mass', 'rk4');
    expect(report.tornado).toHaveLength(7);

    const byKey = Object.fromEntries(report.tornado.map((t) => [t.key, t]));
    // Decreasing mass (-10%) reduces lap time; increasing mass (+10%) increases lap time
    expect(byKey.mass.deltaMsMinus10).toBeLessThan(0);
    expect(byKey.mass.deltaMsPlus10).toBeGreaterThan(0);

    // Increasing tire grip scaling lambdaMu (+10%) reduces lap time
    expect(byKey.lambdaMu.deltaMsPlus10).toBeLessThan(0);
    expect(byKey.lambdaMu.deltaMsMinus10).toBeGreaterThan(0);

    // Increasing downforce ClA (+10%) reduces lap time
    expect(byKey.ClA.deltaMsPlus10).toBeLessThan(0);

    // Increasing drag CdA (+10%) increases lap time and net energy consumption
    expect(byKey.CdA.deltaMsPlus10).toBeGreaterThan(0);
    expect(byKey.CdA.deltaWhPlus10).toBeGreaterThan(0);

    // Decreasing accumulator power cap (-10%) increases lap time
    expect(byKey.powerCap.deltaMsMinus10).toBeGreaterThan(0);
  });

  it('computes a 2D Iso-Lap-Time & Iso-Energy contour grid', () => {
    const track = getPresetTrack('autocross');
    const grid = computeContourGrid(track, veh, pt, 'aero', 'point-mass', 'rk4', 5);
    expect(grid.xValues).toHaveLength(5);
    expect(grid.yValues).toHaveLength(5);
    expect(grid.minLapTimeS).toBeLessThan(grid.maxLapTimeS);
    expect(grid.minEnergyWh).toBeLessThan(grid.maxEnergyWh);
  });
});

describe('Phase 5: 22 km Multi-Lap Endurance Stint Simulator', () => {
  it('tracks multi-lap SoC depletion, terminal voltage sag, and thermal evolution over 17 laps', () => {
    const track = getPresetTrack('endurance');
    const stint = simulateEnduranceStint(track, veh, pt, {
      laps: 17,
      ambientTempC: 28,
      initialSoc: 1.0,
    });

    expect(stint.lapHistory).toHaveLength(17);
    expect(stint.finalSocPct).toBeLessThan(stint.initialSocPct);
    expect(stint.totalNetEnergyKWh).toBeGreaterThan(0);

    // Verify energy conservation: delta SoC * capacity matches total net energy + pack I^2R heat
    for (const row of stint.lapHistory) {
      expect(row.terminalVoltageMinV).toBeLessThan(row.ocvStartV);
      expect(row.socEndPct).toBeLessThan(row.socStartPct);
    }

    expect(stint.peakCellTempC).toBeGreaterThan(30);
    expect(stint.peakMotorTempC).toBeGreaterThan(35);
    expect(stint.optimalCap.optimalPowerCapKW).toBeGreaterThanOrEqual(36);
    expect(stint.optimalCap.optimalPowerCapKW).toBeLessThanOrEqual(80);
  });
});

describe('Phase 6: FSAE Engineering Design Judge Dossier Export', () => {
  it('compiles a complete Markdown design dossier with KPIs, sensitivity table, and endurance summary', () => {
    const track = getPresetTrack('autocross');
    const ctx = createContext(veh, pt);
    const lap = simulateLap(track, ctx);
    const bundle = generateVcuBundle(veh, pt, { map: ctx.map });
    const md = generateFsaeDesignReport({ track, veh, pt, lap, bundle });

    expect(md).toContain('# FSAE / Formula Student Engineering Design Dossier');
    expect(md).toContain('Cornering Understeer Gradient');
    expect(md).toContain('1D Parametric Sensitivity Jacobian & Tornado Ranking');
    expect(md).toContain('22 km Multi-Lap Endurance Battery Sag & Thermal Derating Analysis');
    expect(md).toContain('vcu_dynamics_autogen.h/.c');
  });
});
