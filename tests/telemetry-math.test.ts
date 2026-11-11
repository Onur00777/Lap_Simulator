import { describe, expect, it } from 'vitest';
import { compileMathChannel } from '@/lib/telemetry/math-parser';
import { deltaTimeAtDistance, sampleDeltaTime } from '@/lib/telemetry/distance';
import { createContext, simulateLap, type LapResult } from '@/lib/solver';
import { DEFAULT_POWERTRAIN, DEFAULT_VEHICLE } from '@/lib/physics';
import { buildCircle } from '@/lib/tracks';

describe('Math channels', () => {
  it('evaluates all samples with operator precedence and right-associative powers', () => {
    expect(compileMathChannel('-2^2 + 2^3^2 + 2^-2 * v')({ v: [0, 4, 8] }, 3)).toEqual([508, 509, 510]);
    expect(compileMathChannel('min(10, max(abs(gLong), sqrt(gLat^2)))')({ gLong: [-1, 12], gLat: [3, -2] }, 2)).toEqual([3, 10]);
  });

  it('smooths across a rolling sample window and leaves undefined arithmetic empty', () => {
    expect(compileMathChannel('filter(v, 3) + throttle')({ v: [1, 2, 3, 7], throttle: [0, 0, 0, 0.5] }, 4)).toEqual([1, 1.5, 2, 4.5]);
    expect(compileMathChannel('v / gLong')({ v: [3, 9], gLong: [0, 3] }, 3)).toEqual([null, 3, null]);
  });

  it('rejects invalid syntax, unknown functions and property access', () => {
    for (const expression of ['v +', 'min(v)', 'filter(v, 1.5)', 'gLat[0]', 'v.constructor', 'globalThis', 'eval(v)', 'sqrt(v))']) {
      expect(() => compileMathChannel(expression)).toThrow(SyntaxError);
    }
  });
});

describe('Distance-domain lap timing', () => {
  const context = createContext(DEFAULT_VEHICLE, DEFAULT_POWERTRAIN);
  const lap = simulateLap(buildCircle(20), context);
  const withTiming = (s: number[], t: number[], distance: number, lapTime: number): LapResult => ({
    ...lap, distance, lapTime, channels: { ...lap.channels, s, t },
  });

  it('interpolates unmatched distance grids and includes the closing segment', () => {
    const active = withTiming([0, 30, 70], [0, 3, 7], 100, 10);
    const baseline = withTiming([0, 20, 75], [0, 4, 15], 100, 20);
    expect(deltaTimeAtDistance(active, baseline, 50)).toBeCloseTo(-5);
    expect(deltaTimeAtDistance(active, baseline, 95)).toBeCloseTo(-9.5);
    expect(sampleDeltaTime(active, baseline).at(-1)).toEqual({ s: 100, deltaTS: -10 });
  });

  it('ends a physical-distance comparison at the shorter racing line', () => {
    const active = withTiming([0, 40], [0, 4], 80, 8);
    const baseline = withTiming([0, 50], [0, 10], 100, 20);
    expect(sampleDeltaTime(active, baseline, 3).at(-1)).toEqual({ s: 80, deltaTS: -8 });
    expect(deltaTimeAtDistance(active, baseline, 81)).toBeNull();
  });
});
