import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateVcuDynamics } from '@/lib/codegen/vcu-c-generator';
import { APEX_VCU_CAN_MATRIX, generateApexVcuDbc, generateDbc } from '@/lib/codegen/dbc-generator';
import { formatCascadiaCan0x0C0Hex } from '@/lib/ist26-havuz/vcu-fault-machine';
import { DEFAULT_POWERTRAIN, DEFAULT_VEHICLE } from '@/lib/physics';
import { IST26_RWD_PRESET } from '@/lib/tracks';

const hasGcc = spawnSync('gcc', ['--version']).status === 0;
const python = process.env.APEX_DBC_PYTHON ?? 'python';
const hasCantools = spawnSync(python, ['-c', 'import cantools']).status === 0;

const harness = `#include "vcu_dynamics.h"
#include <assert.h>
#include <math.h>

static ApexVcuOutputs Step(ApexVcuState *state, ApexVcuInputs *input, uint32_t dt, bool refresh)
{
    uint32_t i;
    input->now_ms += dt;
    if (refresh)
    {
        for (i = 0U; i < APEX_VCU_MOTOR_COUNT; i++)
        {
            input->inverter_seen[i] = true;
            input->inverter_last_rx_ms[i] = input->now_ms;
        }
    }
    return ApexVcu_Step(state, input);
}

int main(void)
{
    ApexVcuState state;
    ApexVcuInputs input = {0};
    ApexVcuOutputs output;
    float previous[APEX_VCU_MOTOR_COUNT] = {0.0f};
    uint32_t i;
    uint32_t sample;
    input.now_ms = UINT32_MAX - 4U;
    input.torque_ceiling_nm = 10.0f;
    ApexVcu_Init(&state, input.now_ms);
    assert(Step(&state, &input, 10U, false).mode == APEX_VCU_INIT);
    input.precharge_complete = true;
    input.hv_interlock_closed = true;
    input.enable_request = true;
    assert(Step(&state, &input, 10U, true).mode == APEX_VCU_PRECHARGE_OK);
    assert(!Step(&state, &input, 10U, true).inverter_enable);
    input.enable_request = false;
    (void)Step(&state, &input, 10U, true);
    input.enable_request = true;
    assert(Step(&state, &input, 10U, true).inverter_enable);
    input.apps1_permille = 500U;
    input.apps2_permille = 600U;
    input.vehicle_speed_mps = 12.0f;
    input.road_steer_rad = 0.08f;
    for (sample = 0U; sample < 30U; sample++)
    {
        output = Step(&state, &input, 10U, true);
        assert(output.inverter_enable && output.faults == 0U && output.watchdog_service_permitted);
        for (i = 0U; i < APEX_VCU_MOTOR_COUNT; i++)
        {
            assert(output.torque_nm[i] >= 0.0f && output.torque_nm[i] <= 10.0f);
            assert(output.torque_nm[i] - previous[i] <= APEX_TEST_RATE_STEP + 0.001f);
            previous[i] = output.torque_nm[i];
        }
    }
#if APEX_VCU_MOTOR_COUNT == 2U
    assert(output.torque_nm[1] > output.torque_nm[0]);
    assert(output.torque_nm[0] + output.torque_nm[1] <= 10.001f);
#else
    assert(output.torque_nm[0] > 0.0f && output.torque_nm[0] <= 5.001f);
#endif
    input.apps2_permille = 601U;
    output = Step(&state, &input, 10U, true);
    assert(output.mode == APEX_VCU_SAFE_TORQUE_OFF_FAULT && !output.inverter_enable);
    assert((output.faults & APEX_VCU_FAULT_APPS) != 0U && !output.watchdog_service_permitted);
    for (i = 0U; i < APEX_VCU_MOTOR_COUNT; i++) { assert(output.torque_nm[i] == 0.0f); }
    input.reset_requested = true;
    input.enable_request = false;
    input.apps1_permille = 0U;
    input.apps2_permille = 0U;
    assert(Step(&state, &input, 10U, true).mode == APEX_VCU_SAFE_TORQUE_OFF_FAULT);
    input.precharge_complete = false;
    assert(Step(&state, &input, 10U, true).mode == APEX_VCU_INIT);

    input.reset_requested = false;
    input.precharge_complete = true;
    assert(Step(&state, &input, 10U, true).mode == APEX_VCU_PRECHARGE_OK);
    input.enable_request = true;
    assert(Step(&state, &input, 10U, true).inverter_enable);
    for (i = 0U; i < 9U; i++) { assert(Step(&state, &input, 10U, false).inverter_enable); }
    output = Step(&state, &input, 10U, false);
    assert(!output.inverter_enable && (output.faults & APEX_VCU_FAULT_INVERTER) != 0U);
    ApexVcu_Init(&state, input.now_ms);
    assert((Step(&state, &input, 50U, true).faults & APEX_VCU_FAULT_WATCHDOG) != 0U);
    ApexVcu_Init(&state, input.now_ms);
    input.yaw_rate_rad_s = NAN;
    assert((Step(&state, &input, 10U, true).faults & APEX_VCU_FAULT_INPUT) != 0U);
    return 0;
}
`;

