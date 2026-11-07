// ============================================================================
// STAGE 1: LOG HEALTH SCORER, FLEXIBLE COLUMN MAPPER & PRE-PROCESSOR
// Strictly isolated module for IST26 RWD SIL & Telemetry Lab
// ============================================================================

import { IST26_RWD_PDF_SPEC } from './ist26-vehicle-spec';
import {
  HAVUZ_LOG_ENTRIES,
  HavuzLogEntry,
  HavuzRealTelemetrySample,
} from './precomputed-logs';

export interface ColumnMappingConfig {
  time: string;
  vx: string;
  wheelFl: string;
  wheelFr: string;
  wheelRl: string;
  wheelRr: string;
  ax: string;
  ay: string;
  yawRate: string;
  steer: string;
  torqueCmd: string;
  torqueEst: string;
  motorRpm: string;
  dcVolt: string;
  dcCurr: string;
  apps: string;
  pot1: string;
  pot2: string;
  brakeFront: string;
  brakeRear: string;
  invTemp: string;
  motorTemp: string;
}

export const DEFAULT_IST26_COLUMN_MAP: ColumnMappingConfig = {
  time: 'INV_POWERON_TIMER_u32',
  vx: 'VCU_EKF_VX_EST_f',
  wheelFl: 'WHEEL_OMEGA_FL_FILT_f',
  wheelFr: 'WHEEL_OMEGA_FR_FILT_f',
  wheelRl: 'WHEEL_OMEGA_RL_FILT_f',
  wheelRr: 'WHEEL_OMEGA_RR_FILT_f',
  ax: 'IMU_ACCEL_X_f',
  ay: 'IMU_ACCEL_Y_f',
  yawRate: 'IMU_GYRO_Z_f',
  steer: 'STEERING_ANGLE_f',
  torqueCmd: 'INV_TORQUE_CMD_NM_i16',
  torqueEst: 'INV_TORQUE_EST_NM_i16',
  motorRpm: 'INV_MOTOR_SPEED_RPM_i32',
  dcVolt: 'INV_DCBUS_VOLTAGE_u16',
  dcCurr: 'INV_DCBUS_CURRENT_i16',
  apps: 'THROTTLE_PERCENT_u8',
  pot1: 'POT1_u16',
  pot2: 'POT2_u16',
  brakeFront: 'BRAKE_PRESSURE_FRONT_u8',
  brakeRear: 'BRAKE_PRESSURE_REAR_u8',
  invTemp: 'INV_PWRSTG_TEMP_i16',
  motorTemp: 'INV_EMACHINE_TEMP_1_i16',
};

