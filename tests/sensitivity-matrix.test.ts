import { describe, expect, it } from 'vitest';
import { DEFAULT_POWERTRAIN, DEFAULT_VEHICLE } from '@/lib/physics';
import { computeSetupJacobian } from '@/lib/solver/sensitivity';
import { compareVehicleSetups, solveVehicleSetup, type VehicleSetup } from '@/lib/solver/setup-matrix';
import { buildAcceleration, buildAutocross } from '@/lib/tracks';

const base: VehicleSetup = {
  name: 'Active', veh: DEFAULT_VEHICLE, pt: DEFAULT_POWERTRAIN,
  model: 'point-mass', integrator: 'rk4', racingLineMode: 'centerline',
};

describe('Setup comparison and Jacobian', () => {
  it('aligns sector results to common track gates and reports zero deltas for an identical setup', () => {
    const track = buildAutocross();
    const [active, ghost, reference] = compareVehicleSetups(track, [base, { ...base, name: 'Ghost' }, {
      ...base, name: 'Reference', veh: { ...base.veh, mass: 260 }, racingLineMode: 'optimal',
    }]);
    expect(ghost.metrics).toEqual(active.metrics);
    expect(ghost.deltaToActive.lapTimeS).toBe(0);
    expect(reference.metrics.sectors.reduce((total, sector) => total + sector.timeS, 0)).toBeCloseTo(reference.metrics.lapTimeS, 9);
    expect(reference.metrics.sectors.some((sector) => (sector.apexSpeedKph ?? 0) > 0)).toBe(true);
    expect(reference.deltaToActive.netEnergyKWh).toBeCloseTo(reference.metrics.netEnergyKWh - active.metrics.netEnergyKWh, 12);
  });

  it('leaves apex speeds empty for a straight and identifies a non-dominated setup', () => {
    const setups = compareVehicleSetups(buildAcceleration(), [base, { ...base }, { ...base, pt: { ...base.pt, batteryPowerLimit: 35000 } }]);
    expect(setups.flatMap((setup) => setup.metrics.sectors).every((sector) => sector.apexSpeedKph === null)).toBe(true);
    expect(setups.some((setup) => setup.paretoOptimal)).toBe(true);
  });

  it('matches independent central differences and varies all five inputs by the specified amounts', () => {
    const track = buildAutocross();
    const entries = computeSetupJacobian(track, base.veh, base.pt);
    expect(entries.map((entry) => entry.key)).toEqual(['aeroBalance', 'gearRatio', 'frontRollStiffness', 'mass', 'tirePressure']);
    const [aero, ratio, roll, mass, pressure] = entries;
    expect(aero.highValue - aero.lowValue).toBeCloseTo(4);
    expect(ratio.highValue - ratio.lowValue).toBeCloseTo(base.pt.gearRatio * 0.10);
    expect(roll.highValue - roll.lowValue).toBeCloseTo(base.veh.rollStiffnessFront * 10);
    expect(pressure.highValue - pressure.lowValue).toBeCloseTo(0.4);
    expect(pressure.highDeltaMs).not.toBe(0);
    const low = solveVehicleSetup(track, { ...base, veh: { ...base.veh, mass: base.veh.mass - 10 } });
    const high = solveVehicleSetup(track, { ...base, veh: { ...base.veh, mass: base.veh.mass + 10 } });
    expect(mass.msPerUnit).toBeCloseTo((high.lapTime - low.lapTime) * 1000 / 20, 8);
    expect(mass.whPerUnit).toBeCloseTo((high.energy.netKWh - low.energy.netKWh) * 1000 / 20, 8);
  });
});
