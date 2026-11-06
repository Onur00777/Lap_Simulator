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
import {
  createContext,
  ctxAyMax,
  getTrackWithRacingLine,
  simulateLap,
  type Integrator,
  type RacingLineMode,
} from '@/lib/solver';
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
import { DeltaBadge, Kpi, Panel, Segmented } from './ui';
import CornersPanel from './panels/CornersPanel';
import TorqueVectoringPanel from './panels/TorqueVectoringPanel';
import LaunchPanel from './panels/LaunchPanel';
import PowertrainPanel from './panels/PowertrainPanel';
import CodegenPanel from './panels/CodegenPanel';
import KorfezPanel, { KorfezFacilityBar } from './panels/KorfezPanel';
import SensitivityPanel from './panels/SensitivityPanel';

type TrackSel = PresetTrackId | 'custom';
type Tab = 'corners' | 'tv' | 'sensitivity' | 'launch' | 'powertrain' | 'codegen' | 'korfez';
type Venue = 'fs' | 'korfez';

interface BaselineConfig {
  veh: VehicleParams;
  pt: PowertrainParams;
  model: LateralModel;
  racingLineMode: RacingLineMode;
  integrator: Integrator;
}

const MODEL_OPTIONS: { value: LateralModel; label: string }[] = [
  { value: 'point-mass', label: 'Point-mass' },
  { value: 'two-track-open', label: '2-track open' },
  { value: 'two-track-tv', label: '2-track TV' },
];

const RACING_LINE_OPTIONS: { value: RacingLineMode; label: string }[] = [
  { value: 'centerline', label: 'Centerline' },
  { value: 'optimal', label: 'Optimal Apex' },
];

const TABS: { value: Tab; label: string }[] = [
  { value: 'corners', label: 'Corners · Sectors · Energy' },
  { value: 'tv', label: 'Torque Vectoring' },
  { value: 'sensitivity', label: 'Sensitivity & Pareto Studio' },
  { value: 'launch', label: 'Launch (RK4)' },
  { value: 'powertrain', label: 'Powertrain & Tire' },
  { value: 'codegen', label: 'VCU Codegen' },
];

function findTimeCursor(tArr: number[], targetT: number): number {
  let lo = 0;
  let hi = tArr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tArr[mid] <= targetT) lo = mid;
    else hi = mid;
  }
  return lo;
}

