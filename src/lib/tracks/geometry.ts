import {
  interp1,
  movingAverage,
  solveCyclicTridiagonal,
  solveTridiagonal,
  wrapAngle,
} from '../physics/numerics';
import type { Corner, Point2, Track, TrackKind } from './types';

// ---------------------------------------------------------------------------------------------
// Segment-based layouts (straight / constant-radius arc) with exact closure
// ---------------------------------------------------------------------------------------------

export type Segment =
  | { type: 'straight'; length: number; adjustable?: boolean }
  | { type: 'arc'; radius: number; angleDeg: number }; // angle > 0 = left turn

export const S = (length: number, adjustable = false): Segment => ({ type: 'straight', length, adjustable });
export const A = (radius: number, angleDeg: number): Segment => ({ type: 'arc', radius, angleDeg });

/** Slalom through `cones` gates: alternating arcs with zero net heading change. */
export function slalom(radius: number, halfAngleDeg: number, cones: number, firstLeft = false): Segment[] {
  const sgn = firstLeft ? 1 : -1;
  const out: Segment[] = [A(radius, sgn * halfAngleDeg)];
  for (let i = 1; i < cones; i++) out.push(A(radius, (i % 2 === 1 ? -sgn : sgn) * 2 * halfAngleDeg));
  out.push(A(radius, (cones % 2 === 1 ? -sgn : sgn) * halfAngleDeg));
  return out;
}

function segmentLength(seg: Segment): number {
  return seg.type === 'straight' ? seg.length : (seg.radius * Math.abs(seg.angleDeg) * Math.PI) / 180;
}

function segmentCurvature(seg: Segment): number {
  return seg.type === 'straight' ? 0 : Math.sign(seg.angleDeg) / seg.radius;
}

/** Exact end pose of a constant-curvature segment. */
function advance(x: number, y: number, th: number, k: number, len: number): [number, number, number] {
  if (Math.abs(k) < 1e-12) return [x + len * Math.cos(th), y + len * Math.sin(th), th];
  const th1 = th + k * len;
  return [x + (Math.sin(th1) - Math.sin(th)) / k, y - (Math.cos(th1) - Math.cos(th)) / k, th1];
}

function walkEnd(segs: Segment[], heading0: number): { x: number; y: number; th: number; headings: number[] } {
  let x = 0;
  let y = 0;
  let th = heading0;
  const headings: number[] = [];
  for (const seg of segs) {
    headings.push(th);
    [x, y, th] = advance(x, y, th, segmentCurvature(seg), segmentLength(seg));
  }
  return { x, y, th, headings };
}

/**
 * Closes a segment loop exactly by solving for the lengths of two adjustable straights whose
 * directions u1, u2 span the plane:  dL1 u1 + dL2 u2 = -(p_end - p_start).
 */
export function closeLoop(segs: Segment[], heading0 = 0): Segment[] {
  const adj = segs.map((s, i) => (s.type === 'straight' && s.adjustable ? i : -1)).filter((i) => i >= 0);
  if (adj.length !== 2) throw new Error('closeLoop requires exactly two adjustable straights');
  const totalTurn = segs.reduce((acc, s) => acc + (s.type === 'arc' ? s.angleDeg : 0), 0);
  if (Math.abs(Math.abs(totalTurn) - 360) > 1e-6) throw new Error(`Loop heading change is ${totalTurn} deg, expected ±360`);
  const { x, y, headings } = walkEnd(segs, heading0);
  const [i1, i2] = adj;
  const u1 = [Math.cos(headings[i1]), Math.sin(headings[i1])];
  const u2 = [Math.cos(headings[i2]), Math.sin(headings[i2])];
  const det = u1[0] * u2[1] - u1[1] * u2[0];
  if (Math.abs(det) < 1e-6) throw new Error('Adjustable straights are parallel');
  const dL1 = (-x * u2[1] + y * u2[0]) / det;
  const dL2 = (-u1[0] * y + u1[1] * x) / det;
  return segs.map((s, i) => {
    if (s.type !== 'straight') return s;
    if (i === i1) return { ...s, length: s.length + dL1 };
    if (i === i2) return { ...s, length: s.length + dL2 };
    return s;
  });
}

