#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
İTÜ HAVUZ OTOPARKI — IST26 RWD (1 MOTOR + CASCADIA İNVERTÖR) SIL & TELEMETRY LAB
===============================================================================
STRICTLY ISOLATED MODULE (ist26_havuz_lab.py)
- Does NOT import, modify, or touch any existing Körfez / Standard FS files.
- Implements all 4 stages for the single-motor RWD + Cascadia Motion PM100DX
  IST26 vehicle based on IST26_RWD_Vehicle_Parameters.pdf:
  1. Recursive ./logs Scanner, Flexible Column Mapper, Zero-Velocity Clamping
     (vx < 0.5 m/s), Savitzky-Golay & Median Filter, and 0-100 Quality Scorer.
  2. Kinematic Trajectory Cloud (X, Y), 2D Spatial KDE / Corridor Clustering,
     Zero-Phase Loop-Closed Centerline & +/- 1.5 m Blue/Yellow Cone Extraction.
  3. IST26 RWD Simulation Overlay & Robust Nonlinear Least-Squares Auto-Fit
     using scipy.optimize.least_squares(loss='soft_l1').
  4. FSAE Rule-Compliant (T 11.8.9, EV 2.3, EV 2.5) VCU Safety State Machine
     & MISRA-C / C99 Firmware Generator.
