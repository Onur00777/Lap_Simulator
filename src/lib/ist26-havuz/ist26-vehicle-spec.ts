// ============================================================================
// STRICTLY ISOLATED MODULE: IST26 RWD (1 Motor / 1 Cascadia Motion Inverter)
// Extracted 1-to-1 from IST26_RWD_Vehicle_Parameters.pdf
// DO NOT IMPORT OR MIX WITH EXISTING KORFEZ / FS VEHICLE PROFILES
// ============================================================================

export interface Ist26TorquePoint {
  rpm: number;
  torqueNm: number;
}

export interface Ist26CalibrationParams {
  /** Pacejka tire grip scaling factor lambda_mu [-] (PDF nominal: 1.00, parking lot asphalt ~0.68-0.85) */
  lambdaMu: number;
  /** Equivalent axle cornering stiffness C_alpha [N/deg] (PDF nominal: 488.95 N/deg avg) */
  corneringStiffnessNPerDeg: number;
  /** Drag area Cd*A [m^2] (PDF nominal: 1.58 m^2) */
  cdA: number;
  /** Total RWD drivetrain + Cascadia inverter efficiency eta [-] (PDF nominal: 0.95 = 0.92 * 0.97) */
  drivetrainEfficiency: number;
}

export const IST26_RWD_PDF_SPEC = {
  identity: {
    code: 'IST26_RWD_Cascadia',
    name: 'IST26 — Tek Motor RWD & Cascadia Motion PM100DX',
    configuration: '1 Motor Rear-Wheel Drive (RWD) · Drexler Salisbury LSD · Cascadia Motion Inverter',
    venue: 'İTÜ Ayazağa Olimpik Havuz Otoparkı (41.1016°N, 29.0258°E)',
  },
  massAndGeometry: {
    totalMassKg: 335.5,
    sprungMassKg: 295.64,
    unsprungMassFrontWheelKg: 9.2,
    unsprungMassRearWheelKg: 10.73,
    rotationalEquivalentMassKg: 40.466,
    qssEffectiveMassKg: 375.966,
    frontWeightDistributionPct: 47.9,
    rearWeightDistributionPct: 52.1,
    staticWheelLoadFrontN: 788.32,
    staticWheelLoadRearN: 857.43,
    wheelbaseM: 1.6,
    lF_M: 0.8336,
    lR_M: 0.7664,
    trackFrontM: 1.28,
    trackRearM: 1.26,
    hCgM: 0.247169,
    hRollAxisToCgM: 0.2131,
    bodyLengthM: 3.083,
    bodyWidthM: 1.546,
    frontOverhangM: 0.686,
    loadedWheelRadiusM: 0.205,
    nominalWheelRadiusM: 0.20574,
  },
  inertiaAndSuspension: {
    IxxKgM2: 33.31,
    IyyKgM2: 115.9,
    IzzKgM2: 129.0,
    wheelInertiaKgM2: 0.2567,
    rotorInertiaKgM2: 0.067,
    frontLltdPct: 38.31,
    elasticRollStiffnessRatioPct: 36.84,
    rollCenterFrontMm: 31.42,
    rollCenterRearMm: 36.5,
    rollGradientDegPerG: 1.192,
    heaveSpringFrontNPerM: 110000,
    heaveSpringRearNPerM: 110000,
    rollSpringFrontNPerM: 90000,
    rollSpringRearNPerM: 130000,
    modalRollStiffnessFrontNmPerDeg: 333.795,
    modalRollStiffnessRearNmPerDeg: 572.382,
    staticCamberFrontDeg: -1.7,
    staticCamberRearDeg: -1.4,
    staticToeFrontDeg: 0.3,
    staticToeRearDeg: -0.3,
  },
  aeroAndResistance: {
    clA: 4.14,
    clA_accel: 2.56,
    cdA: 1.58,
    cdA_accel: 1.06,
    airDensityKgM3: 1.225,
    aeroBalanceFrontPct: 48.2,
    aeroPitchSensPctPerG: 0.0,
    rollingResistanceCrr: 0.01,
  },
  powertrainCascadiaRwd: {
    motorCount: 1,
    architecture: 'Single Rear Motor (RWD)',
    inverterModel: 'Cascadia Motion PM100DX',
    gearRatio: 3.2,
    mechanicalEfficiency: 0.92,
    inverterEfficiency: 0.97,
    combinedEfficiency: 0.95,
    peakTorqueNm: 310.0,
    peakPowerKw: 80.0,
    rpmCut: 6000,
    rpmRawMax: 10000,
    peakAxleTorqueEffectiveNm: 942.4, // 310 * 3.2 * 0.95
    peakAxleTorqueRawNm: 992.0, // 310 * 3.2
    regenEnabled: false,
    dcBusNominalV: 342.0,
    dcBusMaxV: 403.2,
    dcBusMinV: 250.0,
    maxDcCurrentA: 260.0,
    inverterTempDerateStartC: 60.0,
    inverterTempCutC: 85.0,
    motorTempDerateStartC: 95.0,
    motorTempCutC: 130.0,
    torqueSpeedCurve: [
      { rpm: 0, torqueNm: 310.0 },
      { rpm: 500, torqueNm: 310.0 },
      { rpm: 900, torqueNm: 310.0 },
      { rpm: 2500, torqueNm: 305.6 },
      { rpm: 2944, torqueNm: 259.5 },
      { rpm: 3250, torqueNm: 235.1 },
      { rpm: 3519, torqueNm: 217.1 },
      { rpm: 3895, torqueNm: 196.1 },
      { rpm: 4050, torqueNm: 188.6 },
      { rpm: 4514, torqueNm: 169.2 },
      { rpm: 5462, torqueNm: 139.9 },
      { rpm: 6000, torqueNm: 127.1 },
      { rpm: 6827, torqueNm: 107.2 },
      { rpm: 8279, torqueNm: 82.6 },
      { rpm: 9379, torqueNm: 69.7 },
      { rpm: 10000, torqueNm: 66.0 },
    ] as Ist26TorquePoint[],
  },
  differentialDrexler: {
    model: 'Drexler Salisbury LSD',
    rampDriveDeg: 50,
    rampCoastDeg: 40,
    lockRatioDrive: 0.42,
    lockRatioCoast: 0.6,
    preloadTorqueNm: 27.5,
    omegaSmoothRadS: 1.0,
  },
  brakesAndTires: {
    maxBrakeTorqueFrontWheelNm: 400,
    maxBrakeTorqueRearWheelNm: 320,
    totalBrakeTorqueNm: 1440,
    brakeBiasFront: 0.55,
    tireModel: 'Hoosier 43075 MF6.1 (12 / 10 psi)',
    verticalStiffnessNPerM: 200000,
    muLongStaticFront: 2.1,
    muLatStaticFront: 2.4,
    muLongStaticRear: 2.22,
    muLatStaticRear: 2.44,
    corneringStiffnessFrontNPerDeg: 481.2,
    corneringStiffnessRearNPerDeg: 496.7,
    lambdaMuNominal: 1.0,
    steeringRatio: 4.54,
    maxSteeringWheelDeg: 126,
  },
} as const;

