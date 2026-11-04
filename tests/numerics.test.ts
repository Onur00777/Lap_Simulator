import { describe, expect, it } from 'vitest';
import { bilinear, eulerStep, rk4Step, solveCyclicTridiagonal, solveTridiagonal } from '@/lib/physics';
import { trackGeometryFromPoints } from '@/lib/tracks';

function integrate(step: typeof rk4Step, h: number): number {
  let y = [1];
  let t = 0;
  const f = (_t: number, yy: readonly number[]) => [yy[0]];
  while (t < 1 - 1e-12) {
    y = step(f, t, y, h);
    t += h;
  }
  return y[0];
}

describe('ODE integrators', () => {
  it('RK4 converges with 4th order on y\' = y', () => {
    const e1 = Math.abs(integrate(rk4Step, 0.1) - Math.E);
    const e2 = Math.abs(integrate(rk4Step, 0.05) - Math.E);
    expect(Math.log2(e1 / e2)).toBeGreaterThan(3.8);
  });

  it('explicit Euler converges with 1st order on y\' = y', () => {
    const e1 = Math.abs(integrate(eulerStep, 0.01) - Math.E);
    const e2 = Math.abs(integrate(eulerStep, 0.005) - Math.E);
    const order = Math.log2(e1 / e2);
    expect(order).toBeGreaterThan(0.9);
    expect(order).toBeLessThan(1.1);
  });
});

describe('Linear algebra', () => {
  it('solves tridiagonal and cyclic tridiagonal systems', () => {
    const n = 6;
    const a = [0, 1, 1, 1, 1, 1];
    const b = [4, 4, 4, 4, 4, 4];
    const c = [1, 1, 1, 1, 1, 0];
    const xTrue = [1, -2, 3, 0.5, -1, 2];
    const mul = (alpha: number, beta: number) =>
      xTrue.map((_, i) => b[i] * xTrue[i] + (i > 0 ? a[i] * xTrue[i - 1] : beta * xTrue[n - 1]) + (i < n - 1 ? c[i] * xTrue[i + 1] : alpha * xTrue[0]));
    const x1 = solveTridiagonal(a, b, c, mul(0, 0));
    x1.forEach((v, i) => expect(v).toBeCloseTo(xTrue[i], 10));
    const x2 = solveCyclicTridiagonal(a, b, c, mul(1, 1), 1, 1);
    x2.forEach((v, i) => expect(v).toBeCloseTo(xTrue[i], 10));
  });

  it('bilinear interpolation reproduces a bilinear function exactly', () => {
    const xs = [0, 1, 3];
    const ys = [0, 2, 5];
    const f = (x: number, y: number) => 2 + 3 * x - y + 0.5 * x * y;
    const tab = xs.map((x) => ys.map((y) => f(x, y)));
    expect(bilinear(xs, ys, tab, 0.4, 1.3)).toBeCloseTo(f(0.4, 1.3), 12);
    expect(bilinear(xs, ys, tab, 2.2, 4.1)).toBeCloseTo(f(2.2, 4.1), 12);
  });
});

describe('Spline curvature pipeline', () => {
  it('recovers kappa = 1/R from sparse points on a circle', () => {
    const R = 25;
    const pts = Array.from({ length: 40 }, (_, k) => ({ x: R * Math.cos((2 * Math.PI * k) / 40), y: R * Math.sin((2 * Math.PI * k) / 40) }));
    const g = trackGeometryFromPoints(pts, { closed: true, ds: 0.5, smoothing: 0 });
    expect(g.closed).toBe(true);
    expect(g.length).toBeCloseTo(2 * Math.PI * R, 1);
    for (const k of g.kappa) expect(k).toBeCloseTo(1 / R, 3);
  });
});