/** Samples a segment chain at uniform spacing, returning analytic curvature at each sample. */
export function sampleSegments(
  segs: Segment[],
  dsTarget: number,
  closed: boolean,
  start: { x: number; y: number; heading: number } = { x: 0, y: 0, heading: 0 },
): { s: number[]; x: number[]; y: number[]; heading: number[]; kappa: number[]; length: number; ds: number } {
  const lens = segs.map(segmentLength);
  const L = lens.reduce((a, b) => a + b, 0);
  const N = closed ? Math.max(8, Math.round(L / dsTarget)) : Math.max(2, Math.round(L / dsTarget) + 1);
  const ds = closed ? L / N : L / (N - 1);
  const s: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const heading: number[] = [];
  const kappa: number[] = [];
  let segIdx = 0;
  let segStart = 0;
  let px = start.x;
  let py = start.y;
  let pth = start.heading;
  // pose at the start of the current segment
  let sx = px;
  let sy = py;
  let sth = pth;
  for (let i = 0; i < N; i++) {
    const si = i * ds;
    while (segIdx < segs.length - 1 && si > segStart + lens[segIdx] + 1e-9) {
      [sx, sy, sth] = advance(sx, sy, sth, segmentCurvature(segs[segIdx]), lens[segIdx]);
      segStart += lens[segIdx];
      segIdx++;
    }
    const k = segmentCurvature(segs[segIdx]);
    [px, py, pth] = advance(sx, sy, sth, k, Math.min(si - segStart, lens[segIdx]));
    s.push(si);
    x.push(px);
    y.push(py);
    heading.push(pth);
    kappa.push(k);
  }
  return { s, x, y, heading, kappa, length: L, ds };
}

/** Converts a segment chain to dense (x, y) coordinates — used to create coordinate-based tracks. */
export function segmentsToPoints(segs: Segment[], spacing: number, closed: boolean): Point2[] {
  const smp = sampleSegments(segs, spacing, closed);
  return smp.x.map((x, i) => ({ x, y: smp.y[i] }));
}

// ---------------------------------------------------------------------------------------------
// Coordinate-based tracks: cubic spline fit, arc-length resampling, analytic curvature
// ---------------------------------------------------------------------------------------------

interface Spline1D {
  t: number[];
  y: number[];
  M: number[]; // second derivatives at the knots
  periodic: boolean;
  period: number;
}

function fitSpline(t: number[], y: number[], periodic: boolean, period: number): Spline1D {
  const n = t.length;
  if (periodic) {
    const h = (k: number) => (k === n - 1 ? period - (t[n - 1] - t[0]) : t[k + 1] - t[k]);
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    const d: number[] = [];
    for (let k = 0; k < n; k++) {
      const hp = h((k - 1 + n) % n);
      const hk = h(k);
      const yPrev = y[(k - 1 + n) % n];
      const yNext = y[(k + 1) % n];
      a.push(hp);
      b.push(2 * (hp + hk));
      c.push(hk);
      d.push(6 * ((yNext - y[k]) / hk - (y[k] - yPrev) / hp));
    }
    const corner = h(n - 1);
    const M = solveCyclicTridiagonal(a, b, c, d, corner, corner);
    return { t, y, M, periodic, period };
  }
  const M = new Array<number>(n).fill(0);
  if (n > 2) {
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    const d: number[] = [];
    for (let k = 1; k < n - 1; k++) {
      const hp = t[k] - t[k - 1];
      const hk = t[k + 1] - t[k];
      a.push(hp);
      b.push(2 * (hp + hk));
      c.push(hk);
      d.push(6 * ((y[k + 1] - y[k]) / hk - (y[k] - y[k - 1]) / hp));
    }
    a[0] = 0;
    c[c.length - 1] = 0;
    const inner = solveTridiagonal(a, b, c, d);
    for (let k = 1; k < n - 1; k++) M[k] = inner[k - 1];
  }
  return { t, y, M, periodic, period };
}

/** Returns [value, first derivative, second derivative] of a cubic spline. */
function evalSpline(sp: Spline1D, tq: number): [number, number, number] {
  const n = sp.t.length;
  let tt = tq;
  if (sp.periodic) {
    tt = sp.t[0] + ((((tq - sp.t[0]) % sp.period) + sp.period) % sp.period);
  }
  let k: number;
  if (sp.periodic && tt >= sp.t[n - 1]) {
    k = n - 1;
  } else {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sp.t[mid] <= tt) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  const k1 = sp.periodic ? (k + 1) % n : Math.min(k + 1, n - 1);
  const t0 = sp.t[k];
  const t1 = sp.periodic && k === n - 1 ? sp.t[0] + sp.period : sp.t[k1];
  const h = t1 - t0;
  const A = t1 - tt;
  const B = tt - t0;
  const M0 = sp.M[k];
  const M1 = sp.M[k1];
  const y0 = sp.y[k];
  const y1 = sp.y[k1];
  const val = (M0 * A * A * A) / (6 * h) + (M1 * B * B * B) / (6 * h) + (y0 / h - (M0 * h) / 6) * A + (y1 / h - (M1 * h) / 6) * B;
  const d1 = (-M0 * A * A) / (2 * h) + (M1 * B * B) / (2 * h) - (y0 / h - (M0 * h) / 6) + (y1 / h - (M1 * h) / 6);
  const d2 = (M0 * A) / h + (M1 * B) / h;
  return [val, d1, d2];
}

