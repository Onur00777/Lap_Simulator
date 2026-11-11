export interface DbcSignal {
  name: string;
  startBit: number;
  length: number;
  byteOrder: 'intel' | 'motorola';
  signed: boolean;
  scale: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  receivers: readonly string[];
}

export interface DbcMessage {
  id: number;
  name: string;
  length: number;
  transmitter: string;
  cycleMs: number;
  signals: readonly DbcSignal[];
  comment?: string;
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quoted = (value: string) => `"${value.replace(/[^\x20-\x7E]|["\\]/g, ' ')}"`;
const validName = (name: string) => identifier.test(name) && name.length <= 32;

/** Serialize a classical CAN matrix, rejecting ambiguous IDs or overlapping signal bits. */
export function generateDbc(messages: readonly DbcMessage[]): string {
  const nodes = new Set<string>();
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const message of messages) {
    if (!Number.isInteger(message.id) || message.id < 0 || message.id > 0x7ff || ids.has(message.id)) throw new Error(`Invalid or duplicate CAN identifier ${message.id}.`);
    if (!validName(message.name) || !validName(message.transmitter) || names.has(message.name)
      || !Number.isInteger(message.length) || message.length < 1 || message.length > 8
      || !Number.isInteger(message.cycleMs) || message.cycleMs < 0 || message.cycleMs > 65535) throw new Error(`Invalid DBC message ${message.name}.`);
    ids.add(message.id);
    names.add(message.name);
    nodes.add(message.transmitter);
    const occupied = new Set<number>();
    const signalNames = new Set<string>();
    for (const signal of message.signals) {
      if (!validName(signal.name) || signalNames.has(signal.name) || !Number.isInteger(signal.startBit) || !Number.isInteger(signal.length)
        || signal.length < 1 || signal.length > 64 || !signal.receivers.every(validName)
        || ![signal.scale, signal.offset, signal.min, signal.max].every(Number.isFinite) || signal.scale === 0 || signal.min > signal.max
        || (signal.byteOrder !== 'intel' && signal.byteOrder !== 'motorola')) throw new Error(`Invalid DBC signal ${message.name}.${signal.name}.`);
      signalNames.add(signal.name);
      signal.receivers.forEach((node) => nodes.add(node));
      let bit = signal.startBit;
      for (let i = 0; i < signal.length; i++) {
        if (bit < 0 || bit >= message.length * 8 || occupied.has(bit)) throw new Error(`Overlapping or out-of-frame signal ${message.name}.${signal.name}.`);
        occupied.add(bit);
        bit = signal.byteOrder === 'intel' ? bit + 1 : bit % 8 === 0 ? bit + 15 : bit - 1;
      }
    }
  }
  const lines = [
    'VERSION "ApexLapSim VCU bus 1.0"', '', 'NS_ :', '    CM_', '    BA_DEF_', '    BA_', '    BA_DEF_DEF_', '', 'BS_:',
    '', `BU_: ${[...nodes].join(' ')}`, '',
  ];
  for (const message of messages) {
    lines.push(`BO_ ${message.id} ${message.name}: ${message.length} ${message.transmitter}`);
    for (const signal of message.signals) {
      const order = signal.byteOrder === 'intel' ? 1 : 0;
      const sign = signal.signed ? '-' : '+';
      const receivers = signal.receivers.join(',') || 'Vector__XXX';
      lines.push(` SG_ ${signal.name} : ${signal.startBit}|${signal.length}@${order}${sign} (${signal.scale},${signal.offset}) [${signal.min}|${signal.max}] ${quoted(signal.unit)} ${receivers}`);
    }
    lines.push('');
  }
  for (const message of messages) if (message.comment) lines.push(`CM_ BO_ ${message.id} ${quoted(message.comment)};`);
  lines.push('', 'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;', 'BA_DEF_DEF_ "GenMsgCycleTime" 0;');
  for (const message of messages) lines.push(`BA_ "GenMsgCycleTime" BO_ ${message.id} ${message.cycleMs};`);
  return lines.join('\r\n') + '\r\n';
}

