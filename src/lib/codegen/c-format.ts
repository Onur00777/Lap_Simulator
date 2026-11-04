/** Formats a number as a C single-precision literal (always with a decimal point / exponent + 'f'). */
export function cf(x: number, sig = 7): string {
  if (!Number.isFinite(x)) throw new Error(`Cannot emit non-finite constant ${x}`);
  if (Object.is(x, -0) || x === 0) return '0.0f';
  let s = Number(x.toPrecision(sig)).toString();
  if (!/[.eE]/.test(s)) s += '.0';
  return `${s}f`;
}

/** Fixed-decimal C float literal for tabular data (aligned columns). */
export function cfFixed(x: number, decimals: number, width = 0): string {
  const v = Math.abs(x) < 0.5 * Math.pow(10, -decimals) ? 0 : x;
  return `${v.toFixed(decimals)}f`.padStart(width, ' ');
}

export function cArray1D(values: number[], decimals: number, width = 8): string {
  return values.map((v) => cfFixed(v, decimals, width)).join(',');
}

export function banner(lines: string[]): string {
  return ['/*', ...lines.map((l) => (l ? ` * ${l}` : ' *')), ' */'].join('\n');
}
