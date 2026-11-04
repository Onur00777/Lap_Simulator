import { describe, expect, it } from 'vitest';
import { DEFAULT_POWERTRAIN as pt, DEFAULT_VEHICLE as veh } from '@/lib/physics';
import { generateVcuBundle } from '@/lib/codegen';
import { analyzeKorfezLayout, compareKorfezLayouts, formatMs } from '@/lib/solver/korfez-analysis';
import { createContext, simulateLap } from '@/lib/solver';
import { KORFEZ_FACILITY, KORFEZ_TRACKS, getKorfezTrack, hasSelfIntersection, minClearance } from '@/lib/tracks';

describe('TOSFED Körfez layouts', () => {
  it('publishes the facility record', () => {
    expect(KORFEZ_FACILITY.mainLengthM).toBe(1950);
    expect(KORFEZ_FACILITY.kartingLengthM).toBe(950);
    expect(KORFEZ_FACILITY.fstLengthM).toBe(1380);
    expect(KORFEZ_FACILITY.corners).toEqual({ total: 9, right: 4, left: 5 });
    expect(KORFEZ_FACILITY.pitGarages).toBe(22);
    expect(KORFEZ_FACILITY.timingResolutionS).toBe(0.001);
    expect(KORFEZ_FACILITY.maxGrade).toBe(0.01);
    expect(KORFEZ_TRACKS.map((t) => t.id)).toEqual(['korfez-gp-1950', 'korfez-karting-950', 'korfez-fst-1380']);
  });

  it.each([
    ['korfez-gp-1950', 1950],
    ['korfez-karting-950', 950],
    ['korfez-fst-1380', 1380],
  ] as const)('%s is a clockwise closed loop of %d m with a 1% grade wave', (id, length) => {
    const t = getKorfezTrack(id);
    expect(t.closed).toBe(true);
    expect(t.direction).toBe('clockwise');
    expect(t.venue).toBe('korfez');
    expect(Math.abs(t.length - length) / length).toBeLessThan(0.005);
    const turn = t.kappa.reduce((a, k) => a + k * t.ds, 0);
    expect(turn).toBeLessThan(-Math.PI); // net right-hand / clockwise
    expect(Math.abs(turn + 2 * Math.PI)).toBeLessThan(0.15);
    const grade = t.grade ?? [];
    expect(Math.max(...grade.map(Math.abs))).toBeLessThanOrEqual(0.01001);
    const elev = grade.reduce((a, g, i) => a + (i ? 0.5 * (g + grade[i - 1]) * t.ds : 0), 0);
    expect(Math.abs(elev)).toBeLessThan(0.05);
    expect(t.pitLane?.garages).toBe(22);
    expect(t.landmarks && t.landmarks.length).toBeGreaterThan(4);
    expect(hasSelfIntersection(t.x, t.y, true, 2)).toBe(false);
    expect(minClearance(t, 15, 2)).toBeGreaterThan(2);
  });

  it('reports the GP lap to the millisecond with a corner breakdown', () => {
    const report = analyzeKorfezLayout('korfez-gp-1950', veh, pt);
    expect(formatMs(report.lapTimeS)).toMatch(/\d+\.\d{3}$/);
    const sectorSum = report.sectors.reduce((a, s) => a + s.timeS, 0);
    expect(sectorSum).toBeCloseTo(report.lapTimeS, 3);
    expect(report.corners.length).toBeGreaterThanOrEqual(9);
    for (const c of report.corners) {
      expect(c.entryKph).toBeGreaterThan(0);
      expect(c.minKph).toBeGreaterThan(0);
      expect(c.exitKph).toBeGreaterThan(0);
      expect(c.apexRadiusM).toBeGreaterThan(3);
      expect(Number.isFinite(c.tvGainMs)).toBe(true);
      expect(c.regenWh).toBeGreaterThanOrEqual(0);
    }
    expect(report.enduranceKWh).toBeGreaterThan(1);
    expect(report.tvDeltaS).toBeLessThan(0);
  });

  it('compares the three layouts and keeps the grade work near zero on a closed lap', () => {
    const rows = compareKorfezLayouts(veh, pt);
    expect(rows.map((r) => r.id)).toEqual(['korfez-gp-1950', 'korfez-karting-950', 'korfez-fst-1380']);
    expect(rows[1].lapTimeS).toBeLessThan(rows[0].lapTimeS);
    const gp = getKorfezTrack('korfez-gp-1950');
    const lap = simulateLap(gp, createContext(veh, pt));
    expect(Math.abs(lap.energy.gradeKJ)).toBeLessThan(1);
  });

  it('emits the Körfez preset macro in the VCU header', () => {
    const bundle = generateVcuBundle(veh, pt, { korfezTrackId: 'korfez-gp-1950' });
    const header = bundle.files[0].content;
    expect(header).toContain('#define KORFEZ_TRACK_PRESET            "korfez-gp-1950"');
    expect(header).toContain('KORFEZ_TIMING_RESOLUTION_S');
    expect(header).toContain('KORFEZ_TV_KP_NM_PER_RADPS');
    expect(bundle.files[2].content).toContain('vcu_torque_map.h');
  });
});
