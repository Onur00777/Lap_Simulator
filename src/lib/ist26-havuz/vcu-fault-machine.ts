// ============================================================================
// STAGE 4: FSAE RULE-COMPLIANT VCU FAULT INJECTION & CASCADIA PLAUSIBILITY FSM
// + ISOLATED MISRA-C / C99 FIRMWARE GENERATOR (ist26_vcu_safety_fsm.h / .c)
// Strictly isolated module for IST26 RWD (1 Motor + Cascadia PM100DX Inverter)
// ============================================================================

import { IST26_RWD_PDF_SPEC, interpolateIst26MotorTorqueNm } from './ist26-vehicle-spec';

export type Ist26VcuState =
  | 'VCU_STATE_INIT'
  | 'VCU_STATE_PRECHARGE'
  | 'VCU_STATE_READY'
  | 'VCU_STATE_DRIVE'
  | 'VCU_STATE_DERATE'
  | 'VCU_STATE_FAULT_LATCHED'
  | 'VCU_STATE_FAULT_SAFE';

export type ImuFaultMode = 'NOMINAL' | 'HIGH_NOISE' | 'CAN_TIMEOUT_DROPOUT';

export interface VcuFaultInjectionInputs {
  /** Driver primary APPS pedal position [0..100 %] */
  appsPct: number;
  /** Injected deviation between APPS1 and APPS2 [0..30 %] (Rule T 11.8.9: >10% for 100 ms) */
  appsDeviationPct: number;
  /** Front brake line pressure [0..60 bar] (Rule EV 2.3 & EV 2.5 hard braking threshold >= 8 bar) */
  brakePressureBar: number;
  /** Simulated or forced DC bus power draw [kW] (Rule EV 2.5 Soft-BSPD: >5 kW + hard brake for 500 ms) */
  dcBusPowerKw: number;
  /** Cascadia PM100DX IGBT module temperature [°C] (Derate >60°C, Cut 85°C) */
  inverterTempC: number;
  /** Single RWD motor stator temperature [°C] (Derate >95°C, Cut 130°C) */
  motorTempC: number;
  /** Current motor shaft speed [RPM] */
  motorRpm: number;
  /** IMU health / fault injection mode */
  imuFaultMode: ImuFaultMode;
  /** Precharge HV bus voltage ratio [0..100 %] */
  prechargePct: number;
  /** Ready-to-Drive (R2D) cockpit button + brake interlock armed */
  r2dArmed: boolean;
}

export interface VcuSafetyFsmRuntimeState {
  state: Ist26VcuState;
  /** T 11.8.9: 0..100 ms timer while |APPS1 - APPS2| > 10% */
  appsFaultTimerMs: number;
  /** EV 2.5: 0..500 ms timer while Brake >= 8 bar and P_dc > 5.0 kW */
  bspdFaultTimerMs: number;
  /** True when T 11.8.9 APPS deviation reached 100 ms; stays latched until APPS < 5% */
  appsImplausibilityLatched: boolean;
  /** True when EV 2.3 Brake + APPS > 25% triggered; stays latched until APPS < 5% */
  brakePlausibilityLatched: boolean;
  /** True when EV 2.5 Soft-BSPD reached 500 ms; latches SDC open until manual reset */
  bspdFaultSafeLatched: boolean;
  /** Shutdown Circuit (SDC / AIRs) relay status */
  sdcRelayClosed: boolean;
  /** Thermal derating multiplier [0.0 .. 1.0] */
  thermalDerateFactor: number;
  /** IMU health derating multiplier [0.0 .. 1.0] */
  imuDerateFactor: number;
  /** Requested torque before safety clamps [Nm] */
  rawRequestedTorqueNm: number;
  /** Final safe CAN torque command sent to Cascadia PM100DX inverter [Nm] */
  cascadiaTorqueCmdNm: number;
  /** Cascadia PM100DX CAN 0x0C0 8-byte payload hex preview */
  cascadiaCanFrameHex: string;
  /** Active rule violation / status banner */
  activeBanner: string;
}

