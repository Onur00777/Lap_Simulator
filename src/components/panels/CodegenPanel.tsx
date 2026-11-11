'use client';

import { useMemo, useState } from 'react';
import {
  generateFsaeDesignReport,
  generateVcuDynamics,
  printFsaeDesignReport,
  type VcuBundle,
} from '@/lib/codegen';
import type { LateralModel, PowertrainParams, VehicleParams } from '@/lib/physics';
import type { Integrator, LapResult } from '@/lib/solver';
import type { Track } from '@/lib/tracks/types';
import { rgb, turbo } from '@/lib/ui/colors';
import { downloadText, fmt } from '@/lib/ui/format';
import { Segmented } from '../ui';

interface Props {
  bundle: VcuBundle;
  track?: Track;
  veh?: VehicleParams;
  pt?: PowertrainParams;
  lap?: LapResult;
  model?: LateralModel;
  integrator?: Integrator;
}

type MatrixMode = 'apps' | 'tv' | 'tc-derate';

export default function CodegenPanel({ bundle, track, veh, pt, lap, model, integrator }: Props) {
  const [active, setActive] = useState(Math.min(3, bundle.files.length - 1));
  const [matrixMode, setMatrixMode] = useState<MatrixMode>('apps');
  const [copied, setCopied] = useState(false);
  const [showDossierPreview, setShowDossierPreview] = useState(false);

  const firmware = useMemo(() => {
    try {
      return { files: veh && pt ? generateVcuDynamics(veh, pt) : [], error: null };
    } catch (err) {
      return { files: [], error: err instanceof Error ? err.message : 'Dynamics export is unavailable.' };
    }
  }, [veh, pt]);
  const files = [...bundle.files, ...firmware.files];
  const file = files[active] ?? files[0];
  const tm = bundle.torqueMap;
  const ag = bundle.autogenTables;

  const totalMax = Math.max(1e-6, ...ag.totalTorqueNm.flat());
  const totalMin = Math.min(0, ...ag.totalTorqueNm.flat());
  const tvMax = Math.max(1e-6, ...ag.tvDeltaTorqueNm.flat());

  const dossierMd = useMemo(() => {
    if (!track || !veh || !pt || !lap) return null;
    return generateFsaeDesignReport({
      track,
      veh,
      pt,
      lap,
      bundle,
      model,
      integrator,
    });
  }, [track, veh, pt, lap, bundle, model, integrator]);

  return (
    <div className="space-y-3 p-3">
      {/* Top Action Bar with FSAE Design Judge Dossier Export */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hud-line pb-2.5">
        <div>
          <div className="font-mono text-[11px] font-bold uppercase tracking-wider text-hud-cyan">
            STM32H7 VCU Codegen & FSAE Design Dossier
          </div>
          <div className="font-mono text-[10px] text-hud-dim">
            Dynamics FSM · APPS & yaw torque control · calibration tables
          </div>
        </div>
        {dossierMd && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={`btn ${showDossierPreview ? 'btn-active' : 'border-hud-violet/50 text-hud-violet'}`}
              onClick={() => setShowDossierPreview((s) => !s)}
            >
              {showDossierPreview ? 'Show C Firmware Code' : 'Preview Design Dossier (.md)'}
            </button>
            <button
              type="button"
              className="btn border-hud-lime/60 bg-hud-lime/10 font-semibold text-hud-lime hover:bg-hud-lime/20"
              onClick={() =>
                downloadText(
                  `FSAE_Engineering_Design_Report_${track?.id ?? 'lap'}.md`,
                  dossierMd,
                  'text/markdown',
                )
              }
            >
              ⬇ Export FSAE Engineering Design Report (.md)
            </button>
            <button
              type="button"
              className="btn border-hud-cyan/60 bg-hud-cyan/10 font-semibold text-hud-cyan hover:bg-hud-cyan/20"
              onClick={() => printFsaeDesignReport(dossierMd)}
            >
              🖨 Print / Save PDF Dossier
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.05fr_1.35fr]">
        {/* Left column: 2D LUT Matrices & Calibration Subsystems */}
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-hud-dim">
              Autogen Calibration Tables
            </span>
            <Segmented
              options={[
                { value: 'apps', label: '1. APPS × Speed Total Nm' },
                { value: 'tv', label: '2. Steer × Speed TV ΔNm' },
                { value: 'tc-derate', label: '3. LC/TC & Derating' },
              ]}
              value={matrixMode}
              onChange={setMatrixMode}
            />
          </div>

          {matrixMode === 'apps' && (
            <>
              <div className="font-mono text-[10px] text-hud-cyan">
                vcu_lookup_total_torque_nm(apps_pedal_pct, speed_kph) — Total Rear Axle Torque [Nm]
              </div>
              <div className="overflow-auto rounded border border-hud-line bg-hud-panel2/40 p-1.5">
                <table className="w-full border-collapse font-mono text-[9px] tabular-nums">
                  <thead>
                    <tr>
                      <th className="px-1 text-hud-dim">% \ kph</th>
                      {tm.speedKph.map((s) => (
                        <th key={s} className="px-1 font-normal text-hud-dim">
                          {s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ag.totalTorqueNm
                      .map((row, i) => ({ row, p: tm.pedalPct[i] }))
                      .reverse()
                      .map(({ row, p }) => (
                        <tr key={p}>
                          <td className="px-1 text-right text-hud-dim">{p}%</td>
                          {row.map((t, j) => (
                            <td
                              key={j}
                              className="px-1 text-center text-black"
                              style={{
                                background:
                                  t < 0
                                    ? 'rgba(59,130,246,0.85)'
                                    : rgb(turbo((t - Math.max(0, totalMin)) / totalMax), 0.85),
                              }}
                            >
                              {fmt(t, 1)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    <tr>
                      <td className="px-1 text-right text-hud-dim">lim</td>
                      {tm.limitedBy.map((l, j) => (
                        <td key={j} className="px-1 text-center text-hud-dim">
                          {l[0].toUpperCase()}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="space-y-0.5 font-mono text-[10px] text-hud-dim">
                <div>
                  T_total(p, v) = {pt?.motorCount ?? 2} × T_avail(v) · (p/100)^{tm.pedalGamma} · lift-off regen{' '}
                  {tm.coastRegenTorque * (pt?.motorCount ?? 2)} Nm total (blue)
                </div>
                <div>
                  Limiter code: T traction ellipse · M motor peak · B {(ag.nominalPowerCapKW).toFixed(0)} kW accumulator · R max RPM
                </div>
              </div>
            </>
          )}

          {matrixMode === 'tv' && (
            <>
              <div className="font-mono text-[10px] text-hud-cyan">
                vcu_lookup_tv_delta_torque_nm(steer_angle_deg, speed_kph) — Differential Motor ΔT [Nm]
              </div>
              <div className="overflow-auto rounded border border-hud-line bg-hud-panel2/40 p-1.5">
                <table className="w-full border-collapse font-mono text-[9px] tabular-nums">
                  <thead>
                    <tr>
                      <th className="px-1 text-hud-dim">deg \ kph</th>
                      {ag.speedAxisKph.map((s) => (
                        <th key={s} className="px-1 font-normal text-hud-dim">
                          {s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ag.tvDeltaTorqueNm
                      .map((row, i) => ({ row, deg: ag.steerAxisDeg[i] }))
                      .reverse()
                      .map(({ row, deg }) => (
                        <tr key={deg}>
                          <td className="px-1 text-right text-hud-dim">{deg}°</td>
                          {row.map((dt, j) => (
                            <td
                              key={j}
                              className="px-1 text-center text-black"
                              style={{
                                background: rgb(turbo(Math.min(1, Math.abs(dt) / tvMax)), 0.85),
                              }}
                            >
                              {fmt(dt, 2)}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-0.5 font-mono text-[10px] text-hud-dim">
                <div>
                  Chassis Understeer Gradient K_us = <span className="text-hud-cyan">{fmt(ag.understeerDegPerG, 2)} deg/G</span> ·
                  TV Yaw PI Gains: Kp = <span className="text-hud-lime">{fmt(bundle.tvParams.kp, 1)} Nm/(rad/s)</span>, Ki ={' '}
                  <span className="text-hud-lime">{fmt(bundle.tvParams.ki, 1)} Nm/rad</span>
                </div>
                <div>
                  Allocation: T_RR = 0.5·T_total + ΔT, T_RL = 0.5·T_total − ΔT · |Mz| ≤ {fmt(bundle.tvParams.mzLimit, 0)} Nm
                </div>
              </div>
            </>
          )}

          {matrixMode === 'tc-derate' && (
            <div className="space-y-3 font-mono text-[10px]">
              <div className="rounded border border-hud-line bg-hud-panel2/50 p-2.5">
                <div className="mb-1.5 font-semibold text-hud-cyan">
                  3. Launch / Traction Control Target Slip Schedule — v_wheel_max_target(v_chassis, ax)
                </div>
                <table className="w-full border-collapse text-left text-[10px]">
                  <thead>
                    <tr className="border-b border-hud-line text-hud-dim">
                      <th className="py-1">a_x [m/s²]</th>
                      {ag.axAxisMps2.map((ax) => (
                        <th key={ax} className="py-1 text-center">
                          {ax}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-hud-line/40">
                      <td className="py-1 text-hud-dim">κ* target [-]</td>
                      {ag.tcSlipTarget.map((k, i) => (
                        <td key={i} className="py-1 text-center text-hud-lime">
                          {k.toFixed(4)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-1 text-hud-dim">v_w @ 20 m/s</td>
                      {ag.tcSlipTarget.map((k, i) => (
                        <td key={i} className="py-1 text-center text-hud-text">
                          {(20 * (1 + k)).toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="rounded border border-hud-line bg-hud-panel2/50 p-2.5">
                <div className="mb-1.5 font-semibold text-hud-amber">
                  4. Thermal & Voltage Derating Function — vcu_calc_power_derating(T_cell, T_mot, V_cell_min)
                </div>
                <div className="grid grid-cols-3 gap-2 text-[10px]">
                  <div className="rounded border border-hud-line/60 bg-hud-bg/60 p-2">
                    <div className="text-hud-dim">Cell Temp Knee</div>
                    <div className="text-xs font-bold text-hud-red">53°C → 58°C → 60°C</div>
                    <div className="text-[9px] text-hud-dim">100% → 55% → 10% cap</div>
                  </div>
                  <div className="rounded border border-hud-line/60 bg-hud-bg/60 p-2">
                    <div className="text-hud-dim">Motor Temp Knee</div>
                    <div className="text-xs font-bold text-hud-amber">102°C → 110°C → 120°C</div>
                    <div className="text-[9px] text-hud-dim">100% → 60% → 10% cap</div>
                  </div>
                  <div className="rounded border border-hud-line/60 bg-hud-bg/60 p-2">
                    <div className="text-hud-dim">Min Cell Voltage</div>
                    <div className="text-xs font-bold text-hud-violet">3.25V → 3.10V → 3.00V</div>
                    <div className="text-[9px] text-hud-dim">100% → 25% → 0% cutoff</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right column: C Firmware Package / Dossier Viewer */}
        <div className="min-w-0">
          {showDossierPreview && dossierMd ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold text-hud-violet">
                  FSAE Engineering Design Judge Dossier Preview (.md)
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    await navigator.clipboard.writeText(dossierMd);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? 'Copied Dossier ✓' : 'Copy Markdown'}
                </button>
              </div>
              <pre className="max-h-[440px] overflow-auto rounded border border-hud-line bg-hud-bg p-3 font-mono text-[11px] leading-[1.45] text-hud-text whitespace-pre-wrap">
                {dossierMd}
              </pre>
            </div>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-1">
                {files.map((f, i) => (
                  <button
                    key={f.name}
                    type="button"
                    className={`btn normal-case ${i === active ? 'btn-active' : ''}`}
                    onClick={() => setActive(i)}
                  >
                    {f.name}
                  </button>
                ))}
                <span className="flex-1" />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    await navigator.clipboard.writeText(file.content);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
                <button type="button" className="btn" onClick={() => downloadText(file.name, file.content, 'text/x-c')}>
                  Download
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => files.forEach((f) => downloadText(f.name, f.content, 'text/x-c'))}
                >
                  Download all ({files.length} C files)
                </button>
              </div>
              <pre className="max-h-[440px] overflow-auto rounded border border-hud-line bg-hud-bg p-3 font-mono text-[11px] leading-[1.45] text-hud-text">
                {firmware.error && <p role="alert" className="p-2 font-mono text-xs text-amber-300">{firmware.error}</p>}
                <CodeView code={file.content} />
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const KEYWORDS =
  /\b(static|const|inline|void|return|if|else|while|for|typedef|struct|extern|bool|true|false|float32_t|uint32_t|int32_t|float|NULL)\b/g;

function CodeView({ code }: { code: string }) {
  return (
    <code>
      {code.split('\n').map((line, i) => {
        const trimmed = line.trimStart();
        let cls = '';
        if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) cls = 'text-hud-dim';
        else if (trimmed.startsWith('#')) cls = 'text-hud-violet';
        const html = cls
          ? line
          : line
              .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
              .replace(KEYWORDS, '<span class="text-hud-cyan">$1</span>');
        return (
          <div key={i} className="flex">
            <span className="mr-3 inline-block w-8 select-none text-right text-hud-dim/50">{i + 1}</span>
            {cls ? <span className={cls}>{html}</span> : <span dangerouslySetInnerHTML={{ __html: html || ' ' }} />}
          </div>
        );
      })}
    </code>
  );
}
