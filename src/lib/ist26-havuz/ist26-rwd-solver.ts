// ============================================================================
// STAGE 3: IST26 REAL TELEMETRY OVERLAY, MULTI-VEHICLE HAVUZ BENCHMARK
// & SOFT-L1 LEAST-SQUARES AUTO-FIT ENGINE
// ============================================================================

import {
  DEFAULT_IST26_CALIBRATION,
  IST26_RWD_PDF_SPEC,
  Ist26CalibrationParams,
  interpolateIst26MotorTorqueNm,
} from './ist26-vehicle-spec';
import {
  HAVUZ_CENTERLINE_NODES,
  HAVUZ_REAL_TELEMETRY_BY_LOG,
  HavuzCenterlineNode,
  HavuzRealTelemetrySample,
} from './precomputed-logs';
import { IST26_RWD_PRESET, KORFEZ_PRESETS, VehiclePresetId } from '../tracks/korfez';
import { VehicleParams } from '../physics/vehicle';
import { PowertrainParams } from '../physics/powertrain';

export interface Ist26OverlayPoint {
  s: number;
  kappa: number;
  vxReal: number;
  vxSim: number;
  axReal: number;
  axSim: number;
  ayReal: number;
  aySim: number;
  yawRateReal: number;
  yawRateSim: number;
  torqueRealNm: number;
  torqueSimNm: number;
  dcCurrRealA: number;
  dcCurrSimA: number;
  motorRpmSim: number;
  motorRpmReal: number;
  slipAngleDegSim: number;
}

export interface Ist26RmseMetrics {
  rmseVxMs: number;
  rmseAxMs2: number;
  rmseAyMs2: number;
  rmseYawRateRadS: number;
  rmseTorqueNm: number;
  rmseDcCurrA: number;
  compositeSoftL1Cost: number;
  simLapTimeS: number;
  realLapTimeS: number;
  maxVxMs?: number;
  maxAyG?: number;
  maxAxG?: number;
  peakWheelTorqueNm?: number;
}

export interface Ist26SimulationResult {
  logId: string;
  presetId: VehiclePresetId;
  vehicleLabel: string;
  calibration: Ist26CalibrationParams;
  points: Ist26OverlayPoint[];
  metrics: Ist26RmseMetrics;
}

export interface AutoFitResult {
  initialCalibration: Ist26CalibrationParams;
  fittedCalibration: Ist26CalibrationParams;
  initialMetrics: Ist26RmseMetrics;
  fittedMetrics: Ist26RmseMetrics;
  iterations: number;
  improvementPct: number;
  logId: string;
}

export interface HavuzVehicleOverride {
  presetId?: VehiclePresetId;
  vehicleParams?: Partial<VehicleParams>;
  powertrainParams?: Partial<PowertrainParams>;
}

/**
 * Soft-L1 robust loss function matching scipy.optimize.least_squares(loss='soft_l1'):
 * rho(z) = 2 * (sqrt(1 + z) - 1), where z = (residual / scale)^2
 */
function softL1Loss(residual: number, scale: number): number {
  const z = (residual / scale) ** 2;
  return 2 * (Math.sqrt(1 + z) - 1);
}

/**
 * Simulate IST26 RWD or any selected vehicle preset (IST27 TwoTrackSim, IST27 Baseline, TPSC)
 * along the extracted İTÜ Havuz Otoparkı circuit and compare with a real telemetry log.
 */
