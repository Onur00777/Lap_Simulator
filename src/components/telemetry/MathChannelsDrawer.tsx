'use client';

import { useEffect, useMemo, useState } from 'react';
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compileMathChannel, MATH_CHANNEL_INPUTS, type MathChannelInputs } from '@/lib/telemetry/math-parser';
import { strideFor } from '@/lib/ui/format';

interface Channel {
  id: string;
  name: string;
  expression: string;
  enabled: boolean;
}

const STORAGE_KEY = 'apexlapsim.math-channels.v1';
const PRESETS = [
  { name: 'Oversteer Angle [°]', expression: '-understeerAngle' },
  { name: 'G-Sum [G]', expression: 'sqrt(gLong^2 + gLat^2)' },
  { name: 'Traction Utilization [%]', expression: '100 * gripUsage' },
];

export default function MathChannelsDrawer({ inputs, distance, cursorS, onClose }: {
  inputs: MathChannelInputs;
  distance: number[];
  cursorS: number | null;
  onClose: () => void;
}) {
  const [channels, setChannels] = useState<Channel[]>(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
      return Array.isArray(saved) ? saved.filter((entry): entry is Channel => (
        entry && typeof entry.id === 'string' && typeof entry.name === 'string' &&
        typeof entry.expression === 'string' && typeof entry.enabled === 'boolean'
      )).slice(0, 16) : [];
    } catch {
      return [];
    }
  });
  const [draft, setDraft] = useState({ id: '', name: '', expression: '' });
  const [error, setError] = useState('');

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const evaluated = useMemo(() => channels.map((channel) => {
    if (!channel.enabled) return { channel, rows: [], invalid: false };
    try {
      const values = compileMathChannel(channel.expression)(inputs, distance.length);
      const stride = strideFor(distance.length, 700);
      const rows = distance.flatMap((s, i) => i % stride === 0 || i === distance.length - 1 ? [{ s, value: values[i] }] : []);
      return { channel, rows, invalid: values.every((value) => value === null) };
    } catch {
      return { channel, rows: [], invalid: true };
    }
  }), [channels, distance, inputs]);

  const update = (next: Channel[]) => {
    setChannels(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      setError('The browser could not save changes to local storage.');
    }
  };

  return (
    <aside aria-label="Math Channels" className="fixed inset-y-12 right-0 z-40 w-[min(100vw,32rem)] overflow-y-auto border-l border-white/[0.12] bg-[#0b0d15] p-4 text-slate-200 shadow-2xl">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Math Channels</h2>
        <button type="button" onClick={onClose} aria-label="Close Math Channels" className="rounded px-2 py-1 text-slate-300 hover:bg-white/10">✕</button>
      </header>
      <div className="mb-3 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button key={preset.name} type="button" className="rounded border border-white/10 bg-white/5 px-2 py-1 text-xs hover:border-cyan-500" onClick={() => { setError(''); setDraft({ id: '', ...preset }); }}>
            {preset.name}
          </button>
        ))}
      </div>
      <form className="grid gap-2" onSubmit={(event) => {
        event.preventDefault();
        try {
          if (!draft.id && channels.length >= 16) throw new Error('Save up to 16 channels.');
          compileMathChannel(draft.expression);
          const entry = { ...draft, name: draft.name.trim(), id: draft.id || crypto.randomUUID(), enabled: channels.find((c) => c.id === draft.id)?.enabled ?? true };
          if (!entry.name) throw new Error('Enter a channel name.');
          setError('');
          update(draft.id ? channels.map((channel) => channel.id === entry.id ? entry : channel) : [...channels, entry]);
          setDraft({ id: '', name: '', expression: '' });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Invalid expression.');
        }
      }}>
        <label className="grid gap-1 text-xs">Channel name<input required maxLength={60} className="rounded border border-white/10 bg-black/30 px-2 py-1.5" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="grid gap-1 text-xs">Expression<input required maxLength={512} spellCheck={false} className="rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono" value={draft.expression} onChange={(e) => setDraft({ ...draft, expression: e.target.value })} /></label>
        <p className="text-xs text-slate-400">{MATH_CHANNEL_INPUTS.join(', ')} · filter(value, samples). Slip ratio estimates rear-wheel slip from drive and regen torque.</p>
        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        <button className="justify-self-start rounded border border-cyan-700 bg-cyan-950 px-3 py-1.5 text-xs text-cyan-200">{draft.id ? 'Save changes' : 'Add channel'}</button>
      </form>
      <div className="mt-4 grid gap-2">
        {evaluated.map(({ channel, rows, invalid }) => (
          <section key={channel.id} className="min-w-0 rounded border border-white/10 px-2 py-2">
            <div className="flex items-center gap-2 text-xs">
              <label className="flex min-w-0 grow items-center gap-2">
                <input type="checkbox" checked={channel.enabled} onChange={(e) => update(channels.map((c) => c.id === channel.id ? { ...c, enabled: e.target.checked } : c))} />
                <span className="truncate">{channel.name}</span>
              </label>
              <button type="button" onClick={() => { setError(''); setDraft(channel); }} className="text-cyan-300">Edit</button>
              <button type="button" onClick={() => {
                update(channels.filter((c) => c.id !== channel.id));
                if (draft.id === channel.id) setDraft({ id: '', name: '', expression: '' });
              }} className="text-slate-400 hover:text-red-300">Delete</button>
            </div>
            {invalid && <p className="py-2 text-xs text-amber-300">No finite samples for this expression.</p>}
            {rows.length > 0 && !invalid && (
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={rows} margin={{ right: 10, top: 8 }}>
                  <XAxis dataKey="s" type="number" tick={{ fontSize: 10 }} unit=" m" />
                  <YAxis width={44} tick={{ fontSize: 10 }} tickFormatter={(v: number) => v.toPrecision(3)} />
                  <Tooltip isAnimationActive={false} contentStyle={{ background: '#0b0d15', borderColor: '#334155' }} />
                  {cursorS != null && <ReferenceLine x={cursorS} stroke="#f8fafc" />}
                  <Line dataKey="value" name={channel.name} stroke="#22d3ee" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}