export const INITIAL_VCU_FSM_RUNTIME: VcuSafetyFsmRuntimeState = {
  state: 'VCU_STATE_DRIVE',
  appsFaultTimerMs: 0,
  bspdFaultTimerMs: 0,
  appsImplausibilityLatched: false,
  brakePlausibilityLatched: false,
  bspdFaultSafeLatched: false,
  sdcRelayClosed: true,
  thermalDerateFactor: 1.0,
  imuDerateFactor: 1.0,
  rawRequestedTorqueNm: 0,
  cascadiaTorqueCmdNm: 0,
  cascadiaCanFrameHex: '00 00 00 00 01 00 00 00',
  activeBanner: 'NOMINAL — VCU_STATE_DRIVE (Cascadia CAN 0x0C0 Active)',
};

/**
 * Format Cascadia Motion PM100DX Command Message (CAN ID 0x0C0, Little-Endian)
 * Bytes 0-1: Torque Command (int16_t, 0.1 Nm/bit)
 * Bytes 2-3: Speed Command (0)
 * Byte 4: Direction (1 = Forward)
 * Byte 5: Inverter Enable (bit 0) | Discharge (bit 1)
 * Bytes 6-7: Commanded Torque Limit (0 = default 310.0 Nm)
 */
export function formatCascadiaCan0x0C0Hex(torqueNm: number, inverterEnable: boolean): string {
  const scaled = Math.max(-3100, Math.min(3100, Math.round(torqueNm * 10)));
  const u16 = scaled < 0 ? 0x10000 + scaled : scaled;
  const b0 = u16 & 0xff;
  const b1 = (u16 >> 8) & 0xff;
  const b4 = 0x01; // Forward RWD
  const b5 = inverterEnable ? 0x01 : 0x00;
  const toHex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `${toHex(b0)} ${toHex(b1)} 00 00 ${toHex(b4)} ${toHex(b5)} 00 00`;
}

/**
 * Step the FSAE-compliant IST26 VCU State Machine forward by dtMs milliseconds
 */
