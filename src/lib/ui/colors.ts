import type { SegmentMode } from '../solver/lap-simulator';

/** Google "Turbo" colormap, polynomial approximation. x in [0, 1]. */
export function turbo(x: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, x));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  const c = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)));
  return [c(r), c(g), c(b)];
}

export const rgb = ([r, g, b]: [number, number, number], a = 1) => `rgba(${r},${g},${b},${a})`;

export const MODE_COLORS: Record<SegmentMode, string> = {
  brake: '#3b82f6',
  'full-throttle': '#22c55e',
  'part-throttle': '#f59e0b',
  cornering: '#ef4444',
  coast: '#64748b',
};

export const MODE_LABELS: Record<SegmentMode, string> = {
  brake: 'Braking',
  'full-throttle': 'Full throttle',
  'part-throttle': 'Part throttle',
  cornering: 'Lateral-G limit',
  coast: 'Coast',
};

export const CHART = {
  grid: '#1b2633',
  axis: '#5c6b7d',
  cyan: '#22d3ee',
  lime: '#a3e635',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
  violet: '#a78bfa',
  slate: '#94a3b8',
};
