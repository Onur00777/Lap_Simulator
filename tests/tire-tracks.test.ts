import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIRE as tire,
  lateralCoefficients,
  lateralForce,
  muLateral,
  peakLateralForce,
  peakSlip,
  slipAngleForForce,
} from '@/lib/physics';
import {
  detectCorners,
  getPresetTrack,
  hasSelfIntersection,
  parseTrackCsv,
  trackFromCsv,
  trackStats,
  trackToCsv,
} from '@/lib/tracks';

describe('Pacejka Magic Formula tire', () => {
  it('peaks at D = mu(Fz) Fz at the analytic peak slip angle', () => {
    for (const Fz of [400, 750, 1500]) {
      const c = lateralCoefficients(tire, Fz);
      const aPeak = peakSlip(c);
      expect(lateralForce(tire, aPeak, Fz)).toBeCloseTo(peakLateralForce(tire, Fz), 6);
      let best = 0;
      for (let a = 0; a < 0.4; a += 1e-4) best = Math.max(best, lateralForce(tire, a, Fz));
      expect(best).toBeLessThanOrEqual(c.D * (1 + 1e-9));
    }
  });

  it('shows load sensitivity: mu decreases and Fy_peak is concave in Fz', () => {
    expect(muLateral(tire, 1500)).toBeLessThan(muLateral(tire, 500));
    const f = (Fz: number) => peakLateralForce(tire, Fz);
    expect(f(1000)).toBeGreaterThan(0.5 * (f(500) + f(1500)));
  });

  it('is odd-symmetric and invertible on the stable branch', () => {
    expect(lateralForce(tire, -0.05, 800)).toBeCloseTo(-lateralForce(tire, 0.05, 800), 9);
    const Fy = 0.7 * peakLateralForce(tire, 800);
    expect(lateralForce(tire, slipAngleForForce(tire, Fy, 800), 800)).toBeCloseTo(Fy, 3);
  });
});

describe('Formula Student tracks', () => {
  it.each(['autocross', 'endurance'] as const)('%s is a valid closed circuit >= 1200 m', (id) => {
    const t = getPresetTrack(id);
    const st = trackStats(t);
    expect(t.closed).toBe(true);
    expect(st.length).toBeGreaterThanOrEqual(1200);
    expect(Math.abs(st.totalTurnDeg - 360)).toBeLessThan(1);
    expect(st.minRadius).toBeGreaterThan(4.5);
    expect(hasSelfIntersection(t.x, t.y, true)).toBe(false);
    expect(detectCorners(t).length).toBeGreaterThan(15);
  });

  it('skidpad uses the FS geometry and acceleration is 75 m', () => {
    const sk = getPresetTrack('skidpad');
    const R = 15.25 / 2 + 1.5;
    const k = sk.kappa.filter((x) => Math.abs(x) > 0);
    k.forEach((x) => expect(Math.abs(x)).toBeCloseTo(1 / R, 9));
    expect(getPresetTrack('acceleration').length).toBeCloseTo(75, 9);
  });

  it('round-trips through CSV export / import', () => {
    const t = getPresetTrack('endurance');
    const csv = trackToCsv(t);
    expect(parseTrackCsv(csv).skippedLines).toBe(1); // header
    const t2 = trackFromCsv(csv);
    expect(t2.closed).toBe(true);
    expect(Math.abs(t2.length - t.length) / t.length).toBeLessThan(0.005);
  });

  it('rejects CSVs with too few points', () => {
    expect(() => trackFromCsv('x,y\n0,0\n1,1')).toThrow();
  });
});
