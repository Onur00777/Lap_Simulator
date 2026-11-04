'use client';

import { KORFEZ_FACILITY } from '@/lib/tracks';
import { formatMs, type KorfezLayoutReport } from '@/lib/solver/korfez-analysis';
import { fmt } from '@/lib/ui/format';
import { DataTable, Kpi } from '../ui';

export function KorfezFacilityBar() {
  const f = KORFEZ_FACILITY;
  const chips = [
    '250.000 m² alan',
    '1.950 km ana pist',
    '950 m karting',
    '9 viraj (4 sağ, 5 sol)',
    '10–12 m genişlik',
    '%1 maks. eğim',
    '22 pit garajı',
    '0.001 s hassasiyet',
    'saat yönü',
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-hud-line bg-hud-panel/80 px-4 py-1.5">
      <span className="mr-1 font-mono text-[11px] font-semibold tracking-wider text-hud-cyan">KOCAELİ — TOSFED KÖRFEZ</span>
      {chips.map((c) => (
        <span key={c} className="rounded border border-hud-line px-1.5 py-0.5 font-mono text-[10px] text-hud-dim">
          {c}
        </span>
      ))}
      <span className="font-mono text-[10px] text-hud-dim">referans {f.benchmarkKph.touring}+ km/h touring · ~{f.benchmarkKph.formulaStudent} km/h FS</span>
    </div>
  );
}

export default function KorfezPanel({
  report,
  comparison,
  onSelect,
}: {
  report: KorfezLayoutReport | null;
  comparison: KorfezLayoutReport[] | null;
  onSelect: (index: number) => void;
}) {
  if (!report) return <div className="p-6 font-mono text-xs text-hud-dim">Körfez turu hesaplanıyor…</div>;
  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Tur zamanı (0.001 s)" value={formatMs(report.lapTimeS)} unit="s" accent="text-hud-cyan" />
        <Kpi label="Sektör 1" value={formatMs(report.sectors[0]?.timeS ?? NaN)} unit="s" />
        <Kpi label="Sektör 2" value={formatMs(report.sectors[1]?.timeS ?? NaN)} unit="s" />
        <Kpi label="Sektör 3" value={formatMs(report.sectors[2]?.timeS ?? NaN)} unit="s" />
        <Kpi label="TV tur farkı" value={`${report.tvDeltaS <= 0 ? '' : '+'}${(report.tvDeltaS * 1000).toFixed(0)}`} unit="ms" accent={report.tvDeltaS <= 0 ? 'text-hud-lime' : 'text-hud-red'} sub="açık diferansiyel − TV" />
        <Kpi label="22 km dayanıklılık" value={fmt(report.enduranceKWh, 2)} unit="kWh" sub={`${fmt(report.coolingKJ, 0)} kJ soğutma / tur`} />
      </div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-hud-dim">
        {report.label} — {report.rights} sağ / {report.lefts} sol (çizimden okunan yarış çizgisi) · tesis kaydı 4 sağ / 5 sol · eğim maks. %{(report.maxGrade * 100).toFixed(1)}
      </div>
      <div className="max-h-[320px] overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-hud-panel text-hud-dim">
            <tr>
              {['Viraj', 'Yön', 'R apeks', 'Giriş', 'Min', 'Çıkış km/h', 'Lat G', 'Fren m', 'Rejen Wh', 'TV ms'].map((h) => (
                <th key={h} className="border-b border-hud-line px-2 py-1 text-right font-normal first:text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.corners.map((c, i) => (
              <tr key={c.id} className="cursor-pointer hover:bg-hud-panel2" onClick={() => onSelect(i)}>
                <td className="px-2 py-0.5 text-hud-cyan">{c.id}</td>
                <td className={`px-2 text-right ${c.direction === 'Sol' ? 'text-hud-cyan' : 'text-hud-amber'}`}>{c.direction}</td>
                <td className="px-2 text-right">{fmt(c.apexRadiusM, 1)}</td>
                <td className="px-2 text-right">{fmt(c.entryKph, 1)}</td>
                <td className="px-2 text-right">{fmt(c.minKph, 1)}</td>
                <td className="px-2 text-right">{fmt(c.exitKph, 1)}</td>
                <td className="px-2 text-right">{fmt(c.peakLatG, 2)}</td>
                <td className="px-2 text-right">{fmt(c.brakingDistanceM, 0)}</td>
                <td className="px-2 text-right">{fmt(c.regenWh, 1)}</td>
                <td className={`px-2 text-right ${c.tvGainMs >= 0 ? 'text-hud-lime' : 'text-hud-red'}`}>{c.tvGainMs.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comparison && (
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">3 pist karşılaştırma</div>
          <DataTable
            head={['Pist', 'Tur', 'Ort.', 'Maks. km/h', 'Wh/tur', '22 km kWh', 'Isı kJ', 'TV ms']}
            rows={comparison.map((r) => [
              r.label,
              formatMs(r.lapTimeS),
              fmt(r.avgKph, 1),
              fmt(r.maxKph, 1),
              fmt(r.energyWh, 0),
              fmt(r.enduranceKWh, 2),
              fmt(r.coolingKJ, 0),
              (r.tvDeltaS * 1000).toFixed(0),
            ])}
          />
        </div>
      )}
    </div>
  );
}
