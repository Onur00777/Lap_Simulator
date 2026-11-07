'use client';

import { useState, type ReactNode } from 'react';

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
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/80" />
        <span className="flex-1 truncate">{title}</span>
        {right}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function DisclosureGroup({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-white/[0.06] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left transition hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`h-3.5 w-3.5 text-slate-400 transition-transform duration-200 ${open ? 'rotate-90 text-cyan-400' : ''}`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
              clipRule="evenodd"
            />
          </svg>
          <span className="text-[10px] font-medium uppercase tracking-wider text-slate-300">{title}</span>
        </div>
        {badge && <span className="font-mono text-[10px] tabular-nums text-slate-500">{badge}</span>}
      </button>
      {open && <div className="px-3.5 pb-3 pt-0.5">{children}</div>}
    </div>
  );
}

export function DeltaBadge({
  delta,
  unit = '',
  digits = 2,
  invertGood = false,
  prefix = '',
}: {
  delta: number;
  unit?: string;
  digits?: number;
  /** Default false = negative delta is good (green), e.g. lap time, energy, heat. True = positive delta is good (speed, G). */
  invertGood?: boolean;
  prefix?: string;
}) {
  const eps = Math.pow(10, -digits) * 0.5;
  if (Math.abs(delta) < eps) {
    return (
      <span className="inline-flex items-center rounded-md border border-white/[0.07] bg-slate-900/80 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-400">
        {prefix}+0.{''.padEnd(digits, '0')}
        {unit ? `${unit}` : ''}
      </span>
    );
  }
  const isGood = invertGood ? delta > 0 : delta < 0;
  const sign = delta > 0 ? '+' : '−';
  const cls = isGood
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
    : 'border-rose-500/30 bg-rose-500/10 text-rose-400';
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums ${cls}`}>
      {prefix}
      {sign}
      {Math.abs(delta).toFixed(digits)}
      {unit ? `${unit}` : ''}
    </span>
  );
}

export function Kpi({
  label,
  value,
  unit,
  sub,
  delta,
  accent = 'text-slate-100',
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: ReactNode;
  delta?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#11141d]/75 px-3.5 py-2.5 backdrop-blur-md">
      <div className="flex items-center justify-between gap-1.5">
        <div className="truncate text-[10px] font-medium uppercase tracking-wider text-slate-400">{label}</div>
        {delta}
      </div>
      <div className={`mt-0.5 font-mono text-xl font-semibold tabular-nums tracking-tight ${accent}`}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-slate-400">{unit}</span>}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] tabular-nums text-slate-400">{sub}</div>}
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
    <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-white/[0.07] bg-[#090a0f]/80 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            className={`rounded-md px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition ${
              active
                ? 'bg-slate-800/95 text-cyan-300 shadow-sm border border-white/[0.08]'
                : 'border border-transparent text-slate-400 hover:text-slate-200'
            }`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
      <thead>
        <tr className="text-[10px] uppercase tracking-wider text-slate-400">
          {head.map((h) => (
            <th key={h} className="border-b border-white/[0.07] px-2.5 py-1.5 text-right font-medium first:text-left">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="transition hover:bg-white/[0.025]">
            {r.map((c, j) => (
              <td key={j} className="border-b border-white/[0.04] px-2.5 py-1 text-right text-slate-200 first:text-left">
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
    background: 'rgba(17, 20, 29, 0.95)',
    border: '1px solid rgba(255, 255, 255, 0.09)',
    borderRadius: 8,
    fontFamily: 'Consolas, ui-monospace, monospace',
    fontSize: 11,
  },
  labelStyle: { color: '#94a3b8' },
  itemStyle: { padding: 0 },
};