export default function Workbench() {
  const [trackSel, setTrackSel] = useState<TrackSel>('endurance');
  const [customTrack, setCustomTrack] = useState<Track | null>(null);
  const [csvMsg, setCsvMsg] = useState<string | null>(null);
  const [vehPatch, setVehPatch] = useState<Partial<Record<VehicleKey, number>>>({});
  const [lambdaMu, setLambdaMu] = useState(DEFAULT_VEHICLE.tire.lambdaMu);
  const [ptPatch, setPtPatch] = useState<Partial<Record<PowertrainKey, number>>>({});
  const [regen, setRegen] = useState(true);
  const [model, setModel] = useState<LateralModel>('point-mass');
  const [racingLineMode, setRacingLineMode] = useState<RacingLineMode>('centerline');
  const [integrator, setIntegrator] = useState<Integrator>('rk4');
  const [colorMode, setColorMode] = useState<ColorMode>('mode');
  const [tab, setTab] = useState<Tab>('corners');
  const [cursor, setCursor] = useState<number | null>(null);
  const [ghostCursor, setGhostCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playRate, setPlayRate] = useState(1);
  const [venue, setVenue] = useState<Venue>('fs');
  const [presetId, setPresetId] = useState<'ist27' | 'tpsc'>('ist27');
  const [baselineCfg, setBaselineCfg] = useState<BaselineConfig | null>(null);
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
    const rl = q.get('line');
    if (rl === 'centerline' || rl === 'optimal') setRacingLineMode(rl);
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
  const rawTrack: Track = trackSel === 'custom' && customTrack ? customTrack : getPresetTrack(trackSel === 'custom' ? 'endurance' : trackSel);
  const dRawTrack = useDeferredValue(rawTrack);
  const dTrack = useMemo(() => getTrackWithRacingLine(dRawTrack, racingLineMode), [dRawTrack, racingLineMode]);
  const centerTrack = useMemo(() => getTrackWithRacingLine(dRawTrack, 'centerline'), [dRawTrack]);

  // Solve Setup A (Baseline) on the current circuit whenever baselineCfg is locked
  const baselineSolved = useMemo(() => {
    if (!baselineCfg) return null;
    const bTrack = getTrackWithRacingLine(dRawTrack, baselineCfg.racingLineMode);
    const vTopA = speedFromMotorRpm(baselineCfg.veh, baselineCfg.pt.motorMaxRpm, baselineCfg.pt.gearRatio) + 2;
    const envA =
      baselineCfg.model === 'point-mass'
        ? undefined
        : buildTwoTrackEnvelope(baselineCfg.veh, baselineCfg.pt, vTopA, baselineCfg.model === 'two-track-tv' ? 'tv' : 'open');
    const ctxA = createContext(baselineCfg.veh, baselineCfg.pt, envA);
    const lapA = simulateLap(bTrack, ctxA, { integrator: baselineCfg.integrator });
    const launchA = simulateLaunch(baselineCfg.veh, baselineCfg.pt, ctxA.map);
    const skidA = skidpadSteadyState(baselineCfg.veh, (v) => ctxAyMax(ctxA, v));
    return { cfg: baselineCfg, track: bTrack, ctx: ctxA, lap: lapA, launch: launchA, skid: skidA };
  }, [baselineCfg, dRawTrack]);

  const sim = useMemo(() => {
    const t0 = performance.now();
    const vTop = speedFromMotorRpm(dVeh, dPt.motorMaxRpm, dPt.gearRatio) + 2;
    const env = model === 'point-mass' ? undefined : buildTwoTrackEnvelope(dVeh, dPt, vTop, model === 'two-track-tv' ? 'tv' : 'open');
    const ctx = createContext(dVeh, dPt, env);
    const t1 = performance.now();
    const lap = simulateLap(dTrack, ctx, { integrator });
    const t2 = performance.now();

    // Ghost comparison lap: Setup A Baseline takes priority, otherwise Centerline / 2-track Open reference
    let ghostLap = null;
    let ghostTrack: Track | null = null;
    let ghostLabel = 'Centerline Ghost';
    if (baselineSolved) {
      ghostLap = baselineSolved.lap;
      ghostTrack = baselineSolved.track;
      ghostLabel = 'Setup A (Baseline)';
    } else if (racingLineMode === 'optimal') {
      ghostLap = simulateLap(centerTrack, ctx, { integrator });
      ghostTrack = centerTrack;
      ghostLabel = 'Centerline Ghost';
    } else if (model === 'two-track-tv') {
      const openCtx = createContext(dVeh, dPt, buildTwoTrackEnvelope(dVeh, dPt, vTop, 'open'));
      ghostLap = simulateLap(dTrack, openCtx, { integrator });
      ghostTrack = dTrack;
      ghostLabel = '2-Track Open Ghost';
    }

    return { ctx, lap, ghostLap, ghostTrack, ghostLabel, setupMs: t1 - t0, solveMs: t2 - t1 };
  }, [dVeh, dPt, dTrack, centerTrack, racingLineMode, model, integrator, baselineSolved]);
  const { ctx, lap, ghostLap, ghostTrack, ghostLabel } = sim;

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
  const effectiveGhostCursor = playing ? ghostCursor : safeCursor;

  // real-time dual-dot lap playback
  useEffect(() => {
    if (!playing) {
      setGhostCursor(null);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let simT = safeCursor != null ? ch.t[safeCursor] : 0;
    let lastPush = 0;
    const tEnd = Math.max(lap.lapTime, ghostLap?.lapTime ?? 0);
    const loop = (now: number) => {
      simT += ((now - last) / 1000) * playRate;
      last = now;
      if (simT >= tEnd) simT = lap.closed ? simT - tEnd : tEnd;
      if (now - lastPush > 33) {
        lastPush = now;
        const activeT = lap.closed ? simT % lap.lapTime : Math.min(simT, lap.lapTime);
        setCursor(findTimeCursor(ch.t, activeT));
        if (ghostLap) {
          const gT = ghostLap.closed ? simT % ghostLap.lapTime : Math.min(simT, ghostLap.lapTime);
          setGhostCursor(findTimeCursor(ghostLap.channels.t, gT));
        }
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
  }, [playing, playRate, lap, ghostLap]);

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
  const timedBase =
    baselineSolved && baselineSolved.lap.timedWindows.length
      ? baselineSolved.lap.timedWindows.reduce((a, w) => a + w.time, 0) / baselineSolved.lap.timedWindows.length
      : null;

  const headline =
    dTrack.kind === 'skidpad' && timed != null
      ? {
          label: 'Skidpad time (avg L/R)',
          value: fmtTime(timed),
          delta: timedBase != null ? timed - timedBase : null,
        }
      : dTrack.kind === 'acceleration'
        ? {
            label: '75 m · RK4 transient',
            value: fmtTime(launch.time75),
            delta: baselineSolved ? launch.time75 - baselineSolved.launch.time75 : null,
          }
        : {
            label: 'Lap time',
            value: fmtTime(lap.lapTime),
            delta: baselineSolved ? lap.lapTime - baselineSolved.lap.lapTime : null,
          };

  const snapshotBaseline = () => {
    setBaselineCfg({
      veh: structuredClone(dVeh),
      pt: structuredClone(dPt),
      model,
      racingLineMode,
      integrator,
    });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hud-line bg-hud-bg/90 px-4 py-2 backdrop-blur">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-lg font-bold tracking-[0.25em] text-hud-cyan">APEX</span>
          <span className="font-mono text-lg font-light tracking-[0.25em] text-hud-text">LAPSIM</span>
          <span className="hidden font-mono text-[10px] uppercase tracking-widest text-hud-dim 2xl:inline">
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
        <div className="flex items-center gap-1.5">
          <span className="hidden font-mono text-[9px] uppercase tracking-wider text-hud-dim sm:inline">Line:</span>
          <Segmented options={RACING_LINE_OPTIONS} value={racingLineMode} onChange={setRacingLineMode} />
        </div>
        <Segmented options={MODEL_OPTIONS} value={model} onChange={setModel} />
        <Segmented
          options={[
            { value: 'rk4', label: 'RK4' },
            { value: 'euler', label: 'Euler' },
          ]}
          value={integrator}
          onChange={setIntegrator}
        />
        <div className="flex items-center gap-1">
          {!baselineSolved ? (
            <button
              type="button"
              className="btn border-hud-cyan/50 text-hud-cyan hover:bg-hud-cyan/15"
              onClick={snapshotBaseline}
              title="Lock current Setup as Baseline (Setup A) for live Setup A vs Setup B diffing"
            >
              ⌖ Snapshot Baseline (Setup A)
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-active"
                onClick={snapshotBaseline}
                title="Overwrite Setup A with current active Setup B"
              >
                ⌖ Update Setup A ({fmtTime(baselineSolved.lap.lapTime)})
              </button>
              <button
                type="button"
                className="btn text-hud-red"
                onClick={() => setBaselineCfg(null)}
                title="Clear Setup A baseline snapshot"
              >
                ✕ Clear A
              </button>
            </>
          )}
        </div>
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
      {baselineSolved && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hud-line bg-hud-panel2/80 px-4 py-1.5 font-mono text-[11px]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded bg-hud-violet/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-hud-violet">
              Setup A (Baseline)
            </span>
            <span className="text-hud-dim">
              {baselineSolved.cfg.veh.mass.toFixed(0)} kg · ClA {baselineSolved.cfg.veh.ClA.toFixed(2)} · CdA {baselineSolved.cfg.veh.CdA.toFixed(2)} ·{' '}
              LLTD {(baselineSolved.cfg.veh.rollStiffnessFront * 100).toFixed(1)}% · {(baselineSolved.cfg.pt.batteryPowerLimit / 1000).toFixed(0)} kW ·{' '}
              {baselineSolved.cfg.model} · {baselineSolved.cfg.racingLineMode}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-hud-dim">Setup B vs Setup A:</span>
            <DeltaBadge delta={lap.lapTime - baselineSolved.lap.lapTime} unit="s" digits={3} />
            <DeltaBadge delta={(lap.lapTime - baselineSolved.lap.lapTime) * 1000} unit="ms" digits={0} />
          </div>
        </div>
      )}

      <div className="grid flex-1 gap-3 p-3 lg:grid-cols-[290px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <Panel title="Track">
            <div className="space-y-2 px-3 py-2 font-mono text-[11px]">
              <div className="text-hud-text">{dTrack.name}</div>
              <div className="text-hud-dim">{dTrack.description}</div>
              <div className="grid grid-cols-2 gap-x-2 text-hud-dim">
                <span>Length ({racingLineMode === 'optimal' ? 'optimal' : 'center'})</span>
                <span className="text-right text-hud-text">{fmt(dTrack.length, 1)} m</span>
                <span>Track width</span>
                <span className="text-right text-hud-text">{fmt(dTrack.racingLine.trackWidthM, 1)} m</span>
                <span>Corners</span>
                <span className="text-right text-hud-text">{lap.corners.length}</span>
                <span>Min radius</span>
                <span className="text-right text-hud-text">
                  {(() => {
                    const kMax = Math.max(...dTrack.kappa.map(Math.abs));
                    return kMax > 1e-6 ? `${fmt(1 / kMax, 2)} m` : '∞';
                  })()}
                </span>
                <span>Closed / laps</span>
                <span className="text-right text-hud-text">
                  {dTrack.closed ? 'yes' : 'no'} / {dTrack.laps}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 pt-1">
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  Import CSV
                </button>
                <button type="button" className="btn" onClick={() => downloadText(`${dTrack.id}.csv`, trackToCsv(dTrack), 'text/csv')}>
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
            <Kpi
              label={headline.label}
              value={headline.value}
              accent="text-hud-cyan"
              delta={headline.delta != null ? <DeltaBadge delta={headline.delta} unit="s" digits={3} /> : undefined}
              sub={`${lap.integrator.toUpperCase()} · ${lap.lateralModel} · ${racingLineMode === 'optimal' ? 'OPT-APEX' : 'CENTER'}`}
            />
            <Kpi
              label="Avg / max speed"
              value={`${fmt(kph(lap.avgSpeed), 1)} / ${fmt(kph(lap.maxSpeed), 1)}`}
              unit="km/h"
              delta={
                baselineSolved ? (
                  <DeltaBadge delta={kph(lap.avgSpeed - baselineSolved.lap.avgSpeed)} unit="km/h" digits={1} invertGood />
                ) : undefined
              }
            />
            <Kpi
              label="Energy (net)"
              value={fmt(lap.energy.netKWh * 1000, 1)}
              unit="Wh"
              delta={
                baselineSolved ? (
                  <DeltaBadge delta={(lap.energy.netKWh - baselineSolved.lap.energy.netKWh) * 1000} unit="Wh" digits={1} />
                ) : undefined
              }
              sub={`${fmt(lap.energy.dischargeKWh * 1000, 1)} out · ${fmt(lap.energy.regenKWh * 1000, 1)} regen`}
              accent="text-hud-amber"
            />
            <Kpi
              label="Cooling heat"
              value={fmt(lap.energy.coolingHeatKJ, 1)}
              unit="kJ"
              delta={
                baselineSolved ? (
                  <DeltaBadge delta={lap.energy.coolingHeatKJ - baselineSolved.lap.energy.coolingHeatKJ} unit="kJ" digits={1} />
                ) : undefined
              }
              sub={`+ ${fmt(lap.energy.batteryLossKJ, 1)} kJ in accumulator`}
              accent="text-hud-violet"
            />
            <Kpi
              label="Peak lat / long / brake"
              value={`${fmt(lap.peakLatG, 2)} / ${fmt(lap.peakLongG, 2)} / ${fmt(lap.peakBrakeG, 2)}`}
              unit="G"
              delta={
                baselineSolved ? (
                  <DeltaBadge delta={lap.peakLatG - baselineSolved.lap.peakLatG} unit="G" digits={2} invertGood />
                ) : undefined
              }
              sub={
                lap.hasWheelLift ? (
                  <span className="font-bold text-hud-red">⚠ Inner Wheel Lift! ({lap.wheelLiftCount} pts)</span>
                ) : (
                  `K_us ${fmt(lap.cornerUndersteerDegPerG, 2)}°/G · SI ${fmt(lap.avgStabilityIndex * 100, 1)}%`
                )
              }
            />
            <Kpi
              label="Skidpad (analytic)"
              value={fmtTime(skid.lapTime)}
              delta={baselineSolved ? <DeltaBadge delta={skid.lapTime - baselineSolved.skid.lapTime} unit="s" digits={3} /> : undefined}
              sub={`${fmt(skid.ayG, 3)} G · μ_eff ${fmt(skid.muEffective, 3)}`}
            />
            <Kpi
              label="Accel 75 m (RK4)"
              value={fmtTime(launch.time75)}
              delta={baselineSolved ? <DeltaBadge delta={launch.time75 - baselineSolved.launch.time75} unit="s" digits={3} /> : undefined}
              sub={`0–100 ${fmt(launch.time0to100, 2)} s · ${fmt(kph(launch.trapSpeed), 0)} km/h`}
            />
            <Kpi
              label={`Event · ${lap.event.laps} lap${lap.event.laps > 1 ? 's' : ''}`}
              value={fmtTime(lap.event.totalTime)}
              delta={
                baselineSolved ? (
                  <DeltaBadge delta={lap.event.totalTime - baselineSolved.lap.event.totalTime} unit="s" digits={2} />
                ) : undefined
              }
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
                  ghostLap={ghostLap}
                  ghostTrack={ghostTrack}
                  ghostCursor={effectiveGhostCursor}
                  ghostLabel={ghostLabel}
                  onHover={onHoverCanvas}
                  mapAlign={korfezOn ? mapAlign : undefined}
                  mapSrcOverride={mapUpload}
                />
              </div>
            </Panel>
            <Panel title="G-G diagram · friction ellipse" bodyClassName="h-[460px]">
              <GGDiagram
                lap={lap}
                ctx={ctx}
                cursor={safeCursor}
                baselineLap={baselineSolved?.lap}
                baselineCtx={baselineSolved?.ctx}
              />
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
            <TelemetryCharts
              lap={lap}
              baselineLap={baselineSolved?.lap ?? ghostLap}
              cursorS={safeCursor != null ? ch.s[safeCursor] : null}
              onHoverS={onHoverS}
            />
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
            {tab === 'sensitivity' && <SensitivityPanel track={dTrack} veh={dVeh} pt={dPt} model={model} integrator={integrator} />}
            {tab === 'launch' && <LaunchPanel launch={launch} qssTime={dTrack.kind === 'acceleration' ? lap.lapTime : undefined} />}
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