export interface FromPointsOptions {
  closed?: boolean; // auto-detected when omitted
  ds?: number;
  minSpacing?: number; // decimate input points closer than this (noise rejection)
  smoothing?: number; // curvature smoothing window, metres
}

function dedupe(points: Point2[], minSpacing: number): Point2[] {
  const out: Point2[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const q = out[out.length - 1];
    if (Math.hypot(p.x - q.x, p.y - q.y) >= minSpacing) out.push(p);
  }
  return out;
}

/** Fits a (periodic) cubic spline through (x, y) points and resamples it at uniform arc length. */
export function trackGeometryFromPoints(
  input: Point2[],
  opts: FromPointsOptions = {},
): { s: number[]; x: number[]; y: number[]; heading: number[]; kappa: number[]; length: number; ds: number; closed: boolean } {
  if (input.length < 4) throw new Error('At least 4 points are required to build a track');
  const ds = opts.ds ?? 0.5;
  let pts = dedupe(input, opts.minSpacing ?? 1.0);
  const gapEnd = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  let meanSpacing = 0;
  for (let i = 1; i < pts.length; i++) meanSpacing += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  meanSpacing /= pts.length - 1;
  const closed = opts.closed ?? gapEnd < Math.max(10, 3 * meanSpacing);
  if (closed && gapEnd < 0.5 * Math.max(meanSpacing, opts.minSpacing ?? 1.0)) pts = pts.slice(0, -1);
  if (pts.length < 4) throw new Error('Too few distinct points after de-duplication');

  // chord-length parametrisation
  const t: number[] = [0];
  for (let i = 1; i < pts.length; i++) t.push(t[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const period = closed ? t[t.length - 1] + Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) : t[t.length - 1];
  const sx = fitSpline(t, pts.map((p) => p.x), closed, period);
  const sy = fitSpline(t, pts.map((p) => p.y), closed, period);

  // dense arc-length table via Simpson integration of |r'(t)|
  const fine = Math.max(2000, Math.ceil(period / 0.05));
  const tf: number[] = [];
  const sf: number[] = [0];
  const speed = (tq: number) => Math.hypot(evalSpline(sx, tq)[1], evalSpline(sy, tq)[1]);
  for (let i = 0; i <= fine; i++) tf.push((period * i) / fine);
  for (let i = 1; i <= fine; i++) {
    const a = tf[i - 1];
    const b = tf[i];
    sf.push(sf[i - 1] + ((b - a) / 6) * (speed(a) + 4 * speed(0.5 * (a + b)) + speed(b)));
  }
  const L = sf[sf.length - 1];
  const N = closed ? Math.round(L / ds) : Math.round(L / ds) + 1;
  const dsEff = closed ? L / N : L / (N - 1);

  const s: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const heading: number[] = [];
  const kappaRaw: number[] = [];
  for (let i = 0; i < N; i++) {
    const si = i * dsEff;
    const tq = interp1(sf, tf, si);
    const [X, dX, ddX] = evalSpline(sx, tq);
    const [Y, dY, ddY] = evalSpline(sy, tq);
    s.push(si);
    x.push(X);
    y.push(Y);
    heading.push(Math.atan2(dY, dX));
    kappaRaw.push((dX * ddY - dY * ddX) / Math.pow(dX * dX + dY * dY, 1.5));
  }
  const half = Math.max(0, Math.round((opts.smoothing ?? 2) / dsEff / 2));
  const kappa = movingAverage(kappaRaw, half, closed);
  return { s, x, y, heading, kappa, length: L, ds: dsEff, closed };
}

// ---------------------------------------------------------------------------------------------
// Track assembly & analysis
// ---------------------------------------------------------------------------------------------

export function makeTrack(
  meta: { id: string; name: string; kind: TrackKind; description: string; laps?: number; startSpeed?: number; sectors?: number[]; timedWindows?: Track['timedWindows'] },
  geo: { s: number[]; x: number[]; y: number[]; heading: number[]; kappa: number[]; length: number; ds: number },
  closed: boolean,
): Track {
  const sectors = meta.sectors ?? [0, geo.length / 3, (2 * geo.length) / 3, geo.length];
  return {
    id: meta.id,
    name: meta.name,
    kind: meta.kind,
    description: meta.description,
    closed,
    ds: geo.ds,
    s: geo.s,
    x: geo.x,
    y: geo.y,
    heading: geo.heading,
    kappa: geo.kappa,
    length: geo.length,
    sectors,
    laps: meta.laps ?? 1,
    startSpeed: meta.startSpeed ?? 0,
    timedWindows: meta.timedWindows,
  };
}

/**
 * Corner detection on the curvature trace: contiguous regions with |kappa| above threshold
 * (same sign), with the geometric apex at the curvature peak.
 */
export function detectCorners(track: Track, kappaThreshold = 1 / 60, minLength = 4): Corner[] {
  const n = track.kappa.length;
  const corners: Corner[] = [];
  let i = 0;
  while (i < n) {
    const k = track.kappa[i];
    if (Math.abs(k) < kappaThreshold) {
      i++;
      continue;
    }
    const sign = Math.sign(k);
    const start = i;
    let apex = i;
    let turn = 0;
    while (i < n && Math.sign(track.kappa[i]) === sign && Math.abs(track.kappa[i]) >= kappaThreshold * 0.7) {
      if (Math.abs(track.kappa[i]) > Math.abs(track.kappa[apex])) apex = i;
      turn += track.kappa[i] * track.ds;
      i++;
    }
    const end = i - 1;
    if ((end - start + 1) * track.ds >= minLength) {
      corners.push({
        index: corners.length + 1,
        direction: sign > 0 ? 'L' : 'R',
        sStart: track.s[start],
        sApex: track.s[apex],
        sEnd: track.s[end],
        apexIndex: apex,
        apexRadius: 1 / Math.abs(track.kappa[apex]),
        turnAngleDeg: (turn * 180) / Math.PI,
      });
    }
  }
  return corners;
}

export interface TrackStats {
  length: number;
  minRadius: number;
  cornerCount: number;
  totalTurnDeg: number;
  straightFraction: number;
  bbox: { minX: number; maxX: number; minY: number; maxY: number };
  closureGap: number;
}

export function trackStats(track: Track): TrackStats {
  let maxK = 0;
  let turn = 0;
  let straight = 0;
  for (const k of track.kappa) {
    maxK = Math.max(maxK, Math.abs(k));
    turn += k * track.ds;
    if (Math.abs(k) < 1 / 200) straight++;
  }
  const n = track.x.length;
  return {
    length: track.length,
    minRadius: maxK > 0 ? 1 / maxK : Infinity,
    cornerCount: detectCorners(track).length,
    totalTurnDeg: (turn * 180) / Math.PI,
    straightFraction: straight / n,
    bbox: {
      minX: Math.min(...track.x),
      maxX: Math.max(...track.x),
      minY: Math.min(...track.y),
      maxY: Math.max(...track.y),
    },
    closureGap: track.closed ? Math.hypot(track.x[0] - track.x[n - 1], track.y[0] - track.y[n - 1]) : 0,
  };
}

/** Checks a polyline for self-intersections (excluding neighbouring segments). */
export function hasSelfIntersection(xs: number[], ys: number[], closed: boolean, stride = 4): boolean {
  const idx: number[] = [];
  for (let i = 0; i < xs.length; i += stride) idx.push(i);
  if (closed) idx.push(0);
  const m = idx.length - 1;
  const seg = (k: number) => [xs[idx[k]], ys[idx[k]], xs[idx[k + 1]], ys[idx[k + 1]]];
  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  for (let a = 0; a < m; a++) {
    const [x1, y1, x2, y2] = seg(a);
    for (let b = a + 2; b < m; b++) {
      if (closed && a === 0 && b === m - 1) continue;
      const [x3, y3, x4, y4] = seg(b);
      const d = cross(x2 - x1, y2 - y1, x4 - x3, y4 - y3);
      if (Math.abs(d) < 1e-12) continue;
      const u = cross(x3 - x1, y3 - y1, x4 - x3, y4 - y3) / d;
      const v = cross(x3 - x1, y3 - y1, x2 - x1, y2 - y1) / d;
      if (u > 0 && u < 1 && v > 0 && v < 1) return true;
    }
  }
  return false;
}

/** Minimum distance between non-adjacent parts of the track (> `gap` metres apart along s). */
export function minClearance(track: Track, gap = 40, stride = 4): number {
  let best = Infinity;
  const n = track.x.length;
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      let ds = Math.abs(track.s[j] - track.s[i]);
      if (track.closed) ds = Math.min(ds, track.length - ds);
      if (ds < gap) continue;
      best = Math.min(best, Math.hypot(track.x[i] - track.x[j], track.y[i] - track.y[j]));
    }
  }
  return best;
}

export function headingChange(track: Track): number {
  let acc = 0;
  for (let i = 1; i < track.heading.length; i++) acc += wrapAngle(track.heading[i] - track.heading[i - 1]);
  return acc;
}
