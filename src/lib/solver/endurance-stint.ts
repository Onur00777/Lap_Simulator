import {
  buildEfficiencyMap,
  clamp,
  interp1,
  speedFromMotorRpm,
  type LateralModel,
  type PowertrainParams,
  type VehicleParams,
} from '../physics';
import { buildTwoTrackEnvelope } from '../dynamics';
import type { Track } from '../tracks/types';
import { createContext } from './context';
import { simulateLap, type Integrator } from './lap-simulator';

export interface EnduranceStintOptions {
  /** Number of laps (default 17 laps for ~22 km FS Endurance). */
  laps?: number;
  /** Initial State of Charge [0..1] (default 1.0 = 100%). */
  initialSoc?: number;
  /** Minimum reserve SoC [0..1] before DNF (default 0.05 = 5%). */
  minReserveSoc?: number;
  /** Ambient air temperature [°C] (default 28 °C). */
  ambientTempC?: number;
  /** Initial cell temperature [°C] (default 30 °C). */
  initialCellTempC?: number;
  /** Initial motor/inverter temperature [°C] (default 35 °C). */
  initialMotorTempC?: number;
  /** Override nominal accumulator power cap [W]. Defaults to pt.batteryPowerLimit. */
  nominalPowerCapW?: number;
  /** Lateral model ('point-mass' | 'two-track-open' | 'two-track-tv'). */
  model?: LateralModel;
  /** Integrator ('rk4' | 'euler'). */
  integrator?: Integrator;
}

export type DeratingCause = 'none' | 'cell-temp' | 'motor-temp' | 'cell-voltage' | 'low-soc';

export interface EnduranceLapState {
  lap: number;
  distanceCumKm: number;
  lapTimeS: number;
  cumulativeTimeS: number;
  socStartPct: number;
  socEndPct: number;
  ocvStartV: number;
  terminalVoltageMinV: number;
  minCellVoltageV: number;
  packResistanceOhm: number;
  cellTempC: number;
  motorTempC: number;
  coolantTempC: number;
  effectivePowerCapKW: number;
  deratingPct: number;
  deratingCause: DeratingCause;
  netEnergyWh: number;
  dischargeWh: number;
  regenWh: number;
  packHeatKJ: number;
  coolingHeatKJ: number;
  radiatorRejectedKJ: number;
  dnf: boolean;
}

export interface PowerCapSweepPoint {
  powerCapKW: number;
  totalTimeS: number;
  finalSocPct: number;
  peakCellTempC: number;
  peakMotorTempC: number;
  minCellVoltageV: number;
  deratedLaps: number;
  dnf: boolean;
}

export interface EnduranceStintResult {
  laps: number;
  totalDistanceKm: number;
  nominalPowerCapKW: number;
  totalTimeS: number;
  naiveTotalTimeS: number;
  sagPenaltyS: number;
  totalNetEnergyKWh: number;
  initialSocPct: number;
  finalSocPct: number;
  minTerminalVoltageV: number;
  minCellVoltageV: number;
  peakCellTempC: number;
  peakMotorTempC: number;
  peakCoolantTempC: number;
  deratedLapCount: number;
  completedLaps: number;
  dnf: boolean;
  dnfReason: string | null;
  lapHistory: EnduranceLapState[];
  optimalCap: {
    optimalPowerCapKW: number;
    optimalTotalTimeS: number;
    timeSavedVsNominalS: number;
    finalSocPct: number;
    peakCellTempC: number;
    peakMotorTempC: number;
    minCellVoltageV: number;
    deratedLaps: number;
    sweep: PowerCapSweepPoint[];
  };
}

const SERIES_CELLS_REF = 132; // 132s LiPo/Li-ion (~550 V nominal at 4.16 V/cell)

/**
 * Single-cell open-circuit voltage V_cell,ocv(soc) [V] for soc in [0, 1].
 * Captures the 4.20 V top-of-charge plateau, linear mid-band, and steep knee below 15% SoC.
 */
export function cellOpenCircuitVoltage(soc: number): number {
  const s = clamp(soc, 0, 1);
  return 3.25 + 0.72 * s + 0.16 * s * s * s + 0.07 * Math.exp(-18 * (1 - s)) - 0.22 * Math.exp(-22 * s);
}

/**
 * Pack open-circuit voltage V_ocv(soc) [V] scaled to the powertrain's nominal voltage.
 */
export function packOpenCircuitVoltage(pt: PowertrainParams, soc: number): number {
  const scale = pt.batteryVoltage / (SERIES_CELLS_REF * cellOpenCircuitVoltage(0.85));
  return SERIES_CELLS_REF * cellOpenCircuitVoltage(soc) * scale;
}

