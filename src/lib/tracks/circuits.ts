import { A, S, closeLoop, makeTrack, segmentsToPoints, slalom, trackGeometryFromPoints, type Segment } from './geometry';
import type { Point2, Track } from './types';

/**
 * Pre-loaded FS Autocross / Endurance circuits.
 *
 * Layouts follow FS Rules D7/D8 guidance: straights <= 80 m, constant turns 23-45 m diameter,
 * hairpins >= 9 m outside diameter, slaloms with ~7.5-12 m cone spacing, chicanes.
 * Each layout is described as a segment chain, closed exactly by solving for two adjustable
 * straights, surveyed into (X, Y) coordinates and then processed by the same coordinate pipeline
 * (periodic cubic spline -> arc-length resampling -> analytic curvature) used for CSV imports.
 */

export const ENDURANCE_SEGMENTS: Segment[] = [
  // bottom edge, heading east: start/finish straight, chicane, infield hairpin finger
  S(80),
  A(12, 35),
  A(12, -70),
  A(12, 35),
  S(60),
  A(10, 90),
  S(50),
  A(8, -180),
  S(50),
  A(10, 90),
  S(45),
  // north-east corner
  A(18, 90),
  // east edge, heading north: slalom and fast S-bend
  S(30, true),
  ...slalom(13, 30, 5),
  S(30),
  A(40, 25),
  A(40, -25),
  S(20),
  // north-east hairpin complex
  A(10, 135),
  S(15),
  A(20, -45),
  // top edge, heading west: second finger, chicane, slalom
  S(40),
  A(10, 90),
  S(45),
  A(8, -180),
  S(45),
  A(10, 90),
  S(20),
  A(15, -30),
  A(15, 60),
  A(15, -30),
  S(25),
  ...slalom(12, 25, 4),
  S(40, true),
  // north-west corner and west edge, heading south
  A(20, 90),
  S(35),
  A(25, 45),
  S(20),
  A(12, -90),
  S(15),
  A(12, 45),
  S(25),
  A(35, -30),
  A(35, 30),
  S(30),
  // south-west corner back onto the main straight
  A(15, 90),
];

export const AUTOCROSS_SEGMENTS: Segment[] = [
  S(75),
  A(14, -30),
  A(14, 60),
  A(14, -30),
  S(30),
  A(10, 120),
  S(30),
  A(20, -60),
  S(40),
  ...slalom(12, 25, 8),
  S(30),
  A(30, -40),
  S(25),
  A(9, 190),
  S(45, true),
  A(25, -30),
  S(35),
  A(9, 90),
  S(60),
  A(7, -180),
  S(60),
  A(9, 90),
  S(30),
  A(9, 90),
  S(55),
  A(8, -180),
  S(55),
  A(9, 90),
  S(30),
  A(16, -45),
  A(16, 45),
  S(30),
  A(14, 90),
  S(60, true),
  A(12, 30),
  A(12, -60),
  A(12, 30),
  S(25),
  A(16, 60),
  S(25),
  A(10, -60),
  S(25),
  ...slalom(11, 20, 3, true),
  S(20),
  A(14, 90),
];

/** Survey a layout into coordinates (as a GPS / total-station track walk would). */
export function surveyLayout(segs: Segment[], spacing = 2.0): Point2[] {
  return segmentsToPoints(closeLoop(segs), spacing, true);
}

export function buildEndurance(ds = 0.5): Track {
  const pts = surveyLayout(ENDURANCE_SEGMENTS);
  const geo = trackGeometryFromPoints(pts, { closed: true, ds, minSpacing: 1.0, smoothing: 3 });
  const laps = Math.round(22000 / geo.length);
  return makeTrack(
    {
      id: 'endurance',
      name: 'FS Endurance',
      kind: 'endurance',
      description: `Closed circuit, ${laps} laps ≈ ${((laps * geo.length) / 1000).toFixed(1)} km event`,
      laps,
    },
    geo,
    true,
  );
}

export function buildAutocross(ds = 0.5): Track {
  const pts = surveyLayout(AUTOCROSS_SEGMENTS);
  const geo = trackGeometryFromPoints(pts, { closed: true, ds, minSpacing: 1.0, smoothing: 3 });
  return makeTrack(
    {
      id: 'autocross',
      name: 'FS Autocross',
      kind: 'autocross',
      description: 'Single flying lap, technical layout',
      laps: 1,
    },
    geo,
    true,
  );
}
