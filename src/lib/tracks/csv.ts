import { makeTrack, trackGeometryFromPoints } from './geometry';
import type { Point2, Track } from './types';

export interface CsvParseResult {
  points: Point2[];
  skippedLines: number;
}

/**
 * Parses X,Y coordinates from CSV / TSV / whitespace separated text. Header rows and lines that
 * do not contain two numeric fields are skipped. Additional columns are ignored.
 */
export function parseTrackCsv(text: string): CsvParseResult {
  const points: Point2[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/[,;\t ]+/).filter((f) => f.length > 0);
    if (fields.length < 2) {
      skipped++;
      continue;
    }
    const x = Number(fields[0]);
    const y = Number(fields[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      skipped++;
      continue;
    }
    points.push({ x, y });
  }
  return { points, skippedLines: skipped };
}

export function trackFromCsv(
  text: string,
  opts: { name?: string; closed?: boolean; ds?: number; laps?: number } = {},
): Track {
  const { points } = parseTrackCsv(text);
  if (points.length < 4) throw new Error(`CSV contains ${points.length} valid points; at least 4 are required`);
  const geo = trackGeometryFromPoints(points, { closed: opts.closed, ds: opts.ds ?? 0.5, minSpacing: 1.0, smoothing: 3 });
  return makeTrack(
    {
      id: 'custom',
      name: opts.name ?? 'Custom CSV track',
      kind: 'custom',
      description: `${points.length} imported points, ${geo.closed ? 'closed' : 'open'} ${geo.length.toFixed(0)} m`,
      laps: opts.laps ?? 1,
      startSpeed: geo.closed ? 0 : 0,
    },
    geo,
    geo.closed,
  );
}

/** Serialises a track centre line to CSV (handy for exporting the pre-loaded circuits). */
export function trackToCsv(track: Track, stride = 4): string {
  const lines = ['x_m,y_m'];
  for (let i = 0; i < track.x.length; i += stride) lines.push(`${track.x[i].toFixed(3)},${track.y[i].toFixed(3)}`);
  return lines.join('\n');
}
