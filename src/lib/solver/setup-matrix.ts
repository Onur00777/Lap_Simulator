import { buildTwoTrackEnvelope } from '../dynamics/two-track';
import { speedFromMotorRpm, type LateralModel, type PowertrainParams, type VehicleParams } from '../physics';
import { sampleLapDistance } from '../telemetry/distance';
import type { Track } from '../tracks/types';
import { createContext } from './context';
import { simulateLap, type Integrator, type LapResult } from './lap-simulator';
import { getTrackWithRacingLine, type RacingLineMode } from './racing-line';

export interface VehicleSetup {
  name: string;
  veh: VehicleParams;
  pt: PowertrainParams;
  model: LateralModel;
  integrator: Integrator;
  racingLineMode: RacingLineMode;
}

export interface SetupSectorMetrics {
  index: number;
  timeS: number;
  apexSpeedKph: number | null;
}

export interface SetupMetrics {
  lapTimeS: number;
  netEnergyKWh: number;
  understeerDegPerG: number;
  sectors: SetupSectorMetrics[];
}

export interface SetupComparison {
  id: 'A' | 'B' | 'C';
  name: string;
  metrics: SetupMetrics;
  deltaToActive: SetupMetrics;
  paretoOptimal: boolean;
}

export function solveVehicleSetup(track: Track, config: VehicleSetup) {
  const { veh, pt, model, integrator, racingLineMode } = config;
  const line = getTrackWithRacingLine(track, racingLineMode);
  const top = speedFromMotorRpm(veh, pt.motorMaxRpm, pt.gearRatio) + 2;
  const envelope = model === 'point-mass' ? undefined : buildTwoTrackEnvelope(veh, pt, top, model === 'two-track-tv' ? 'tv' : 'open');
  return simulateLap(line, createContext(veh, pt, envelope), { integrator });
}

export function compareVehicleSetups(
  track: Track,
  setups: readonly [VehicleSetup, VehicleSetup, VehicleSetup],
  solved: Partial<Record<SetupComparison['id'], LapResult>> = {},
): SetupComparison[] {
  const ids = ['A', 'B', 'C'] as const;
  const gates = track.sectors.length > 1 ? track.sectors : [0, track.length];
  const apexProgress = gates.slice(1).map((gate, i) => {
    let apex = -1;
    let curvature = 1e-5;
    for (let j = 0; j < track.s.length && track.s[j] < gate; j++) {
      if (track.s[j] >= gates[i] && Math.abs(track.kappa[j]) > curvature) {
        apex = j;
        curvature = Math.abs(track.kappa[j]);
      }
    }
    return apex >= 0 ? track.s[apex] / track.length : null;
  });
  const metrics = setups.map((setup, i): SetupMetrics => {
    const lap = solved[ids[i]] ?? solveVehicleSetup(track, setup);
    return {
      lapTimeS: lap.lapTime,
      netEnergyKWh: lap.energy.netKWh,
      understeerDegPerG: lap.cornerUndersteerDegPerG,
      sectors: apexProgress.map((apex, sector) => {
        const atTime = (gate: number) => sampleLapDistance(lap, lap.channels.t, gate / track.length * lap.distance, lap.lapTime);
        return {
          index: sector + 1,
          timeS: atTime(gates[sector + 1]) - atTime(gates[sector]),
          apexSpeedKph: apex == null ? null : sampleLapDistance(lap, lap.channels.v, apex * lap.distance, lap.channels.v[0]) * 3.6,
        };
      }),
    };
  });
  const active = metrics[0];
  return metrics.map((entry, i) => ({
    id: ids[i], name: setups[i].name, metrics: entry,
    paretoOptimal: !metrics.some((other) => other.lapTimeS <= entry.lapTimeS && other.netEnergyKWh <= entry.netEnergyKWh
      && (other.lapTimeS < entry.lapTimeS || other.netEnergyKWh < entry.netEnergyKWh)),
    deltaToActive: {
      lapTimeS: entry.lapTimeS - active.lapTimeS,
      netEnergyKWh: entry.netEnergyKWh - active.netEnergyKWh,
      understeerDegPerG: entry.understeerDegPerG - active.understeerDegPerG,
      sectors: entry.sectors.map((sector, j) => ({
        index: sector.index,
        timeS: sector.timeS - active.sectors[j].timeS,
        apexSpeedKph: sector.apexSpeedKph != null && active.sectors[j].apexSpeedKph != null
          ? sector.apexSpeedKph - active.sectors[j].apexSpeedKph! : null,
      })),
    },
  }));
}