const SYNONYM_PATTERNS: Record<keyof ColumnMappingConfig, RegExp[]> = {
  time: [/INV_POWERON_TIMER/i, /^time$/i, /timestamp/i, /rtc_millisec/i],
  vx: [/VCU_EKF_VX_EST/i, /vx_gps_raw/i, /GPS_SPEED_KMH/i, /VCU_VEHICLE_SPEED/i, /^vx$/i],
  wheelFl: [/WHEEL_OMEGA_FL/i, /TIRE_SPEED_FL_TELEMETRY/i, /ws_fl/i],
  wheelFr: [/WHEEL_OMEGA_FR/i, /TIRE_SPEED_FR_TELEMETRY/i, /ws_fr/i],
  wheelRl: [/WHEEL_OMEGA_RL/i, /TIRE_SPEED_RL/i, /ws_rl/i],
  wheelRr: [/WHEEL_OMEGA_RR/i, /TIRE_SPEED_RR/i, /ws_rr/i],
  ax: [/IMU_ACCEL_X/i, /^ax$/i, /accel_x/i],
  ay: [/IMU_ACCEL_Y/i, /^ay$/i, /accel_y/i],
  yawRate: [/IMU_GYRO_Z/i, /yaw_rate/i, /gyro_z/i],
  steer: [/STEERING_ANGLE/i, /steer/i, /delta_f/i],
  torqueCmd: [/INV_TORQUE_CMD/i, /VCU_TORQUE_NM_REQ/i, /trq_cmd/i],
  torqueEst: [/INV_TORQUE_EST/i, /trq_est/i, /actual_torque/i],
  motorRpm: [/INV_MOTOR_SPEED_RPM/i, /motor_rpm/i, /^rpm$/i],
  dcVolt: [/INV_DCBUS_VOLTAGE/i, /BMS_TOTAL_VOLTAGE/i, /dc_volt/i],
  dcCurr: [/INV_DCBUS_CURRENT/i, /BMS_CURRENT/i, /dc_curr/i],
  apps: [/THROTTLE_PERCENT/i, /apps/i, /pedal/i],
  pot1: [/POT1/i, /apps1/i],
  pot2: [/POT2/i, /apps2/i],
  brakeFront: [/BRAKE_PRESSURE_FRONT/i, /brake_f/i],
  brakeRear: [/BRAKE_PRESSURE_REAR/i, /brake_r/i],
  invTemp: [/INV_PWRSTG_TEMP/i, /INV_BOARD_1_TEMP/i],
  motorTemp: [/INV_EMACHINE_TEMP/i, /motor_temp/i],
};

/**
 * Automatically match raw CSV/XLSX header names to IST26 canonical telemetry channels
 */
export function autoDetectColumns(headers: string[]): ColumnMappingConfig {
  const mapped: ColumnMappingConfig = { ...DEFAULT_IST26_COLUMN_MAP };
  (Object.keys(SYNONYM_PATTERNS) as Array<keyof ColumnMappingConfig>).forEach((key) => {
    const patterns = SYNONYM_PATTERNS[key];
    for (const pat of patterns) {
      const hit = headers.find((h) => pat.test(h.trim()));
      if (hit) {
        mapped[key] = hit.trim();
        break;
      }
    }
  });
  return mapped;
}

/**
 * 5-point Median filter for removing single/double sample NaN or sensor spikes
 */
export function medianFilter5(signal: number[]): number[] {
  const n = signal.length;
  if (n < 5) return signal.slice();
  const out = signal.slice();
  for (let i = 2; i < n - 2; i++) {
    const win = [signal[i - 2], signal[i - 1], signal[i], signal[i + 1], signal[i + 2]].sort((a, b) => a - b);
    out[i] = win[2];
  }
  return out;
}

/**
 * 5-point Savitzky-Golay smoothing filter (polynomial order 2, window 5: [-3, 12, 17, 12, -3] / 35)
 */
export function savitzkyGolay5(signal: number[]): number[] {
  const n = signal.length;
  if (n < 5) return signal.slice();
  const out = signal.slice();
  for (let i = 2; i < n - 2; i++) {
    out[i] =
      (-3 * signal[i - 2] + 12 * signal[i - 1] + 17 * signal[i] + 12 * signal[i + 1] - 3 * signal[i + 2]) / 35;
  }
  return out;
}

/**
 * Parse and score an uploaded raw CSV text using the IST26 Pre-Processor
 * (Zero-velocity clamping vx < 0.5 m/s, Short-log & Spin filter, Savitzky-Golay + Median filtering)
 */