/**
 * Temperature- and SoC-dependent pack internal resistance R_pack(T_cell, SoC) [Ohm].
 */
export function packInternalResistance(pt: PowertrainParams, cellTempC: number, soc: number): number {
  const s = clamp(soc, 0.01, 1);
  const dT = cellTempC - 25;
  const tempFactor = Math.max(0.78, 1 - 0.0055 * dT + 0.00018 * dT * dT);
  const socFactor = 1 + 1.35 * Math.exp(-9.5 * s);
  return pt.batteryResistance * tempFactor * socFactor;
}

interface PrecomputedLapTable {
  pGridW: number[];
  lapTimeS: number[];
  netKWh: number[];
  dischargeKWh: number[];
  regenKWh: number[];
  coolingHeatKJ: number[];
  batteryLossKJ: number[];
  avgSpeedMps: number[];
  lapDistanceM: number;
}

function buildLapPowerTable(
  track: Track,
  veh: VehicleParams,
  pt: PowertrainParams,
  model: LateralModel,
  integrator: Integrator,
): PrecomputedLapTable {
  const map = buildEfficiencyMap(pt);
  const vTop = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio) + 2;
  const env =
    model === 'point-mass'
      ? undefined
      : buildTwoTrackEnvelope(veh, pt, vTop, model === 'two-track-tv' ? 'tv' : 'open', 1.0);

  const pMax = Math.max(85000, pt.batteryPowerLimit * 1.15);
  const pGridW = [15000, 25000, 35000, 45000, 55000, 62000, 68000, 74000, 80000, pMax].sort((a, b) => a - b);

  const lapTimeS: number[] = [];
  const netKWh: number[] = [];
  const dischargeKWh: number[] = [];
  const regenKWh: number[] = [];
  const coolingHeatKJ: number[] = [];
  const batteryLossKJ: number[] = [];
  const avgSpeedMps: number[] = [];
  let lapDistanceM = track.length;

  for (const pW of pGridW) {
    const ptMod: PowertrainParams = { ...pt, batteryPowerLimit: pW };
    const ctx = createContext(veh, ptMod, env);
    ctx.map = map;
    const lap = simulateLap(track, ctx, { integrator });
    lapDistanceM = lap.distance;
    lapTimeS.push(lap.lapTime);
    netKWh.push(lap.energy.netKWh);
    dischargeKWh.push(lap.energy.dischargeKWh);
    regenKWh.push(lap.energy.regenKWh);
    coolingHeatKJ.push(lap.energy.coolingHeatKJ);
    batteryLossKJ.push(lap.energy.batteryLossKJ);
    avgSpeedMps.push(lap.avgSpeed);
  }

  return {
    pGridW,
    lapTimeS,
    netKWh,
    dischargeKWh,
    regenKWh,
    coolingHeatKJ,
    batteryLossKJ,
    avgSpeedMps,
    lapDistanceM,
  };
}

