import { DEFAULT_POWERTRAIN, DEFAULT_TIRE, DEFAULT_VEHICLE, movingAverage, wrapAngle, type PowertrainParams, type TireParams, type VehicleParams } from '../physics';
import gpDrawing from './data/korfez-gp.json';
import kartingDrawing from './data/korfez-karting.json';
import { makeTrack, trackGeometryFromPoints } from './geometry';
import type { Track, TrackLandmark } from './types';

/**
 * TOSFED Körfez Yarış Pisti (Kocaeli / Körfez).
 *
 * Centre lines are traced from the published facility drawings (Ana Pist, Karting uzun
 * versiyon) and scaled to the official lengths. They follow the drawn racing surface;
 * they are not a surveyed GPS centre line. A ±1 % grade wave with zero net elevation
 * change carries the circuit's 1.0 % longitudinal-slope limit into the lap solver.
 */

export const KORFEZ_FACILITY = {
  name: 'TOSFED Körfez Yarış Pisti',
  location: 'Kocaeli / Körfez',
  areaM2: 250_000,
  direction: 'clockwise' as const,
  directionLabel: 'Saat yönü',
  mainLengthM: 1950,
  kartingLengthM: 950,
  fstLengthM: 1380,
  widthM: [10, 12] as const,
  maxGrade: 0.01,
  corners: { total: 9, right: 4, left: 5 },
  pitGarages: 22,
  timingResolutionS: 0.001,
  benchmarkKph: { touring: 220, formulaStudent: 125 },
};

export type KorfezTrackId = 'korfez-gp-1950' | 'korfez-karting-950' | 'korfez-fst-1380';

export const KORFEZ_TRACKS: { id: KorfezTrackId; label: string; short: string }[] = [
  { id: 'korfez-gp-1950', label: '1.950 m Ana Pist', short: 'GP' },
  { id: 'korfez-karting-950', label: '950 m Karting', short: 'Karting' },
  { id: 'korfez-fst-1380', label: '1.380 m FST Endurance', short: 'FST' },
];

type XY = [number, number];