export function processRawIst26Csv(
  fileName: string,
  csvText: string,
  customMap?: Partial<ColumnMappingConfig>,
): { entry: HavuzLogEntry; samples: HavuzRealTelemetrySample[] } {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const sep = lines[0]?.includes(';') ? ';' : ',';
  const headers = (lines[0] ?? '').split(sep).map((s) => s.trim());
  const colMap = { ...autoDetectColumns(headers), ...(customMap ?? {}) };
  const idx = (colName: string) => headers.indexOf(colName);

  const iTime = idx(colMap.time);
  const iVx = idx(colMap.vx);
  const iWFl = idx(colMap.wheelFl);
  const iWFr = idx(colMap.wheelFr);
  const iWRl = idx(colMap.wheelRl);
  const iWRr = idx(colMap.wheelRr);
  const iAx = idx(colMap.ax);
  const iAy = idx(colMap.ay);
  const iGz = idx(colMap.yawRate);
  const iRpm = idx(colMap.motorRpm);
  const iTrqCmd = idx(colMap.torqueCmd);
  const iTrqEst = idx(colMap.torqueEst);
  const iVdc = idx(colMap.dcVolt);
  const iIdc = idx(colMap.dcCurr);
  const iThr = idx(colMap.apps);
  const iPot1 = idx(colMap.pot1);
  const iPot2 = idx(colMap.pot2);
  const iBrkF = idx(colMap.brakeFront);
  const iBrkR = idx(colMap.brakeRear);
  const iInvT = idx(colMap.invTemp);
  const iMotT = idx(colMap.motorTemp);

  const rWheel = IST26_RWD_PDF_SPEC.massAndGeometry.loadedWheelRadiusM;
  const gear = IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.gearRatio;

  const nRows = Math.max(0, lines.length - 1);
  const rawVx: number[] = [];
  const rawAx: number[] = [];
  const rawAy: number[] = [];
  const rawGz: number[] = [];
  const rawDt: number[] = [];
  const rawMeta: Array<{
    rpm: number;
    trqCmd: number;
    trqEst: number;
    vdc: number;
    idc: number;
    thr: number;
    pot1: number;
    pot2: number;
    brkF: number;
    brkR: number;
    invT: number;
    motT: number;
  }> = [];

  let prevTimer: number | null = null;
  let spikesFiltered = 0;

  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(sep);
    if (c.length < 4) continue;
    const tVal = iTime >= 0 ? Number(c[iTime]) : r * 8;
    let dt = 0.024;
    if (prevTimer !== null && Number.isFinite(tVal) && tVal > prevTimer) {
      const diff = tVal - prevTimer;
      dt = diff > 1 ? diff * 0.003 : diff;
      if (dt > 0.5 || dt <= 0) dt = 0.024;
    }
    prevTimer = tVal;

    const wfl = iWFl >= 0 ? Number(c[iWFl]) || 0 : 0;
    const wfr = iWFr >= 0 ? Number(c[iWFr]) || 0 : 0;
    const wrl = iWRl >= 0 ? Number(c[iWRl]) || 0 : 0;
    const wrr = iWRr >= 0 ? Number(c[iWRr]) || 0 : 0;
    const vxCol = iVx >= 0 ? Number(c[iVx]) || 0 : 0;
    const rpm = iRpm >= 0 ? Math.abs(Number(c[iRpm]) || 0) : 0;

    const vFront = ((wfl + wfr) * 0.5) * rWheel;
    const vRear = ((wrl + wrr) * 0.5) * rWheel;
    const vRpm = ((rpm * 2 * Math.PI) / 60 / gear) * rWheel;
    let vx = vFront > 0.3 ? vFront : vxCol > 0.3 ? vxCol : vRear > 0.3 ? vRear : vRpm;

    let ax = iAx >= 0 ? Number(c[iAx]) || 0 : 0;
    let ay = iAy >= 0 ? Number(c[iAy]) || 0 : 0;
    let gz = iGz >= 0 ? (Number(c[iGz]) || 0) * (Math.PI / 180) : 0;

    if (!Number.isFinite(vx) || vx < 0 || vx > 40) {
      vx = 0;
      spikesFiltered++;
    }
    if (!Number.isFinite(ax) || Math.abs(ax) > 22) {
      ax = 0;
      spikesFiltered++;
    }
    if (!Number.isFinite(ay) || Math.abs(ay) > 22) {
      ay = 0;
      spikesFiltered++;
    }
    if (!Number.isFinite(gz) || Math.abs(gz) > 4.0) {
      gz = 0;
      spikesFiltered++;
    }

    rawDt.push(dt);
    rawVx.push(vx);
    rawAx.push(ax);
    rawAy.push(ay);
    rawGz.push(gz);
    rawMeta.push({
      rpm,
      trqCmd: iTrqCmd >= 0 ? Number(c[iTrqCmd]) || 0 : 0,
      trqEst: iTrqEst >= 0 ? Number(c[iTrqEst]) || 0 : 0,
      vdc: iVdc >= 0 ? Number(c[iVdc]) || 340 : 340,
      idc: iIdc >= 0 ? Number(c[iIdc]) || 0 : 0,
      thr: iThr >= 0 ? Number(c[iThr]) || 0 : 0,
      pot1: iPot1 >= 0 ? Number(c[iPot1]) || 0 : 0,
      pot2: iPot2 >= 0 ? Number(c[iPot2]) || 0 : 0,
      brkF: iBrkF >= 0 ? Number(c[iBrkF]) || 0 : 0,
      brkR: iBrkR >= 0 ? Number(c[iBrkR]) || 0 : 0,
      invT: iInvT >= 0 ? Number(c[iInvT]) || 32 : 32,
      motT: iMotT >= 0 ? Number(c[iMotT]) || 34 : 34,
    });
  }

  const filtVx = savitzkyGolay5(medianFilter5(rawVx));
  const filtAx = savitzkyGolay5(medianFilter5(rawAx));
  const filtAy = savitzkyGolay5(medianFilter5(rawAy));
  const filtGz = savitzkyGolay5(medianFilter5(rawGz));

  let totalDurationS = 0;
  let activeDrivingTimeS = 0;
  let distanceM = 0;
  let activeRows = 0;
  let zeroVelClampedRows = 0;
  let maxVx = 0;
  let maxRpm = 0;
  let maxTrq = 0;
  let absYawRad = 0;

  const activeSamples: HavuzRealTelemetrySample[] = [];

  for (let i = 0; i < filtVx.length; i++) {
    const dt = rawDt[i];
    totalDurationS += dt;
    const vx = filtVx[i];
    if (vx < 0.5) {
      // Zero-velocity clamping: freeze integration
      zeroVelClampedRows++;
      continue;
    }
    activeRows++;
    activeDrivingTimeS += dt;
    distanceM += vx * dt;
    absYawRad += Math.abs(filtGz[i]) * dt;
    if (vx > maxVx) maxVx = vx;
    if (rawMeta[i].rpm > maxRpm) maxRpm = rawMeta[i].rpm;
    if (Math.abs(rawMeta[i].trqEst) > maxTrq) maxTrq = Math.abs(rawMeta[i].trqEst);

    activeSamples.push({
      s: Number(distanceM.toFixed(2)),
      vx: Number(vx.toFixed(2)),
      ax: Number(filtAx[i].toFixed(2)),
      ay: Number(filtAy[i].toFixed(2)),
      yawRate: Number(filtGz[i].toFixed(3)),
      rpm: Math.round(rawMeta[i].rpm),
      trqCmd: Math.round(rawMeta[i].trqCmd),
      trqEst: Math.round(rawMeta[i].trqEst),
      vdc: Math.round(rawMeta[i].vdc),
      idc: Math.round(rawMeta[i].idc),
      thr: Math.round(rawMeta[i].thr),
      pot1: Math.round(rawMeta[i].pot1),
      pot2: Math.round(rawMeta[i].pot2),
      brkF: Math.round(rawMeta[i].brkF),
      brkR: Math.round(rawMeta[i].brkR),
      invT: Math.round(rawMeta[i].invT),
      motT: Math.round(rawMeta[i].motT),
    });
  }

  const hasImu = filtAx.some((v) => Math.abs(v) > 0.5) && filtGz.some((v) => Math.abs(v) > 0.08);
  const hasWheelSpeed = filtVx.some((v) => v > 1.0);
  const hasCascadia = maxRpm > 100 && maxTrq > 10;
  const estLaps = Number((hasImu ? absYawRad / (2 * Math.PI) : distanceM / 147.2).toFixed(2));

  let qualityScore = 0;
  let status: 'Temiz' | 'Kısmi' | 'Bozuk' = 'Bozuk';
  let statusReason = '';

  if (activeDrivingTimeS < 15 || distanceM < 50) {
    qualityScore = Math.min(24, Math.round((activeDrivingTimeS / 15) * 14 + (distanceM / 50) * 10));
    status = 'Bozuk';
    statusReason = `Kısa veya hareketsiz kayıt (${activeDrivingTimeS.toFixed(1)} sn aktif, ${distanceM.toFixed(0)} m < 50 m)`;
  } else if (!hasImu) {
    qualityScore = 58;
    status = 'Kısmi';
    statusReason = 'Tekerlek hızı ve Cascadia mevcut, ancak IMU ivme/yaw kanalları 0.00';
  } else {
    qualityScore = Math.min(98, Math.round(50 + Math.min(25, activeDrivingTimeS / 5) + Math.min(23, estLaps * 4)));
    status = qualityScore >= 75 ? 'Temiz' : 'Kısmi';
    statusReason = 'Kullanıcı tarafından yüklenen log · Savitzky-Golay & Medyan filtre uygulandı';
  }

  // Downsample activeSamples onto 150 nodes
  const downsampled: HavuzRealTelemetrySample[] = [];
  if (activeSamples.length > 0) {
    for (let k = 0; k < 150; k++) {
      const idxSample = Math.min(activeSamples.length - 1, Math.floor((k / 150) * activeSamples.length));
      downsampled.push({
        ...activeSamples[idxSample],
        s: Number(((k / 150) * 135.4).toFixed(2)),
      });
    }
  }

  const entry: HavuzLogEntry = {
    id: `uploaded/${fileName}`,
    relativePath: `uploaded/${fileName}`,
    folder: 'uploaded',
    format: 'csv',
    fileSizeBytes: csvText.length,
    totalRows: nRows,
    activeRows,
    zeroVelClampedRows,
    spikesFiltered,
    totalDurationS: Number(totalDurationS.toFixed(1)),
    activeDrivingTimeS: Number(activeDrivingTimeS.toFixed(1)),
    distanceM: Number(distanceM.toFixed(1)),
    estimatedLaps: estLaps,
    maxSpeedKmh: Number((maxVx * 3.6).toFixed(1)),
    maxMotorRpm: maxRpm,
    maxTorqueNm: maxTrq,
    hasImu,
    hasWheelSpeed,
    hasCascadia,
    hasGps: true,
    qualityScore,
    status,
    statusReason,
    autoSelected: qualityScore >= 80,
    detectedColumns: {
      time: colMap.time,
      vx: colMap.vx,
      wheelFl: colMap.wheelFl,
      wheelFr: colMap.wheelFr,
      wheelRl: colMap.wheelRl,
      wheelRr: colMap.wheelRr,
      ax: colMap.ax,
      ay: colMap.ay,
      yawRate: colMap.yawRate,
      steer: colMap.steer,
      torqueCmd: colMap.torqueCmd,
      torqueEst: colMap.torqueEst,
      motorRpm: colMap.motorRpm,
      dcVolt: colMap.dcVolt,
      dcCurr: colMap.dcCurr,
      apps: colMap.apps,
      brakeFront: colMap.brakeFront,
    },
  };

  return { entry, samples: downsampled };
}

export function getSortedHavuzLogs(logs: HavuzLogEntry[] = HAVUZ_LOG_ENTRIES): HavuzLogEntry[] {
  return [...logs].sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    return b.distanceM - a.distanceM;
  });
}
