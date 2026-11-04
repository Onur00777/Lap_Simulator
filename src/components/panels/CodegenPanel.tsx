'use client';

import { useState } from 'react';
import type { VcuBundle } from '@/lib/codegen';
import { rgb, turbo } from '@/lib/ui/colors';
import { downloadText, fmt } from '@/lib/ui/format';

export default function CodegenPanel({ bundle }: { bundle: VcuBundle }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const file = bundle.files[active];
  const tm = bundle.torqueMap;
  const tMax = Math.max(...tm.torque.flat());
  const tMin = Math.min(...tm.torque.flat());
  return (
    <div className="grid gap-3 p-3 xl:grid-cols-[1fr_1.4fr]">
      <div className="min-w-0">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-hud-dim">
          Driver torque map — pedal [%] × speed [km/h] → Nm per motor
        </div>
        <div className="overflow-auto">
          <table className="border-collapse font-mono text-[9px] tabular-nums">
            <thead>
              <tr>
                <th className="px-1 text-hud-dim">% \ kph</th>
                {tm.speedKph.map((s) => (
                  <th key={s} className="px-1 font-normal text-hud-dim">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tm.torque
                .map((row, i) => ({ row, p: tm.pedalPct[i] }))
                .reverse()
                .map(({ row, p }) => (
                  <tr key={p}>
                    <td className="px-1 text-right text-hud-dim">{p}</td>
                    {row.map((t, j) => (
                      <td
                        key={j}
                        className="px-1 text-center text-black"
                        style={{ background: t < 0 ? 'rgba(59,130,246,0.85)' : rgb(turbo((t - Math.max(0, tMin)) / Math.max(1e-6, tMax)), 0.85) }}
                      >
                        {fmt(t, 1)}
                      </td>
                    ))}
                  </tr>
                ))}
              <tr>
                <td className="px-1 text-right text-hud-dim">lim</td>
                {tm.limitedBy.map((l, j) => (
                  <td key={j} className="px-1 text-center text-hud-dim">
                    {l[0].toUpperCase()}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-2 space-y-0.5 font-mono text-[10px] text-hud-dim">
          <div>T(p, v) = T_avail(v) · (p/100)^{tm.pedalGamma} · lift-off regen {tm.coastRegenTorque} Nm (blue)</div>
          <div>TC slip set point κ* = {fmt(tm.slipTarget, 4)} · limiter: T traction · M motor · B 80 kW battery · R max rpm</div>
          <div>
            TV: Kp {fmt(bundle.tvParams.kp, 0)} · Ki {fmt(bundle.tvParams.ki, 0)} · Mz ≤ {fmt(bundle.tvParams.mzLimit, 0)} Nm · a_y,lim table{' '}
            {bundle.tvParams.ayLimitTable?.ay.map((a) => fmt(a / 9.81, 2)).join(' / ')} G
          </div>
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-1">
          {bundle.files.map((f, i) => (
            <button key={f.name} type="button" className={`btn normal-case ${i === active ? 'btn-active' : ''}`} onClick={() => setActive(i)}>
              {f.name}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await navigator.clipboard.writeText(file.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button type="button" className="btn" onClick={() => downloadText(file.name, file.content, 'text/x-c')}>
            Download
          </button>
          <button type="button" className="btn" onClick={() => bundle.files.forEach((f) => downloadText(f.name, f.content, 'text/x-c'))}>
            Download all
          </button>
        </div>
        <pre className="max-h-[420px] overflow-auto rounded border border-hud-line bg-hud-bg p-3 font-mono text-[11px] leading-[1.45] text-hud-text">
          <CodeView code={file.content} />
        </pre>
      </div>
    </div>
  );
}

const KEYWORDS = /\b(static|const|inline|void|return|if|else|while|for|typedef|struct|extern|bool|true|false|float32_t|uint32_t|int32_t|float|NULL)\b/g;

function CodeView({ code }: { code: string }) {
  return (
    <code>
      {code.split('\n').map((line, i) => {
        const trimmed = line.trimStart();
        let cls = '';
        if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) cls = 'text-hud-dim';
        else if (trimmed.startsWith('#')) cls = 'text-hud-violet';
        const html = cls
          ? line
          : line.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string).replace(KEYWORDS, '<span class="text-hud-cyan">$1</span>');
        return (
          <div key={i} className="flex">
            <span className="mr-3 inline-block w-8 select-none text-right text-hud-dim/50">{i + 1}</span>
            {cls ? <span className={cls}>{html}</span> : <span dangerouslySetInnerHTML={{ __html: html || ' ' }} />}
          </div>
        );
      })}
    </code>
  );
}
