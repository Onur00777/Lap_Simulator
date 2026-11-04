'use client';

import type { ReactNode } from 'react';

export function Panel({
  title,
  right,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel flex min-w-0 flex-col ${className}`}>
      <header className="panel-title">
        <span className="h-1.5 w-1.5 rounded-full bg-hud-cyan shadow-[0_0_8px_#22d3ee]" />
        <span className="flex-1 truncate">{title}</span>
        {right}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  unit,
  sub,
  accent = 'text-hud-text',
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="panel px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-hud-dim">{label}</div>
      <div className={`kpi-value ${accent}`}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-hud-dim">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-hud-dim">{sub}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn ${o.value === value ? 'btn-active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
      <thead>
        <tr className="text-hud-dim">
          {head.map((h) => (
            <th key={h} className="border-b border-hud-line px-2 py-1 text-right font-normal first:text-left">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-hud-panel2">
            {r.map((c, j) => (
              <td key={j} className="border-b border-hud-line/50 px-2 py-0.5 text-right first:text-left">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Compact numeric axis ticks (avoids raw floating-point dataMax labels). */
export const tickFmt = (v: number) => {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return (+v.toFixed(1)).toString();
  return (+v.toFixed(2)).toString();
};

export const tooltipStyle = {
  contentStyle: {
    background: 'rgba(5,7,11,0.92)',
    border: '1px solid #1b2633',
    borderRadius: 4,
    fontFamily: 'Consolas, ui-monospace, monospace',
    fontSize: 11,
  },
  labelStyle: { color: '#5c6b7d' },
  itemStyle: { padding: 0 },
};