function simulateWithTable(
  tab: PrecomputedLapTable,
  pt: PowertrainParams,
  nominalCapW: number,
  opts: Required<Pick<EnduranceStintOptions, 'laps' | 'initialSoc' | 'minReserveSoc' | 'ambientTempC' | 'initialCellTempC' | 'initialMotorTempC'>>,
): {
  lapHistory: EnduranceLapState[];
  totalTimeS: number;
  totalNetEnergyKWh: number;
  finalSocPct: number;
  minTerminalVoltageV: number;
  minCellVoltageV: number;
  peakCellTempC: number;
  peakMotorTempC: number;
  peakCoolantTempC: number;
  deratedLapCount: number;
  completedLaps: number;
  dnf: boolean;
  dnfReason: string | null;
} {
  const { laps, initialSoc, minReserveSoc, ambientTempC, initialCellTempC, initialMotorTempC } = opts;
  const capKWh = Math.max(0.5, pt.batteryCapacityKWh);
  const scaleCells = pt.batteryVoltage / (SERIES_CELLS_REF * cellOpenCircuitVoltage(0.85));

  // Thermal capacitances [J/K]
  const cThPack = 36000; // ~34 kg cells + busbars
  const cThMotor = 11500; // dual PMSM stators/rotors + inverter coldplate
  const cThCoolant = 16500; // water/glycol loop + radiator cores

  let soc = initialSoc;
  let cellTempC = initialCellTempC;
  let motorTempC = initialMotorTempC;
  let coolantTempC = ambientTempC + 4;

  let cumTimeS = 0;
  let cumNetKWh = 0;
  let minTermV = Infinity;
  let minCellV = Infinity;
  let peakCellC = cellTempC;
  let peakMotorC = motorTempC;
  let peakCoolC = coolantTempC;
  let deratedLapCount = 0;
  let completedLaps = 0;
  let dnf = false;
  let dnfReason: string | null = null;

  const lapHistory: EnduranceLapState[] = [];

  for (let k = 1; k <= laps; k++) {
    const socStart = soc;
    const ocv = packOpenCircuitVoltage(pt, socStart);
    const rPack = packInternalResistance(pt, cellTempC, socStart);

    // 1. Evaluate VCU Thermal & Low-SoC / Min-Cell-Voltage Power Derating
    // Cell temp derating starts at 53.0°C, reaches 25% cap at 58.0°C (FS 60°C rule margin)
    const etaCellTemp = cellTempC <= 52.5 ? 1.0 : clamp((58.5 - cellTempC) / (58.5 - 52.5), 0.22, 1.0);
    // Motor temp derating starts at 96.0°C, reaches 25% cap at 110.0°C
    const etaMotorTemp = motorTempC <= 96.0 ? 1.0 : clamp((111.0 - motorTempC) / (111.0 - 96.0), 0.25, 1.0);
    // Low-SoC soft derating below 16% SoC
    const etaSoc = socStart >= 0.16 ? 1.0 : clamp((socStart - 0.03) / (0.16 - 0.03), 0.20, 1.0);

    // Min cell voltage under load derating: keep V_cell,min >= 3.10 V under peak power draw
    const vTermFloor = SERIES_CELLS_REF * (3.10 + 0.025) * scaleCells;
    const pMaxVoltageW = vTermFloor < ocv ? (vTermFloor * (ocv - vTermFloor)) / rPack : nominalCapW * 0.25;
    const etaVolt = clamp(pMaxVoltageW / Math.max(1, nominalCapW), 0.22, 1.0);

    const minEta = Math.min(etaCellTemp, etaMotorTemp, etaSoc, etaVolt);
    const effPowerW = clamp(nominalCapW * minEta, tab.pGridW[0], tab.pGridW[tab.pGridW.length - 1]);

    let cause: DeratingCause = 'none';
    if (minEta < 0.992) {
      deratedLapCount++;
      if (etaCellTemp <= etaMotorTemp && etaCellTemp <= etaVolt && etaCellTemp <= etaSoc) cause = 'cell-temp';
      else if (etaMotorTemp <= etaCellTemp && etaMotorTemp <= etaVolt && etaMotorTemp <= etaSoc) cause = 'motor-temp';
      else if (etaVolt <= etaSoc) cause = 'cell-voltage';
      else cause = 'low-soc';
    }

    // 2. Interpolate lap performance at effPowerW
    const lapTimeS = interp1(tab.pGridW, tab.lapTimeS, effPowerW);
    const baseNetKWh = interp1(tab.pGridW, tab.netKWh, effPowerW);
    const dischargeKWh = interp1(tab.pGridW, tab.dischargeKWh, effPowerW);
    const regenKWh = interp1(tab.pGridW, tab.regenKWh, effPowerW);
    const coolingHeatKJ = interp1(tab.pGridW, tab.coolingHeatKJ, effPowerW);
    const baseBattLossKJ = interp1(tab.pGridW, tab.batteryLossKJ, effPowerW);
    const avgSpeedMps = interp1(tab.pGridW, tab.avgSpeedMps, effPowerW);

    // Scale I^2 R battery heating by (V_nom / V_ocv)^2 * (R_pack / R_0) because lower OCV requires higher current for same power
    const vRatio = pt.batteryVoltage / Math.max(200, ocv);
    const rRatio = rPack / Math.max(0.01, pt.batteryResistance);
    const packHeatKJ = baseBattLossKJ * vRatio * vRatio * rRatio;
    const extraPackLossKWh = Math.max(0, (packHeatKJ - baseBattLossKJ) / 3600);
    const lapNetKWh = baseNetKWh + extraPackLossKWh;

    // Peak load terminal voltage sag during the lap
    const pPeakDraw = Math.min(effPowerW, nominalCapW);
    const disc = Math.max(0, ocv * ocv - 4 * rPack * pPeakDraw);
    const iPeak = (ocv - Math.sqrt(disc)) / (2 * rPack);
    const vTermMin = ocv - iPeak * rPack;
    const vCellMin = vTermMin / (SERIES_CELLS_REF * scaleCells) - 0.025;

    // 3. Update SoC & Thermal states over lapTimeS
    const dSoc = lapNetKWh / capKWh;
    soc = Math.max(0, socStart - dSoc);

    // Pack thermal update
    const uaPack = 16 + 1.8 * Math.pow(Math.max(5, avgSpeedMps), 0.75); // W/K air cooling on accumulator
    const qPackRejJ = uaPack * (cellTempC - ambientTempC) * lapTimeS;
    cellTempC = cellTempC + (packHeatKJ * 1000 - qPackRejJ) / cThPack;

    // Motor & Coolant lump-capacitance thermal update (sub-stepped for stability)
    const subSteps = 10;
    const dtSub = lapTimeS / subSteps;
    const pHeatInW = (coolingHeatKJ * 1000) / lapTimeS;
    const uaMotCool = 215; // W/K motor/inverter coldplate conductance
    const uaRad = 88 + 13.5 * Math.pow(Math.max(5, avgSpeedMps), 0.8); // W/K sidepod radiator rejection
    let qRadRejJ = 0;
    for (let s = 0; s < subSteps; s++) {
      const qMotToCoolW = uaMotCool * (motorTempC - coolantTempC);
      const qRadW = uaRad * (coolantTempC - ambientTempC);
      motorTempC += ((pHeatInW - qMotToCoolW) * dtSub) / cThMotor;
      coolantTempC += ((qMotToCoolW - qRadW) * dtSub) / cThCoolant;
      qRadRejJ += qRadW * dtSub;
    }

    cumTimeS += lapTimeS;
    cumNetKWh += lapNetKWh;
    minTermV = Math.min(minTermV, vTermMin);
    minCellV = Math.min(minCellV, vCellMin);
    peakCellC = Math.max(peakCellC, cellTempC);
    peakMotorC = Math.max(peakMotorC, motorTempC);
    peakCoolC = Math.max(peakCoolC, coolantTempC);

    const isLapDnf = soc < minReserveSoc || cellTempC > 60.0 || motorTempC > 120.0 || vCellMin < 2.95;
    if (isLapDnf && !dnf) {
      dnf = true;
      if (soc < minReserveSoc) dnfReason = `Battery depleted on Lap ${k} (SoC ${(soc * 100).toFixed(1)}% < ${(minReserveSoc * 100).toFixed(0)}% reserve)`;
      else if (cellTempC > 60.0) dnfReason = `Accumulator over-temp trip on Lap ${k} (${cellTempC.toFixed(1)}°C > 60°C FS rule limit)`;
      else if (motorTempC > 120.0) dnfReason = `Motor over-temp trip on Lap ${k} (${motorTempC.toFixed(1)}°C > 120°C limit)`;
      else dnfReason = `BMS under-voltage trip on Lap ${k} (${vCellMin.toFixed(2)}V < 2.95V/cell)`;
    }
    if (!dnf) completedLaps = k;

    lapHistory.push({
      lap: k,
      distanceCumKm: (k * tab.lapDistanceM) / 1000,
      lapTimeS,
      cumulativeTimeS: cumTimeS,
      socStartPct: socStart * 100,
      socEndPct: soc * 100,
      ocvStartV: ocv,
      terminalVoltageMinV: vTermMin,
      minCellVoltageV: vCellMin,
      packResistanceOhm: rPack,
      cellTempC,
      motorTempC,
      coolantTempC,
      effectivePowerCapKW: effPowerW / 1000,
      deratingPct: (1 - effPowerW / Math.max(1, nominalCapW)) * 100,
      deratingCause: cause,
      netEnergyWh: lapNetKWh * 1000,
      dischargeWh: dischargeKWh * 1000,
      regenWh: regenKWh * 1000,
      packHeatKJ,
      coolingHeatKJ,
      radiatorRejectedKJ: qRadRejJ / 1000,
      dnf: isLapDnf,
    });
  }

  return {
    lapHistory,
    totalTimeS: cumTimeS,
    totalNetEnergyKWh: cumNetKWh,
    finalSocPct: soc * 100,
    minTerminalVoltageV: minTermV,
    minCellVoltageV: minCellV,
    peakCellTempC: peakCellC,
    peakMotorTempC: peakMotorC,
    peakCoolantTempC: peakCoolC,
    deratedLapCount,
    completedLaps,
    dnf,
    dnfReason,
  };
}

