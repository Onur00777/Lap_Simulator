import type { LateralModel, PowertrainParams, VehicleParams } from '../physics';
import {
  runSensitivitySweep,
  simulateEnduranceStint,
  type EnduranceStintResult,
  type Integrator,
  type LapResult,
  type SensitivityReport,
} from '../solver';
import type { Track } from '../tracks/types';
import type { VcuBundle } from './vcu-files';

export interface DesignDossierInput {
  track: Track;
  veh: VehicleParams;
  pt: PowertrainParams;
  lap: LapResult;
  bundle: VcuBundle;
  model?: LateralModel;
  integrator?: Integrator;
  sensitivity?: SensitivityReport;
  endurance?: EnduranceStintResult;
}

/**
 * Generates a complete Formula Student / FSAE Engineering Design Judge Dossier (.md)
 * compiling vehicle architecture, 4-corner LLTD & G-G envelope limits, corner speeds,
 * 1D Jacobian sensitivity derivatives, 22 km multi-lap endurance thermal/voltage margins,
 * and STM32H7 VCU firmware LUT calibration summary.
 */
export function generateFsaeDesignReport(input: DesignDossierInput): string {
  const { track, veh, pt, lap, bundle } = input;
  const model: LateralModel = input.model ?? 'point-mass';
  const integrator: Integrator = input.integrator ?? 'rk4';
  const sens = input.sensitivity ?? runSensitivitySweep(track, veh, pt, model, integrator);
  const endur =
    input.endurance ??
    simulateEnduranceStint(track, veh, pt, {
      laps: 17,
      ambientTempC: 28,
      initialSoc: 1.0,
      model,
      integrator,
    });

  const staticFzN = veh.mass * 9.81;
  const aero100KphN = 0.5 * veh.airDensity * veh.ClA * Math.pow(100 / 3.6, 2);
  const drag100KphN = 0.5 * veh.airDensity * veh.CdA * Math.pow(100 / 3.6, 2);

  const cornerRows =
    lap.corners.length > 0
      ? lap.corners
          .map(
            (c, idx) =>
              `| T${idx + 1} (${c.direction}) | ${c.sApex.toFixed(1)} m | ${c.apexRadius.toFixed(1)} m | ${(c.entrySpeed * 3.6).toFixed(1)} | **${(c.apexSpeed * 3.6).toFixed(1)}** | ${(c.exitSpeed * 3.6).toFixed(1)} | ${c.peakLatG.toFixed(2)} G | ${(c.understeerDegPerG ?? lap.cornerUndersteerDegPerG).toFixed(2)} °/G | ${(c.minInnerFzN ?? lap.minInnerWheelLoadN).toFixed(0)} N |`,
          )
          .join('\n')
      : '| Straight / No discrete apexes | — | ∞ | — | — | — | — | — | — |';

  const tornadoRows = sens.tornado
    .map(
      (t, idx) =>
        `| #${idx + 1} | **${t.label}** | ${t.baseValueDisplay} ${t.unit} | ${t.deltaMsMinus10 >= 0 ? '+' : ''}${t.deltaMsMinus10.toFixed(0)} ms | ${t.deltaMsPlus10 >= 0 ? '+' : ''}${t.deltaMsPlus10.toFixed(0)} ms | **${t.swingMs.toFixed(0)} ms** | \`${t.derivativeLabel}\` |`,
    )
    .join('\n');

  const enduranceSampleIndices = Array.from(
    new Set([0, 2, 5, 8, 11, 14, Math.max(0, endur.lapHistory.length - 1)]),
  ).filter((i) => i < endur.lapHistory.length);

  const enduranceRows = enduranceSampleIndices
    .map((idx) => {
      const r = endur.lapHistory[idx];
      return `| Lap ${r.lap} | ${r.distanceCumKm.toFixed(2)} km | ${r.lapTimeS.toFixed(3)} s | ${r.socEndPct.toFixed(1)} % | ${r.ocvStartV.toFixed(0)} V / ${r.terminalVoltageMinV.toFixed(0)} V | ${r.minCellVoltageV.toFixed(2)} V | ${r.cellTempC.toFixed(1)} °C | ${r.motorTempC.toFixed(1)} °C | ${r.effectivePowerCapKW.toFixed(1)} kW (${r.deratingCause}) |`;
    })
    .join('\n');

  return `# FSAE / Formula Student Engineering Design Dossier — ApexLapSim

**Vehicle Configuration:** \`${veh.name}\`  
**Powertrain Package:** \`${pt.name}\`  
**Evaluated Circuit:** \`${track.name}\` (${track.length.toFixed(1)} m, ${lap.corners.length} corners)  
**Solver Architecture:** 3-Pass QSS (\`${integrator.toUpperCase()}\` in $v^2$) · Lateral Model: \`${model}\`  

---

## 1. Executive Summary & Single-Lap KPIs

| Metric | Value | Unit | Engineering Notes |
| :--- | :---: | :---: | :--- |
| **Simulated Lap Time** | **${lap.lapTime.toFixed(3)}** | s | Track length ${lap.distance.toFixed(1)} m |
| **Average / Peak Speed** | ${(lap.avgSpeed * 3.6).toFixed(1)} / ${(lap.maxSpeed * 3.6).toFixed(1)} | km/h | Min apex ${(lap.minSpeed * 3.6).toFixed(1)} km/h |
| **G-G Envelope Peaks** | ${lap.peakLatG.toFixed(2)} Lat · ${lap.peakLongG.toFixed(2)} Acc · ${lap.peakBrakeG.toFixed(2)} Brk | G | Combined Pacejka friction ellipse |
| **Cornering Understeer Gradient ($K_{us}$)** | **${lap.cornerUndersteerDegPerG.toFixed(2)}** | deg/G | Lap avg ${lap.avgUndersteerDegPerG.toFixed(2)} deg/G · Stability index ${lap.minStabilityIndex.toFixed(3)} |
| **4-Corner Min Inner Wheel Load** | **${lap.minInnerWheelLoadN.toFixed(0)}** | N | ${lap.hasWheelLift ? `WARNING: Inner wheel lift at ${lap.wheelLiftCount} nodes` : 'Zero inner-wheel lift across entire lap'} |
| **Net Accumulator Energy** | **${(lap.energy.netKWh * 1000).toFixed(1)}** | Wh | Discharge ${(lap.energy.dischargeKWh * 1000).toFixed(1)} Wh · Regen ${(lap.energy.regenKWh * 1000).toFixed(1)} Wh |
| **Powertrain Cooling Rejection** | **${lap.energy.coolingHeatKJ.toFixed(1)}** | kJ/lap | Battery $I^2R$ loss ${lap.energy.batteryLossKJ.toFixed(1)} kJ/lap |
| **Full Throttle / Braking Duty** | ${(lap.fullThrottleFraction * 100).toFixed(1)}% / ${(lap.brakingFraction * 100).toFixed(1)}% | % time | Driver pedal duty cycle |

---

## 2. Vehicle Dynamics, 4-Corner Suspension & Aerodynamics

| Subsystem Parameter | Symbol | Value | Unit | Design Target / Justification |
| :--- | :---: | :---: | :---: | :--- |
| Total Vehicle + Driver Mass | $m$ | ${veh.mass.toFixed(1)} | kg | Static vertical load $\\sum F_{z,0} = ${staticFzN.toFixed(0)}\\text{ N}$ |
| Front Weight Distribution | $w_f$ | ${(veh.frontWeightFraction * 100).toFixed(1)} | % | Rear-biased for 2WD traction authority |
| CG Height / Wheelbase | $h_{cg} / L$ | ${(veh.cgHeight * 1000).toFixed(0)} / ${(veh.wheelbase * 1000).toFixed(0)} | mm | Longitudinal transfer $\\Delta F_{z,x} = m a_x h_{cg}/L$ |
| Track Width (Front / Rear) | $t_f / t_r$ | ${(veh.trackWidth * 1000).toFixed(0)} / ${((veh.trackWidthRear ?? veh.trackWidth) * 1000).toFixed(0)} | mm | Lateral roll stability base |
| **Front Roll Stiffness Share (LLTD)** | $\\lambda_{\\phi,f}$ | **${(veh.rollStiffnessFront * 100).toFixed(1)}** | % | Tuned ahead of mass share for limit stability |
| Roll Center Heights (Front / Rear) | $h_{rc,f} / h_{rc,r}$ | ${(veh.rollCenterFront * 1000).toFixed(0)} / ${(veh.rollCenterRear * 1000).toFixed(0)} | mm | Geometric vs elastic roll moment split |
| Static Camber (Front / Rear) | $\\gamma_f / \\gamma_r$ | ${veh.camberFront.toFixed(2)} / ${veh.camberRear.toFixed(2)} | deg | Camber thrust & roll camber compensation |
| Downforce Area ($C_L A$) & Aero Balance | $C_L A$ | ${veh.ClA.toFixed(2)} (${(veh.aeroBalanceFront * 100).toFixed(1)}% F) | m² | ${aero100KphN.toFixed(0)} N downforce @ 100 km/h |
| Drag Area ($C_D A$) & L/D Ratio | $C_D A$ | ${veh.CdA.toFixed(2)} (L/D ${(veh.ClA / Math.max(0.01, veh.CdA)).toFixed(2)}) | m² | ${drag100KphN.toFixed(0)} N aero drag @ 100 km/h |
| Tire Peak Grip Scaling | $\\lambda_\\mu$ | ${veh.tire.lambdaMu.toFixed(2)} | — | Pacejka Magic Formula $\\mu_0 = ${veh.tire.lateral.a2.toFixed(2)}$ |

---

## 3. Corner-by-Corner Speeds, Understeer Gradient & Inner Wheel Load

| Corner | Apex $s$ | Min Radius | Entry (km/h) | Apex (km/h) | Exit (km/h) | Peak Lat $G$ | Corner $K_{us}$ | Min Inner $F_z$ |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
${cornerRows}

---

## 4. 1D Parametric Sensitivity Jacobian & Tornado Ranking (±10% Perturbation)

| Rank | Parameter | Baseline | -10% $\\Delta t$ | +10% $\\Delta t$ | Total Swing | Linearized Jacobian Derivative |
| :---: | :--- | :---: | :---: | :---: | :---: | :--- |
${tornadoRows}

---

## 5. 22 km Multi-Lap Endurance Battery Sag & Thermal Derating Analysis (${endur.laps} Laps)

* **Total 22 km Stint Time:** **${endur.dnf ? `DNF at Lap ${endur.completedLaps} (${endur.dnfReason})` : `${endur.totalTimeS.toFixed(2)} s`}** (Naive $17 \\times \\text{Lap 1}$ = ${endur.naiveTotalTimeS.toFixed(2)} s $\\rightarrow$ **+${endur.sagPenaltyS.toFixed(2)} s** voltage sag & thermal derating penalty)
* **Accumulator SoC & Voltage Margin:** Start ${endur.initialSocPct.toFixed(1)}% $\\rightarrow$ End **${endur.finalSocPct.toFixed(1)}%** (Net energy ${endur.totalNetEnergyKWh.toFixed(2)} / ${pt.batteryCapacityKWh.toFixed(2)} kWh) · Min Terminal Voltage **${endur.minTerminalVoltageV.toFixed(0)} V** · Min Cell Voltage **${endur.minCellVoltageV.toFixed(2)} V** (VCU cutoff 3.10 V)
* **Peak Thermal State:** Cell Peak **${endur.peakCellTempC.toFixed(1)} °C** (FS derate knee 58.0 °C, hard rule 60.0 °C) · Motor/Inverter Peak **${endur.peakMotorTempC.toFixed(1)} °C** (derate knee 110.0 °C) · Coolant Peak **${endur.peakCoolantTempC.toFixed(1)} °C**
* **Automated Optimal Endurance Power Cap Recommendation:** **${endur.optimalCap.optimalPowerCapKW} kW** achieves **${endur.optimalCap.optimalTotalTimeS.toFixed(2)} s** (saving **${endur.optimalCap.timeSavedVsNominalS.toFixed(2)} s** vs nominal ${endur.nominalPowerCapKW.toFixed(0)} kW cap, finishing at ${endur.optimalCap.finalSocPct.toFixed(1)}% SoC and ${endur.optimalCap.peakCellTempC.toFixed(1)} °C peak cell temperature).

| Lap | Cum. Distance | Lap Time | End SoC | $V_{ocv}$ / $V_{term,min}$ | Min Cell $V$ | Cell Temp | Motor Temp | Effective Power Cap |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
${enduranceRows}

---

## 6. STM32H7 Production VCU Firmware Calibration Summary (\`vcu_dynamics_autogen.h/.c\`)

* **2D Driver Torque Request LUT (\`vcu_lookup_total_torque_nm\`):** ${bundle.torqueMap.pedalPct.length} APPS pedal breakpoints $\\times$ ${bundle.torqueMap.speedKph.length} speed breakpoints ($0 \\dots ${bundle.torqueMap.maxSpeedKph.toFixed(1)}\\text{ km/h}$), exponent $\\gamma = ${bundle.torqueMap.pedalGamma}$, peak total rear axle motor torque **${(pt.motorPeakTorque * pt.motorCount).toFixed(1)} Nm**.
* **2D Torque Vectoring Yaw Matrix (\`vcu_lookup_tv_delta_torque_nm\`) & PI Gains:** ${bundle.autogenTables.steerAxisDeg.length} steering breakpoints $\\times$ ${bundle.autogenTables.speedAxisKph.length} speed breakpoints · $K_p = ${bundle.tvParams.kp.toFixed(1)}\\text{ Nm/(rad/s)}$, $K_i = ${bundle.tvParams.ki.toFixed(1)}\\text{ Nm/rad}$, $|M_z| \\le ${bundle.tvParams.mzLimit.toFixed(0)}\\text{ Nm}$, calibrated to chassis $K_{us} = ${bundle.autogenTables.understeerDegPerG.toFixed(2)}^\\circ\\text{/G}$.
* **Launch / Traction Control Target (\`v_wheel_max_target\`):** Load-sensitive Pacejka slip-ratio schedule $\\kappa^*(a_x) \\in [${Math.min(...bundle.autogenTables.tcSlipTarget).toFixed(4)}, ${Math.max(...bundle.autogenTables.tcSlipTarget).toFixed(4)}]$.
* **Thermal & Low-Voltage Derating (\`vcu_calc_power_derating\`):** Continuous piecewise-linear multiplier protecting cell temperature ($53^\\circ\\text{C} \\rightarrow 58^\\circ\\text{C} \\rightarrow 60^\\circ\\text{C}$), motor/inverter temperature ($102^\\circ\\text{C} \\rightarrow 110^\\circ\\text{C} \\rightarrow 120^\\circ\\text{C}$), and minimum cell voltage under load ($3.25\\text{ V} \\rightarrow 3.10\\text{ V}$).
`;
}

/**
 * Opens a clean, competition-formatted printable view of the FSAE Engineering Design Dossier
 * so the user can save directly to PDF from the browser print dialog.
 */
export function printFsaeDesignReport(markdown: string, title = 'FSAE Engineering Design Report — ApexLapSim'): void {
  if (typeof window === 'undefined') return;
  const win = window.open('', '_blank', 'width=980,height=820');
  if (!win) return;
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  win.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body {
      font-family: 'JetBrains Mono', Consolas, monospace;
      margin: 28px 36px;
      color: #0f172a;
      background: #ffffff;
      font-size: 11px;
      line-height: 1.5;
    }
    h1 { font-size: 16px; border-bottom: 2px solid #0f172a; padding-bottom: 6px; }
    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: inherit;
      font-size: 11px;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      padding: 16px;
      border-radius: 4px;
    }
    @media print {
      body { margin: 12mm; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
    <strong>${title}</strong>
    <button onclick="window.print()" style="padding:6px 14px;cursor:pointer;font-family:inherit;font-weight:bold;">Print / Save as PDF</button>
  </div>
  <pre>${escaped}</pre>
  <script>setTimeout(() => window.print(), 250);</script>
</body>
</html>`);
  win.document.close();
}
