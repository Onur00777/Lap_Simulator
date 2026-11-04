import { buildAcceleration } from './acceleration';
import { buildAutocross, buildEndurance } from './circuits';
import { buildSkidpad } from './skidpad';
import type { Track } from './types';

export * from './types';
export * from './geometry';
export * from './skidpad';
export * from './acceleration';
export * from './circuits';
export * from './csv';

export type PresetTrackId = 'skidpad' | 'acceleration' | 'autocross' | 'endurance';

export const PRESET_TRACKS: { id: PresetTrackId; label: string }[] = [
  { id: 'skidpad', label: 'FS Skidpad' },
  { id: 'acceleration', label: 'FS Acceleration 75 m' },
  { id: 'autocross', label: 'FS Autocross' },
  { id: 'endurance', label: 'FS Endurance' },
];

const cache = new Map<PresetTrackId, Track>();

export function getPresetTrack(id: PresetTrackId): Track {
  const hit = cache.get(id);
  if (hit) return hit;
  let t: Track;
  switch (id) {
    case 'skidpad':
      t = buildSkidpad();
      break;
    case 'acceleration':
      t = buildAcceleration();
      break;
    case 'autocross':
      t = buildAutocross();
      break;
    case 'endurance':
      t = buildEndurance();
      break;
  }
  cache.set(id, t);
  return t;
}
