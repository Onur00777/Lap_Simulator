// AUTO-GENERATED FROM ./logs TELEMETRY DATASET — DO NOT EDIT MANUALLY
// Strictly isolated data module for İTÜ Havuz Otoparkı — IST26 RWD SIL & Telemetry Lab

import rawData from './precomputed-logs.json';

export interface HavuzLogEntry {
  id: string;
  relativePath: string;
  folder: string;
  format: 'csv' | 'xlsx';
  fileSizeBytes: number;
  totalRows: number;
  activeRows: number;
  zeroVelClampedRows: number;
  spikesFiltered: number;
  totalDurationS: number;
  activeDrivingTimeS: number;
  distanceM: number;
  estimatedLaps: number;
  maxSpeedKmh: number;
  maxMotorRpm: number;
  maxTorqueNm: number;
  hasImu: boolean;
  hasWheelSpeed: boolean;
  hasCascadia: boolean;
  hasGps: boolean;
  qualityScore: number;
  status: 'Temiz' | 'Kısmi' | 'Bozuk';
  statusReason: string;
  autoSelected: boolean;
  detectedColumns: {
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
    brakeFront: string;
  };
}

export interface HavuzCenterlineNode {
  s: number;
  x: number;
  y: number;
  kappa: number;
  leftConeX: number;
  leftConeY: number;
  rightConeX: number;
  rightConeY: number;
}

export interface HavuzTrajectoryTrace {
  id: string;
  logId: string;
  isOutlier: boolean;
  points: [number, number][];
}

export interface HavuzRealTelemetrySample {
  s: number;
  vx: number;
  ax: number;
  ay: number;
  yawRate: number;
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
}

export const HAVUZ_LOG_ENTRIES: HavuzLogEntry[] = rawData.HAVUZ_LOG_ENTRIES as HavuzLogEntry[];
export const HAVUZ_CENTERLINE_NODES: HavuzCenterlineNode[] = rawData.HAVUZ_CENTERLINE_NODES as HavuzCenterlineNode[];
export const HAVUZ_TRAJECTORY_CLOUD: HavuzTrajectoryTrace[] = rawData.HAVUZ_TRAJECTORY_CLOUD as HavuzTrajectoryTrace[];
export const HAVUZ_REAL_TELEMETRY_BY_LOG: Record<string, HavuzRealTelemetrySample[]> =
  rawData.HAVUZ_REAL_TELEMETRY_BY_LOG as Record<string, HavuzRealTelemetrySample[]>;