function shoelace(pts: XY[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a;
}

/** Positive shoelace (y up) is counter-clockwise; the circuits are driven clockwise. */
function clockwise(pts: XY[]): XY[] {
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
  return shoelace(clean) > 0 ? clean.reverse() : clean;
}

function gradeWave(n: number, amplitude: number): number[] {
  const g = new Array<number>(n);
  for (let i = 0; i < n; i++) g[i] = amplitude * Math.sin((2 * Math.PI * i) / n);
  return g;
}

interface DrawingOptions {
  id: KorfezTrackId;
  name: string;
  description: string;
  target: number;
  width: number;
  ds: number;
  smoothing: number;
  /** Smallest heading change (degrees) that counts as its own corner. */
  minCornerDeg: number;
  notes?: string[];
  map?: { src: string; widthPx: number; heightPx: number };
}

function buildFromDrawing(raw: number[][], opt: DrawingOptions): Track {
  const pts = clockwise(raw as XY[]);
  const geo0 = trackGeometryFromPoints(
    pts.map(([x, y]) => ({ x, y })),
    { closed: true, ds: opt.ds, minSpacing: opt.ds, smoothing: opt.smoothing },
  );
  const k = opt.target / geo0.length;
  const geo = {
    ...geo0,
    s: geo0.s.map((s) => s * k),
    x: geo0.x.map((x) => x * k),
    y: geo0.y.map((y) => y * k),
    kappa: geo0.kappa.map((c) => c / k),
    length: geo0.length * k,
    ds: geo0.ds * k,
  };
  const track = makeTrack(
    {
      id: opt.id,
      name: opt.name,
      kind: 'endurance',
      description: opt.description,
      laps: Math.max(1, Math.round(22000 / opt.target)),
      sectors: [0, opt.target / 3, (2 * opt.target) / 3, opt.target],
    },
    geo,
    true,
  );
  const found = significantCorners(track, opt.minCornerDeg);
  track.landmarks = found.map((c, i): TrackLandmark => ({
    id: `T${i + 1}`,
    name: `T${i + 1}`,
    direction: c.direction,
    note: opt.notes?.[i] ?? (c.direction === 'L' ? 'Sol' : 'Sağ'),
    sStart: c.sStart,
    sApex: c.sApex,
    sEnd: c.sEnd,
  }));
  track.grade = gradeWave(track.s.length, KORFEZ_FACILITY.maxGrade);
  if (opt.map) track.mapImage = { ...opt.map, metersPerPixel: k };
  track.pitLane = pitLane(track, opt.width);
  track.width = opt.width;
  track.direction = 'clockwise';
  track.venue = 'korfez';
  return track;
}

/** Pit lane just infield (right-hand side) of the longest straight. */
function pitLane(track: Track, offset: number) {
  const n = track.kappa.length;
  const thresh = 1 / 120;
  let bestA = 0;
  let bestB = 1;
  let bestScore = Infinity;
  let a = 0;
  for (let i = 0; i <= n; i++) {
    if (i < n && Math.abs(track.kappa[i]) < thresh) continue;
    const len = i - a;
    if (len > 8) {
      let y = 0;
      for (let k = a; k < i; k++) y += track.y[k];
      const score = y / len - len * track.ds * 0.02;
      if (score < bestScore) {
        bestScore = score;
        bestA = a;
        bestB = i - 1;
      }
    }
    a = i + 1;
  }
  const x: number[] = [];
  const y: number[] = [];
  const stalls = 30;
  for (let s = 0; s <= stalls; s++) {
    const idx = Math.round(bestA + ((bestB - bestA) * s) / stalls);
    const h = track.heading[Math.min(n - 1, Math.max(0, idx))];
    x.push(track.x[idx] + offset * Math.sin(h));
    y.push(track.y[idx] - offset * Math.cos(h));
  }
  return { x, y, garages: KORFEZ_FACILITY.pitGarages };
}

function significantCorners(track: Track, minDeg: number): { direction: 'L' | 'R'; sStart: number; sApex: number; sEnd: number }[] {
  const n = track.kappa.length;
  const half = Math.max(1, Math.round(18 / track.ds));
  const k = movingAverage(track.kappa, half, true);
  const sign = k.map((v) => (Math.abs(v) < 1 / 400 ? 0 : Math.sign(v)));
  let origin = sign.findIndex((s) => s === 0);
  if (origin < 0) origin = 0;
  const at = (i: number) => (origin + i) % n;
  const groups: { a: number; b: number; sign: number; angle: number; peak: number }[] = [];
  let i = 0;
  while (i < n) {
    if (sign[at(i)] === 0) {
      i++;
      continue;
    }
    const s = sign[at(i)];
    const a = i;
    let angle = 0;
    let peak = a;
    while (i < n && sign[at(i)] === s) {
      angle += k[at(i)] * track.ds;
      if (Math.abs(k[at(i)]) > Math.abs(k[at(peak)])) peak = i;
      i++;
    }
    groups.push({ a, b: i - 1, sign: s, angle, peak });
  }
  const merged: typeof groups = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && prev.sign === g.sign && (g.a - prev.b) * track.ds < 45) {
      prev.b = g.b;
      prev.angle += g.angle;
      if (Math.abs(k[at(g.peak)]) > Math.abs(k[at(prev.peak)])) prev.peak = g.peak;
    } else merged.push({ ...g });
  }
  return merged
    .filter((g) => Math.abs(g.angle) * (180 / Math.PI) >= minDeg)
    .map((g) => ({
      direction: (g.sign > 0 ? 'L' : 'R') as 'L' | 'R',
      sStart: track.s[at(g.a)],
      sApex: track.s[at(g.peak)],
      sEnd: track.s[at(g.b)],
      angle: g.angle,
    }))
    .sort((p, q) => p.sStart - q.sStart);
}

