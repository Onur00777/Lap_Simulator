import { describe, expect, it } from 'vitest';
import { createVehicleFusion, IST26_FUSION_PARAMS, type FusionSample } from '@/lib/ist26-havuz/ekf-fusion';
import { buildHavuzExtractedCircuit, filterTrajectoryCorridor, fitHavuzCenterline } from '@/lib/ist26-havuz/havuz-track-extractor';
import { simulateIst26OnHavuz } from '@/lib/ist26-havuz/ist26-rwd-solver';
import { exportMotecTelemetry, exportTrackGeoJson, exportTrackSvg } from '@/lib/export/telemetry-exporters';
import { GRAVITY } from '@/lib/physics';

describe('Havuz 6-DOF fusion', () => {
  it('converges to speed and sideslip on a noisy steady turn with driven-wheel slip', () => {
    const p = IST26_FUSION_PARAMS;
    const u = 8, r = 0.4, steer = 0.075;
    const rearForce = p.massKg * u * r * p.cgToFrontM / (p.cgToFrontM + p.cgToRearM);
    const v = p.cgToRearM * r - u * Math.tan(rearForce / p.rearCorneringStiffnessNPerRad);
    const wheel = (a: number, b: number, delta: number) => ((u - r * b) * Math.cos(delta) + (v + r * a) * Math.sin(delta)) / p.wheelRadiusM;
    const estimate = createVehicleFusion();
    const result = Array.from({ length: 400 }, (_, i) => estimate({
      timeS: i * 0.02,
      accelerationMps2: [-r * v + 0.05 * Math.sin(i), u * r + 0.09 * Math.cos(i * 0.9), GRAVITY + 0.04 * Math.cos(i)],
      gyroRadPerS: [0.001 * Math.sin(i), 0.001 * Math.cos(i), r + 0.005 * Math.sin(i * 2)],
      wheelOmegaRadPerS: [wheel(p.cgToFrontM, p.frontTrackM / 2, steer), wheel(p.cgToFrontM, -p.frontTrackM / 2, steer),
        wheel(-p.cgToRearM, p.rearTrackM / 2, 0) * 1.12, wheel(-p.cgToRearM, -p.rearTrackM / 2, 0) * 1.12],
      roadWheelSteerRad: steer, cascadiaHeartbeat: i % 3 === 0,
    })).at(-1)!;
    expect(Math.abs(result.bodyVelocityMps[0] - u)).toBeLessThan(0.18);
    expect(Math.abs(result.sideslipRad! - Math.atan2(v, u))).toBeLessThan(0.018);
    expect(result.wheelSlipRatio[2]).toBeGreaterThan(0.09);
    expect(result.flags.canTimeout).toBe(false);
    expect(Math.abs(result.positionM[2])).toBeLessThan(0.1);
  });

  it('reports missing sensors, long gaps and an expired heartbeat independently', () => {
    const estimate = createVehicleFusion();
    const sample: FusionSample = {
      timeS: 0, accelerationMps2: [0, 0, GRAVITY], gyroRadPerS: [0, 0, 0], wheelOmegaRadPerS: [0, 0, 0, 0], roadWheelSteerRad: 0,
    };
    expect(estimate(sample).flags.canTimeout).toBeNull();
    estimate({ ...sample, timeS: 0.02, cascadiaHeartbeat: true });
    const result = estimate({ ...sample, timeS: 0.3, cascadiaHeartbeat: false, wheelOmegaRadPerS: [0, null, 0, 0], gyroRadPerS: [null, 0, 0], roadWheelSteerRad: null });
    expect(result.flags).toEqual({ imuDropout: true, wheelDropout: true, steerDropout: true, sampleGap: true, canTimeout: true });
    expect(result.wheelSlipRatio[1]).toBeNull();
    expect(() => estimate(sample)).toThrow(RangeError);
  });
});

describe('Havuz periodic track fit and exports', () => {
  it('removes isolated noise and recovers curvature across the loop seam', () => {
    const radius = 20;
    const seed = Array.from({ length: 60 }, (_, i) => ({ x: radius * Math.cos(i * Math.PI / 30), y: radius * Math.sin(i * Math.PI / 30) }));
    const cloud = [...seed, ...seed, ...seed, ...seed, { x: 80, y: 80 }];
    expect(filterTrajectoryCorridor(cloud)).toHaveLength(240);
    const { geometry, rejectedPointCount } = fitHavuzCenterline(seed, cloud, 300);
    expect(rejectedPointCount).toBe(1);
    expect(geometry.s).toHaveLength(300);
    expect(geometry.length).toBeCloseTo(2 * Math.PI * radius, 2);
    expect(Math.max(...geometry.kappa.map((value) => Math.abs(value - 1 / radius)))).toBeLessThan(0.001);
    expect(Math.abs(geometry.kappa.at(-1)! - geometry.kappa[0])).toBeLessThan(0.0001);
  });

  it('exports a closed WGS84 corridor, numbered sectors and a uniform CSV time base', () => {
    const track = buildHavuzExtractedCircuit();
    const data = JSON.parse(exportTrackGeoJson(track, { latitude: 41, longitude: 29, rotationDeg: 0 }));
    const coordinates = data.features[0].geometry.coordinates;
    expect(data.type).toBe('FeatureCollection');
    expect(coordinates[0][0]).toBeCloseTo(29, 2);
    expect(coordinates[0][1]).toBeCloseTo(41, 2);
    expect(coordinates.at(-1)).toEqual(coordinates[0]);
    expect(data.features.filter((feature: { properties: { role: string } }) => feature.properties.role === 'sectorGate')).toHaveLength(3);
    expect(exportTrackSvg(track)).toContain('id="sector-3"');
    const csv = exportMotecTelemetry(simulateIst26OnHavuz('23_08/23_08_2026-11.31.49.csv'), 20).split('\r\n');
    expect(csv[0]).toBe('"Format","MoTeC CSV File"');
    const header = csv.findIndex((line) => line.startsWith('"Time",'));
    expect(csv[header + 4].split(',')[0]).toBe('0.05');
  });
});
