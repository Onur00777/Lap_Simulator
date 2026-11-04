import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POWERTRAIN as pt, DEFAULT_VEHICLE as veh } from '@/lib/physics';
import { generateVcuBundle, torqueMapLookup } from '@/lib/codegen';
import { tvInitialState, tvStep } from '@/lib/dynamics';

const bundle = generateVcuBundle(veh, pt);
const tm = bundle.torqueMap;

const hasGcc = (() => {
  try {
    return spawnSync('gcc', ['--version']).status === 0;
  } catch {
    return false;
  }
})();

const GCC_FLAGS = ['-std=c99', '-O1', '-Wall', '-Wextra', '-Wpedantic', '-Wconversion', '-Wshadow', '-Wdouble-promotion', '-Wcast-qual', '-Werror'];

describe('Torque map', () => {
  it('reproduces the table at the breakpoints and is monotonic in pedal travel', () => {
    tm.pedalPct.forEach((p, i) => tm.speedKph.forEach((s, j) => expect(torqueMapLookup(tm, p, s)).toBeCloseTo(tm.torque[i][j], 9)));
    for (const s of tm.speedKph) {
      for (let i = 1; i < tm.pedalPct.length; i++) expect(tm.torque[i][tm.speedKph.indexOf(s)]).toBeGreaterThanOrEqual(tm.torque[i - 1][tm.speedKph.indexOf(s)]);
    }
  });

  it('never exceeds the motor torque, 80 kW or traction limits at full pedal', () => {
    tm.availableTorque.forEach((t, j) => {
      expect(t).toBeLessThanOrEqual(pt.motorPeakTorque + 1e-9);
      expect(t).toBeLessThanOrEqual(tm.tractionTorque[j] + 1e-9);
      expect(tm.torque[tm.pedalPct.length - 1][j]).toBeCloseTo(t, 9);
    });
  });

  it('emits the three firmware files with MISRA-style constructs', () => {
    expect(bundle.files.map((f) => f.name)).toEqual(['vcu_torque_map.h', 'vcu_torque_vectoring.h', 'vcu_torque_vectoring.c']);
    const src = bundle.files[2].content;
    expect(src).not.toMatch(/\bmalloc\b|\bfree\b|\bgoto\b/);
    expect(src).toContain('VCU_TV_Step');
    expect(src).toContain('vTaskDelayUntil');
    expect(bundle.files[0].content).toContain('VCU_TM_Interpolate');
  });
});

describe.skipIf(!hasGcc)('Generated C firmware (gcc)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-vcu-'));
  for (const f of bundle.files) fs.writeFileSync(path.join(dir, f.name), f.content);

  it('compiles warning-free with -Wall -Wextra -Wpedantic -Wconversion -Werror (incl. FreeRTOS task)', () => {
    fs.writeFileSync(
      path.join(dir, 'FreeRTOS.h'),
      '#include <stdint.h>\ntypedef uint32_t TickType_t;\n#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))\n',
    );
    fs.writeFileSync(path.join(dir, 'task.h'), 'TickType_t xTaskGetTickCount(void);\nvoid vTaskDelayUntil(TickType_t *prev, TickType_t inc);\n');
    execFileSync('gcc', [...GCC_FLAGS, '-c', '-I', dir, path.join(dir, 'vcu_torque_vectoring.c'), '-o', path.join(dir, 'tv.o')]);
    execFileSync('gcc', [...GCC_FLAGS, '-DVCU_TV_USE_FREERTOS', '-c', '-I', dir, path.join(dir, 'vcu_torque_vectoring.c'), '-o', path.join(dir, 'tv_rtos.o')]);
  });

  it('C controller and torque map match the TypeScript reference implementation', () => {
    const N = 3000;
    const inputs: number[][] = [];
    for (let k = 0; k < N; k++) {
      const vx = Math.fround(2 + (28 * k) / N);
      const steer = Math.fround(0.12 * Math.sin((2 * Math.PI * k) / 700));
      const yaw = Math.fround(((0.85 * vx * steer) / veh.wheelbase) * (1 + 0.2 * Math.sin(k / 37)));
      const treq = Math.fround(30 * Math.max(0, Math.sin((2 * Math.PI * k) / 900)) - 4);
      inputs.push([vx, steer, yaw, treq]);
    }
    const queries: number[][] = [];
    for (let k = 0; k < 200; k++) queries.push([Math.fround((k * 37) % 107) - 3, Math.fround(((k * 53) % 140) - 2)]);
    fs.writeFileSync(path.join(dir, 'in.txt'), [...inputs, ...queries].map((r) => r.map((x) => x.toPrecision(9)).join(' ')).join('\n'));
    fs.writeFileSync(
      path.join(dir, 'harness.c'),
      `#include <stdio.h>
#include "vcu_torque_map.h"
#include "vcu_torque_vectoring.h"
int main(void) {
  VCU_TV_State_t st; VCU_TV_Inputs_t in; VCU_TV_Outputs_t out; int k;
  FILE *f = fopen("in.txt", "r");
  if (f == NULL) { return 1; }
  VCU_TV_Init(&st);
  for (k = 0; k < ${N}; k++) {
    if (fscanf(f, "%f %f %f %f", &in.vx_mps, &in.steer_rad, &in.yaw_rate_rps, &in.torque_request_Nm) != 4) { return 2; }
    VCU_TV_Step(&VCU_TV_DefaultParams, &st, &in, &out);
    printf("%.9g %.9g %.9g\\n", (double)out.torque_rl_Nm, (double)out.torque_rr_Nm, (double)out.mz_Nm);
  }
  for (k = 0; k < 200; k++) {
    float p, s;
    if (fscanf(f, "%f %f", &p, &s) != 2) { return 3; }
    printf("%.9g\\n", (double)VCU_TM_Interpolate(p, s));
  }
  fclose(f);
  return 0;
}
`,
    );
    const exe = path.join(dir, process.platform === 'win32' ? 'harness.exe' : 'harness');
    execFileSync('gcc', ['-std=c99', '-O1', '-Wall', '-Werror', '-I', dir, path.join(dir, 'harness.c'), path.join(dir, 'vcu_torque_vectoring.c'), '-o', exe]);
    const lines = execFileSync(exe, { cwd: dir, encoding: 'utf8' }).trim().split(/\r?\n/);
    expect(lines).toHaveLength(N + 200);

    // TypeScript reference with the exact emitted (rounded) calibration constants
    const p = { ...bundle.tvParams };
    const state = tvInitialState();
    let maxErr = 0;
    for (let k = 0; k < N; k++) {
      const [vx, steer, yawRate, torqueRequest] = inputs[k];
      const ts = tvStep(p, state, { vx, steer, yawRate, torqueRequest });
      const [rl, rr, mz] = lines[k].split(' ').map(Number);
      maxErr = Math.max(maxErr, Math.abs(rl - ts.torqueRL), Math.abs(rr - ts.torqueRR), Math.abs(mz - ts.mz) / 50);
    }
    expect(maxErr).toBeLessThan(0.02); // Nm — float32 vs float64 arithmetic
    for (let k = 0; k < 200; k++) {
      const c = Number(lines[N + k]);
      expect(Math.abs(c - torqueMapLookup(tm, queries[k][0], queries[k][1]))).toBeLessThan(2e-3);
    }
  });
});
