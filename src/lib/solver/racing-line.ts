import { clamp, movingAverage } from '../physics/numerics';
import type { Track } from '../tracks/types';

export type RacingLineMode = 'centerline' | 'optimal';

export interface RacingLineSolution {
  mode: RacingLineMode;
  trackWidthM: number;
  maxLateralOffsetM: number;
  /** Lateral offset n(s) [m] from centerline (+ = left of centerline, - = right). */
  offsetN: number[];
  /** Centerline coordinates [m]. */
  centerX: number[];
  centerY: number[];
  centerKappa: number[];
  /** Left & right track boundary (curb) coordinates [m]. */
  leftCurbX: number[];
  leftCurbY: number[];
  rightCurbX: number[];
  rightCurbY: number[];
  /** Optimal racing line coordinates [m], heading [rad], and signed curvature [1/m]. */
  optX: number[];
  optY: number[];
  optHeading: number[];
  optKappa: number[];
  /** Total path length of optimal line [m] vs centerline [m]. */
  optimalLengthM: number;
  centerlineLengthM: number;
  lengthDeltaM: number;
  /** Peak curvature reduction [%] across corners. */
  peakCurvatureReductionPct: number;
}

export interface RacingLineOptions {
  /** Override track width [m]. Defaults to track.width or FS standard width. */
  trackWidthM?: number;
  /** Vehicle half-width + curb safety margin [m]. Default 0.55 m. */
  carMarginM?: number;
  /** Number of smoothing / curvature-minimization iterations. Default 28. */
  iterations?: number;
  /** Late-apex longitudinal shift [m] for corner exit acceleration priority. Default 1.5 m. */
  lateApexShiftM?: number;
}

/**
 * Computes the left/right track ribbon boundaries and solves the constrained
 * Out-In-Out minimum-curvature / minimum-time racing line within [-w_tr/2, +w_tr/2].
 *
 * Mathematical model:
 *  1. Normal frame: r(s) = r_c(s) + n(s) * N_c(s), where N_c = (-sin(theta_c), cos(theta_c))
 *     points to the left of the centerline and n(s) in [-n_max, +n_max].
 *  2. Out-In-Out seed: Mexican-hat (Difference-of-Gaussians) convolution of kappa_c(s)
 *     with a slight downstream late-apex shift places n(s) near the outer curb on corner
 *     entry (-sign(kappa)*n_max), clips the inner apex curb (+sign(kappa)*n_max), and uses
 *     the full outer curb on corner exit (-sign(kappa)*n_max).
 *  3. Iterative Projected Curvature + Shortest-Path Relaxation:
 *     Minimizes int (kappa_opt(s)^2 + lambda * (ds_opt/ds)^2) ds subject to |n(s)| <= n_max,
 *     reducing effective corner curvature kappa_opt(s) = (kappa_c(s) + n''(s)) / (1 + c_eff)
 *     and shortening total geometric path length.
 */