function turnAt(pts: XY[], i: number): number {
  const n = pts.length;
  const a = pts[(i - 1 + n) % n];
  const b = pts[i];
  const c = pts[(i + 1) % n];
  return wrapAngle(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
}

function fstDrawing(gp: XY[]): XY[] {
  return chicanesOnStraights(gp);
}

function chicanesOnStraights(pts: XY[]): XY[] {
  const n = pts.length;
  const straight: boolean[] = pts.map((_, i) => Math.abs(turnAt(pts, i)) < 0.08);
  const runs: { a: number; b: number }[] = [];
  let a = 0;
  for (let i = 0; i <= n; i++) {
    if (i < n && straight[i]) continue;
    if (i - a > 6) runs.push({ a, b: i - 1 });
    a = i + 1;
  }
  runs.sort((p, q) => q.b - q.a - (p.b - p.a));
  const chosen = runs.slice(0, 2).sort((p, q) => p.a - q.a);
  let out = pts.slice();
  for (const run of chosen.reverse()) {
    const i0 = run.a + Math.round((run.b - run.a) * 0.45);
    const p = out[i0];
    const q = out[Math.min(out.length - 1, i0 + 1)];
    const h = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const nx = -Math.sin(h);
    const ny = Math.cos(h);
    const w = 34;
    const zig: XY[] = [
      [p[0] + nx * w, p[1] + ny * w],
      [p[0] + (q[0] - p[0]) * 0.5 - nx * w, p[1] + (q[1] - p[1]) * 0.5 - ny * w],
      [q[0], q[1]],
    ];
    out = [...out.slice(0, i0 + 1), ...zig, ...out.slice(i0 + 1)];
  }
  return out;
}

export function buildKorfezGp(): Track {
  return buildFromDrawing(gpDrawing, {
    id: 'korfez-gp-1950',
    name: 'TOSFED Körfez Ana Pist',
    description: '1.950 m GP, saat yönü, 10–12 m genişlik, maks. %1 boyuna eğim, 22 pit garajı',
    target: KORFEZ_FACILITY.mainLengthM,
    width: 12,
    ds: 2,
    smoothing: 14,
    minCornerDeg: 30,
    map: { src: '/tracks/korfez/gp.png', widthPx: 832, heightPx: 588 },
  });
}

export function buildKorfezKarting(): Track {
  return buildFromDrawing(kartingDrawing, {
    id: 'korfez-karting-950',
    name: 'TOSFED Körfez Karting Pisti',
    description: '950 m teknik iç pist, dar firketeler ve hızlı yön değişimleri, 8–10 m genişlik',
    target: KORFEZ_FACILITY.kartingLengthM,
    width: 9,
    ds: 1.5,
    smoothing: 8,
    minCornerDeg: 25,
    map: { src: '/tracks/korfez/karting.png', widthPx: 856, heightPx: 806 },
  });
}

export function buildKorfezFst(): Track {
  return buildFromDrawing(fstDrawing(clockwise(gpDrawing as XY[])), {
    id: 'korfez-fst-1380',
    name: 'TOSFED Körfez FST Endurance',
    description: '1.380 m Formula Student Turkey düzeni — göl süpürmesi kesilmiş GP, düzlüklerde koni şikanı',
    target: KORFEZ_FACILITY.fstLengthM,
    width: 10,
    ds: 2,
    smoothing: 6,
    minCornerDeg: 18,
    map: { src: '/tracks/korfez/fst.png', widthPx: 832, heightPx: 588 },
  });
}

const cache = new Map<KorfezTrackId, Track>();

export function getKorfezTrack(id: KorfezTrackId): Track {
  const hit = cache.get(id);
  if (hit) return hit;
  const built = id === 'korfez-gp-1950' ? buildKorfezGp() : id === 'korfez-karting-950' ? buildKorfezKarting() : buildKorfezFst();
  cache.set(id, built);
  return built;
}

export function isKorfezTrack(track: { id: string; venue?: string }): boolean {
  return track.venue === 'korfez' || track.id.startsWith('korfez-');
}

// -------------------------------------------------------------------------------------------------
// Vehicle presets selectable across all layouts (Formula Student & TOSFED Körfez)
// -------------------------------------------------------------------------------------------------

const TOURING_TIRE: TireParams = {
  ...DEFAULT_TIRE,
  name: 'Touring slick (TPSC referans)',
  lateral: { ...DEFAULT_TIRE.lateral, a1: -0.04, a2: 1.55, a3: 180000, a4: 6 },
  longitudinal: { ...DEFAULT_TIRE.longitudinal, b1: -0.04, b2: 1.5, b3: 0, b4: 220000, b5: 0.04 },
  nominalLoad: 3200,
};

export type VehiclePresetId = 'ist27-twotrack' | 'ist27' | 'tpsc';

export interface KorfezPreset {
  id: VehiclePresetId;
  label: string;
  blurb: string;
  vehicle: VehicleParams;
  powertrain: PowertrainParams;
}

/** IST27 Formula Student EV — the suite's baseline car. */
export const IST27_PRESET: KorfezPreset = {
  id: 'ist27',
  label: 'IST27 FS Baseline',
  blurb: '230 kg · 80 kW · 12.0:1',
  vehicle: DEFAULT_VEHICLE,
  powertrain: DEFAULT_POWERTRAIN,
};

/**
 * IST27 - TwoTrackSim — real vehicle setup imported from Two-Track-simulation
 * (with 11.8:1 planetary ratio and persistent user overrides).
 */
export const IST27_TWOTRACK_PRESET: KorfezPreset = {
  id: 'ist27-twotrack',
  label: 'IST27 - TwoTrackSim',
  blurb: 'IST27 Gerçek Veri · 11.8:1',
  vehicle: {
    ...DEFAULT_VEHICLE,
    name: 'IST27 - TwoTrackSim',
  },
  powertrain: {
    ...DEFAULT_POWERTRAIN,
    name: 'IST27 - TwoTrackSim (2x PMSM, 1:11.8 planetary)',
    gearRatio: 11.8,
  },
};

/**
 * Reference touring car mapped onto the same dual-motor solver so the GP can be
 * run at the circuit's 220+ km/h benchmark. Loss coefficients are rescaled from the
 * 21 Nm FS motor model so efficiency stays physical at touring torque.
 */
export const TPSC_PRESET: KorfezPreset = {
  id: 'tpsc',
  label: 'Türkiye Pist Şampiyonası Referans',
  blurb: '1.050 kg · 230 kW · 220+ km/h',
  vehicle: {
    ...DEFAULT_VEHICLE,
    name: 'TPSC Referans (touring)',
    mass: 1050,
    frontWeightFraction: 0.54,
    wheelbase: 2.65,
    trackWidth: 1.6,
    cgHeight: 0.48,
    ClA: 1.3,
    CdA: 0.72,
    aeroBalanceFront: 0.42,
    rollingResistance: 0.015,
    wheelRadius: 0.32,
    yawInertia: 1600,
    wheelInertia: 1.2,
    rollStiffnessFront: 0.5,
    tire: TOURING_TIRE,
  },
  powertrain: {
    ...DEFAULT_POWERTRAIN,
    name: 'TPSC referans, 2x arka motor, 230 kW',
    motorPeakTorque: 280,
    motorPeakPower: 140000,
    motorMaxRpm: 8500,
    gearRatio: 3.6,
    gearboxEfficiency: 0.96,
    batteryPowerLimit: 230000,
    regenPowerLimit: 100000,
    batteryVoltage: 700,
    batteryResistance: 0.04,
    batteryCapacityKWh: 60,
    losses: { ...DEFAULT_POWERTRAIN.losses, copper: 0.04 },
  },
};

export const KORFEZ_PRESETS: KorfezPreset[] = [IST27_TWOTRACK_PRESET, IST27_PRESET, TPSC_PRESET];
