import {
  buildEfficiencyMap,
  buildPointMassEnvelope,
  buildPowertrainCurve,
  envelopeAyMax,
  interpUniform,
  steadyStateLateralLimit,
  type EfficiencyMap,
  type LateralEnvelope,
  type PowertrainCurve,
  type PowertrainParams,
  type VehicleParams,
} from '../physics';

/** Everything the solvers need, pre-tabulated once per vehicle configuration. */
export interface SimulationContext {
  veh: VehicleParams;
  pt: PowertrainParams;
  map: EfficiencyMap;
  curve: PowertrainCurve;
  env: LateralEnvelope;
  /** Steady-state (drag-compensated) lateral limit tabulated on the envelope grid. */
  aySteady: number[];
  vCap: number;
}

export function createContext(veh: VehicleParams, pt: PowertrainParams, env?: LateralEnvelope): SimulationContext {
  const map = buildEfficiencyMap(pt);
  const curve = buildPowertrainCurve(veh, pt, map);
  const vCap = curve.vMax * 0.999;
  const envelope = env ?? buildPointMassEnvelope(veh, curve.vMax + 2);
  const aySteady = envelope.ayMax.map((ay, i) => steadyStateLateralLimit(veh, ay, envelope.v0 + i * envelope.dv));
  return { veh, pt, map, curve, env: envelope, aySteady, vCap };
}

export function ctxAyMax(ctx: SimulationContext, v: number): number {
  return envelopeAyMax(ctx.env, v);
}

export function ctxAySteady(ctx: SimulationContext, v: number): number {
  return interpUniform(ctx.env.v0, ctx.env.dv, ctx.aySteady, v);
}