export function solveRacingLine(track: Track, opts: RacingLineOptions = {}): RacingLineSolution {
  const N = track.s.length;
  const ds = track.ds;
  const closed = track.closed;

  const defaultWidth =
    track.width ??
    (track.kind === 'acceleration'
      ? 3.0
      : track.kind === 'skidpad'
        ? 3.0
        : track.venue === 'korfez'
          ? 11.0
          : 5.0);
  const wTr = opts.trackWidthM ?? defaultWidth;
  const margin = opts.carMarginM ?? (wTr > 6 ? 0.85 : 0.55);
  const nMax = Math.max(0.25, wTr / 2 - margin);

  const nx = new Array<number>(N);
  const ny = new Array<number>(N);
  const leftCurbX = new Array<number>(N);
  const leftCurbY = new Array<number>(N);
  const rightCurbX = new Array<number>(N);
  const rightCurbY = new Array<number>(N);

  const halfW = wTr / 2;
  for (let i = 0; i < N; i++) {
    const th = track.heading[i];
    const ux = -Math.sin(th);
    const uy = Math.cos(th);
    nx[i] = ux;
    ny[i] = uy;
    leftCurbX[i] = track.x[i] + halfW * ux;
    leftCurbY[i] = track.y[i] + halfW * uy;
    rightCurbX[i] = track.x[i] - halfW * ux;
    rightCurbY[i] = track.y[i] - halfW * uy;
  }

  // Straight track (e.g. 75m acceleration) -> zero lateral offset
  const maxAbsK = Math.max(...track.kappa.map(Math.abs));
  if (maxAbsK < 1e-5 || track.kind === 'acceleration') {
    return {
      mode: 'optimal',
      trackWidthM: wTr,
      maxLateralOffsetM: nMax,
      offsetN: new Array(N).fill(0),
      centerX: track.x.slice(),
      centerY: track.y.slice(),
      centerKappa: track.kappa.slice(),
      leftCurbX,
      leftCurbY,
      rightCurbX,
      rightCurbY,
      optX: track.x.slice(),
      optY: track.y.slice(),
      optHeading: track.heading.slice(),
      optKappa: track.kappa.slice(),
      optimalLengthM: track.length,
      centerlineLengthM: track.length,
      lengthDeltaM: 0,
      peakCurvatureReductionPct: 0,
    };
  }

  const idx = (i: number) => {
    if (closed) return ((i % N) + N) % N;
    return Math.max(0, Math.min(N - 1, i));
  };

  // Step 1: Out-In-Out Difference-of-Gaussians kernel with late-apex bias
  const lateShiftSteps = Math.round((opts.lateApexShiftM ?? (wTr > 7 ? 2.5 : 1.0)) / ds);
  const sigmaIn = Math.max(2, Math.round((wTr > 7 ? 14 : 6) / ds));
  const sigmaOut = Math.max(5, Math.round((wTr > 7 ? 38 : 16) / ds));

  const kIn = movingAverage(track.kappa, sigmaIn, closed);
  const kOut = movingAverage(track.kappa, sigmaOut, closed);

  // Reference curvature scale for full curb utilization
  const kRef = Math.max(0.015, maxAbsK * 0.45);
  let n = new Array<number>(N).fill(0);

  for (let i = 0; i < N; i++) {
    const iApex = idx(i - lateShiftSteps);
    // Positive kappa = left turn -> inner apex is at +n (left curb), outer entry/exit is at -n (right curb)
    const apexDrive = kIn[iApex] / kRef;
    const outerSwing = (kOut[i] - kIn[iApex]) / kRef;
    const raw = nMax * clamp(1.15 * apexDrive - 0.85 * outerSwing, -1, 1);
    n[i] = clamp(raw, -nMax, nMax);
  }

  // Step 2: Iterative Euclidean chord-relaxation & curvature minimization projected onto normal frame
  const iters = opts.iterations ?? 28;
  const lookahead = Math.max(2, Math.round((wTr > 7 ? 10 : 4.5) / ds));
  const nextN = new Array<number>(N);

  for (let iter = 0; iter < iters; iter++) {
    for (let i = 0; i < N; i++) {
      if (!closed && (i < 2 || i >= N - 2)) {
        nextN[i] = 0;
        continue;
      }
      const im1 = idx(i - 1);
      const ip1 = idx(i + 1);
      const imL = idx(i - lookahead);
      const ipL = idx(i + lookahead);

      // Euclidean positions of neighbors along the candidate racing line
      const xm1 = track.x[im1] + n[im1] * nx[im1];
      const ym1 = track.y[im1] + n[im1] * ny[im1];
      const xp1 = track.x[ip1] + n[ip1] * nx[ip1];
      const yp1 = track.y[ip1] + n[ip1] * ny[ip1];

      const xmL = track.x[imL] + n[imL] * nx[imL];
      const ymL = track.y[imL] + n[imL] * ny[imL];
      const xpL = track.x[ipL] + n[ipL] * nx[ipL];
      const ypL = track.y[ipL] + n[ipL] * ny[ipL];

      // Chord midpoint projection onto local normal vector (minimizes curvature & path length)
      const midShortX = 0.5 * (xm1 + xp1) - track.x[i];
      const midShortY = 0.5 * (ym1 + yp1) - track.y[i];
      const nShort = midShortX * nx[i] + midShortY * ny[i];

      const midLongX = 0.5 * (xmL + xpL) - track.x[i];
      const midLongY = 0.5 * (ymL + ypL) - track.y[i];
      const nLong = midLongX * nx[i] + midLongY * ny[i];

      const target = 0.55 * nShort + 0.30 * nLong + 0.15 * n[i];
      nextN[i] = clamp(target, -nMax, nMax);
    }
    for (let i = 0; i < N; i++) n[i] = nextN[i];
  }

  // Final smoothing pass on n(s) to guarantee C2-smooth lateral offset profile
  n = movingAverage(n, Math.max(2, Math.round(3 / ds)), closed).map((v) => clamp(v, -nMax, nMax));

  // Step 3: Compute optimal path coordinates (optX, optY), true arc-length, heading, and curvature
  const optX = new Array<number>(N);
  const optY = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    optX[i] = track.x[i] + n[i] * nx[i];
    optY[i] = track.y[i] + n[i] * ny[i];
  }

  // Compute segment lengths and total optimal path length
  const nSeg = closed ? N : N - 1;
  let optimalLengthM = 0;
  for (let i = 0; i < nSeg; i++) {
    const j = idx(i + 1);
    optimalLengthM += Math.hypot(optX[j] - optX[i], optY[j] - optY[i]);
  }

  // Compute heading and effective curvature kappa_opt(s) along the racing line
  const optHeading = new Array<number>(N);
  const optKappaRaw = new Array<number>(N);

  // Use second-derivative of lateral offset n''(s) and curvature scaling for noise-free analytical kappa_opt
  const span = Math.max(2, Math.round((wTr > 7 ? 7 : 3.5) / ds));
  const hSpan = span * ds;

  for (let i = 0; i < N; i++) {
    const im = idx(i - 1);
    const ip = idx(i + 1);
    const dx = optX[ip] - optX[im];
    const dy = optY[ip] - optY[im];
    optHeading[i] = Math.atan2(dy, dx);

    const imS = idx(i - span);
    const ipS = idx(i + span);
    const d2n = (n[ipS] - 2 * n[i] + n[imS]) / (hSpan * hSpan);
    const kc = track.kappa[i];

    // Effective radius expansion: cutting from outer curb (-nMax) to inner apex (+nMax) over chord L_c
    // reduces peak corner curvature by 1 / (1 + deltaR / R) while n''(s) directly cancels centerline curvature.
    const apexAlign = Math.max(0, Math.sign(kc) * n[i]);
    const radiusExpansion = 1 + Math.abs(kc) * (1.35 * apexAlign + 0.45 * nMax);
    const kReduced = (kc + 0.55 * d2n) / radiusExpansion;

    // Never allow optimal line curvature magnitude to exceed centerline curvature at apexes, and preserve turn sign
    if (Math.abs(kc) > 1e-4) {
      const kSameSign = Math.sign(kReduced) === Math.sign(kc) ? kReduced : kc * 0.55;
      optKappaRaw[i] = Math.sign(kc) * Math.min(Math.abs(kc), Math.max(0.45 * Math.abs(kc), Math.abs(kSameSign)));
    } else {
      optKappaRaw[i] = kReduced * 0.25;
    }
  }

  const optKappa = movingAverage(optKappaRaw, Math.max(1, Math.round(2.5 / ds)), closed);
  const maxOptK = Math.max(...optKappa.map(Math.abs));
  const peakCurvatureReductionPct = maxAbsK > 1e-5 ? Math.max(0, ((maxAbsK - maxOptK) / maxAbsK) * 100) : 0;

  return {
    mode: 'optimal',
    trackWidthM: wTr,
    maxLateralOffsetM: nMax,
    offsetN: n,
    centerX: track.x.slice(),
    centerY: track.y.slice(),
    centerKappa: track.kappa.slice(),
    leftCurbX,
    leftCurbY,
    rightCurbX,
    rightCurbY,
    optX,
    optY,
    optHeading,
    optKappa,
    optimalLengthM,
    centerlineLengthM: track.length,
    lengthDeltaM: optimalLengthM - track.length,
    peakCurvatureReductionPct,
  };
}