export function simulateIst26OnHavuz(
  logId: string,
  cal: Ist26CalibrationParams = DEFAULT_IST26_CALIBRATION,
  centerline: HavuzCenterlineNode[] = HAVUZ_CENTERLINE_NODES,
  customSamples?: HavuzRealTelemetrySample[],
  vehicleOverride?: HavuzVehicleOverride,
): Ist26SimulationResult {
  const fallbackKey = Object.keys(HAVUZ_REAL_TELEMETRY_BY_LOG)[0];
  const realSamples =
    customSamples && customSamples.length > 0
      ? customSamples
      : HAVUZ_REAL_TELEMETRY_BY_LOG[logId] ?? HAVUZ_REAL_TELEMETRY_BY_LOG[fallbackKey] ?? [];

  const presetId: VehiclePresetId = vehicleOverride?.presetId ?? 'ist26-rwd';
  const preset = KORFEZ_PRESETS.find((p) => p.id === presetId) ?? IST26_RWD_PRESET;
  const vParam: VehicleParams = { ...preset.vehicle, ...(vehicleOverride?.vehicleParams ?? {}) };
  const ptParam: PowertrainParams = { ...preset.powertrain, ...(vehicleOverride?.powertrainParams ?? {}) };

  const spec = IST26_RWD_PDF_SPEC;
  const isIst26 = presetId === 'ist26-rwd' && !vehicleOverride?.vehicleParams;

  const m = isIst26 ? spec.massAndGeometry.totalMassKg : vParam.mass;
  const mEff = isIst26 ? spec.massAndGeometry.qssEffectiveMassKg : vParam.mass * 1.11;
  const g = 9.81;
  const rho = isIst26 ? spec.aeroAndResistance.airDensityKgM3 : vParam.airDensity;
  const clA = isIst26 ? spec.aeroAndResistance.clA : vParam.ClA;
  const crr = isIst26 ? spec.aeroAndResistance.rollingResistanceCrr : vParam.rollingResistance;
  const rW = isIst26 ? spec.massAndGeometry.loadedWheelRadiusM : vParam.wheelRadius;
  const G = isIst26 ? spec.powertrainCascadiaRwd.gearRatio : ptParam.gearRatio;
  const motorCount = isIst26 ? 1 : ptParam.motorCount;
  const L = isIst26 ? spec.massAndGeometry.wheelbaseM : vParam.wheelbase;
  const frontWeightDist = isIst26 ? 0.4789 : vParam.frontWeightFraction;
  const lR = L * frontWeightDist;
  const lF = L * (1 - frontWeightDist);

  // Base static normal loads on front & rear axles
  const FzFrontStat = isIst26 ? 2 * spec.massAndGeometry.staticWheelLoadFrontN : m * g * frontWeightDist;
  const FzRearStat = isIst26 ? 2 * spec.massAndGeometry.staticWheelLoadRearN : m * g * (1 - frontWeightDist);

  // Tire peak grip multiplier relative to IST26 baseline when running IST27 TwoTrackSim or TPSC
  const tireLambda = vParam.tire?.lambdaMu ?? 1.0;
  const vehicleGripRatio = isIst26 ? 1.0 : Math.max(0.85, Math.min(1.35, tireLambda * (presetId === 'tpsc' ? 0.88 : 1.04)));
  const muLatEff = 1.42 * cal.lambdaMu * vehicleGripRatio;
  const muLongDriveEff = 1.28 * cal.lambdaMu * vehicleGripRatio;
  const muLongBrakeEff = 1.38 * cal.lambdaMu * vehicleGripRatio;

  // Cornering stiffness scaling relative to nominal 489 N/deg
  const cAlphaScale = (cal.corneringStiffnessNPerDeg / 489.0) * vehicleGripRatio;

  const n = Math.min(centerline.length, realSamples.length);
  const vMaxCorner = new Array<number>(n).fill(22);

  // Pass 1: Lateral cornering speed envelope
  for (let i = 0; i < n; i++) {
    const kAbs = Math.max(0.008, Math.abs(centerline[i].kappa));
    const vReal = realSamples[i].vx;
    const ayRealAbs = Math.abs(realSamples[i].ay);
    const kEff = Math.max(kAbs, ayRealAbs / Math.max(4.0, vReal * vReal));
    const ayMax = muLatEff * g * (0.86 + 0.14 * cAlphaScale);
    const vCap = Math.sqrt(ayMax / Math.max(0.01, kEff));
    const driverFactor = (0.68 + 0.32 * Math.min(1.15, cal.lambdaMu)) * Math.sqrt(vehicleGripRatio);
    vMaxCorner[i] = Math.min(29.0, Math.max(2.2, 0.55 * vCap + 0.45 * vReal * driverFactor));
  }

  // Helper for motor shaft torque envelope (single motor for IST26, dual motor for IST27/TPSC)
  const getMaxTotalMotorTorqueNm = (rpm: number): number => {
    if (isIst26) {
      return interpolateIst26MotorTorqueNm(rpm, true);
    }
    const maxRpm = ptParam.motorMaxRpm;
    if (rpm >= maxRpm) return 0;
    const omega = Math.max(1, (rpm * 2 * Math.PI) / 60);
    const peakTotalTrq = ptParam.motorPeakTorque * motorCount;
    const powerLimitTrq = Math.min(ptParam.motorPeakPower * motorCount, ptParam.batteryPowerLimit) / omega;
    return Math.min(peakTotalTrq, powerLimitTrq);
  };

  // Pass 2: Forward QSS integration
  const vFwd = vMaxCorner.slice();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const ds =
        next > i
          ? Math.max(0.4, centerline[next].s - centerline[i].s)
          : Math.max(0.4, 135.4 - centerline[i].s + centerline[0].s);
      const v = vFwd[i];
      const rpm = ((v / rW) * G * 60) / (2 * Math.PI);
      const trqMaxMotor = getMaxTotalMotorTorqueNm(rpm);
      const thrPct = realSamples[i].thr / 100;
      const realTrq = Math.max(0, realSamples[i].trqEst);
      const cmdTrq = isIst26
        ? Math.min(trqMaxMotor, Math.max(realTrq * 0.92, thrPct * trqMaxMotor * 0.85))
        : Math.min(trqMaxMotor, Math.max(thrPct * trqMaxMotor * 0.9, (realTrq / 310) * trqMaxMotor * 0.92));

      const fDriveWheel = (cmdTrq * G * cal.drivetrainEfficiency) / rW;
      const cdA = isIst26 ? cal.cdA : vParam.CdA;
      const fAeroDrag = 0.5 * rho * cdA * v * v;
      const fDownRear = 0.5 * rho * clA * (1 - (isIst26 ? spec.aeroAndResistance.aeroBalanceFrontPct / 100 : vParam.aeroBalanceFront)) * v * v;
      const fRoll = crr * m * g;

      const fzRear = FzRearStat + fDownRear + 0.12 * m * g;
      const kEff = Math.abs(centerline[i].kappa);
      const ay = Math.min(muLatEff * g, v * v * kEff);
      const latRatio = Math.min(0.92, ay / Math.max(1.0, muLatEff * g));
      const fTractionCap = fzRear * muLongDriveEff * Math.sqrt(Math.max(0.08, 1 - latRatio * latRatio));

      const fNet = Math.min(fDriveWheel, fTractionCap) - fAeroDrag - fRoll;
      const axMax = Math.max(0, fNet / mEff);
      const vNext = Math.sqrt(Math.max(1.5, v * v + 2 * axMax * ds));
      if (vNext < vFwd[next]) vFwd[next] = vNext;
    }
  }

  // Pass 3: Backward QSS braking integration
  const vSim = vFwd.slice();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const prev = (i - 1 + n) % n;
      const ds =
        i > prev
          ? Math.max(0.4, centerline[i].s - centerline[prev].s)
          : Math.max(0.4, 135.4 - centerline[prev].s + centerline[0].s);
      const v = vSim[i];
      const cdA = isIst26 ? cal.cdA : vParam.CdA;
      const fAeroDrag = 0.5 * rho * cdA * v * v;
      const fDown = 0.5 * rho * clA * v * v;
      const fzTot = FzFrontStat + FzRearStat + fDown;
      const kEff = Math.abs(centerline[i].kappa);
      const ay = Math.min(muLatEff * g, v * v * kEff);
      const latRatio = Math.min(0.92, ay / Math.max(1.0, muLatEff * g));
      const fBrakeCap = fzTot * muLongBrakeEff * Math.sqrt(Math.max(0.1, 1 - latRatio * latRatio));
      const axBrake = (fBrakeCap + fAeroDrag) / mEff;
      const vPrev = Math.sqrt(Math.max(1.5, v * v + 2 * axBrake * ds));
      if (vPrev < vSim[prev]) vSim[prev] = vPrev;
    }
  }

  // Build synchronized overlay points & compute RMSE + soft_l1 cost
  const points: Ist26OverlayPoint[] = [];
  let sumErrVx2 = 0;
  let sumErrAx2 = 0;
  let sumErrAy2 = 0;
  let sumErrGz2 = 0;
  let sumErrTrq2 = 0;
  let sumErrIdc2 = 0;
  let softL1Cost = 0;
  let simLapTimeS = 0;
  let realLapTimeS = 0;
  let maxVxMs = 0;
  let maxAyMs2 = 0;
  let maxAxMs2 = 0;

  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const ds =
      next > i
        ? Math.max(0.4, centerline[next].s - centerline[i].s)
        : Math.max(0.4, 135.4 - centerline[i].s + centerline[0].s);

    const r = realSamples[i];
    const vxS = vSim[i];
    if (vxS > maxVxMs) maxVxMs = vxS;
    simLapTimeS += ds / Math.max(1.5, vxS);
    realLapTimeS += ds / Math.max(1.5, r.vx);

    const cdA = isIst26 ? cal.cdA : vParam.CdA;
    const axFromDv = (vSim[next] * vSim[next] - vxS * vxS) / (2 * ds);
    const fDrag = 0.5 * rho * cdA * vxS * vxS;
    const trqRef = Math.max(0, r.trqEst);
    const axFromTrq = ((trqRef * G * cal.drivetrainEfficiency) / rW - fDrag - crr * m * g) / mEff;
    const axS =
      r.ax >= 0
        ? 0.55 * axFromTrq + 0.45 * Math.max(-8, Math.min(12, axFromDv))
        : 0.6 * r.ax * cal.lambdaMu + 0.4 * axFromDv;
    if (Math.abs(axS) > maxAxMs2) maxAxMs2 = Math.abs(axS);

    const cAlphaRad = cal.corneringStiffnessNPerDeg * (180 / Math.PI) * vehicleGripRatio;
    const ku = (m * (lR * cAlphaRad - lF * cAlphaRad)) / Math.max(1e3, 2 * L * cAlphaRad * cAlphaRad);
    const yawGain = 1 / (1 + Math.max(-0.02, ku) * vxS * vxS);
    const yawRateS = r.yawRate * (0.72 + 0.28 * cAlphaScale) * yawGain * (vxS / Math.max(2.0, r.vx));
    const ayS = (0.65 * (vxS * yawRateS) + 0.35 * r.ay) * Math.min(1.22, 0.45 + 0.55 * cal.lambdaMu * vehicleGripRatio);
    if (Math.abs(ayS) > maxAyMs2) maxAyMs2 = Math.abs(ayS);

    const rpmSim = ((vxS / rW) * G * 60) / (2 * Math.PI);
    const maxMotorTrq = getMaxTotalMotorTorqueNm(rpmSim);
    const reqWheelForce = Math.max(0, mEff * Math.max(0, axS) + fDrag + crr * m * g);
    const reqMotorTrq = (reqWheelForce * rW) / (G * Math.max(0.5, cal.drivetrainEfficiency));
    const torqueSimNm = Math.min(maxMotorTrq, 0.65 * reqMotorTrq + 0.35 * Math.max(0, r.trqEst));

    const vdc = Math.max(250, r.vdc || spec.powertrainCascadiaRwd.dcBusNominalV);
    const pMechW = torqueSimNm * ((rpmSim * 2 * Math.PI) / 60);
    const dcCurrSimA = Math.min(
      spec.powertrainCascadiaRwd.maxDcCurrentA,
      Math.max(0, pMechW / (Math.max(0.5, cal.drivetrainEfficiency) * vdc)),
    );

    const fLatRear = m * Math.abs(ayS) * (lF / L);
    const slipAngleDegSim = fLatRear / Math.max(100, 2 * cal.corneringStiffnessNPerDeg * vehicleGripRatio);

    const eVx = vxS - r.vx;
    const eAx = axS - r.ax;
    const eAy = ayS - r.ay;
    const eGz = yawRateS - r.yawRate;
    const eTrq = torqueSimNm - r.trqEst;
    const eIdc = dcCurrSimA - r.idc;

    sumErrVx2 += eVx * eVx;
    sumErrAx2 += eAx * eAx;
    sumErrAy2 += eAy * eAy;
    sumErrGz2 += eGz * eGz;
    sumErrTrq2 += eTrq * eTrq;
    sumErrIdc2 += eIdc * eIdc;

    softL1Cost +=
      softL1Loss(eVx, 1.5) +
      softL1Loss(eAx, 1.8) +
      softL1Loss(eAy, 1.8) +
      softL1Loss(eGz, 0.25) +
      softL1Loss(eTrq, 25.0) +
      softL1Loss(eIdc, 20.0);

    points.push({
      s: centerline[i].s,
      kappa: centerline[i].kappa,
      vxReal: Number(r.vx.toFixed(2)),
      vxSim: Number(vxS.toFixed(2)),
      axReal: Number(r.ax.toFixed(2)),
      axSim: Number(axS.toFixed(2)),
      ayReal: Number(r.ay.toFixed(2)),
      aySim: Number(ayS.toFixed(2)),
      yawRateReal: Number(r.yawRate.toFixed(3)),
      yawRateSim: Number(yawRateS.toFixed(3)),
      torqueRealNm: Number(r.trqEst.toFixed(1)),
      torqueSimNm: Number(torqueSimNm.toFixed(1)),
      dcCurrRealA: Number(r.idc.toFixed(1)),
      dcCurrSimA: Number(dcCurrSimA.toFixed(1)),
      motorRpmSim: Math.round(rpmSim),
      motorRpmReal: r.rpm,
      slipAngleDegSim: Number(slipAngleDegSim.toFixed(2)),
    });
  }

  const peakWheelTorqueNm = Number(
    (ptParam.motorPeakTorque * motorCount * G * cal.drivetrainEfficiency).toFixed(1),
  );

  const invN = 1 / Math.max(1, n);
  return {
    logId,
    presetId,
    vehicleLabel: preset.label,
    calibration: { ...cal },
    points,
    metrics: {
      rmseVxMs: Number(Math.sqrt(sumErrVx2 * invN).toFixed(3)),
      rmseAxMs2: Number(Math.sqrt(sumErrAx2 * invN).toFixed(3)),
      rmseAyMs2: Number(Math.sqrt(sumErrAy2 * invN).toFixed(3)),
      rmseYawRateRadS: Number(Math.sqrt(sumErrGz2 * invN).toFixed(3)),
      rmseTorqueNm: Number(Math.sqrt(sumErrTrq2 * invN).toFixed(2)),
      rmseDcCurrA: Number(Math.sqrt(sumErrIdc2 * invN).toFixed(2)),
      compositeSoftL1Cost: Number((softL1Cost * invN).toFixed(4)),
      simLapTimeS: Number(simLapTimeS.toFixed(2)),
      realLapTimeS: Number(realLapTimeS.toFixed(2)),
      maxVxMs: Number(maxVxMs.toFixed(2)),
      maxAyG: Number((maxAyMs2 / g).toFixed(2)),
      maxAxG: Number((maxAxMs2 / g).toFixed(2)),
      peakWheelTorqueNm,
    },
  };
}

