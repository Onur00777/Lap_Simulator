export interface TireTemperatures {
  coreC: number;
  surfaceC: number;
}

export interface TireThermalParams {
  coreCapacityJPerK: number;
  surfaceCapacityJPerK: number;
  coreSurfaceConductanceWPerK: number;
  coreCoolingWPerK: number;
  surfaceCoolingWPerK: number;
  speedCoolingWPerKPerMps: number;
  slipHeatFraction: number;
}

export interface TireThermalInput {
  ambientC: number;
  speedMps: number;
  slipPowerW: number;
}