/**
 * Simulates a full multi-lap Formula Student Endurance stint (default 17 laps / ~22 km)
 * with sequential battery SoC depletion, V_ocv(SoC) sag, I^2 R cell heating, coolant/motor
 * thermal balance, VCU power derating, and an automated Optimal Endurance Power Cap Finder.
 */
export function simulateEnduranceStint(
  track: Track,
  veh: VehicleParams,
  pt: PowertrainParams,
  opts: EnduranceStintOptions = {},
): EnduranceStintResult {
  const defaultLaps = opts.laps ?? Math.max(15, Math.round(22000 / Math.max(400, track.length)));
  const simOpts = {
    laps: defaultLaps,
    initialSoc: opts.initialSoc ?? 1.0,
    minReserveSoc: opts.minReserveSoc ?? 0.05,
    ambientTempC: opts.ambientTempC ?? 28,
    initialCellTempC: opts.initialCellTempC ?? 30,
    initialMotorTempC: opts.initialMotorTempC ?? 35,
  };
  const model = opts.model ?? 'point-mass';
  const integrator = opts.integrator ?? 'rk4';
  const nominalCapW = opts.nominalPowerCapW ?? pt.batteryPowerLimit;

  const tab = buildLapPowerTable(track, veh, pt, model, integrator);
  const mainRun = simulateWithTable(tab, pt, nominalCapW, simOpts);

  const lap1TimeS = interp1(tab.pGridW, tab.lapTimeS, nominalCapW);
  const naiveTotalTimeS = lap1TimeS * simOpts.laps;

  // Automated Optimal Endurance Power Cap Finder (sweeps 30 kW .. 80 kW in 2 kW steps + fine 0.5 kW refinement)
  const sweep: PowerCapSweepPoint[] = [];
  let bestCapKW = nominalCapW / 1000;
  let bestScore = Infinity;
  let bestRun = mainRun;

  for (let kw = 32; kw <= 80; kw += 2) {
    const r = simulateWithTable(tab, pt, kw * 1000, simOpts);
    sweep.push({
      powerCapKW: kw,
      totalTimeS: r.totalTimeS,
      finalSocPct: r.finalSocPct,
      peakCellTempC: r.peakCellTempC,
      peakMotorTempC: r.peakMotorTempC,
      minCellVoltageV: r.minCellVoltageV,
      deratedLaps: r.deratedLapCount,
      dnf: r.dnf,
    });
    // Prefer zero-DNF runs with minimal thermal derating and fastest total time
    const penalty = (r.dnf ? 1000 : 0) + (r.deratedLapCount > 0 ? r.deratedLapCount * 0.35 : 0);
    const score = r.totalTimeS + penalty;
    if (score < bestScore) {
      bestScore = score;
      bestCapKW = kw;
      bestRun = r;
    }
  }

  // Fine 0.5 kW refinement around bestCapKW
  const fineLo = Math.max(30, bestCapKW - 3);
  const fineHi = Math.min(80, bestCapKW + 3);
  for (let kw = fineLo; kw <= fineHi; kw += 0.5) {
    const r = simulateWithTable(tab, pt, kw * 1000, simOpts);
    const penalty = (r.dnf ? 1000 : 0) + (r.deratedLapCount > 0 ? r.deratedLapCount * 0.35 : 0);
    const score = r.totalTimeS + penalty;
    if (score < bestScore) {
      bestScore = score;
      bestCapKW = kw;
      bestRun = r;
    }
  }

  return {
    laps: simOpts.laps,
    totalDistanceKm: (simOpts.laps * tab.lapDistanceM) / 1000,
    nominalPowerCapKW: nominalCapW / 1000,
    totalTimeS: mainRun.totalTimeS,
    naiveTotalTimeS,
    sagPenaltyS: mainRun.totalTimeS - naiveTotalTimeS,
    totalNetEnergyKWh: mainRun.totalNetEnergyKWh,
    initialSocPct: simOpts.initialSoc * 100,
    finalSocPct: mainRun.finalSocPct,
    minTerminalVoltageV: mainRun.minTerminalVoltageV,
    minCellVoltageV: mainRun.minCellVoltageV,
    peakCellTempC: mainRun.peakCellTempC,
    peakMotorTempC: mainRun.peakMotorTempC,
    peakCoolantTempC: mainRun.peakCoolantTempC,
    deratedLapCount: mainRun.deratedLapCount,
    completedLaps: mainRun.completedLaps,
    dnf: mainRun.dnf,
    dnfReason: mainRun.dnfReason,
    lapHistory: mainRun.lapHistory,
    optimalCap: {
      optimalPowerCapKW: bestCapKW,
      optimalTotalTimeS: bestRun.totalTimeS,
      timeSavedVsNominalS: mainRun.totalTimeS - bestRun.totalTimeS,
      finalSocPct: bestRun.finalSocPct,
      peakCellTempC: bestRun.peakCellTempC,
      peakMotorTempC: bestRun.peakMotorTempC,
      minCellVoltageV: bestRun.minCellVoltageV,
      deratedLaps: bestRun.deratedLapCount,
      sweep,
    },
  };
}
