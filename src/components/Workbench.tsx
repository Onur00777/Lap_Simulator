'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_POWERTRAIN,
  DEFAULT_VEHICLE,
  speedFromMotorRpm,
  type LateralModel,
  type PowertrainParams,
  type VehicleParams,
} from '@/lib/physics';
import { analyzeTorqueVectoring, buildTwoTrackEnvelope } from '@/lib/dynamics';
import { createContext, ctxAyMax, simulateLap, type Integrator } from '@/lib/solver';
import {
  getPresetTrack,
  IST27_PRESET,
  isKorfezTrack,
  KORFEZ_PRESETS,
  KORFEZ_TRACKS,
  PRESET_TRACKS,
  simulateLaunch,
  skidpadSteadyState,
  TPSC_PRESET,
  trackFromCsv,
  trackToCsv,
  type KorfezTrackId,
  type PresetTrackId,
  type Track,
} from '@/lib/tracks';
import { analyzeKorfezLayout, compareKorfezLayouts } from '@/lib/solver/korfez-analysis';
import { generateVcuBundle } from '@/lib/codegen';
import { downloadText, fmt, fmtTime, kph } from '@/lib/ui/format';
import TrackCanvas, { type ColorMode, type MapAlign } from './TrackCanvas';
import TelemetryCharts from './TelemetryCharts';
import GGDiagram from './GGDiagram';
import { PowertrainForm, VehicleForm, type PowertrainKey, type VehicleKey } from './ParamPanel';
import { Kpi, Panel, Segmented } from './ui';
import CornersPanel from './panels/CornersPanel';
import TorqueVectoringPanel from './panels/TorqueVectoringPanel';
import LaunchPanel from './panels/LaunchPanel';
import PowertrainPanel from './panels/PowertrainPanel';
import CodegenPanel from './panels/CodegenPanel';
import KorfezPanel, { KorfezFacilityBar } from './panels/KorfezPanel';

type TrackSel = PresetTrackId | 'custom';
type Tab = 'corners' | 'tv' | 'launch' | 'powertrain' | 'codegen' | 'korfez';
type Venue = 'fs' | 'korfez';

const MODEL_OPTIONS: { value: LateralModel; label: string }[] = [
  { value: 'point-mass', label: 'Point-mass' },
  { value: 'two-track-open', label: '2-track open' },
  { value: 'two-track-tv', label: '2-track TV' },
];

const TABS: { value: Tab; label: string }[] = [
  { value: 'corners', label: 'Corners · Sectors · Energy' },
  { value: 'tv', label: 'Torque Vectoring' },
  { value: 'launch', label: 'Launch (RK4)' },
  { value: 'powertrain', label: 'Powertrain & Tire' },
  { value: 'codegen', label: 'VCU Codegen' },
];