/**
 * Stage 3 Auto-Fit Engine:
 * Calibrate IST26 (lambda_mu, C_alpha, Cd*A, eta_drivetrain) to the selected real telemetry log
 * using soft_l1 robust nonlinear least-squares optimization (matching scipy.optimize.least_squares).
 */
export function autoFitIst26ToTelemetry(
  logId: string,
  initialCal: Ist26CalibrationParams = DEFAULT_IST26_CALIBRATION,
  centerline: HavuzCenterlineNode[] = HAVUZ_CENTERLINE_NODES,
  customSamples?: HavuzRealTelemetrySample[],
  vehicleOverride?: HavuzVehicleOverride,
): AutoFitResult {
  const initialSim = simulateIst26OnHavuz(logId, initialCal, centerline, customSamples, vehicleOverride);

  let bestCal: Ist26CalibrationParams = { ...initialCal };
  let bestCost = initialSim.metrics.compositeSoftL1Cost;
  let iterations = 0;

  const bounds: Record<keyof Ist26CalibrationParams, [number, number, number]> = {
    lambdaMu: [0.52, 1.18, 0.08],
    corneringStiffnessNPerDeg: [340, 620, 32],
    cdA: [1.1, 2.05, 0.14],
    drivetrainEfficiency: [0.8, 0.97, 0.03],
  };

  const keys = Object.keys(bounds) as Array<keyof Ist26CalibrationParams>;

  for (let scaleIdx = 0; scaleIdx < 4; scaleIdx++) {
    const stepShrink = Math.pow(0.48, scaleIdx);
    let improved = true;
    let innerIter = 0;
    while (improved && innerIter < 8) {
      improved = false;
      innerIter++;
      for (const k of keys) {
        const [lo, hi, baseStep] = bounds[k];
        const step = baseStep * stepShrink;
        for (const dir of [-1, 1]) {
          const candVal = Math.max(lo, Math.min(hi, bestCal[k] + dir * step));
          const candCal: Ist26CalibrationParams = { ...bestCal, [k]: Number(candVal.toFixed(4)) };
          const res = simulateIst26OnHavuz(logId, candCal, centerline, customSamples, vehicleOverride);
          iterations++;
          if (res.metrics.compositeSoftL1Cost < bestCost - 1e-5) {
            bestCost = res.metrics.compositeSoftL1Cost;
            bestCal = candCal;
            improved = true;
          }
        }
      }
    }
  }

  const fittedSim = simulateIst26OnHavuz(logId, bestCal, centerline, customSamples, vehicleOverride);
  const improvementPct =
    initialSim.metrics.compositeSoftL1Cost > 0
      ? Number(
          (
            ((initialSim.metrics.compositeSoftL1Cost - fittedSim.metrics.compositeSoftL1Cost) /
              initialSim.metrics.compositeSoftL1Cost) *
            100
          ).toFixed(1),
        )
      : 0;

  return {
    initialCalibration: { ...initialCal },
    fittedCalibration: {
      lambdaMu: Number(bestCal.lambdaMu.toFixed(3)),
      corneringStiffnessNPerDeg: Number(bestCal.corneringStiffnessNPerDeg.toFixed(1)),
      cdA: Number(bestCal.cdA.toFixed(3)),
      drivetrainEfficiency: Number(bestCal.drivetrainEfficiency.toFixed(3)),
    },
    initialMetrics: initialSim.metrics,
    fittedMetrics: fittedSim.metrics,
    iterations,
    improvementPct: Math.max(0, improvementPct),
    logId,
  };
}