describe('Generated VCU dynamics', () => {
  it('uses qualified C symbols, fixed-size arrays and no heap allocation', () => {
    const [header, source] = generateVcuDynamics(DEFAULT_VEHICLE, DEFAULT_POWERTRAIN);
    expect(header.name).toBe('vcu_dynamics.h');
    expect(header.content).toMatch(/#include <stdbool\.h>[\s\S]+uint32_t inverter_last_rx_ms\[APEX_VCU_MOTOR_COUNT\]/);
    expect(source.content.match(/^(?:static )?(?:void|float|ApexVcuOutputs)\s+(\w+)\(/gm)?.every((name) => name.includes(' ApexVcu_'))).toBe(true);
    expect(source.content).not.toMatch(/\b(?:malloc|calloc|realloc|free)\s*\(/);
  });

  it.skipIf(!hasGcc).each([
    { veh: DEFAULT_VEHICLE, pt: DEFAULT_POWERTRAIN },
    { veh: IST26_RWD_PRESET.vehicle, pt: IST26_RWD_PRESET.powertrain },
  ])('compiles and runs safety and torque tests for $pt.motorCount motor(s)', ({ veh, pt }) => {
    const directory = mkdtempSync(join(tmpdir(), 'apex-vcu-dynamics-'));
    try {
      for (const file of generateVcuDynamics(veh, pt)) writeFileSync(join(directory, file.name), file.content);
      writeFileSync(join(directory, 'harness.c'), harness);
      const output = join(directory, process.platform === 'win32' ? 'verify.exe' : 'verify');
      execFileSync('gcc', [
        '-std=c99', '-Wall', '-Wextra', '-Wpedantic', '-Wconversion', '-Wsign-conversion', '-Werror', '-Wstrict-prototypes',
        `-DAPEX_TEST_RATE_STEP=${(pt.motorPeakTorque * 0.04).toFixed(4)}f`, 'vcu_dynamics.c', 'harness.c', '-o', output,
      ], { cwd: directory, stdio: 'pipe' });
      execFileSync(output, { cwd: directory, stdio: 'pipe' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('CAN DBC export', () => {
  it('uses the Cascadia protocol signal positions and declares all application channels', () => {
    const dbc = generateApexVcuDbc();
    expect(dbc).toContain(' SG_ InverterEnable : 40|1@1+ (1,0)');
    expect(dbc).toContain(' SG_ DCBusCurrent : 48|16@1- (0.1,0)');
    expect(dbc).toContain(' SG_ DCBusVoltage : 0|16@1- (0.1,0)');
    expect(dbc).toContain('BA_ "GenMsgCycleTime" BO_ 192 10;');
    expect(dbc.match(/ SG_ WheelSpeed_/g)).toHaveLength(4);
    expect(dbc.match(/^BO_ /gm)).toHaveLength(APEX_VCU_CAN_MATRIX.length);
    const bytes = formatCascadiaCan0x0C0Hex(-12.3, true).split(' ');
    expect(bytes).toEqual(['85', 'FF', '00', '00', '01', '01', '00', '00']);
  });

  it('serializes Motorola signals and rejects overlaps, duplicate IDs and invalid DLCs', () => {
    const source = APEX_VCU_CAN_MATRIX[0];
    const bigEndian = { ...source.signals[0], startBit: 7, byteOrder: 'motorola' as const };
    expect(generateDbc([{ ...source, signals: [bigEndian] }])).toContain('7|16@0-');
    expect(() => generateDbc([{ ...source, signals: [bigEndian, { ...source.signals[1], startBit: 8 }] }])).toThrow(/overlapping/i);
    expect(() => generateDbc([source, source])).toThrow(/duplicate/i);
    expect(() => generateDbc([{ ...source, length: 9 }])).toThrow(/invalid/i);
  });

  it.skipIf(!hasCantools)('parses with cantools in strict mode and decodes protocol payloads', () => {
    const script = `
import sys, cantools
dbc = cantools.database.load_string(sys.stdin.read(), database_format='dbc', strict=True)
command = dbc.get_message_by_frame_id(0xc0)
assert command.cycle_time == 10
decoded = command.decode(bytes.fromhex('85 FF 00 00 01 01 00 00'))
assert abs(decoded['TorqueCommand'] + 12.3) < 0.0001
assert decoded['DirectionForward'] == decoded['InverterEnable'] == 1
assert dbc.decode_message(0xa6, bytes.fromhex('00 00 00 00 00 00 9C FF'))['DCBusCurrent'] == -10
assert dbc.decode_message(0xa7, bytes.fromhex('5C 0D 00 00 00 00 00 00'))['DCBusVoltage'] == 342
assert dbc.decode_message(0xa0, bytes.fromhex('EE 02 00 00 00 00 00 00'))['IGBT_Module_A'] == 75
assert dbc.get_message_by_frame_id(0x201).senders == ['WSS']
`;
    expect(() => execFileSync(python, ['-c', script], { input: generateApexVcuDbc() })).not.toThrow();
  });
});
