import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IST26_CALIBRATION,
  IST26_RWD_PDF_SPEC,
  interpolateIst26MotorTorqueNm,
} from '../src/lib/ist26-havuz/ist26-vehicle-spec';
import { getSortedHavuzLogs } from '../src/lib/ist26-havuz/log-scorer';
import { buildHavuzExtractedCircuit } from '../src/lib/ist26-havuz/havuz-track-extractor';
import { autoFitIst26ToTelemetry, simulateIst26OnHavuz } from '../src/lib/ist26-havuz/ist26-rwd-solver';
import {
  INITIAL_VCU_FSM_RUNTIME,
  generateIst26VcuSafetyFirmware,
  stepIst26VcuSafetyFsm,
} from '../src/lib/ist26-havuz/vcu-fault-machine';

describe('IST26 RWD SIL & Telemetry Lab (Strictly Isolated Module)', () => {
  it('matches exact IST26_RWD_Vehicle_Parameters.pdf physical constants', () => {
    expect(IST26_RWD_PDF_SPEC.massAndGeometry.totalMassKg).toBe(335.5);
    expect(IST26_RWD_PDF_SPEC.massAndGeometry.frontWeightDistributionPct).toBe(47.9);
    expect(IST26_RWD_PDF_SPEC.massAndGeometry.wheelbaseM).toBe(1.6);
    expect(IST26_RWD_PDF_SPEC.massAndGeometry.loadedWheelRadiusM).toBe(0.205);
    expect(IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.gearRatio).toBe(3.2);
    expect(IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.peakTorqueNm).toBe(310.0);
    expect(IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.rpmCut).toBe(6000);
    expect(interpolateIst26MotorTorqueNm(500)).toBe(310.0);
    expect(interpolateIst26MotorTorqueNm(6000)).toBeCloseTo(127.1, 1);
  });

  it('scores all 41 telemetry files in ./logs and separates clean, partial, and broken logs', () => {
    const logs = getSortedHavuzLogs();
    expect(logs.length).toBe(41);
    const clean = logs.filter((l) => l.status === 'Temiz');
    const broken = logs.filter((l) => l.status === 'Bozuk');
    expect(clean.length).toBeGreaterThanOrEqual(12);
    expect(broken.length).toBeGreaterThanOrEqual(8);
    expect(logs[0].qualityScore).toBeGreaterThanOrEqual(90);
  });

  it('extracts the closed-loop İTÜ Havuz Otoparkı circuit with +/-1.5m cones and KDE heatmap', () => {
    const circuit = buildHavuzExtractedCircuit(1.5);
    expect(circuit.nodes.length).toBe(150);
    expect(circuit.totalLengthM).toBeGreaterThan(120);
    expect(circuit.totalLengthM).toBeLessThan(165);
    expect(circuit.heatmapCells.length).toBeGreaterThan(50);
    expect(circuit.rejectedOutlierTracesCount).toBeGreaterThanOrEqual(3);
  });

  it('runs IST26 RWD and IST27 TwoTrackSim simulation overlays and reduces soft_l1 error via Auto-Fit', () => {
    const logId = '23_08/23_08_2026-11.31.49.csv';
    const baseSim = simulateIst26OnHavuz(logId, DEFAULT_IST26_CALIBRATION);
    expect(baseSim.points.length).toBe(150);
    expect(baseSim.presetId).toBe('ist26-rwd');

    const ist27Sim = simulateIst26OnHavuz(logId, DEFAULT_IST26_CALIBRATION, undefined, undefined, {
      presetId: 'ist27-twotrack',
    });
    expect(ist27Sim.points.length).toBe(150);
    expect(ist27Sim.presetId).toBe('ist27-twotrack');
    expect(ist27Sim.metrics.simLapTimeS).toBeGreaterThan(5);

    const fit = autoFitIst26ToTelemetry(logId, DEFAULT_IST26_CALIBRATION);
    expect(fit.fittedMetrics.compositeSoftL1Cost).toBeLessThanOrEqual(baseSim.metrics.compositeSoftL1Cost);
  });

  it('enforces FSAE T 11.8.9 (100ms APPS), EV 2.3 (APPS+Brake), EV 2.5 (500ms Soft-BSPD), and generates MISRA-C code', () => {
    let state = INITIAL_VCU_FSM_RUNTIME;
    // Inject >10% APPS deviation for 100 ms
    state = stepIst26VcuSafetyFsm(
      state,
      {
        appsPct: 60,
        appsDeviationPct: 14.0,
        brakePressureBar: 0,
        dcBusPowerKw: 20,
        inverterTempC: 40,
        motorTempC: 50,
        motorRpm: 2500,
        imuFaultMode: 'NOMINAL',
        prechargePct: 98,
        r2dArmed: true,
      },
      100,
    );
    expect(state.state).toBe('VCU_STATE_FAULT_LATCHED');
    expect(state.cascadiaTorqueCmdNm).toBe(0);

    // Unlatch only when APPS < 5% and deviation <= 10%
    state = stepIst26VcuSafetyFsm(
      state,
      {
        appsPct: 3.0,
        appsDeviationPct: 1.0,
        brakePressureBar: 0,
        dcBusPowerKw: 0,
        inverterTempC: 40,
        motorTempC: 50,
        motorRpm: 2000,
        imuFaultMode: 'NOMINAL',
        prechargePct: 98,
        r2dArmed: true,
      },
      50,
    );
    expect(state.appsImplausibilityLatched).toBe(false);
    expect(state.state).toBe('VCU_STATE_DRIVE');

    // EV 2.5 Soft-BSPD: hard brake + >5 kW for 500 ms -> VCU_STATE_FAULT_SAFE & SDC open
    state = stepIst26VcuSafetyFsm(
      state,
      {
        appsPct: 10,
        appsDeviationPct: 1.0,
        brakePressureBar: 20,
        dcBusPowerKw: 12.0,
        inverterTempC: 40,
        motorTempC: 50,
        motorRpm: 2000,
        imuFaultMode: 'NOMINAL',
        prechargePct: 98,
        r2dArmed: true,
      },
      500,
    );
    expect(state.state).toBe('VCU_STATE_FAULT_SAFE');
    expect(state.sdcRelayClosed).toBe(false);

    const fw = generateIst26VcuSafetyFirmware();
    expect(fw.headerContent).toContain('#include <stdint.h>');
    expect(fw.sourceContent).toContain('IST26_VCU_Step1ms');
  });
});
