import { downforce, GRAVITY, type VehicleParams } from '../physics/vehicle';
import { pointMassLateralLimit, steadyStateLateralLimit } from '../physics/grip';
import { A, S, makeTrack, sampleSegments } from './geometry';
import type { Track } from './types';

/** FS Rules D5 skidpad geometry. */
export const SKIDPAD_RULES = {
  innerDiameter: 15.25,
  outerDiameter: 21.25,
  centreDistance: 18.25,
  laneWidth: 3.0,
};

/** Driving-line radius: centre of the 3 m lane = 15.25/2 + 1.5 = 9.125 m (circles touch at the crossing). */
export const SKIDPAD_LINE_RADIUS = SKIDPAD_RULES.innerDiameter / 2 + SKIDPAD_RULES.laneWidth / 2;

/**
 * Figure-of-eight: entry straight, two right-hand circles, two left-hand circles, exit straight.
 * The timed laps are the second right and the second left circle.
 */
export function buildSkidpad(opts: { radius?: number; ds?: number; entry?: number; exit?: number } = {}): Track {
  const R = opts.radius ?? SKIDPAD_LINE_RADIUS;
  const entry = opts.entry ?? 15;
  const exit = opts.exit ?? 15;
  const segs = [S(entry), A(R, -720), A(R, 720), S(exit)];
  const geo = sampleSegments(segs, opts.ds ?? 0.25, false, { x: 0, y: -entry, heading: Math.PI / 2 });
  const C = 2 * Math.PI * R;
  return makeTrack(
    {
      id: 'skidpad',
      name: 'FS Skidpad',
      kind: 'skidpad',
      description: `Figure-of-eight, ${SKIDPAD_RULES.innerDiameter} m inner circles, driving line R = ${R.toFixed(3)} m`,
      startSpeed: 0,
      sectors: [0, entry + 2 * C, entry + 4 * C, geo.length],
      timedWindows: [
        { label: 'Right (2nd lap)', s0: entry + C, s1: entry + 2 * C },
        { label: 'Left (2nd lap)', s0: entry + 3 * C, s1: entry + 4 * C },
      ],
    },
    geo,
    false,
  );
}

/** A single closed circle — the steady-state timed lap in isolation. */
export function buildCircle(radius: number, ds = 0.25, direction: 1 | -1 = 1): Track {
  const geo = sampleSegments([A(radius, direction * 360)], ds, true, { x: radius, y: 0, heading: Math.PI / 2 });
  return makeTrack(
    { id: `circle-${radius}`, name: `Circle R=${radius} m`, kind: 'skidpad', description: 'Constant radius steady-state circle' },
    geo,
    true,
  );
}

export interface SkidpadSteadyState {
  radius: number;
  speed: number; // m/s
  ay: number; // m/s^2
  ayG: number;
  muEffective: number;
  downforce: number; // N
  lapTime: number; // s (one circle)
  iterations: number;
}

/**
 * Closed-form steady-state skidpad solution with load-sensitive tires:
 *   m v^2 / R = mu (m g + 0.5 rho ClA v^2)   =>   v^2 = mu m g / (m / R - 0.5 rho ClA mu)
 * mu is the effective vehicle friction coefficient, itself a function of v (aero load, load
 * sensitivity, drag compensation), so the closed form is iterated to a fixed point.
 */
export function skidpadSteadyState(
  veh: VehicleParams,
  ayMaxFn: (v: number) => number = (v) => pointMassLateralLimit(veh, v),
  radius = SKIDPAD_LINE_RADIUS,
): SkidpadSteadyState {
  const m = veh.mass;
  const kA = 0.5 * veh.airDensity * veh.ClA;
  const muOf = (v: number) => (m * steadyStateLateralLimit(veh, ayMaxFn(v), v)) / (m * GRAVITY + downforce(veh, v));
  let v = Math.sqrt(muOf(0) * GRAVITY * radius);
  let mu = muOf(v);
  let it = 0;
  for (; it < 100; it++) {
    const denom = m / radius - kA * mu;
    if (denom <= 0) throw new Error('Downforce exceeds weight-equivalent: no finite skidpad speed');
    const vNext = Math.sqrt((mu * m * GRAVITY) / denom);
    mu = muOf(vNext);
    if (Math.abs(vNext - v) < 1e-10) {
      v = vNext;
      break;
    }
    v = vNext;
  }
  const ay = (v * v) / radius;
  return {
    radius,
    speed: v,
    ay,
    ayG: ay / GRAVITY,
    muEffective: mu,
    downforce: downforce(veh, v),
    lapTime: (2 * Math.PI * radius) / v,
    iterations: it + 1,
  };
}
