// ============================================================================
// STAGE 2: "EN ÇOK GİDİLEN YOL PİSTİMİZDİR" — İTÜ HAVUZ OTOPARKI TRACK EXTRACTOR
// 2D Trajectory Cloud, Spatial KDE Heatmap, Outlier Rejection & Loop-Closed Centerline
// Strictly isolated module for IST26 RWD SIL & Telemetry Lab
// ============================================================================

import { IST26_RWD_PDF_SPEC } from './ist26-vehicle-spec';
import { detectCorners, makeTrack, trackGeometryFromPoints } from '../tracks/geometry';
import type { Corner, Point2 } from '../tracks/types';
import { movingAverage } from '../physics/numerics';
import {
  HAVUZ_CENTERLINE_NODES,
  HAVUZ_TRAJECTORY_CLOUD,
  HavuzCenterlineNode,
  HavuzTrajectoryTrace,
} from './precomputed-logs';

export interface KdeHeatmapCell {
  x: number;
  y: number;
  density: number; // normalized [0, 1]
}

export interface HavuzExtractedCircuit {
  name: string;
  totalLengthM: number;
  coneHalfWidthM: number;
  nodes: HavuzCenterlineNode[];
  validTracesCount: number;
  rejectedOutlierTracesCount: number;
  maxCurvatureOnePerM: number;
  minCornerRadiusM: number;
  kinematicParamsUsed: {
    wheelbaseM: number;
    lR_M: number;
    wheelRadiusM: number;
  };
  heatmapCells: KdeHeatmapCell[];
  corners: Corner[];
  sectors: Array<{ s: number; x: number; y: number }>;
  rejectedPointCount: number;
}

/**
 * Compute 2D Kernel Density Estimation (KDE) grid over the Trajectory Cloud
 * to highlight the most traveled corridor and identify spatial outliers
 */
export function computeTrajectoryKdeHeatmap(
  traces: HavuzTrajectoryTrace[] = HAVUZ_TRAJECTORY_CLOUD,
  bandwidthM = 1.85,
  gridResX = 56,
  gridResY = 36,
): KdeHeatmapCell[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const allPts: Array<{ x: number; y: number; weight: number }> = [];
  for (const tr of traces) {
    const w = tr.isOutlier ? 0.15 : 1.0;
    for (const [px, py] of tr.points) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      allPts.push({ x: px, y: py, weight: w });
    }
  }

  if (allPts.length === 0) return [];
  const pad = 4.0;
  minX -= pad;
  maxX += pad;
  minY -= pad;
  maxY += pad;

  const cells: KdeHeatmapCell[] = [];
  const inv2Sigma2 = 1 / (2 * bandwidthM * bandwidthM);
  let maxD = 1e-9;

  for (let ix = 0; ix < gridResX; ix++) {
    const gx = minX + ((ix + 0.5) / gridResX) * (maxX - minX);
    for (let iy = 0; iy < gridResY; iy++) {
      const gy = minY + ((iy + 0.5) / gridResY) * (maxY - minY);
      let d = 0;
      for (let k = 0; k < allPts.length; k++) {
        const dx = gx - allPts[k].x;
        const dy = gy - allPts[k].y;
        const r2 = dx * dx + dy * dy;
        if (r2 < 16.0) {
          d += allPts[k].weight * Math.exp(-r2 * inv2Sigma2);
        }
      }
      if (d > maxD) maxD = d;
      if (d > 0.15) {
        cells.push({ x: gx, y: gy, density: d });
      }
    }
  }

  for (const c of cells) {
    c.density = Math.min(1, c.density / maxD);
  }

  return cells.filter((c) => c.density > 0.06);
}

/**
 * Recompute cone boundaries at customizable half-width (default 1.5 m Blue Left / Yellow Right)
 * using IST26 kinematic geometry (L = 1.600 m, l_r = 0.7664 m, r_w = 0.205 m)
 */
export function buildHavuzExtractedCircuit(
  coneHalfWidthM = 1.5,
  traces: HavuzTrajectoryTrace[] = HAVUZ_TRAJECTORY_CLOUD,
): HavuzExtractedCircuit {
  const points = traces.filter((trace) => !trace.isOutlier).flatMap((trace) => trace.points.map(([x, y]) => ({ x, y })));
  const { geometry, rejectedPointCount } = fitHavuzCenterline(HAVUZ_CENTERLINE_NODES, points);
  const baseNodes = geometry.s.map((s, i) => ({ s, x: geometry.x[i], y: geometry.y[i], kappa: geometry.kappa[i] }));
  const n = baseNodes.length;
  const nodes: HavuzCenterlineNode[] = [];
  let maxKappa = 0;

  for (let i = 0; i < n; i++) {
    const curr = baseNodes[i];
    const nx = -Math.sin(geometry.heading[i]);
    const ny = Math.cos(geometry.heading[i]);

    const absK = Math.abs(curr.kappa);
    if (absK > maxKappa) maxKappa = absK;

    nodes.push({
      s: curr.s,
      x: curr.x,
      y: curr.y,
      kappa: curr.kappa,
      leftConeX: Number((curr.x + coneHalfWidthM * nx).toFixed(3)),
      leftConeY: Number((curr.y + coneHalfWidthM * ny).toFixed(3)),
      rightConeX: Number((curr.x - coneHalfWidthM * nx).toFixed(3)),
      rightConeY: Number((curr.y - coneHalfWidthM * ny).toFixed(3)),
    });
  }

  const validTracesCount = traces.filter((t) => !t.isOutlier).length;
  const rejectedOutlierTracesCount = traces.filter((t) => t.isOutlier).length;

  const track = makeTrack({ id: 'havuz-spline', name: 'İTÜ Havuz', kind: 'custom', description: 'Closed periodic spline' }, geometry, true);
  const sectors = [0, 1, 2].map((sector) => {
    const { s, x, y } = nodes[Math.floor(n * sector / 3)];
    return { s, x, y };
  });
  return {
    name: 'İTÜ Ayazağa Olimpik Havuz Otoparkı (DBSCAN + Periodic Spline)',
    totalLengthM: geometry.length,
    coneHalfWidthM,
    nodes,
    validTracesCount,
    rejectedOutlierTracesCount,
    maxCurvatureOnePerM: Number(maxKappa.toFixed(4)),
    minCornerRadiusM: Number((1 / Math.max(0.01, maxKappa)).toFixed(2)),
    kinematicParamsUsed: {
      wheelbaseM: IST26_RWD_PDF_SPEC.massAndGeometry.wheelbaseM,
      lR_M: IST26_RWD_PDF_SPEC.massAndGeometry.lR_M,
      wheelRadiusM: IST26_RWD_PDF_SPEC.massAndGeometry.loadedWheelRadiusM,
    },
    heatmapCells: computeTrajectoryKdeHeatmap(traces),
    corners: detectCorners(track, 0.045, 3),
    sectors,
    rejectedPointCount,
  };
}

