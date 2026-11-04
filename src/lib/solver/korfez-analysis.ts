import { buildTwoTrackEnvelope } from '../dynamics/two-track';
import { speedFromMotorRpm, type PowertrainParams, type VehicleParams } from '../physics';
import { KORFEZ_TRACKS, getKorfezTrack, type KorfezTrackId, type Track, type TrackLandmark } from '../tracks';
import { createContext } from './context';
import { simulateLap, type Integrator, type LapResult } from './lap-simulator';

/**
 * Millisecond timing and a per-corner breakdown for the TOSFED Körfez layouts.
 * Times are kept in seconds at full precision; format with 3 decimal places (0.001 s).
 */

export interface KorfezCornerRow {
  id: string;
  direction: 'Sol' | 'Sağ';
  apexRadiusM: number;
  entryKph: number;
  minKph: number;
  exitKph: number;
  peakLatG: number;
  brakingDistanceM: number;
  regenWh: number;
  /** Open-differential time minus torque-vectoring time through this corner. Positive = TV is faster. */
  tvGainMs: number;
}

export interface KorfezLayoutReport {
  id: KorfezTrackId;
  label: string;
  lengthM: number;
  lapTimeS: number;
  sectors: { index: number; timeS: number }[];
  avgKph: number;
  maxKph: number;
  energyWh: number;
  regenWh: number;
  /** Net consumption scaled to a 22 km endurance distance. */
  enduranceKWh: number;
  coolingKJ: number;
  peakLatG: number;
  peakBrakeG: number;
  tvDeltaS: number;
  corners: KorfezCornerRow[];
  rights: number;
  lefts: number;
  maxGrade: number;
}

const KPH = 3.6;

function idxAt(track: Track, s: number): number {
  const n = track.s.length;
  return Math.min(n - 1, Math.max(0, Math.round(s / track.ds)));
}

/** Time spent on the half-open arc [s0, s1), wrapping past the start line when s1 < s0. */
function segmentDt(lap: LapResult, i: number): number {
  const ch = lap.channels;
  const n = ch.s.length;
  return i < n - 1 ? ch.t[i + 1] - ch.t[i] : Math.max(0, lap.lapTime - ch.t[i]);
}

function arcTime(lap: LapResult, s0: number, s1: number): number {
  const ch = lap.channels;
  const inside = (s: number) => (s1 >= s0 ? s >= s0 && s < s1 : s >= s0 || s < s1);
  let t = 0;
  for (let i = 0; i < ch.s.length; i++) {
    if (inside(ch.s[i])) t += segmentDt(lap, i);
  }
  return t;
}

function brakingDistance(lap: LapResult, entry: number): number {
  const ch = lap.channels;
  const n = ch.s.length;
  const ds = n > 1 ? ch.s[1] - ch.s[0] : 0;
  let dist = 0;
  let i = entry;
  for (let k = 0; k < n; k++) {
    const p = (i - 1 + n) % n;
    if (ch.mode[p] !== 'brake') break;
    dist += ds;
    i = p;
  }
  return dist;
}

function regenWh(lap: LapResult, s0: number, s1: number): number {
  const ch = lap.channels;
  const n = ch.s.length;
  const inside = (s: number) => (s1 >= s0 ? s >= s0 && s < s1 : s >= s0 || s < s1);
  let wh = 0;
  for (let i = 0; i < n; i++) {
    if (!inside(ch.s[i]) || ch.pElecKW[i] >= 0) continue;
    wh += (-ch.pElecKW[i] * segmentDt(lap, i) * 1000) / 3600;
  }
  return wh;
}

function cornerRow(track: Track, lm: TrackLandmark, base: LapResult, open: LapResult, tv: LapResult): KorfezCornerRow {
  const ch = base.channels;
  const n = ch.s.length;
  const i0 = idxAt(track, lm.sStart);
  const i1 = idxAt(track, lm.sEnd);
  const ia = idxAt(track, lm.sApex);
  let minV = Infinity;
  let peakG = 0;
  for (let i = i0, guard = 0; guard < n; i = (i + 1) % n, guard++) {
    minV = Math.min(minV, ch.v[i]);
    peakG = Math.max(peakG, Math.abs(ch.gLat[i]));
    if (i === i1) break;
  }
  const kappa = ch.kappa[ia];
  return {
    id: lm.id,
    direction: lm.direction === 'L' ? 'Sol' : 'Sağ',
    apexRadiusM: Math.abs(kappa) > 1e-4 ? 1 / Math.abs(kappa) : Infinity,
    entryKph: ch.v[i0] * KPH,
    minKph: (Number.isFinite(minV) ? minV : ch.v[ia]) * KPH,
    exitKph: ch.v[i1] * KPH,
    peakLatG: peakG,
    brakingDistanceM: brakingDistance(base, i0),
    regenWh: regenWh(base, lm.sStart, lm.sEnd),
    tvGainMs: (arcTime(open, lm.sStart, lm.sEnd) - arcTime(tv, lm.sStart, lm.sEnd)) * 1000,
  };
}

export function analyzeKorfezLayout(
  id: KorfezTrackId,
  veh: VehicleParams,
  pt: PowertrainParams,
  integrator: Integrator = 'rk4',
): KorfezLayoutReport {
  const track = getKorfezTrack(id);
  const vTop = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio) + 2;
  const base = simulateLap(track, createContext(veh, pt), { integrator });
  const open = simulateLap(track, createContext(veh, pt, buildTwoTrackEnvelope(veh, pt, vTop, 'open')), { integrator });
  const tv = simulateLap(track, createContext(veh, pt, buildTwoTrackEnvelope(veh, pt, vTop, 'tv')), { integrator });
  const landmarks = track.landmarks ?? [];
  const corners = landmarks.map((lm) => cornerRow(track, lm, base, open, tv));
  return {
    id,
    label: KORFEZ_TRACKS.find((t) => t.id === id)?.label ?? track.name,
    lengthM: track.length,
    lapTimeS: base.lapTime,
    sectors: base.sectors.map((s) => ({ index: s.index, timeS: s.time })),
    avgKph: base.avgSpeed * KPH,
    maxKph: base.maxSpeed * KPH,
    energyWh: base.energy.netKWh * 1000,
    regenWh: base.energy.regenKWh * 1000,
    enduranceKWh: base.energy.netKWh * (22000 / track.length),
    coolingKJ: base.energy.coolingHeatKJ,
    peakLatG: base.peakLatG,
    peakBrakeG: base.peakBrakeG,
    tvDeltaS: tv.lapTime - open.lapTime,
    corners,
    rights: corners.filter((c) => c.direction === 'Sağ').length,
    lefts: corners.filter((c) => c.direction === 'Sol').length,
    maxGrade: Math.max(...(track.grade ?? [0]).map((g) => Math.abs(g))),
  };
}

export function compareKorfezLayouts(
  veh: VehicleParams,
  pt: PowertrainParams,
  integrator: Integrator = 'rk4',
): KorfezLayoutReport[] {
  return KORFEZ_TRACKS.map((t) => analyzeKorfezLayout(t.id, veh, pt, integrator));
}

/** Seconds to millisecond resolution: `65.760` or `1:05.760`. */
export function formatMs(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const sign = sec < 0 ? '-' : '';
  const a = Math.abs(sec);
  if (a < 60) return `${sign}${a.toFixed(3)}`;
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}