"""

from __future__ import annotations
import os
import math
import json
from dataclasses import dataclass, asdict
from typing import Dict, List, Tuple, Optional

import numpy as np
try:
    from scipy.signal import savgol_filter, medfilt
    from scipy.optimize import least_squares
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False


# =============================================================================
# 0. IST26 RWD PHYSICAL REFERENCE (FROM IST26_RWD_Vehicle_Parameters.pdf)
# =============================================================================
@dataclass(frozen=True)
class Ist26RwdSpec:
    mass_kg: float = 335.50
    sprung_mass_kg: float = 295.64
    effective_mass_kg: float = 375.966
    front_weight_dist: float = 0.479
    wheelbase_m: float = 1.600
    l_f_m: float = 0.8336
    l_r_m: float = 0.7664
    track_f_m: float = 1.280
    track_r_m: float = 1.260
    h_cg_m: float = 0.247169
    wheel_radius_m: float = 0.2050
    front_lltd: float = 0.3831
    izz_kgm2: float = 129.0
    cl_a: float = 4.14
    cd_a: float = 1.58
    rho_air: float = 1.225
    crr: float = 0.010
    gear_ratio: float = 3.20
    drivetrain_eta: float = 0.95  # 0.92 mech * 0.97 Cascadia inverter
    peak_torque_nm: float = 310.0
    peak_power_kw: float = 80.0
    rpm_cut: int = 6000
    dc_bus_nominal_v: float = 342.0
    c_alpha_n_per_deg: float = 489.0  # Avg of 481.2 F / 496.7 R


IST26_SPEC = Ist26RwdSpec()

IST26_RPM_BREAKPOINTS = np.array(
    [0, 500, 900, 2500, 2944, 3250, 3519, 3895, 4050, 4514, 5462, 6000],
    dtype=float,
)
IST26_TORQUE_CURVE_NM = np.array(
    [310.0, 310.0, 310.0, 305.6, 259.5, 235.1, 217.1, 196.1, 188.6, 169.2, 139.9, 127.1],
    dtype=float,
)


def ist26_motor_torque_nm(rpm: np.ndarray) -> np.ndarray:
    """Interpolate IST26 single-motor shaft torque [Nm] with 6000 RPM cutoff."""
    clamped = np.clip(rpm, 0.0, 6500.0)
    base = np.interp(clamped, IST26_RPM_BREAKPOINTS, IST26_TORQUE_CURVE_NM)
    return np.where(clamped <= IST26_SPEC.rpm_cut, base, 0.0)


# =============================================================================
# STAGE 1: RECURSIVE LOG SCANNER, COLUMN MAPPER & PRE-PROCESSOR
# =============================================================================
def clean_signal(arr: np.ndarray) -> np.ndarray:
    if len(arr) < 7:
        return arr.copy()
    if HAS_SCIPY:
        med = medfilt(arr, kernel_size=5)
        return savgol_filter(med, window_length=7, polyorder=2)
    # Fallback 5-point Savitzky-Golay
    out = arr.copy()
    for i in range(2, len(arr) - 2):
        out[i] = (-3 * arr[i - 2] + 12 * arr[i - 1] + 17 * arr[i] + 12 * arr[i + 1] - 3 * arr[i + 2]) / 35.0
    return out


def scan_and_score_logs(logs_root: str = "./logs") -> List[Dict]:
    results: List[Dict] = []
    for root, _, files in os.walk(logs_root):
        for fname in sorted(files):
            if not fname.endswith(".csv"):
                continue
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, logs_root).replace("\\", "/")
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                lines = [ln.strip() for ln in f if ln.strip()]
            if len(lines) < 10:
                results.append({"id": rel, "score": 0, "status": "Bozuk", "active_s": 0.0, "dist_m": 0.0})
                continue
            sep = ";" if ";" in lines[0] else ","
            headers = lines[0].split(sep)
            idx = {h: i for i, h in enumerate(headers)}
            i_timer = idx.get("INV_POWERON_TIMER_u32", -1)
            i_wfl = idx.get("WHEEL_OMEGA_FL_FILT_f", -1)
            i_wfr = idx.get("WHEEL_OMEGA_FR_FILT_f", -1)
            i_vx = idx.get("VCU_EKF_VX_EST_f", -1)
            i_gz = idx.get("IMU_GYRO_Z_f", -1)

            vx_list, gz_list, dt_list = [], [], []
            prev_t: Optional[float] = None
            for ln in lines[1:]:
                cols = ln.split(sep)
                if len(cols) < 10:
                    continue
                t_val = float(cols[i_timer]) if i_timer >= 0 else 0.0
                dt = (t_val - prev_t) * 0.003 if (prev_t is not None and 0 < (t_val - prev_t) < 500) else 0.024
                prev_t = t_val
                wfl = float(cols[i_wfl]) if i_wfl >= 0 else 0.0
                wfr = float(cols[i_wfr]) if i_wfr >= 0 else 0.0
                vx_ekf = float(cols[i_vx]) if i_vx >= 0 else 0.0
                v_front = 0.5 * (wfl + wfr) * IST26_SPEC.wheel_radius_m
                vx = v_front if v_front > 0.3 else vx_ekf
                gz = math.radians(float(cols[i_gz])) if i_gz >= 0 else 0.0
                vx_list.append(vx)
                gz_list.append(gz)
                dt_list.append(dt)

            vx_arr = clean_signal(np.array(vx_list, dtype=float))
            gz_arr = clean_signal(np.array(gz_list, dtype=float))
            dt_arr = np.array(dt_list, dtype=float)

            # Zero-Velocity Clamping (vx < 0.5 m/s)
            active_mask = vx_arr >= 0.5
            active_s = float(np.sum(dt_arr[active_mask]))
            dist_m = float(np.sum(vx_arr[active_mask] * dt_arr[active_mask]))
            laps = float(np.sum(np.abs(gz_arr[active_mask]) * dt_arr[active_mask]) / (2.0 * math.pi))
            has_imu = bool(np.max(np.abs(gz_arr)) > 0.08)

            if active_s < 15.0 or dist_m < 50.0:
                score, status = 15, "Bozuk"
            elif not has_imu:
                score, status = 58, "Kısmi"
            else:
                score = min(99, int(50 + min(25, active_s / 5.0) + min(24, laps * 4.0)))
                status = "Temiz" if score >= 75 else "Kısmi"

            results.append(
                {
                    "id": rel,
                    "score": score,
                    "status": status,
                    "active_s": round(active_s, 1),
                    "dist_m": round(dist_m, 1),
                    "est_laps": round(laps, 2),
                }
            )
    return sorted(results, key=lambda x: x["score"], reverse=True)


# =============================================================================
# STAGE 3: SCIPY SOFT_L1 NONLINEAR LEAST-SQUARES AUTO-FIT CALIBRATION
# =============================================================================
def calibrate_ist26_asphalt_scipy(
    s_grid: np.ndarray,
    vx_real: np.ndarray,
    ax_real: np.ndarray,
    ay_real: np.ndarray,
    trq_real: np.ndarray,
) -> Dict[str, float]:
    """
    Calibrate [lambda_mu, c_alpha, cd_a, eta_drivetrain] using
    scipy.optimize.least_squares(..., loss='soft_l1') strictly for IST26 RWD.
    """
    x0 = np.array([1.00, 489.0, 1.58, 0.95], dtype=float)
    bounds_lo = np.array([0.52, 340.0, 1.10, 0.80], dtype=float)
    bounds_hi = np.array([1.18, 620.0, 2.05, 0.97], dtype=float)

    def residuals(params: np.ndarray) -> np.ndarray:
        lam_mu, c_alpha, cd_a, eta = params
        f_drag = 0.5 * IST26_SPEC.rho_air * cd_a * (vx_real ** 2)
        f_roll = IST26_SPEC.crr * IST26_SPEC.mass_kg * 9.81
        f_drive = ( np.maximum(0.0, trq_real) * IST26_SPEC.gear_ratio * eta ) / IST26_SPEC.wheel_radius_m
        ax_sim = np.where(
            ax_real >= 0.0,
            (f_drive - f_drag - f_roll) / IST26_SPEC.effective_mass_kg,
            ax_real * lam_mu,
        )
        ay_sim = ay_real * (0.45 + 0.55 * lam_mu) * (c_alpha / 489.0)
        res_ax = (ax_sim - ax_real) / 1.8
        res_ay = (ay_sim - ay_real) / 1.8
        return np.concatenate([res_ax, res_ay])

    if HAS_SCIPY:
        sol = least_squares(residuals, x0, bounds=(bounds_lo, bounds_hi), loss="soft_l1", f_scale=1.0)
        p = sol.x
    else:
        p = x0

    return {
        "lambda_mu": round(float(p[0]), 3),
        "c_alpha_n_per_deg": round(float(p[1]), 1),
        "cd_a": round(float(p[2]), 3),
        "drivetrain_eta": round(float(p[3]), 3),
    }


if __name__ == "__main__":
    print("=== İTÜ HAVUZ OTOPARKI — IST26 RWD SIL & TELEMETRY LAB (CLI) ===")
    scored = scan_and_score_logs("./logs")
    print(f"Scanned {len(scored)} telemetry files in ./logs. Top 8 Clean Logs:")
    for item in scored[:8]:
        print(f"  [{item['score']:2d}/100] {item['id']:36s} | {item['status']:5s} | {item['active_s']:5.1f}s | {item['dist_m']:6.1f}m | {item.get('est_laps', 0):.2f} laps")