const signal = (
  name: string, startBit: number, length: number, unit = '', scale = 1, signed = false, receivers: readonly string[] = ['VCU', 'Logger'],
  max = +(((signed ? 2 ** (length - 1) : 2 ** length) - 1) * scale).toPrecision(12),
): DbcSignal => ({ name, startBit, length, byteOrder: 'intel', signed, scale, offset: 0,
  min: signed ? +(-(2 ** (length - 1)) * scale).toPrecision(12) : 0, max, unit, receivers });

const vendor = (id: number, name: string, cycleMs: number, signals: DbcSignal[], extra = ''): DbcMessage => ({
  id, name, cycleMs, signals, length: 8, transmitter: 'Cascadia',
  comment: `Cascadia Motion software manual 0A-0163-02, default CAN offset. Cycle configured on the inverter. ${extra}`.trim(),
});

const apex = (id: number, name: string, transmitter: string, cycleMs: number, signals: DbcSignal[]): DbcMessage => ({
  id, name, transmitter, cycleMs, signals, length: 8, comment: 'ApexLapSim SIL application frame. Confirm the assigned layout against the vehicle network before ECU integration.',
});

export const APEX_VCU_CAN_MATRIX: readonly DbcMessage[] = [
  vendor(0xa0, 'Cascadia_IGBT_Temperatures', 100, [
    signal('IGBT_Module_A', 0, 16, 'degC', 0.1, true), signal('IGBT_Module_B', 16, 16, 'degC', 0.1, true),
    signal('IGBT_Module_C', 32, 16, 'degC', 0.1, true), signal('GateDriverBoard', 48, 16, 'degC', 0.1, true),
  ]),
  vendor(0xa2, 'Cascadia_Motor_Temperatures', 100, [
    signal('CoolantTemp', 0, 16, 'degC', 0.1, true), signal('InverterHotSpot', 16, 16, 'degC', 0.1, true), signal('MotorTemp', 32, 16, 'degC', 0.1, true),
  ]),
  vendor(0xa5, 'Cascadia_Motor_Position', 10, [
    signal('ElectricalAngle', 0, 16, 'deg', 0.1, true), signal('MotorRPM', 16, 16, 'rpm', 1, true),
    signal('OutputFrequency', 32, 16, 'Hz', 0.1, true), signal('ResolverDelta', 48, 16, 'deg', 0.1, true),
  ]),
  vendor(0xa6, 'Cascadia_Current', 10, [
    signal('PhaseACurrent', 0, 16, 'A', 0.1, true), signal('PhaseBCurrent', 16, 16, 'A', 0.1, true),
    signal('PhaseCCurrent', 32, 16, 'A', 0.1, true), signal('DCBusCurrent', 48, 16, 'A', 0.1, true),
  ]),
  vendor(0xa7, 'Cascadia_Voltage', 10, [
    signal('DCBusVoltage', 0, 16, 'V', 0.1, true), signal('OutputVoltage', 16, 16, 'V', 0.1, true),
    signal('VabVdVoltage', 32, 16, 'V', 0.1, true), signal('VbcVqVoltage', 48, 16, 'V', 0.1, true),
  ]),
  vendor(0xaa, 'Cascadia_Internal_States', 10, [
    signal('VsmState', 0, 8), signal('PwmFrequency', 8, 8, 'kHz'), signal('InverterState', 16, 8),
    signal('RelayStateMask', 24, 8), signal('ExpectedRollingCounter', 44, 4), signal('InverterEnabled', 48, 1),
    signal('BmsMessageActive', 57, 1), signal('BmsTorqueLimitActive', 58, 1),
  ]),
  vendor(0xab, 'Cascadia_Fault_Codes', 10, [
    signal('PostFaultLow', 0, 16), signal('PostFaultHigh', 16, 16), signal('RunFaultLow', 32, 16), signal('RunFaultHigh', 48, 16),
  ]),
  vendor(0xac, 'Cascadia_Torque_And_Timer', 10, [
    signal('CommandedTorque', 0, 16, 'Nm', 0.1, true), signal('TorqueFeedback', 16, 16, 'Nm', 0.1, true), signal('PowerOnTime', 32, 32, 'ms', 3),
  ]),
  {
    id: 0xc0, name: 'Cascadia_Command', length: 8, cycleMs: 10, transmitter: 'VCU',
    comment: 'Cascadia manual 0A-0163-02 tables 28 and 35. Verify optional counter and torque-limit support on installed firmware.',
    signals: [
      signal('TorqueCommand', 0, 16, 'Nm', 0.1, true, ['Cascadia', 'Logger']),
      signal('SpeedCommand', 16, 16, 'rpm', 1, true, ['Cascadia', 'Logger']),
      signal('DirectionForward', 32, 8, '', 1, false, ['Cascadia', 'Logger'], 1),
      signal('InverterEnable', 40, 1, '', 1, false, ['Cascadia', 'Logger']),
      signal('DischargeEnable', 41, 1, '', 1, false, ['Cascadia', 'Logger']),
      signal('SpeedModeEnable', 42, 1, '', 1, false, ['Cascadia', 'Logger']),
      signal('RollingCounter', 44, 4, '', 1, false, ['Cascadia', 'Logger']),
      signal('CommandTorqueLimit', 48, 16, 'Nm', 0.1, true, ['Cascadia', 'Logger']),
    ],
  },
  apex(0x181, 'IMU_Accel_Yaw', 'IMU', 3, [
    signal('AccelX', 0, 16, 'm/s2', 0.01, true), signal('AccelY', 16, 16, 'm/s2', 0.01, true),
    signal('YawRate', 32, 16, 'deg/s', 0.01, true), signal('Status', 48, 8),
  ]),
  apex(0x201, 'WSS_4Corner_Speed', 'WSS', 5, ['FL', 'FR', 'RL', 'RR'].map((corner, i) => signal(`WheelSpeed_${corner}`, i * 16, 16, 'km/h', 0.01, true))),
  {
    id: 0x202, name: 'BMS_Orion_Current_Limits', length: 8, transmitter: 'BMS', cycleMs: 100,
    comment: 'Cascadia manual 0A-0163-02 section 8.10. Enable and configure Orion compatibility on the installed inverter and BMS.',
    signals: [signal('MaxDischargeCurrent', 0, 16, 'A', 1, true, ['Cascadia', 'VCU', 'Logger']), signal('MaxChargeCurrent', 16, 16, 'A', 1, true, ['Cascadia', 'VCU', 'Logger'])],
  },
  apex(0x210, 'PedalBox_APPS_BPS', 'PedalBox', 2, [
    signal('APPS1', 0, 8, '%', 1, false, ['VCU', 'Logger'], 100), signal('APPS2', 8, 8, '%', 1, false, ['VCU', 'Logger'], 100),
    signal('BrakePressure', 16, 8, 'bar'),
  ]),
  apex(0x211, 'Apex_VCU_Safety_Status', 'VCU', 10, [
    signal('SafetyMode', 0, 8, '', 1, false, ['Logger'], 3), signal('InverterAuthorization', 8, 1, '', 1, false, ['Logger']),
    signal('WatchdogService', 9, 1, '', 1, false, ['Logger']), signal('FaultMask', 16, 32, '', 1, false, ['Logger']),
  ]),
  apex(0x212, 'Apex_VCU_Torque', 'VCU', 10, [
    signal('TorqueRL', 0, 16, 'Nm', 0.1, true, ['Logger']), signal('TorqueRR', 16, 16, 'Nm', 0.1, true, ['Logger']),
    signal('TorqueCeiling', 32, 16, 'Nm', 0.1, false, ['Logger']), signal('VehicleSpeed', 48, 16, 'm/s', 0.01, false, ['Logger']),
  ]),
  apex(0x221, 'Apex_BMS_Pack', 'BMS', 20, [
    signal('PackVoltage', 0, 16, 'V', 0.1), signal('PackCurrent', 16, 16, 'A', 0.1, true),
    signal('MinDischargeVoltage', 32, 16, 'V', 0.1), signal('MaxChargeVoltage', 48, 16, 'V', 0.1),
  ]),
];

export function generateApexVcuDbc(): string {
  return generateDbc(APEX_VCU_CAN_MATRIX);
}