/** DBSCAN on a uniform spatial index. Retain the largest connected driving corridor. */
export function filterTrajectoryCorridor(points: Point2[], radiusM = 3.3, minPoints = 5): Point2[] {
  if (!(radiusM > 0) || minPoints < 1) throw new RangeError('DBSCAN requires a positive radius and neighbor count.');
  const cells = new Map<string, number[]>();
  const cell = (p: Point2) => [Math.floor(p.x / radiusM), Math.floor(p.y / radiusM)] as const;
  points.forEach((point, i) => {
    const key = cell(point).join(',');
    const entries = cells.get(key) ?? [];
    entries.push(i);
    cells.set(key, entries);
  });
  const neighbors = (i: number) => {
    const point = points[i];
    const [x, y] = cell(point);
    const near: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of cells.get(`${x + dx},${y + dy}`) ?? []) {
        if ((points[j].x - point.x) ** 2 + (points[j].y - point.y) ** 2 <= radiusM ** 2) near.push(j);
      }
    }
    return near;
  };
  const labels = new Int32Array(points.length).fill(-2); // -2 unvisited, -1 noise
  let largest: number[] = [];
  let clusterId = 0;
  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -2) continue;
    const queue = neighbors(i);
    if (queue.length < minPoints) { labels[i] = -1; continue; }
    const queued = new Set(queue);
    const cluster = [i];
    labels[i] = clusterId;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const j = queue[cursor];
      const previous = labels[j];
      if (previous >= 0) continue;
      labels[j] = clusterId;
      cluster.push(j);
      if (previous === -1) continue;
      const expanded = neighbors(j);
      if (expanded.length < minPoints) continue;
      for (const k of expanded) {
        if (!queued.has(k) && labels[k] < 0) { queued.add(k); queue.push(k); }
      }
    }
    if (cluster.length > largest.length) largest = cluster;
    clusterId++;
  }
  return largest.map((i) => points[i]);
}

export function fitHavuzCenterline(seed: Point2[], points: Point2[], sampleCount = 150) {
  if (!Number.isInteger(sampleCount) || sampleCount < 4) throw new RangeError('At least four output samples are required.');
  const stride = Math.max(1, Math.floor(seed.length / 48));
  const knots = seed.filter((_, i) => i % stride === 0);
  const cluster = filterTrajectoryCorridor(points);
  const normal = knots.map((_, i) => {
    const prev = knots[(i - 1 + knots.length) % knots.length];
    const next = knots[(i + 1) % knots.length];
    const norm = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    return { x: (prev.y - next.y) / norm, y: (next.x - prev.x) / norm };
  });
  const offsets = knots.map((): number[] => []);
  for (const point of cluster) {
    let closest = -1;
    let distanceSq = 4.5 ** 2;
    knots.forEach((knot, i) => {
      const d = (knot.x - point.x) ** 2 + (knot.y - point.y) ** 2;
      if (d < distanceSq) { distanceSq = d; closest = i; }
    });
    if (closest < 0) continue;
    const n = normal[closest];
    const k = knots[closest];
    offsets[closest].push((point.x - k.x) * n.x + (point.y - k.y) * n.y);
  }
  const shift = movingAverage(offsets.map((row) => {
    if (row.length === 0) return 0;
    row.sort((a, b) => a - b);
    return (row[Math.floor((row.length - 1) / 2)] + row[Math.floor(row.length / 2)]) / 2;
  }), 2, true);
  const fitted = knots.map((point, i) => ({ x: point.x + shift[i] * normal[i].x, y: point.y + shift[i] * normal[i].y }));
  // The periodic cubic spline matches position, tangent and second derivative at the seam.
  const options = { closed: true, minSpacing: 0.25, smoothing: 0 };
  const draft = trackGeometryFromPoints(fitted, options);
  return { geometry: trackGeometryFromPoints(fitted, { ...options, ds: draft.length / sampleCount }), rejectedPointCount: points.length - cluster.length };
}