export function stepIst26VcuSafetyFsm(
  prev: VcuSafetyFsmRuntimeState,
  inp: VcuFaultInjectionInputs,
  dtMs: number,
): VcuSafetyFsmRuntimeState {
  let {
    appsFaultTimerMs,
    bspdFaultTimerMs,
    appsImplausibilityLatched,
    brakePlausibilityLatched,
    bspdFaultSafeLatched,
  } = prev;

  // 1. Check Rule T 11.8.9: APPS1 vs APPS2 Deviation > 10% for 100 ms
  if (inp.appsDeviationPct > 10.0) {
    appsFaultTimerMs = Math.min(100, appsFaultTimerMs + dtMs);
    if (appsFaultTimerMs >= 100) {
      appsImplausibilityLatched = true;
    }
  } else {
    appsFaultTimerMs = Math.max(0, appsFaultTimerMs - dtMs * 2);
    // Unlatch ONLY when driver releases pedal below 5% AND deviation <= 10%
    if (inp.appsPct < 5.0) {
      appsImplausibilityLatched = false;
    }
  }

  // 2. Check Rule EV 2.3: APPS + Brake Plausibility (Brake >= 8 bar AND APPS > 25%)
  const hardBrakeActive = inp.brakePressureBar >= 8.0;
  if (hardBrakeActive && inp.appsPct > 25.0) {
    brakePlausibilityLatched = true;
  } else if (inp.appsPct < 5.0) {
    // Immediate unlatch ONLY when APPS drops below 5%
    brakePlausibilityLatched = false;
  }

  // 3. Check Rule EV 2.5: Soft-BSPD (Hard Brake >= 8 bar AND Cascadia DC Power > 5.0 kW for 500 ms)
  if (hardBrakeActive && inp.dcBusPowerKw > 5.0) {
    bspdFaultTimerMs = Math.min(500, bspdFaultTimerMs + dtMs);
    if (bspdFaultTimerMs >= 500) {
      bspdFaultSafeLatched = true;
    }
  } else {
    bspdFaultTimerMs = Math.max(0, bspdFaultTimerMs - dtMs * 2);
  }

  // 4. Compute Cascadia Inverter & Motor linear thermal derating [0..1]
  const invStart = IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.inverterTempDerateStartC; // 60°C
  const invCut = IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.inverterTempCutC; // 85°C
  const motStart = IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.motorTempDerateStartC; // 95°C
  const motCut = IST26_RWD_PDF_SPEC.powertrainCascadiaRwd.motorTempCutC; // 130°C

  const invFactor =
    inp.inverterTempC <= invStart
      ? 1.0
      : inp.inverterTempC >= invCut
        ? 0.0
        : 1.0 - (inp.inverterTempC - invStart) / (invCut - invStart);

  const motFactor =
    inp.motorTempC <= motStart
      ? 1.0
      : inp.motorTempC >= motCut
        ? 0.0
        : 1.0 - (inp.motorTempC - motStart) / (motCut - motStart);

  const thermalDerateFactor = Number(Math.min(invFactor, motFactor).toFixed(3));
  const imuDerateFactor =
    inp.imuFaultMode === 'NOMINAL' ? 1.0 : inp.imuFaultMode === 'HIGH_NOISE' ? 0.75 : 0.5;

  // 5. Base torque request from IST26 6000 RPM motor curve
  const maxTorqueAtRpm = interpolateIst26MotorTorqueNm(inp.motorRpm, true);
  const rawRequestedTorqueNm = Number(((inp.appsPct / 100) * maxTorqueAtRpm).toFixed(1));

  // 6. State transition logic
  let state: Ist26VcuState = 'VCU_STATE_DRIVE';
  let sdcRelayClosed = true;
  let cascadiaTorqueCmdNm = 0;
  let activeBanner = 'NOMINAL — VCU_STATE_DRIVE (Cascadia CAN 0x0C0 Active)';

  if (bspdFaultSafeLatched || thermalDerateFactor <= 0.001) {
    state = 'VCU_STATE_FAULT_SAFE';
    sdcRelayClosed = false;
    cascadiaTorqueCmdNm = 0;
    activeBanner = bspdFaultSafeLatched
      ? 'EV 2.5 SOFT-BSPD TRIP (>5 kW + Fren >= 500 ms) — SDC RELAY OPENED (0 Nm)'
      : 'THERMAL CUTOFF EXCEEDED — SDC RELAY OPENED (0 Nm)';
  } else if (inp.prechargePct < 10) {
    state = 'VCU_STATE_INIT';
    cascadiaTorqueCmdNm = 0;
    activeBanner = 'LV / CAN BUS INIT — Waiting for Precharge Sequence';
  } else if (inp.prechargePct < 95) {
    state = 'VCU_STATE_PRECHARGE';
    cascadiaTorqueCmdNm = 0;
    activeBanner = `HV PRECHARGE IN PROGRESS (${inp.prechargePct.toFixed(0)}% V_dc)`;
  } else if (!inp.r2dArmed) {
    state = 'VCU_STATE_READY';
    cascadiaTorqueCmdNm = 0;
    activeBanner = 'HV READY — Waiting for Brake + R2D Button Interlock';
  } else if (appsImplausibilityLatched || brakePlausibilityLatched) {
    state = 'VCU_STATE_FAULT_LATCHED';
    cascadiaTorqueCmdNm = 0;
    if (appsImplausibilityLatched && brakePlausibilityLatched) {
      activeBanner = 'T 11.8.9 APPS >10% (100ms) + EV 2.3 APPS/BRAKE LATCHED -> 0 Nm (Gaz <%5 bekleniyor)';
    } else if (appsImplausibilityLatched) {
      activeBanner = 'T 11.8.9 APPS >10% SAPMA (100 ms DOLDU) LATCHED -> 0 Nm (Gaz <%5 inene kadar kilitli)';
    } else {
      activeBanner = 'EV 2.3 APPS >%25 + FREN PLAUSIBILITY LATCHED -> 0 Nm (Gaz <%5 inene kadar kilitli)';
    }
  } else if (thermalDerateFactor < 0.999 || imuDerateFactor < 0.999) {
    state = 'VCU_STATE_DERATE';
    const combinedDerate = Math.min(thermalDerateFactor, imuDerateFactor);
    cascadiaTorqueCmdNm = Number((rawRequestedTorqueNm * combinedDerate).toFixed(1));
    activeBanner = `DERATE ACTIVE (Çarpan: ${(combinedDerate * 100).toFixed(0)}%) — Tork: ${cascadiaTorqueCmdNm} Nm`;
  } else {
    state = 'VCU_STATE_DRIVE';
    cascadiaTorqueCmdNm = rawRequestedTorqueNm;
    activeBanner = `NOMINAL DRIVE — Cascadia Tork Komutu: ${cascadiaTorqueCmdNm.toFixed(1)} Nm`;
  }

  const inverterEnable =
    state === 'VCU_STATE_DRIVE' || state === 'VCU_STATE_DERATE';

  return {
    state,
    appsFaultTimerMs: Number(appsFaultTimerMs.toFixed(1)),
    bspdFaultTimerMs: Number(bspdFaultTimerMs.toFixed(1)),
    appsImplausibilityLatched,
    brakePlausibilityLatched,
    bspdFaultSafeLatched,
    sdcRelayClosed,
    thermalDerateFactor,
    imuDerateFactor,
    rawRequestedTorqueNm,
    cascadiaTorqueCmdNm,
    cascadiaCanFrameHex: formatCascadiaCan0x0C0Hex(cascadiaTorqueCmdNm, inverterEnable),
    activeBanner,
  };
}