export default function Workbench() {
  const [trackSel, setTrackSel] = useState<TrackSel>('endurance');
  const [customTrack, setCustomTrack] = useState<Track | null>(null);
  const [csvMsg, setCsvMsg] = useState<string | null>(null);
  const [vehPatch, setVehPatch] = useState<Partial<Record<VehicleKey, number>>>({});
  const [lambdaMu, setLambdaMu] = useState(DEFAULT_VEHICLE.tire.lambdaMu);
  const [ptPatch, setPtPatch] = useState<Partial<Record<PowertrainKey, number>>>({});
  const [regen, setRegen] = useState(true);
  const [model, setModel] = useState<LateralModel>('point-mass');
  const [integrator, setIntegrator] = useState<Integrator>('rk4');
  const [colorMode, setColorMode] = useState<ColorMode>('mode');
  const [tab, setTab] = useState<Tab>('corners');
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playRate, setPlayRate] = useState(1);
  const [venue, setVenue] = useState<Venue>('fs');
  const [presetId, setPresetId] = useState<'ist27' | 'tpsc'>('ist27');
  const [mapAlign, setMapAlign] = useState<MapAlign>({ opacity: 0.32, scale: 1, x: 0, y: 0, rotation: 0, visible: true });
  const [mapUpload, setMapUpload] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mapFileRef = useRef<HTMLInputElement>(null);

  // deep links: ?track=autocross&tab=tv&model=two-track-tv&color=speed
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('track');
    if (t && KORFEZ_TRACKS.some((p) => p.id === t)) {
      setVenue('korfez');
      setTrackSel(t as KorfezTrackId);
      setTab('korfez');
    } else if (t && PRESET_TRACKS.some((p) => p.id === t)) setTrackSel(t as PresetTrackId);
    const tb = q.get('tab');
    if (tb && TABS.some((x) => x.value === tb)) setTab(tb as Tab);
    const m = q.get('model');
    if (m && MODEL_OPTIONS.some((x) => x.value === m)) setModel(m as LateralModel);
    const c = q.get('color');
    if (c === 'mode' || c === 'speed' || c === 'latg' || c === 'grip') setColorMode(c);
    const cur = q.get('cursor');
    if (cur) setCursor(Number(cur));
  }, []);

  const basePreset = venue === 'korfez' && presetId === 'tpsc' ? TPSC_PRESET : IST27_PRESET;
  const veh: VehicleParams = useMemo(() => {
    const base = venue === 'korfez' ? basePreset.vehicle : DEFAULT_VEHICLE;
    return { ...base, ...vehPatch, tire: { ...base.tire, lambdaMu } };
  }, [venue, basePreset, vehPatch, lambdaMu]);
  const pt: PowertrainParams = useMemo(() => {
    const base = venue === 'korfez' ? basePreset.powertrain : DEFAULT_POWERTRAIN;
    return { ...base, ...ptPatch, regenEnabled: regen };
  }, [venue, basePreset, ptPatch, regen]);
  const dVeh = useDeferredValue(veh);
  const dPt = useDeferredValue(pt);
  const track: Track = trackSel === 'custom' && customTrack ? customTrack : getPresetTrack(trackSel === 'custom' ? 'endurance' : trackSel);
  const dTrack = useDeferredValue(track);

  const sim = useMemo(() => {
    const t0 = performance.now();
    const vTop = speedFromMotorRpm(dVeh, dPt.motorMaxRpm, dPt.gearRatio) + 2;
    const env = model === 'point-mass' ? undefined : buildTwoTrackEnvelope(dVeh, dPt, vTop, model === 'two-track-tv' ? 'tv' : 'open');
    const ctx = createContext(dVeh, dPt, env);
    const t1 = performance.now();
    const lap = simulateLap(dTrack, ctx, { integrator });
    const t2 = performance.now();
    return { ctx, lap, setupMs: t1 - t0, solveMs: t2 - t1 };
  }, [dVeh, dPt, dTrack, model, integrator]);
  const { ctx, lap } = sim;

  const launch = useMemo(() => simulateLaunch(dVeh, dPt, ctx.map), [dVeh, dPt, ctx]);
  const skid = useMemo(() => skidpadSteadyState(dVeh, (v) => ctxAyMax(ctx, v)), [dVeh, ctx]);
  const tvOpen = tab === 'tv';
  const tv = useMemo(() => (tvOpen ? analyzeTorqueVectoring(dVeh, dPt, dTrack, { integrator }) : null), [tvOpen, dVeh, dPt, dTrack, integrator]);
  const cgOpen = tab === 'codegen';
  const korfezOn = venue === 'korfez' && isKorfezTrack(dTrack);
  const bundle = useMemo(
    () => (cgOpen ? generateVcuBundle(dVeh, dPt, { map: ctx.map, korfezTrackId: korfezOn ? dTrack.id : undefined }) : null),
    [cgOpen, dVeh, dPt, ctx, korfezOn, dTrack.id],
  );
  const korfezReport = useMemo(
    () => (korfezOn ? analyzeKorfezLayout(dTrack.id as KorfezTrackId, dVeh, dPt, integrator) : null),
    [korfezOn, dTrack, dVeh, dPt, integrator],
  );
  const korfezCompare = useMemo(
    () => (korfezOn && tab === 'korfez' ? compareKorfezLayouts(dVeh, dPt, integrator) : null),
    [korfezOn, tab, dVeh, dPt, integrator],
  );
  const tabs = venue === 'korfez' ? [{ value: 'korfez' as Tab, label: 'Körfez Analiz' }, ...TABS] : TABS;

  const ch = lap.channels;
  const n = ch.s.length;
  const safeCursor = cursor != null && cursor < n ? cursor : null;

  // real-time lap playback
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let simT = safeCursor != null ? ch.t[safeCursor] : 0;
    let lastPush = 0;
    const tEnd = lap.lapTime;
    const loop = (now: number) => {
      simT += ((now - last) / 1000) * playRate;
      last = now;
      if (simT >= tEnd) simT = lap.closed ? simT - tEnd : tEnd;
      if (now - lastPush > 33) {
        lastPush = now;
        let lo = 0;
        let hi = n - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (ch.t[mid] <= simT) lo = mid;
          else hi = mid;
        }
        setCursor(lo);
        if (!lap.closed && simT >= tEnd) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playRate, lap]);

  const onHoverCanvas = useCallback((i: number | null) => {
    if (!playing) setCursor(i);
  }, [playing]);
  const onHoverS = useCallback(
    (s: number | null) => {
      if (playing) return;
      setCursor(s == null ? null : Math.max(0, Math.min(n - 1, Math.round(s / dTrack.ds))));
    },
    [playing, n, dTrack],
  );

  const importCsv = (text: string, name: string) => {
    try {
      const t = trackFromCsv(text, { name });
      setCustomTrack(t);
      setTrackSel('custom');
      setCsvMsg(`Imported ${t.closed ? 'closed' : 'open'} track · ${t.length.toFixed(0)} m · ${t.s.length} samples`);
    } catch (e) {
      setCsvMsg(`Import failed: ${(e as Error).message}`);
    }
  };

  const timed = lap.timedWindows.length ? lap.timedWindows.reduce((a, w) => a + w.time, 0) / lap.timedWindows.length : null;
  const headline =
    track.kind === 'skidpad' && timed != null
      ? { label: 'Skidpad time (avg L/R)', value: fmtTime(timed) }
      : track.kind === 'acceleration'
        ? { label: '75 m · RK4 transient', value: fmtTime(launch.time75) }
        : { label: 'Lap time', value: fmtTime(lap.lapTime) };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-hud-line bg-hud-bg/90 px-4 py-2 backdrop-blur">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-lg font-bold tracking-[0.25em] text-hud-cyan">APEX</span>
          <span className="font-mono text-lg font-light tracking-[0.25em] text-hud-text">LAPSIM</span>
          <span className="hidden font-mono text-[10px] uppercase tracking-widest text-hud-dim md:inline">
            FS vehicle dynamics · QSS lap sim · torque vectoring · VCU codegen
          </span>
        </div>
        <span className="flex-1" />
        <Segmented
          options={[
            { value: 'fs' as Venue, label: 'Formula Student' },
            { value: 'korfez' as Venue, label: 'Kocaeli — Körfez' },
          ]}
          value={venue}
          onChange={(v) => {
            setVenue(v);
            setTrackSel(v === 'korfez' ? 'korfez-gp-1950' : 'endurance');
            setTab(v === 'korfez' ? 'korfez' : 'corners');
            setCursor(null);
            setPlaying(false);
            setMapUpload(null);
          }}
        />
        <Segmented
          options={
            venue === 'korfez'
              ? KORFEZ_TRACKS.map((t) => ({ value: t.id as TrackSel, label: t.label }))
              : [...PRESET_TRACKS.map((t) => ({ value: t.id as TrackSel, label: t.label })), ...(customTrack ? [{ value: 'custom' as TrackSel, label: customTrack.name }] : [])]
          }
          value={trackSel}
          onChange={(v) => {
            setTrackSel(v);
            setCursor(null);
            setPlaying(false);
          }}
        />
        <Segmented options={MODEL_OPTIONS} value={model} onChange={setModel} />
        <Segmented
          options={[
            { value: 'rk4', label: 'RK4' },
            { value: 'euler', label: 'Euler' },
          ]}
          value={integrator}
          onChange={setIntegrator}
        />
        <span className="rounded border border-hud-line px-2 py-1 font-mono text-[10px] text-hud-dim" title="setup (envelope + powertrain tables) / 3-pass solve">
          {fmt(sim.setupMs, 0)} + {fmt(sim.solveMs, 0)} ms · {n} pts
        </span>
        {venue === 'korfez' && (
          <Segmented
            options={KORFEZ_PRESETS.map((p) => ({ value: p.id, label: p.id === 'ist27' ? 'IST27 FS EV' : 'TPSC 220+ km/h' }))}
            value={presetId}
            onChange={(id) => {
              setPresetId(id);
              setVehPatch({});
              setPtPatch({});
              setLambdaMu((id === 'tpsc' ? TPSC_PRESET : IST27_PRESET).vehicle.tire.lambdaMu);
              setRegen(true);
            }}
          />
        )}
      </header>
      {venue === 'korfez' && <KorfezFacilityBar />}

      <div className="grid flex-1 gap-3 p-3 lg:grid-cols-[290px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <Panel title="Track">
            <div className="space-y-2 px-3 py-2 font-mono text-[11px]">
              <div className="text-hud-text">{track.name}</div>
              <div className="text-hud-dim">{track.description}</div>
              <div className="grid grid-cols-2 gap-x-2 text-hud-dim">
                <span>Length</span>
                <span className="text-right text-hud-text">{fmt(track.length, 1)} m</span>
                <span>Corners</span>
                <span className="text-right text-hud-text">{lap.corners.length}</span>
                <span>Min radius</span>
                <span className="text-right text-hud-text">
                  {(() => {
                    const kMax = Math.max(...track.kappa.map(Math.abs));
                    return kMax > 1e-6 ? `${fmt(1 / kMax, 2)} m` : '∞';
                  })()}
                </span>
                <span>Closed / laps</span>
                <span className="text-right text-hud-text">
                  {track.closed ? 'yes' : 'no'} / {track.laps}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 pt-1">
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  Import CSV
                </button>
                <button type="button" className="btn" onClick={() => downloadText(`${track.id}.csv`, trackToCsv(track), 'text/csv')}>
                  Export CSV
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.txt,.tsv"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) importCsv(await f.text(), f.name.replace(/\.[^.]+$/, ''));
                    e.target.value = '';
                  }}
                />
              </div>
              <div className="text-[10px] text-hud-dim">CSV columns: X, Y [m] (header optional). Closed loops auto-detected.</div>
              {csvMsg && <div className={`text-[10px] ${csvMsg.startsWith('Import failed') ? 'text-hud-red' : 'text-hud-lime'}`}>{csvMsg}</div>}
            </div>
          </Panel>
          <Panel
            title="Vehicle"
            right={
              <button
                type="button"
                className="btn !px-1.5 !py-0 text-[9px]"
                onClick={() => {
                  setVehPatch({});
                  setPtPatch({});
                  setLambdaMu(DEFAULT_VEHICLE.tire.lambdaMu);
                  setRegen(true);
                }}
              >
                reset
              </button>
            }
          >
            <VehicleForm
              veh={veh}
              onChange={(k, v) => setVehPatch((p) => ({ ...p, [k]: v }))}
              lambdaMu={lambdaMu}
              onLambdaMu={setLambdaMu}
              lap={lap}
            />
          </Panel>
          <Panel title="Powertrain">
            <PowertrainForm pt={pt} onChange={(k, v) => setPtPatch((p) => ({ ...p, [k]: v }))} onRegen={setRegen} />
          </Panel>
        </aside>

        <main className="flex min-w-0 flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
            <Kpi label={headline.label} value={headline.value} accent="text-hud-cyan" sub={`${lap.integrator.toUpperCase()} · ${lap.lateralModel}`} />
            <Kpi label="Avg / max speed" value={`${fmt(kph(lap.avgSpeed), 1)} / ${fmt(kph(lap.maxSpeed), 1)}`} unit="km/h" />
            <Kpi label="Energy (net)" value={fmt(lap.energy.netKWh * 1000, 1)} unit="Wh" sub={`${fmt(lap.energy.dischargeKWh * 1000, 1)} out · ${fmt(lap.energy.regenKWh * 1000, 1)} regen`} accent="text-hud-amber" />
            <Kpi label="Cooling heat" value={fmt(lap.energy.coolingHeatKJ, 1)} unit="kJ" sub={`+ ${fmt(lap.energy.batteryLossKJ, 1)} kJ in accumulator`} accent="text-hud-violet" />
            <Kpi
              label="Peak lat / long / brake"
              value={`${fmt(lap.peakLatG, 2)} / ${fmt(lap.peakLongG, 2)} / ${fmt(lap.peakBrakeG, 2)}`}
              unit="G"
              sub={
                lap.hasWheelLift ? (
                  <span className="font-bold text-hud-red">⚠ Inner Wheel Lift! ({lap.wheelLiftCount} pts)</span>
                ) : (
                  `K_us ${fmt(lap.cornerUndersteerDegPerG, 2)}°/G · SI ${fmt(lap.avgStabilityIndex * 100, 1)}%`
                )
              }
            />
            <Kpi label="Skidpad (analytic)" value={fmtTime(skid.lapTime)} sub={`${fmt(skid.ayG, 3)} G · μ_eff ${fmt(skid.muEffective, 3)}`} />
            <Kpi label="Accel 75 m (RK4)" value={fmtTime(launch.time75)} sub={`0–100 ${fmt(launch.time0to100, 2)} s · ${fmt(kph(launch.trapSpeed), 0)} km/h`} />
            <Kpi
              label={`Event · ${lap.event.laps} lap${lap.event.laps > 1 ? 's' : ''}`}
              value={fmtTime(lap.event.totalTime)}
              sub={`${fmt(lap.event.totalEnergyKWh, 2)} kWh · ${fmt(lap.event.totalHeatMJ, 2)} MJ heat`}
              accent="text-hud-lime"
            />
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <Panel
              title="Track heat-map"
              right={
                <div className="flex items-center gap-1 normal-case tracking-normal">
                  <Segmented
                    options={[
                      { value: 'mode', label: 'Mode' },
                      { value: 'speed', label: 'Speed' },
                      { value: 'latg', label: 'Lat G' },
                      { value: 'grip', label: 'Grip' },
                    ]}
                    value={colorMode}
                    onChange={setColorMode}
                  />
                  <button type="button" className={`btn ${playing ? 'btn-active' : ''}`} onClick={() => setPlaying((p) => !p)}>
                    {playing ? '❚❚ Pause' : '▶ Play lap'}
                  </button>
                  <select className="field !w-auto !py-0.5" value={playRate} onChange={(e) => setPlayRate(Number(e.target.value))}>
                    {[0.5, 1, 2, 4].map((r) => (
                      <option key={r} value={r}>
                        ×{r}
                      </option>
                    ))}
                  </select>
                </div>
              }
              bodyClassName="flex h-[500px] flex-col"
            >
              {korfezOn && (
                <div className="flex flex-wrap items-center gap-2 border-b border-hud-line px-2 py-1 font-mono text-[10px] text-hud-dim">
                  <span className="uppercase tracking-wider text-hud-cyan">Pist görseli</span>
                  <button type="button" className={`btn ${mapAlign.visible ? 'btn-active' : ''}`} onClick={() => setMapAlign((m) => ({ ...m, visible: !m.visible }))}>
                    {mapAlign.visible ? 'Görsel açık' : 'Görsel kapalı'}
                  </button>
                  <button type="button" className="btn" onClick={() => mapFileRef.current?.click()}>
                    Yükle
                  </button>
                  <input
                    ref={mapFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setMapUpload(URL.createObjectURL(f));
                      e.target.value = '';
                    }}
                  />
                  {mapUpload && (
                    <button type="button" className="btn" onClick={() => setMapUpload(null)}>
                      Kroki
                    </button>
                  )}
                  <label className="flex items-center gap-1">
                    opak
                    <input type="range" min={0} max={100} value={Math.round(mapAlign.opacity * 100)} onChange={(e) => setMapAlign((m) => ({ ...m, opacity: Number(e.target.value) / 100 }))} />
                  </label>
                  <label className="flex items-center gap-1">
                    ölçek
                    <input type="range" min={50} max={180} value={Math.round(mapAlign.scale * 100)} onChange={(e) => setMapAlign((m) => ({ ...m, scale: Number(e.target.value) / 100 }))} />
                  </label>
                  <label className="flex items-center gap-1">
                    X
                    <input type="range" min={-400} max={400} value={mapAlign.x} onChange={(e) => setMapAlign((m) => ({ ...m, x: Number(e.target.value) }))} />
                  </label>
                  <label className="flex items-center gap-1">
                    Y
                    <input type="range" min={-400} max={400} value={mapAlign.y} onChange={(e) => setMapAlign((m) => ({ ...m, y: Number(e.target.value) }))} />
                  </label>
                  <label className="flex items-center gap-1">
                    açı
                    <input type="range" min={-180} max={180} value={mapAlign.rotation} onChange={(e) => setMapAlign((m) => ({ ...m, rotation: Number(e.target.value) }))} />
                  </label>
                  <button type="button" className="btn" onClick={() => setMapAlign({ opacity: 0.32, scale: 1, x: 0, y: 0, rotation: 0, visible: true })}>
                    Sıfırla
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <TrackCanvas
                  track={dTrack}
                  lap={lap}
                  colorMode={colorMode}
                  cursor={safeCursor}
                  onHover={onHoverCanvas}
                  mapAlign={korfezOn ? mapAlign : undefined}
                  mapSrcOverride={mapUpload}
                />
              </div>
            </Panel>
            <Panel title="G-G diagram · friction ellipse" bodyClassName="h-[460px]">
              <GGDiagram lap={lap} ctx={ctx} cursor={safeCursor} />
            </Panel>
          </div>

          <Panel
            title="Synchronised telemetry"
            right={
              safeCursor != null ? (
                <span className="font-mono text-[10px] normal-case tracking-normal text-hud-cyan">
                  s {fmt(ch.s[safeCursor], 1)} m · {fmt(kph(ch.v[safeCursor]), 1)} km/h · {fmt(ch.gLat[safeCursor], 2)} G lat ·{' '}
                  Fz [{fmt(ch.fzFL[safeCursor], 0)}, {fmt(ch.fzFR[safeCursor], 0)}, {fmt(ch.fzRL[safeCursor], 0)}, {fmt(ch.fzRR[safeCursor], 0)}] N ·{' '}
                  K_us {fmt(ch.understeerDegPerG[safeCursor], 2)}°/G
                </span>
              ) : undefined
            }
            bodyClassName="p-2"
          >
            <TelemetryCharts lap={lap} cursorS={safeCursor != null ? ch.s[safeCursor] : null} onHoverS={onHoverS} />
          </Panel>

          <Panel title={<Segmented options={tabs} value={tab} onChange={setTab} />}>
            {tab === 'korfez' && (
              <KorfezPanel
                report={korfezReport}
                comparison={korfezCompare}
                onSelect={(i) => {
                  const lm = dTrack.landmarks?.[i];
                  if (lm) setCursor(Math.round(lm.sApex / dTrack.ds));
                }}
              />
            )}
            {tab === 'corners' && <CornersPanel lap={lap} skid={skid} onSelect={(i) => setCursor(i)} />}
            {tab === 'tv' && (tv ? <TorqueVectoringPanel tv={tv} cursorS={safeCursor != null ? ch.s[safeCursor] : null} /> : <Busy />)}
            {tab === 'launch' && <LaunchPanel launch={launch} qssTime={track.kind === 'acceleration' ? lap.lapTime : undefined} />}
            {tab === 'powertrain' && <PowertrainPanel veh={dVeh} pt={dPt} map={ctx.map} />}
            {tab === 'codegen' && (bundle ? <CodegenPanel bundle={bundle} /> : <Busy />)}
          </Panel>
        </main>
      </div>
      <footer className="border-t border-hud-line px-4 py-2 font-mono text-[10px] text-hud-dim">
        ApexLapSim · Pacejka MF tires · 3-pass QSS solver (Euler / RK4 in v²) · 2-track yaw dynamics (RK4) · MISRA-C VCU export
      </footer>
    </div>
  );
}

function Busy() {
  return <div className="p-6 font-mono text-xs text-hud-dim">Computing…</div>;
}
