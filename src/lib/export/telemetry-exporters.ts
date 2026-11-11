import type { HavuzExtractedCircuit } from '../ist26-havuz/havuz-track-extractor';
import type { Ist26SimulationResult } from '../ist26-havuz/ist26-rwd-solver';
import { interp1 } from '../physics/numerics';
import { GRAVITY } from '../physics/vehicle';

function csvCell(value: string | number) {
  return typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : `"${value.replace(/"/g, '""')}"`;
}

/** MoTeC i2-style CSV export with explicit units and uniform time samples. */
export function exportMotecTelemetry(sim: Ist26SimulationResult, sampleRateHz = 20): string {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < 1 || sampleRateHz > 1000) throw new RangeError('Use a sample rate from 1 to 1000 Hz.');
  const points = sim.points;
  const time = [0];
  for (let i = 1; i < points.length; i++) {
    const ds = Math.max(0, points[i].s - points[i - 1].s);
    time.push(time[i - 1] + ds / Math.max(0.5, (points[i - 1].vxReal + points[i].vxReal) / 2));
  }
  const duration = time[time.length - 1];
  const channels = [
    ['Distance', 'm', points.map((p) => p.s)],
    ['Ground Speed', 'km/h', points.map((p) => p.vxReal * 3.6)],
    ['G Force Long', 'G', points.map((p) => p.axReal / GRAVITY)],
    ['G Force Lat', 'G', points.map((p) => p.ayReal / GRAVITY)],
    ['Yaw Rate', 'deg/s', points.map((p) => p.yawRateReal * 180 / Math.PI)],
    ['Engine RPM', 'rpm', points.map((p) => p.motorRpmReal)],
    ['Motor Torque', 'Nm', points.map((p) => p.torqueRealNm)],
    ['DC Bus Current', 'A', points.map((p) => p.dcCurrRealA)],
    ['Sim Ground Speed', 'km/h', points.map((p) => p.vxSim * 3.6)],
    ['Sim G Force Long', 'G', points.map((p) => p.axSim / GRAVITY)],
    ['Sim G Force Lat', 'G', points.map((p) => p.aySim / GRAVITY)],
  ] as const;
  const rows: (string | number)[][] = [
    ['Format', 'MoTeC CSV File'], ['Venue', 'İTÜ Havuz'], ['Vehicle', sim.vehicleLabel], ['Comment', `${sim.logId} · time reconstructed from speed and distance`],
    ['Sample Rate', sampleRateHz], ['Start Time', 0], ['End Time', Math.floor(duration * sampleRateHz) / sampleRateHz], [],
    ['Time', ...channels.map(([name]) => name)], ['s', ...channels.map(([, unit]) => unit)], [],
  ];
  if (points.length > 0) for (let i = 0; i <= Math.floor(duration * sampleRateHz); i++) {
    const t = i / sampleRateHz;
    rows.push([+t.toFixed(6), ...channels.map(([, , values]) => +interp1(time, values, t).toFixed(6))]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

interface GeographicAnchor {
  latitude: number;
  longitude: number;
  /** Counterclockwise rotation of local +x from east. */
  rotationDeg: number;
}

const paths = (track: HavuzExtractedCircuit) => [
  { role: 'centerline', stroke: '#0891b2', points: track.nodes.map((node) => [node.x, node.y] as const) },
  { role: 'leftBoundary', stroke: '#2563eb', points: track.nodes.map((node) => [node.leftConeX, node.leftConeY] as const) },
  { role: 'rightBoundary', stroke: '#d97706', points: track.nodes.map((node) => [node.rightConeX, node.rightConeY] as const) },
];

export function exportTrackGeoJson(track: HavuzExtractedCircuit, anchor: GeographicAnchor): string {
  const radiusM = 6378137;
  const theta = anchor.rotationDeg * Math.PI / 180;
  const metersToDegrees = 180 / (Math.PI * radiusM);
  const geo = ([x, y]: readonly [number, number]) => {
    const east = x * Math.cos(theta) - y * Math.sin(theta);
    const north = x * Math.sin(theta) + y * Math.cos(theta);
    return [anchor.longitude + east * metersToDegrees / Math.cos(anchor.latitude * Math.PI / 180), anchor.latitude + north * metersToDegrees];
  };
  const lines = paths(track).filter(({ points }) => points.length >= 2).map(({ role, points }) => ({
    type: 'Feature', properties: { role, name: track.name, lengthM: track.totalLengthM, approximateGeoreferencing: true },
    geometry: { type: 'LineString', coordinates: [...points, points[0]].map(geo) },
  }));
  const gates = track.sectors.map(({ s, x, y }, i) => ({
    type: 'Feature', properties: { role: 'sectorGate', sector: i + 1, distanceM: s }, geometry: { type: 'Point', coordinates: geo([x, y]) },
  }));
  const corners = track.corners.map(({ index, apexIndex, sApex, direction }) => ({
    type: 'Feature', properties: { role: 'cornerApex', corner: index, distanceM: sApex, direction },
    geometry: { type: 'Point', coordinates: geo([track.nodes[apexIndex].x, track.nodes[apexIndex].y]) },
  }));
  return JSON.stringify({ type: 'FeatureCollection', features: [...lines, ...gates, ...corners] });
}

export function exportTrackSvg(track: HavuzExtractedCircuit): string {
  const geometry = paths(track);
  const points = geometry.flatMap((path) => path.points);
  if (points.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
  const x = points.map(([x]) => x), y = points.map(([, y]) => -y);
  const minX = Math.min(...x), minY = Math.min(...y);
  const bounds = `${minX - 2} ${minY - 2} ${Math.max(...x) - minX + 4} ${Math.max(...y) - minY + 4}`;
  const lines = geometry.map(({ role, points, stroke }) => {
    const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(3)} ${(-y).toFixed(3)}`).join(' ');
    return `<path id="${role}" d="${path} Z" fill="none" stroke="${stroke}" stroke-width="0.20"/>`;
  });
  const gates = track.sectors.map(({ x, y }, i) => `<circle id="sector-${i + 1}" cx="${x.toFixed(3)}" cy="${(-y).toFixed(3)}" r="0.6" fill="#b45309"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds}">${[...lines, ...gates].join('')}</svg>\n`;
}
