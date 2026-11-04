import {
  DEFAULT_POWERTRAIN,
  DEFAULT_VEHICLE,
  buildEfficiencyMap,
  peakWheelTorque,
  pointMassLateralLimit,
  GRAVITY,
} from '@/lib/physics';

export default function Home() {
  const v = DEFAULT_VEHICLE;
  const pt = DEFAULT_POWERTRAIN;
  const map = buildEfficiencyMap(pt);
  const rows: [string, string][] = [
    ['Mass', `${v.mass} kg`],
    ['Weight distribution F:R', `${Math.round(v.frontWeightFraction * 100)}:${Math.round((1 - v.frontWeightFraction) * 100)}`],
    ['Wheelbase / Track', `${v.wheelbase * 1000} / ${v.trackWidth * 1000} mm`],
    ['CG height', `${v.cgHeight * 1000} mm`],
    ['ClA / CdA', `${v.ClA} / ${v.CdA} m²`],
    ['Peak wheel torque', `${peakWheelTorque(pt)} Nm`],
    ['Peak motor+inverter efficiency', `${(Math.max(...map.eta.flat()) * 100).toFixed(1)} %`],
    ['Lateral limit @ 15 m/s', `${(pointMassLateralLimit(v, 15) / GRAVITY).toFixed(2)} g`],
  ];
  return (
    <main className="mx-auto max-w-xl p-8 font-mono text-sm">
      <h1 className="mb-4 text-lg text-hud-cyan">ApexLapSim — parameter registry</h1>
      <table className="w-full">
        <tbody>
          {rows.map(([k, val]) => (
            <tr key={k} className="border-b border-hud-line">
              <td className="py-1 text-hud-dim">{k}</td>
              <td className="py-1 text-right">{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
