import { buildAcceleration } from './acceleration';
import { buildAutocross, buildEndurance } from './circuits';
import { makeTrack, trackGeometryFromPoints } from './geometry';
import { getKorfezTrack, type KorfezTrackId } from './korfez';
import { buildSkidpad } from './skidpad';
import type { Track } from './types';
import { HAVUZ_CENTERLINE_NODES } from '../ist26-havuz/precomputed-logs';

export * from './types';
export * from './geometry';
export * from './skidpad';
export * from './acceleration';
export * from './circuits';
export * from './csv';
export * from './korfez';

export type PresetTrackId = 'skidpad' | 'acceleration' | 'autocross' | 'endurance' | 'itu-havuz' | KorfezTrackId;

export const PRESET_TRACKS: { id: PresetTrackId; label: string }[] = [
  { id: 'skidpad', label: 'FS Skidpad' },
  { id: 'acceleration', label: 'FS Acceleration 75 m' },
  { id: 'autocross', label: 'FS Autocross' },
  { id: 'endurance', label: 'FS Endurance' },
  { id: 'itu-havuz', label: 'İTÜ Havuz Otoparkı (135m)' },
];

export function buildItuHavuzTrack(): Track {
  const geo = trackGeometryFromPoints(
    HAVUZ_CENTERLINE_NODES.map((n) => ({ x: n.x, y: n.y })),
    { closed: true, ds: 1.0, minSpacing: 0.8, smoothing: 3 },
  );
  const track = makeTrack(
    {
      id: 'itu-havuz',
      name: 'İTÜ Ayazağa Havuz Otoparkı (KDE Loop)',
      kind: 'autocross',
      description:
        '135.4 m İTÜ Olimpik Havuz Otoparkı — 43 gerçek log turundan 2D KDE ile çıkarılan kapalı pist (±1.5 m koni koridoru)',
      laps: 15,
      sectors: [0, geo.length / 3, (2 * geo.length) / 3, geo.length],
    },
    geo,
    true,
  );
  track.width = 3.0;
  return track;
}

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
    case 'itu-havuz':
      t = buildItuHavuzTrack();
      break;
    default:
      t = getKorfezTrack(id);
      break;
  }
  cache.set(id, t);
  return t;
}
