'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LateralModel, PowertrainParams, VehicleParams } from '@/lib/physics';
import {
  computeContourGrid,
  runSensitivitySweep,
  type ContourGrid,
  type ContourPreset,
  type Integrator,
  type SensitivityReport,
} from '@/lib/solver';
import type { Track } from '@/lib/tracks';
import { rgb, turbo } from '@/lib/ui/colors';
import { fmt } from '@/lib/ui/format';
import { DataTable, Segmented } from '../ui';

interface Props {
  track: Track;
  veh: VehicleParams;
  pt: PowertrainParams;
  model: LateralModel;
  integrator: Integrator;
}

export default function SensitivityPanel({ track, veh, pt, model, integrator }: Props) {
  const [preset, setPreset] = useState<ContourPreset>('aero');
  const [surfaceMode, setSurfaceMode] = useState<'laptime' | 'energy'>('laptime');

  const report: SensitivityReport = useMemo(
    () => runSensitivitySweep(track, veh, pt, model, integrator),
    [track, veh, pt, model, integrator],
  );

  const grid: ContourGrid = useMemo(
    () => computeContourGrid(track, veh, pt, preset, model, integrator, 7),
    [track, veh, pt, preset, model, integrator],
  );

  const maxAbsDelta = Math.max(10, ...report.tornado.map((t) => Math.max(Math.abs(t.deltaMsMinus10), Math.abs(t.deltaMsPlus10))));

  return (
    <div className="space-y-4 p-3">
      <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
        {/* Left: 1D Parameter Sweep & Jacobian Tornado Chart */}
        <div className="rounded border border-hud-line bg-hud-bg/60 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-mono text-xs font-bold uppercase tracking-wider text-hud-cyan">
                1D Parameter Sweep · Jacobian Tornado Chart (±10% Perturbation)
              </div>
              <div className="font-mono text-[10px] text-hud-dim">
                Baseline: {report.baseLapTimeS.toFixed(3)} s · {report.baseEnergyWh.toFixed(1)} Wh · {report.baseCoolingKJ.toFixed(1)} kJ cooling · solved in{' '}
                {report.computeTimeMs.toFixed(0)} ms
              </div>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px]">
              <span className="flex items-center gap-1 text-hud-lime">
                <span className="inline-block h-2 w-3 rounded-sm bg-emerald-400/80" /> Faster (Δt &lt; 0)
              </span>
              <span className="flex items-center gap-1 text-hud-red">
                <span className="inline-block h-2 w-3 rounded-sm bg-red-400/80" /> Slower (Δt &gt; 0)
              </span>
            </div>
          </div>

          <div className="space-y-2.5 py-1">
            {report.tornado.map((entry) => {
              const leftPct = (Math.min(0, entry.deltaMsMinus10, entry.deltaMsPlus10) / maxAbsDelta) * 50;
              const rightPct = (Math.max(0, entry.deltaMsMinus10, entry.deltaMsPlus10) / maxAbsDelta) * 50;
              const m10Neg = entry.deltaMsMinus10 < 0;
              const p10Neg = entry.deltaMsPlus10 < 0;

              return (
                <div key={entry.key} className="rounded border border-hud-line/60 bg-hud-panel/70 px-2.5 py-1.5 font-mono text-[11px]">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-hud-text">
                      {entry.label}{' '}
                      <span className="font-normal text-hud-dim">
                        ({fmt(entry.baseValueDisplay, entry.unit === '–' ? 2 : 1)} {entry.unit})
                      </span>
                    </span>
                    <span className="rounded border border-hud-cyan/30 bg-hud-cyan/10 px-1.5 py-0.5 text-[10px] text-hud-cyan">
                      {entry.derivativeLabel}
                    </span>
                  </div>

                  {/* Horizontal Tornado Bar */}
                  <div className="relative flex h-5 items-center rounded bg-hud-bg px-2">
                    <div className="absolute left-1/2 top-0 h-full w-px bg-hud-dim/50" />
                    {/* -10% bar */}
                    {Math.abs(entry.deltaMsMinus10) > 0.1 && (
                      <div
                        className={`absolute h-3 rounded-sm ${m10Neg ? 'bg-emerald-400/80' : 'bg-red-400/80'}`}
                        style={{
                          left: m10Neg ? `${50 + (entry.deltaMsMinus10 / maxAbsDelta) * 46}%` : '50%',
                          width: `${Math.max(1, (Math.abs(entry.deltaMsMinus10) / maxAbsDelta) * 46)}%`,
                        }}
                        title={`-10%: ${entry.deltaMsMinus10.toFixed(1)} ms`}
                      />
                    )}
                    {/* +10% bar */}
                    {Math.abs(entry.deltaMsPlus10) > 0.1 && (
                      <div
                        className={`absolute h-3 rounded-sm ${p10Neg ? 'bg-emerald-400/80' : 'bg-red-400/80'}`}
                        style={{
                          left: p10Neg ? `${50 + (entry.deltaMsPlus10 / maxAbsDelta) * 46}%` : '50%',
                          width: `${Math.max(1, (Math.abs(entry.deltaMsPlus10) / maxAbsDelta) * 46)}%`,
                        }}
                        title={`+10%: ${entry.deltaMsPlus10.toFixed(1)} ms`}
                      />
                    )}
                    <div className="relative z-10 flex w-full justify-between text-[9px] tabular-nums">
                      <span className={leftPct < 0 ? 'text-hud-lime' : 'text-hud-dim'}>
                        −10%: {entry.deltaMsMinus10 >= 0 ? '+' : ''}
                        {entry.deltaMsMinus10.toFixed(0)} ms
                      </span>
                      <span className="text-hud-dim">swing {entry.swingMs.toFixed(0)} ms</span>
                      <span className={rightPct > 0 ? 'text-hud-red' : 'text-hud-lime'}>
                        +10%: {entry.deltaMsPlus10 >= 0 ? '+' : ''}
                        {entry.deltaMsPlus10.toFixed(0)} ms
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: 2D Iso-Lap-Time & Iso-Energy Contour Heatmap */}
        <div className="flex flex-col rounded border border-hud-line bg-hud-bg/60 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-mono text-xs font-bold uppercase tracking-wider text-hud-cyan">
                2D Iso-Lap-Time & Iso-Energy Contour Heatmap
              </div>
              <div className="font-mono text-[10px] text-hud-dim">
                Optimal trade-off point: {grid.xLabel} {fmt(grid.bestPoint.x, 2)} {grid.xUnit} × {grid.yLabel} {fmt(grid.bestPoint.y, 2)}{' '}
                {grid.yUnit} ({grid.bestPoint.lapTimeS.toFixed(3)} s)
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Segmented
                options={[
                  { value: 'aero', label: 'Cl·A vs Cd·A' },
                  { value: 'mass-power', label: 'Mass vs kW' },
                  { value: 'cg-lltd', label: 'CG vs LLTD' },
                ]}
                value={preset}
                onChange={setPreset}
              />
              <Segmented
                options={[
                  { value: 'laptime', label: 'Iso-Lap-Time' },
                  { value: 'energy', label: 'Iso-Energy' },
                ]}
                value={surfaceMode}
                onChange={setSurfaceMode}
              />
            </div>
          </div>

          <div className="min-h-[340px] flex-1">
            <ContourCanvas grid={grid} mode={surfaceMode} />
          </div>
        </div>
      </div>

      {/* Jacobian Derivatives Summary Table for Design Judges */}
      <div className="rounded border border-hud-line bg-hud-bg/60 p-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-hud-dim">
          FSAE Design Judge Sensitivity Matrix — Exact Partial Derivatives ∂t/∂p & ∂E/∂p
        </div>
        <DataTable
          head={['Rank', 'Parameter', 'Baseline', '−10% Δt [ms]', '+10% Δt [ms]', 'Swing [ms]', 'Time Sensitivity', 'Energy Sensitivity']}
          rows={report.tornado.map((t, idx) => [
            `#${idx + 1}`,
            t.label,
            `${fmt(t.baseValueDisplay, t.unit === '–' ? 2 : 1)} ${t.unit}`,
            `${t.deltaMsMinus10 >= 0 ? '+' : ''}${t.deltaMsMinus10.toFixed(1)}`,
            `${t.deltaMsPlus10 >= 0 ? '+' : ''}${t.deltaMsPlus10.toFixed(1)}`,
            t.swingMs.toFixed(1),
            t.derivativeLabel,
            `${t.whPerUnit >= 0 ? '+' : '−'}${Math.abs(t.whPerUnit).toFixed(2)} Wh / ${t.engineeringUnitLabel}`,
          ])}
        />
      </div>
    </div>
  );
}

function ContourCanvas({ grid, mode }: { grid: ContourGrid; mode: 'laptime' | 'energy' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ xVal: number; yVal: number; lapS: number; dMs: number; eWh: number } | null>(null);

  const zMat = mode === 'laptime' ? grid.lapTimeS : grid.energyWh;
  const zMin = mode === 'laptime' ? grid.minLapTimeS : grid.minEnergyWh;
  const zMax = mode === 'laptime' ? grid.maxLapTimeS : grid.maxEnergyWh;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const w = 520;
    const h = 340;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 54;
    const padR = 24;
    const padT = 18;
    const padB = 38;
    const pw = w - padL - padR;
    const ph = h - padT - padB;

    const nx = grid.xValues.length;
    const ny = grid.yValues.length;

    // Bilinear interpolation helper on normalized [0..1] x [0..1]
    const sampleZ = (u: number, v: number) => {
      const fx = Math.max(0, Math.min(nx - 1.0001, u * (nx - 1)));
      const fy = Math.max(0, Math.min(ny - 1.0001, v * (ny - 1)));
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const z00 = zMat[iy][ix];
      const z10 = zMat[iy][ix + 1];
      const z01 = zMat[iy + 1][ix];
      const z11 = zMat[iy + 1][ix + 1];
      return (1 - ty) * ((1 - tx) * z00 + tx * z10) + ty * ((1 - tx) * z01 + tx * z11);
    };

    // Render smooth 2D heatmap pixels
    const resX = 120;
    const resY = 85;
    const cellW = pw / resX;
    const cellH = ph / resY;
    const span = Math.max(1e-6, zMax - zMin);

    for (let ry = 0; ry < resY; ry++) {
      const v = 1 - (ry + 0.5) / resY;
      for (let rx = 0; rx < resX; rx++) {
        const u = (rx + 0.5) / resX;
        const z = sampleZ(u, v);
        const norm = (z - zMin) / span;
        ctx.fillStyle = rgb(turbo(norm), 0.86);
        ctx.fillRect(padL + rx * cellW, padT + ry * cellH, Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    // Draw Marching-Squares Iso-Contour lines (6 levels)
    const levels = 6;
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.55)';
    ctx.lineWidth = 1.1;
    ctx.font = '9px Consolas, monospace';
    ctx.fillStyle = '#f8fafc';

    for (let l = 1; l < levels; l++) {
      const target = zMin + (span * l) / levels;
      ctx.beginPath();
      let labelPlaced = false;
      for (let ry = 0; ry < resY - 1; ry++) {
        const v0 = 1 - ry / (resY - 1);
        const v1 = 1 - (ry + 1) / (resY - 1);
        for (let rx = 0; rx < resX - 1; rx++) {
          const u0 = rx / (resX - 1);
          const u1 = (rx + 1) / (resX - 1);
          const z0 = sampleZ(u0, v0);
          const z1 = sampleZ(u1, v0);
          const z2 = sampleZ(u0, v1);
          if ((z0 <= target && z1 >= target) || (z0 >= target && z1 <= target)) {
            const px = padL + u0 * pw;
            const py = padT + (1 - v0) * ph;
            ctx.moveTo(px, py);
            ctx.lineTo(px + cellW, py);
            if (!labelPlaced && rx > resX * 0.25 && rx < resX * 0.75 && ry > resY * 0.2 && ry < resY * 0.8) {
              ctx.fillText(mode === 'laptime' ? `${target.toFixed(2)}s` : `${target.toFixed(0)}Wh`, px + 2, py - 2);
              labelPlaced = true;
            }
          } else if ((z0 <= target && z2 >= target) || (z0 >= target && z2 <= target)) {
            const px = padL + u0 * pw;
            const py = padT + (1 - v0) * ph;
            ctx.moveTo(px, py);
            ctx.lineTo(px, py + cellH);
          }
        }
      }
      ctx.stroke();
    }

    // Plot current baseline setup marker (⊕)
    const xMin = grid.xValues[0];
    const xMax = grid.xValues[nx - 1];
    const yMin = grid.yValues[0];
    const yMax = grid.yValues[ny - 1];

    const sx = (x: number) => padL + ((x - xMin) / Math.max(1e-6, xMax - xMin)) * pw;
    const sy = (y: number) => padT + (1 - (y - yMin) / Math.max(1e-6, yMax - yMin)) * ph;

    const bx = sx(grid.baseX);
    const by = sy(grid.baseY);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px Consolas, monospace';
    ctx.fillText('Current', Math.min(bx + 8, w - 65), Math.max(padT + 12, by - 6));

    // Plot optimal point marker (★)
    const ox = sx(grid.bestPoint.x);
    const oy = sy(grid.bestPoint.y);
    ctx.strokeStyle = '#a3e635';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ox, oy, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#a3e635';
    ctx.fillText('Optimum', Math.min(ox + 8, w - 65), Math.min(h - padB - 4, oy + 12));

    // Axes & labels
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, pw, ph);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Consolas, monospace';
    for (let i = 0; i < nx; i += 2) {
      const px = sx(grid.xValues[i]);
      ctx.fillText(grid.xValues[i].toFixed(grid.xUnit === 'm²' ? 2 : 0), px - 10, h - 20);
    }
    for (let j = 0; j < ny; j += 2) {
      const py = sy(grid.yValues[j]);
      ctx.fillText(grid.yValues[j].toFixed(grid.yUnit === 'm²' ? 2 : 0), 8, py + 3);
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`${grid.xLabel} [${grid.xUnit}]`, padL + pw / 2 - 55, h - 5);
  }, [grid, mode, zMat, zMin, zMax]);

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const u = (e.clientX - rect.left - 54 * (rect.width / 520)) / ((520 - 78) * (rect.width / 520));
    const v = 1 - (e.clientY - rect.top - 18 * (rect.height / 340)) / ((340 - 56) * (rect.height / 340));
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      setHover(null);
      return;
    }
    const nx = grid.xValues.length;
    const ny = grid.yValues.length;
    const ix = Math.min(nx - 1, Math.max(0, Math.round(u * (nx - 1))));
    const iy = Math.min(ny - 1, Math.max(0, Math.round(v * (ny - 1))));
    setHover({
      xVal: grid.xValues[ix],
      yVal: grid.yValues[iy],
      lapS: grid.lapTimeS[iy][ix],
      dMs: grid.deltaMs[iy][ix],
      eWh: grid.energyWh[iy][ix],
    });
  };

  return (
    <div className="relative flex h-full flex-col">
      <canvas
        ref={canvasRef}
        className="h-[310px] w-full rounded border border-hud-line/60 bg-hud-bg"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between font-mono text-[10px] text-hud-dim">
        <span>
          Y-Axis: {grid.yLabel} [{grid.yUnit}] · Range: {mode === 'laptime' ? `${zMin.toFixed(2)}s → ${zMax.toFixed(2)}s` : `${zMin.toFixed(0)}Wh → ${zMax.toFixed(0)}Wh`}
        </span>
        {hover && (
          <span className="text-hud-cyan">
            {fmt(hover.xVal, 2)} {grid.xUnit} × {fmt(hover.yVal, 2)} {grid.yUnit} → {hover.lapS.toFixed(3)} s (
            {hover.dMs >= 0 ? '+' : ''}
            {hover.dMs.toFixed(0)} ms) · {hover.eWh.toFixed(1)} Wh
          </span>
        )}
      </div>
    </div>
  );
}
