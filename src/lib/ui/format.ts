export const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec.toFixed(3)} s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export const kph = (mps: number) => mps * 3.6;

/** Index stride so that a channel of length n is reduced to at most `max` samples. */
export const strideFor = (n: number, max: number) => Math.max(1, Math.ceil(n / max));

export function downloadText(name: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
