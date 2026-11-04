export type TrackKind = 'skidpad' | 'acceleration' | 'autocross' | 'endurance' | 'custom';

/**
 * A discretised track centre line / racing line sampled at uniform arc-length spacing `ds`.
 * Closed tracks wrap from the last sample back to the first (that final segment also has length ds),
 * so length = N * ds. Open tracks have length = (N - 1) * ds.
 */
export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  description: string;
  closed: boolean;
  ds: number;
  s: number[];
  x: number[];
  y: number[];
  heading: number[];
  kappa: number[]; // signed curvature [1/m], + = left turn
  length: number;
  /** Sector boundaries in metres, starting at 0 and ending at `length`. */
  sectors: number[];
  /** Number of laps for the event (e.g. endurance ~22 km). */
  laps: number;
  /** Initial speed for open tracks (m/s). */
  startSpeed: number;
  /** Optional timed windows (e.g. the second right and left skidpad circles). */
  timedWindows?: { label: string; s0: number; s1: number }[];
}

export interface Corner {
  index: number;
  direction: 'L' | 'R';
  sStart: number;
  sApex: number;
  sEnd: number;
  apexIndex: number;
  apexRadius: number; // m
  turnAngleDeg: number;
}

export interface Point2 {
  x: number;
  y: number;
}