export const DEFAULT_IST26_CALIBRATION: Ist26CalibrationParams = {
  lambdaMu: 1.0,
  corneringStiffnessNPerDeg: 489.0,
  cdA: 1.58,
  drivetrainEfficiency: 0.95,
};

/**
 * Interpolate IST26 single-motor shaft torque [Nm] at a given motor RPM
 * respecting the 6000 RPM soft/hard limiter from IST26_RWD_Vehicle_Parameters.pdf
 */
export function interpolateIst26MotorTorqueNm(rpm: number, enforce6000Cut = true): number {
  const absRpm = Math.max(0, rpm);
  if (enforce6000Cut && absRpm > IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.rpmCut) {
    // Smooth limiter taper above 6000 RPM
    const over = absRpm - IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.rpmCut;
    return Math.max(0, 127.1 * Math.exp(-over / 220));
  }
  const curve = IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.torqueSpeedCurve;
  if (absRpm <= curve[0].rpm) return curve[0].torqueNm;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (absRpm >= a.rpm && absRpm <= b.rpm) {
      const u = (absRpm - a.rpm) / Math.max(1e-6, b.rpm - a.rpm);
      return a.torqueNm + u * (b.torqueNm - a.torqueNm);
    }
  }
  return curve[curve.length - 1].torqueNm;
}