/**
 * Generate isolated MISRA-C:2012 / C99 compliant firmware files (.h and .c)
 * with zero dynamic memory allocation (stdint.h, stdbool.h) for IST26 RWD + Cascadia PM100DX
 */
export function generateIst26VcuSafetyFirmware(): {
  headerName: string;
  headerContent: string;
  sourceName: string;
  sourceContent: string;
} {
  const headerName = 'ist26_vcu_safety_fsm.h';
  const sourceName = 'ist26_vcu_safety_fsm.c';

  const headerContent = `/**
 * @file ist26_vcu_safety_fsm.h
 * @brief IST26 RWD (Single Motor + Cascadia Motion PM100DX) FSAE Safety & Plausibility State Machine
 * @note MISRA-C:2012 / C99 Compliant — Zero dynamic memory allocation (<stdint.h>, <stdbool.h>)
 * @note Rules Implemented: FSAE T 11.8.9 (Dual APPS >10% 100ms), EV 2.3 (APPS >25% + Brake), EV 2.5 (Soft-BSPD 500ms)
 */

#ifndef IST26_VCU_SAFETY_FSM_H
#define IST26_VCU_SAFETY_FSM_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================== */
/* IST26 PHYSICAL & FSAE RULE CONSTANTS                                       */
/* ========================================================================== */
#define IST26_MAX_TORQUE_NM              (310.0f)
#define IST26_MAX_POWER_KW               (80.0f)
#define IST26_RPM_CUTOFF                 (6000U)
#define IST26_GEAR_RATIO                 (3.20f)
#define IST26_WHEEL_RADIUS_M             (0.205f)

#define IST26_APPS_DEVIATION_MAX_PCT     (10.0f)
#define IST26_APPS_PLAUS_UNLATCH_PCT     (5.0f)
#define IST26_APPS_BRAKE_TRIP_PCT        (25.0f)
#define IST26_HARD_BRAKE_THRESH_BAR      (8.0f)
#define IST26_BSPD_POWER_THRESH_KW       (5.0f)

#define IST26_APPS_FAULT_TIMEOUT_MS      (100U)
#define IST26_BSPD_FAULT_TIMEOUT_MS      (500U)

#define IST26_INV_TEMP_DERATE_START_C    (60.0f)
#define IST26_INV_TEMP_CUTOFF_C          (85.0f)
#define IST26_MOT_TEMP_DERATE_START_C    (95.0f)
#define IST26_MOT_TEMP_CUTOFF_C          (130.0f)

#define CASCADIA_CAN_ID_CMD              (0x0C0U)

/* ========================================================================== */
/* VCU STATE MACHINE ENUMERATION                                              */
/* ========================================================================== */
typedef enum {
    VCU_STATE_INIT = 0U,
    VCU_STATE_PRECHARGE = 1U,
    VCU_STATE_READY = 2U,
    VCU_STATE_DRIVE = 3U,
    VCU_STATE_DERATE = 4U,
    VCU_STATE_FAULT_LATCHED = 5U,
    VCU_STATE_FAULT_SAFE = 6U
} ist26_vcu_state_t;

typedef enum {
    IST26_IMU_NOMINAL = 0U,
    IST26_IMU_HIGH_NOISE = 1U,
    IST26_IMU_CAN_TIMEOUT = 2U
} ist26_imu_health_t;

/* ========================================================================== */
/* INPUT, STATE & CASCADIA CAN COMMAND STRUCTURES                             */
/* ========================================================================== */
typedef struct {
    float apps1_pct;            /* Primary APPS sensor [0.0 .. 100.0 %] */
    float apps2_pct;            /* Secondary APPS sensor [0.0 .. 100.0 %] */
    float brake_front_bar;      /* Front hydraulic brake pressure [bar] */
    float dc_bus_voltage_v;     /* Cascadia HV DC bus voltage [V] */
    float dc_bus_current_a;     /* Cascadia HV DC bus current [A] */
    float inverter_temp_c;      /* Cascadia IGBT power stage temp [deg C] */
    float motor_temp_c;         /* Emrax / RWD motor temp [deg C] */
    uint16_t motor_rpm;         /* Motor shaft speed [RPM] */
    float precharge_pct;        /* HV bus precharge completion [0..100 %] */
    bool r2d_armed;             /* Cockpit Ready-to-Drive latched */
    ist26_imu_health_t imu_sts; /* IMU sensor plausibility status */
} ist26_vcu_inputs_t;

typedef struct {
    ist26_vcu_state_t state;
    uint16_t apps_fault_timer_ms;
    uint16_t bspd_fault_timer_ms;
    bool apps_implaus_latched;
    bool brake_plaus_latched;
    bool bspd_safe_latched;
    bool sdc_relay_closed;
    float thermal_derate_factor;
    float commanded_torque_nm;
    uint8_t can_0x0c0_payload[8];
} ist26_vcu_fsm_t;

/* ========================================================================== */
/* PUBLIC API PROTOTYPES (1 kHz DETERMINISTIC EXECUTION)                      */
/* ========================================================================== */
void IST26_VCU_Init(ist26_vcu_fsm_t * const fsm);
void IST26_VCU_Step1ms(ist26_vcu_fsm_t * const fsm, const ist26_vcu_inputs_t * const in);
float IST26_LookupMaxMotorTorqueNm(uint16_t rpm);

#ifdef __cplusplus
}
#endif

#endif /* IST26_VCU_SAFETY_FSM_H */
`;

  const sourceContent = `/**
 * @file ist26_vcu_safety_fsm.c
 * @brief IST26 RWD (Single Motor + Cascadia Motion PM100DX) FSAE Safety & Plausibility Implementation
 * @note MISRA-C:2012 / C99 Compliant — Deterministic 1 kHz execution, zero heap allocation
 */

#include "ist26_vcu_safety_fsm.h"

/* 16-Point IST26 RWD Motor Torque Envelope from IST26_RWD_Vehicle_Parameters.pdf */
static const uint16_t kIst26RpmBreakpoints[12] = {
    0U, 500U, 900U, 2500U, 2944U, 3250U, 3519U, 3895U, 4050U, 4514U, 5462U, 6000U
};

static const float kIst26TorqueEnvelopeNm[12] = {
    310.0f, 310.0f, 310.0f, 305.6f, 259.5f, 235.1f, 217.1f, 196.1f, 188.6f, 169.2f, 139.9f, 127.1f
};

static float ist26_absf(float val) {
    return (val < 0.0f) ? -val : val;
}

static float ist26_clampf(float val, float lo, float hi) {
    float res = val;
    if (res < lo) { res = lo; }
    if (res > hi) { res = hi; }
    return res;
}

float IST26_LookupMaxMotorTorqueNm(uint16_t rpm) {
    float trq_nm = 0.0f;
    if (rpm > IST26_RPM_CUTOFF) {
        trq_nm = 0.0f;
    } else if (rpm <= kIst26RpmBreakpoints[0]) {
        trq_nm = kIst26TorqueEnvelopeNm[0];
    } else {
        uint8_t i = 0U;
        for (i = 0U; i < 11U; i++) {
            if ((rpm >= kIst26RpmBreakpoints[i]) && (rpm <= kIst26RpmBreakpoints[i + 1U])) {
                const float span = (float)(kIst26RpmBreakpoints[i + 1U] - kIst26RpmBreakpoints[i]);
                const float frac = (span > 0.0f) ? ((float)(rpm - kIst26RpmBreakpoints[i]) / span) : 0.0f;
                trq_nm = kIst26TorqueEnvelopeNm[i] + frac * (kIst26TorqueEnvelopeNm[i + 1U] - kIst26TorqueEnvelopeNm[i]);
                break;
            }
        }
    }
    return trq_nm;
}

static void ist26_pack_cascadia_0x0c0(float torque_nm, bool inv_enable, uint8_t payload[8]) {
    const float clamped = ist26_clampf(torque_nm, 0.0f, IST26_MAX_TORQUE_NM);
    const int16_t trq_deci_nm = (int16_t)(clamped * 10.0f);
    const uint16_t raw_u16 = (uint16_t)trq_deci_nm;

    payload[0] = (uint8_t)(raw_u16 & 0xFFU);
    payload[1] = (uint8_t)((raw_u16 >> 8U) & 0xFFU);
    payload[2] = 0U; /* Speed command LSB */
    payload[3] = 0U; /* Speed command MSB */
    payload[4] = 1U; /* Forward direction */
    payload[5] = inv_enable ? 0x01U : 0x00U;
    payload[6] = 0U; /* Default torque limit LSB */
    payload[7] = 0U; /* Default torque limit MSB */
}

void IST26_VCU_Init(ist26_vcu_fsm_t * const fsm) {
    if (fsm != (ist26_vcu_fsm_t *)0) {
        uint8_t k = 0U;
        fsm->state = VCU_STATE_INIT;
        fsm->apps_fault_timer_ms = 0U;
        fsm->bspd_fault_timer_ms = 0U;
        fsm->apps_implaus_latched = false;
        fsm->brake_plaus_latched = false;
        fsm->bspd_safe_latched = false;
        fsm->sdc_relay_closed = true;
        fsm->thermal_derate_factor = 1.0f;
        fsm->commanded_torque_nm = 0.0f;
        for (k = 0U; k < 8U; k++) {
            fsm->can_0x0c0_payload[k] = 0U;
        }
    }
}

void IST26_VCU_Step1ms(ist26_vcu_fsm_t * const fsm, const ist26_vcu_inputs_t * const in) {
    if ((fsm != (ist26_vcu_fsm_t *)0) && (in != (const ist26_vcu_inputs_t *)0)) {
        const float apps_avg_pct = ist26_clampf(0.5f * (in->apps1_pct + in->apps2_pct), 0.0f, 100.0f);
        const float apps_diff_pct = ist26_absf(in->apps1_pct - in->apps2_pct);
        const float dc_power_kw = (in->dc_bus_voltage_v * in->dc_bus_current_a) * 0.001f;
        const bool hard_brake = (in->brake_front_bar >= IST26_HARD_BRAKE_THRESH_BAR);

        /* 1. FSAE Rule T 11.8.9: Dual APPS > 10% deviation for 100 ms */
        if (apps_diff_pct > IST26_APPS_DEVIATION_MAX_PCT) {
            if (fsm->apps_fault_timer_ms < IST26_APPS_FAULT_TIMEOUT_MS) {
                fsm->apps_fault_timer_ms++;
            }
            if (fsm->apps_fault_timer_ms >= IST26_APPS_FAULT_TIMEOUT_MS) {
                fsm->apps_implaus_latched = true;
            }
        } else {
            if (fsm->apps_fault_timer_ms > 0U) {
                fsm->apps_fault_timer_ms--;
            }
            if (apps_avg_pct < IST26_APPS_PLAUS_UNLATCH_PCT) {
                fsm->apps_implaus_latched = false;
            }
        }

        /* 2. FSAE Rule EV 2.3: Brake + APPS > 25% Plausibility */
        if (hard_brake && (apps_avg_pct > IST26_APPS_BRAKE_TRIP_PCT)) {
            fsm->brake_plaus_latched = true;
        } else if (apps_avg_pct < IST26_APPS_PLAUS_UNLATCH_PCT) {
            fsm->brake_plaus_latched = false;
        }

        /* 3. FSAE Rule EV 2.5: Soft-BSPD (>5 kW DC power + hard brake for 500 ms) */
        if (hard_brake && (dc_power_kw > IST26_BSPD_POWER_THRESH_KW)) {
            if (fsm->bspd_fault_timer_ms < IST26_BSPD_FAULT_TIMEOUT_MS) {
                fsm->bspd_fault_timer_ms++;
            }
            if (fsm->bspd_fault_timer_ms >= IST26_BSPD_FAULT_TIMEOUT_MS) {
                fsm->bspd_safe_latched = true;
            }
        } else {
            if (fsm->bspd_fault_timer_ms > 0U) {
                fsm->bspd_fault_timer_ms--;
            }
        }

        /* 4. Cascadia Inverter & Motor Linear Thermal Derating */
        {
            float inv_derate = 1.0f;
            float mot_derate = 1.0f;
            if (in->inverter_temp_c >= IST26_INV_TEMP_CUTOFF_C) {
                inv_derate = 0.0f;
            } else if (in->inverter_temp_c > IST26_INV_TEMP_DERATE_START_C) {
                inv_derate = 1.0f - ((in->inverter_temp_c - IST26_INV_TEMP_DERATE_START_C) /
                                     (IST26_INV_TEMP_CUTOFF_C - IST26_INV_TEMP_DERATE_START_C));
            }

            if (in->motor_temp_c >= IST26_MOT_TEMP_CUTOFF_C) {
                mot_derate = 0.0f;
            } else if (in->motor_temp_c > IST26_MOT_TEMP_DERATE_START_C) {
                mot_derate = 1.0f - ((in->motor_temp_c - IST26_MOT_TEMP_DERATE_START_C) /
                                     (IST26_MOT_TEMP_CUTOFF_C - IST26_MOT_TEMP_DERATE_START_C));
            }
            fsm->thermal_derate_factor = (inv_derate < mot_derate) ? inv_derate : mot_derate;
        }

        /* 5. State Machine Transitions & Torque Limiting */
        if (fsm->bspd_safe_latched || (fsm->thermal_derate_factor <= 0.001f)) {
            fsm->state = VCU_STATE_FAULT_SAFE;
            fsm->sdc_relay_closed = false;
            fsm->commanded_torque_nm = 0.0f;
        } else if (in->precharge_pct < 10.0f) {
            fsm->state = VCU_STATE_INIT;
            fsm->commanded_torque_nm = 0.0f;
        } else if (in->precharge_pct < 95.0f) {
            fsm->state = VCU_STATE_PRECHARGE;
            fsm->commanded_torque_nm = 0.0f;
        } else if (!in->r2d_armed) {
            fsm->state = VCU_STATE_READY;
            fsm->commanded_torque_nm = 0.0f;
        } else if (fsm->apps_implaus_latched || fsm->brake_plaus_latched) {
            fsm->state = VCU_STATE_FAULT_LATCHED;
            fsm->commanded_torque_nm = 0.0f;
        } else {
            const float env_trq = IST26_LookupMaxMotorTorqueNm(in->motor_rpm);
            const float req_trq = (apps_avg_pct * 0.01f) * env_trq;
            const float imu_scale = (in->imu_sts == IST26_IMU_NOMINAL) ? 1.0f :
                                    ((in->imu_sts == IST26_IMU_HIGH_NOISE) ? 0.75f : 0.50f);
            const float scale = (fsm->thermal_derate_factor < imu_scale) ? fsm->thermal_derate_factor : imu_scale;

            if (scale < 0.999f) {
                fsm->state = VCU_STATE_DERATE;
                fsm->commanded_torque_nm = req_trq * scale;
            } else {
                fsm->state = VCU_STATE_DRIVE;
                fsm->commanded_torque_nm = req_trq;
            }
        }

        ist26_pack_cascadia_0x0c0(
            fsm->commanded_torque_nm,
            (fsm->state == VCU_STATE_DRIVE) || (fsm->state == VCU_STATE_DERATE),
            fsm->can_0x0c0_payload
        );
    }
}
`;

  return { headerName, headerContent, sourceName, sourceContent };
}