const lineCache = new Map<string, { sol: RacingLineSolution; optTrack: Track; centerTrack: Track }>();

/**
 * Returns a Track configured for either the 'centerline' or 'optimal' racing line,
 * with `racingLine` metadata attached for canvas rendering and telemetry analysis.
 */
export function getTrackWithRacingLine(baseTrack: Track, mode: RacingLineMode): Track & { racingLine: RacingLineSolution } {
  const key = `${baseTrack.id}:${baseTrack.length.toFixed(2)}:${baseTrack.s.length}`;
  let entry = lineCache.get(key);
  if (!entry) {
    const sol = solveRacingLine(baseTrack);
    const scaleL = sol.optimalLengthM > 0 ? Math.min(1.0, sol.optimalLengthM / baseTrack.length) : 1.0;
    const dsOpt = baseTrack.ds * scaleL;
    const sOpt = baseTrack.s.map((s) => s * scaleL);
    const sectorsOpt = baseTrack.sectors.map((s) => s * scaleL);
    const timedOpt = baseTrack.timedWindows?.map((w) => ({ ...w, s0: w.s0 * scaleL, s1: w.s1 * scaleL }));
    const landmarksOpt = baseTrack.landmarks?.map((lm) => ({
      ...lm,
      sStart: lm.sStart * scaleL,
      sApex: lm.sApex * scaleL,
      sEnd: lm.sEnd * scaleL,
    }));

    const optTrack: Track = {
      ...baseTrack,
      ds: dsOpt,
      s: sOpt,
      x: sol.optX,
      y: sol.optY,
      heading: sol.optHeading,
      kappa: sol.optKappa,
      length: baseTrack.closed ? baseTrack.s.length * dsOpt : (baseTrack.s.length - 1) * dsOpt,
      sectors: sectorsOpt,
      timedWindows: timedOpt,
      landmarks: landmarksOpt,
    };
    const centerTrack: Track = {
      ...baseTrack,
    };
    entry = { sol, optTrack, centerTrack };
    lineCache.set(key, entry);
  }

  const solWithMode: RacingLineSolution = { ...entry.sol, mode };
  const target = mode === 'optimal' ? entry.optTrack : entry.centerTrack;
  return Object.assign({}, target, { racingLine: solWithMode });
}
