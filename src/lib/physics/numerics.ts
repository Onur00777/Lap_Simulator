/**
 * Numerical toolkit shared by the physics, track and solver modules.
 * Everything here is dependency-free and deterministic.
 */

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Linear interpolation on a monotonically increasing abscissa (clamped at the ends). */
export function interp1(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

/** Interpolation on a uniform grid x0 + i*dx (O(1)). */
export function interpUniform(x0: number, dx: number, ys: ArrayLike<number>, x: number): number {
  const n = ys.length;
  const f = (x - x0) / dx;
  if (f <= 0) return ys[0];
  if (f >= n - 1) return ys[n - 1];
  const i = Math.floor(f);
  const t = f - i;
  return ys[i] + (ys[i + 1] - ys[i]) * t;
}

/**
 * Bilinear interpolation on a rectangular grid. `table[i][j]` is the value at (xs[i], ys[j]).
 * Out-of-range queries are clamped to the table boundary.
 */
export function bilinear(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  table: ArrayLike<ArrayLike<number>>,
  x: number,
  y: number,
): number {
  const xi = bracket(xs, x);
  const yi = bracket(ys, y);
  const x0 = xs[xi.i];
  const x1 = xs[xi.i + 1];
  const y0 = ys[yi.i];
  const y1 = ys[yi.i + 1];
  const tx = x1 === x0 ? 0 : clamp((x - x0) / (x1 - x0), 0, 1);
  const ty = y1 === y0 ? 0 : clamp((y - y0) / (y1 - y0), 0, 1);
  const q00 = table[xi.i][yi.i];
  const q01 = table[xi.i][yi.i + 1];
  const q10 = table[xi.i + 1][yi.i];
  const q11 = table[xi.i + 1][yi.i + 1];
  return (
    q00 * (1 - tx) * (1 - ty) + q10 * tx * (1 - ty) + q01 * (1 - tx) * ty + q11 * tx * ty
  );
}

function bracket(xs: ArrayLike<number>, x: number): { i: number } {
  const n = xs.length;
  if (n < 2) return { i: 0 };
  if (x <= xs[0]) return { i: 0 };
  if (x >= xs[n - 1]) return { i: n - 2 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return { i: lo };
}

/** Bisection root finder. Requires f(lo) and f(hi) to bracket a sign change. */
export function bisect(
  f: (x: number) => number,
  lo: number,
  hi: number,
  tol = 1e-9,
  maxIter = 200,
): number {
  let flo = f(lo);
  for (let k = 0; k < maxIter; k++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm === 0 || hi - lo < tol) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/** Golden-section search for the maximum of a unimodal function on [a, b]. */
export function goldenMax(
  f: (x: number) => number,
  a: number,
  b: number,
  tol = 1e-6,
  maxIter = 120,
): { x: number; fx: number } {
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let k = 0; k < maxIter && Math.abs(b - a) > tol; k++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = f(d);
    }
  }
  const x = 0.5 * (a + b);
  return { x, fx: f(x) };
}

/** Composite trapezoidal integral of y(x). */
export function trapz(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  let acc = 0;
  for (let i = 1; i < xs.length; i++) acc += 0.5 * (ys[i] + ys[i - 1]) * (xs[i] - xs[i - 1]);
  return acc;
}

/** Cumulative trapezoidal integral (same length as input, starting at 0). */
export function cumtrapz(xs: ArrayLike<number>, ys: ArrayLike<number>): number[] {
  const out = new Array<number>(xs.length);
  out[0] = 0;
  for (let i = 1; i < xs.length; i++) {
    out[i] = out[i - 1] + 0.5 * (ys[i] + ys[i - 1]) * (xs[i] - xs[i - 1]);
  }
  return out;
}

export type Derivative = (t: number, y: readonly number[]) => number[];

/** One explicit (forward) Euler step: y_{n+1} = y_n + h f(t_n, y_n). */
export function eulerStep(f: Derivative, t: number, y: readonly number[], h: number): number[] {
  const k = f(t, y);
  return y.map((yi, i) => yi + h * k[i]);
}

/** One classical 4th-order Runge-Kutta step. */
export function rk4Step(f: Derivative, t: number, y: readonly number[], h: number): number[] {
  const n = y.length;
  const k1 = f(t, y);
  const y2 = new Array<number>(n);
  for (let i = 0; i < n; i++) y2[i] = y[i] + 0.5 * h * k1[i];
  const k2 = f(t + 0.5 * h, y2);
  const y3 = new Array<number>(n);
  for (let i = 0; i < n; i++) y3[i] = y[i] + 0.5 * h * k2[i];
  const k3 = f(t + 0.5 * h, y3);
  const y4 = new Array<number>(n);
  for (let i = 0; i < n; i++) y4[i] = y[i] + h * k3[i];
  const k4 = f(t + h, y4);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = y[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return out;
}

/** Scalar RK4 step for dy/dx = f(x, y). */
export function rk4Scalar(f: (x: number, y: number) => number, x: number, y: number, h: number): number {
  const k1 = f(x, y);
  const k2 = f(x + 0.5 * h, y + 0.5 * h * k1);
  const k3 = f(x + 0.5 * h, y + 0.5 * h * k2);
  const k4 = f(x + h, y + h * k3);
  return y + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
}

/** Centered moving average. For closed (periodic) signals the window wraps around. */
export function movingAverage(ys: ArrayLike<number>, halfWindow: number, periodic: boolean): number[] {
  const n = ys.length;
  const out = new Array<number>(n);
  if (halfWindow <= 0) {
    for (let i = 0; i < n; i++) out[i] = ys[i];
    return out;
  }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let cnt = 0;
    for (let k = -halfWindow; k <= halfWindow; k++) {
      let j = i + k;
      if (periodic) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      acc += ys[j];
      cnt++;
    }
    out[i] = acc / cnt;
  }
  return out;
}

/** Thomas algorithm for tridiagonal systems: a (sub), b (diag), c (super), d (rhs). */
export function solveTridiagonal(a: number[], b: number[], c: number[], d: number[]): number[] {
  const n = b.length;
  const cp = new Array<number>(n);
  const dp = new Array<number>(n);
  cp[0] = c[0] / b[0];
  dp[0] = d[0] / b[0];
  for (let i = 1; i < n; i++) {
    const m = b[i] - a[i] * cp[i - 1];
    cp[i] = i < n - 1 ? c[i] / m : 0;
    dp[i] = (d[i] - a[i] * dp[i - 1]) / m;
  }
  const x = new Array<number>(n);
  x[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
  return x;
}

/**
 * Cyclic tridiagonal solver (Sherman-Morrison). `alpha` couples row 0 to x[n-1],
 * `beta` couples row n-1 to x[0].
 */
export function solveCyclicTridiagonal(
  a: number[],
  b: number[],
  c: number[],
  d: number[],
  alpha: number,
  beta: number,
): number[] {
  const n = b.length;
  const gamma = -b[0];
  const bb = b.slice();
  bb[0] = b[0] - gamma;
  bb[n - 1] = b[n - 1] - (alpha * beta) / gamma;
  const x = solveTridiagonal(a, bb, c, d);
  const u = new Array<number>(n).fill(0);
  u[0] = gamma;
  u[n - 1] = alpha;
  const z = solveTridiagonal(a, bb, c, u);
  const fact = (x[0] + (beta * x[n - 1]) / gamma) / (1 + z[0] + (beta * z[n - 1]) / gamma);
  return x.map((xi, i) => xi - fact * z[i]);
}

/** Wrap an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

export function linspace(a: number, b: number, n: number): number[] {
  if (n === 1) return [a];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a + ((b - a) * i) / (n - 1);
  return out;
}
