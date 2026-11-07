// ============================================================================
// STAGE 2: "EN ÇOK GİDİLEN YOL PİSTİMİZDİR" — İTÜ HAVUZ OTOPARKI TRACK EXTRACTOR
// 2D Trajectory Cloud, Spatial KDE Heatmap, Outlier Rejection & Loop-Closed Centerline
// Strictly isolated module for IST26 RWD SIL & Telemetry Lab
// ============================================================================

import { IST26_RWD_PDF_SPEC } from './ist26-vehicle-spec';
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
  const baseNodes = HAVUZ_CENTERLINE_NODES;
  const n = baseNodes.length;
  const nodes: HavuzCenterlineNode[] = [];
  let maxKappa = 0;

  for (let i = 0; i < n; i++) {
    const prev = baseNodes[(i - 1 + n) % n];
    const curr = baseNodes[i];
    const next = baseNodes[(i + 1) % n];

    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const ds = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / ds;
    const ny = dx / ds;

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

  return {
    name: 'İTÜ Ayazağa Olimpik Havuz Otoparkı (KDE Loop-Closed)',
    totalLengthM: nodes[nodes.length - 1]?.s ?? 135.4,
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
  };
}
