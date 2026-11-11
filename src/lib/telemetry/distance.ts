import { interp1 } from '@/lib/physics/numerics';
import type { LapResult } from '@/lib/solver';

export function sampleLapDistance(lap: LapResult, values: ArrayLike<number>, distance: number, finishValue: number): number {
  const distances = lap.channels.s;
  const last = distances.length - 1;
  if (distance <= distances[last] || lap.distance <= distances[last]) return interp1(distances, values, distance);
  const progress = Math.min(1, (distance - distances[last]) / (lap.distance - distances[last]));
  return values[last] + (finishValue - values[last]) * progress;
}

/** Cumulative time difference at the same physical distance along each path. */
export function deltaTimeAtDistance(active: LapResult, baseline: LapResult, distance: number): number | null {
  if (distance < 0 || distance > Math.min(active.distance, baseline.distance)) return null;
  const time = (lap: LapResult) => sampleLapDistance(lap, lap.channels.t, distance, lap.lapTime);
  return time(active) - time(baseline);
}

export function sampleDeltaTime(active: LapResult, baseline: LapResult, spacingM = 0.5) {
  const distance = Math.min(active.distance, baseline.distance);
  const steps = Math.min(4000, Math.max(1, Math.ceil(distance / Math.max(0.05, spacingM))));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const s = i === steps ? distance : i * distance / steps;
    return { s, deltaTS: deltaTimeAtDistance(active, baseline, s) ?? 0 };
  });
}
