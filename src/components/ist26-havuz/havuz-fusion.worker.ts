import { createVehicleFusion } from '@/lib/ist26-havuz/ekf-fusion';
import { IST26_RWD_PDF_SPEC } from '@/lib/ist26-havuz/ist26-vehicle-spec';

export interface FusionLogResult {
  sampleCount: number;
  imuDropouts: number;
  wheelDropouts: number;
  canTimeouts: number | null;
  rows: { time: number; beta: number | null; slipRL: number | null; slipRR: number | null }[];
}

self.onmessage = (event: MessageEvent<{ csv: string }>) => {
  try {
    const lines = event.data.csv.trim().split(/\r?\n/);
    const separator = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].replace(/^\uFEFF/, '').split(separator).map((column) => column.trim().replace(/^"|"$/g, ''));
    const accel = ['X', 'Y', 'Z'].map((axis) => headers.indexOf(`IMU_ACCEL_${axis}_f`));
    const gyro = ['X', 'Y', 'Z'].map((axis) => headers.indexOf(`IMU_GYRO_${axis}_f`));
    const wheel = ['FL', 'FR', 'RL', 'RR'].map((corner) => headers.indexOf(`WHEEL_OMEGA_${corner}_FILT_f`));
    const steer = headers.indexOf('STEERING_ANGLE_f');
    const timer = headers.indexOf('INV_POWERON_TIMER_u32');
    if (gyro[2] < 0 || wheel.every((index) => index < 0)) throw new Error('EKF için yaw hızı ve en az bir tekerlek hızı gerekli.');
    const estimate = createVehicleFusion();
    const result: FusionLogResult = { sampleCount: 0, imuDropouts: 0, wheelDropouts: 0, canTimeouts: timer >= 0 ? 0 : null, rows: [] };
    const stride = Math.max(1, Math.ceil((lines.length - 1) / 900));
    const toRad = Math.PI / 180;
    let lastTimer: number | null = null;
    let timeS = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const columns = lines[i].split(separator);
      const get = (index: number, scale = 1) => {
        const raw = columns[index]?.trim().replace(/^"|"$/g, '');
        const value = raw ? Number(raw) : NaN;
        return Number.isFinite(value) ? value * scale : null;
      };
      const ticks = get(timer);
      const tickDelta = ticks != null && lastTimer != null ? (ticks - lastTimer) >>> 0 : 0;
      if (result.sampleCount > 0) timeS += tickDelta > 0 && tickDelta < 1000 ? 0.003 * tickDelta : 0.024;
      const heartbeat = timer < 0 ? null : ticks != null && (lastTimer == null || ticks !== lastTimer);
      if (ticks != null) lastTimer = ticks;
      const state = estimate({
        timeS, accelerationMode: 'gravity-compensated',
        accelerationMps2: [get(accel[0]), get(accel[1]), get(accel[2])],
        gyroRadPerS: [get(gyro[0], toRad), get(gyro[1], toRad), get(gyro[2], toRad)],
        wheelOmegaRadPerS: [get(wheel[0]), get(wheel[1]), get(wheel[2]), get(wheel[3])],
        roadWheelSteerRad: get(steer, toRad / IST26_RWD_PDF_SPEC.brakesAndTires.steeringRatio), cascadiaHeartbeat: heartbeat,
      });
      result.imuDropouts += Number(state.flags.imuDropout);
      result.wheelDropouts += Number(state.flags.wheelDropout);
      if (result.canTimeouts != null) result.canTimeouts += Number(state.flags.canTimeout === true);
      if (result.sampleCount % stride === 0 || i === lines.length - 1) result.rows.push({
        time: timeS, beta: state.sideslipRad == null ? null : state.sideslipRad / toRad,
        slipRL: state.wheelSlipRatio[2] == null ? null : state.wheelSlipRatio[2] * 100,
        slipRR: state.wheelSlipRatio[3] == null ? null : state.wheelSlipRatio[3] * 100,
      });
      result.sampleCount++;
    }
    if (result.sampleCount === 0) throw new Error('CSV içinde sensör örneği bulunamadı.');
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : 'EKF çalıştırılamadı.' });
  }
};
