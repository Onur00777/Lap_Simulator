'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_POWERTRAIN,
  DEFAULT_VEHICLE,
  longitudinalCoefficients,
  magicFormula,
  peakSlip,
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
  type LapResult,
  type RacingLineMode,
} from '@/lib/solver';
import {
  getPresetTrack,
  IST26_RWD_PRESET,
  IST27_PRESET,
  IST27_TWOTRACK_PRESET,
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
  type VehiclePresetId,
} from '@/lib/tracks';
import { analyzeKorfezLayout, compareKorfezLayouts } from '@/lib/solver/korfez-analysis';
import { generateFsaeDesignReport, generateVcuBundle, printFsaeDesignReport } from '@/lib/codegen';
import { downloadText, fmt, fmtTime, kph } from '@/lib/ui/format';
import TrackCanvas, { type ColorMode, type MapAlign } from './TrackCanvas';
import TelemetryCharts from './telemetry/TelemetryCharts';
import MathChannelsDrawer from './telemetry/MathChannelsDrawer';
import GGDiagram from './GGDiagram';
import { PowertrainForm, VehicleForm, type PowertrainKey, type VehicleKey } from './ParamPanel';
import { DeltaBadge, DisclosureGroup, Kpi, Panel, Segmented } from './ui';
import CornersPanel from './panels/CornersPanel';
import TorqueVectoringPanel from './panels/TorqueVectoringPanel';
import LaunchPanel from './panels/LaunchPanel';
import PowertrainPanel from './panels/PowertrainPanel';
import CodegenPanel from './panels/CodegenPanel';
import KorfezPanel, { KorfezFacilityBar } from './panels/KorfezPanel';
import SensitivityPanel from './panels/SensitivityPanel';
import EndurancePanel from './panels/EndurancePanel';
import CanCockpitDrawer from './panels/CanCockpitDrawer';

type TrackSel = PresetTrackId | 'custom';
type Tab = 'corners' | 'tv' | 'sensitivity' | 'endurance' | 'launch' | 'powertrain' | 'codegen' | 'korfez';
type Venue = 'fs' | 'korfez';

interface SavedVehicleProfile {
  vehPatch: Partial<Record<VehicleKey, number>>;
  ptPatch: Partial<Record<PowertrainKey, number>>;
  lambdaMu: number;
  regen: boolean;
  savedAt?: string;
}

const STORAGE_TWOTRACK_KEY = 'apexlapsim.preset.ist27-twotrack.v1';
const STORAGE_SESSION_KEY = 'apexlapsim.activeSession.v1';

interface BaselineConfig {
  veh: VehicleParams;
  pt: PowertrainParams;
  model: LateralModel;
  racingLineMode: RacingLineMode;
  integrator: Integrator;
}

const TABS: { value: Tab; label: string }[] = [
  { value: 'corners', label: 'Corners · Sectors · Energy' },
  { value: 'tv', label: 'Torque Vectoring' },
  { value: 'sensitivity', label: 'Sensitivity & Pareto Studio' },
  { value: 'endurance', label: 'Endurance Stint (22 km)' },
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

function lapTelemetryToCsv(lap: LapResult): string {
  const ch = lap.channels;
  const header = [
    's_m',
    'time_s',
    'speed_kph',
    'g_long',
    'g_lat',
    'grip_usage',
    'throttle',
    'brake',
    'motor_torque_nm',
    'motor_rpm',
    'p_elec_kw',
    'energy_kwh',
    'heat_kj',
    'fz_fl_n',
    'fz_fr_n',
    'fz_rl_n',
    'fz_rr_n',
    'understeer_deg_per_g',
    'stability_index',
    'roll_deg',
    'mode',
  ].join(',');
  const rows = ch.s.map((_, i) =>
    [
      ch.s[i].toFixed(2),
      ch.t[i].toFixed(4),
      (ch.v[i] * 3.6).toFixed(2),
      ch.gLong[i].toFixed(3),
      ch.gLat[i].toFixed(3),
      ch.gripUsage[i].toFixed(3),
      ch.throttle[i].toFixed(3),
      ch.brake[i].toFixed(3),
      ch.motorTorque[i].toFixed(2),
      ch.motorRpm[i].toFixed(0),
      ch.pElecKW[i].toFixed(2),
      ch.energyKWh[i].toFixed(4),
      ch.heatKJ[i].toFixed(2),
      ch.fzFL[i].toFixed(1),
      ch.fzFR[i].toFixed(1),
      ch.fzRL[i].toFixed(1),
      ch.fzRR[i].toFixed(1),
      ch.understeerDegPerG[i].toFixed(3),
      ch.stabilityIndex[i].toFixed(4),
      ch.rollDeg[i].toFixed(3),
      ch.mode[i],
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export interface WorkbenchProps {
  externalPresetId?: VehiclePresetId;
  onPresetIdChange?: (id: VehiclePresetId) => void;
  onOpenHavuzLab?: () => void;
  onOpenGuide?: () => void;
}

export default function Workbench({
  externalPresetId,
  onPresetIdChange,
  onOpenHavuzLab,
  onOpenGuide,
}: WorkbenchProps = {}) {
  const [trackSel, setTrackSel] = useState<TrackSel>('endurance');
  const [customTrack, setCustomTrack] = useState<Track | null>(null);
  const [csvMsg, setCsvMsg] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<VehiclePresetId>(externalPresetId ?? 'ist27-twotrack');
  const [savedTwoTrack, setSavedTwoTrack] = useState<SavedVehicleProfile>({
    vehPatch: {},
    ptPatch: { gearRatio: 11.8 },
    lambdaMu: IST27_TWOTRACK_PRESET.vehicle.tire.lambdaMu,
    regen: true,
  });
  const [vehPatch, setVehPatch] = useState<Partial<Record<VehicleKey, number>>>({});
  const [lambdaMu, setLambdaMu] = useState(IST27_TWOTRACK_PRESET.vehicle.tire.lambdaMu);
  const [ptPatch, setPtPatch] = useState<Partial<Record<PowertrainKey, number>>>({ gearRatio: 11.8 });
  const [regen, setRegen] = useState(true);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

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
  const [baselineCfg, setBaselineCfg] = useState<BaselineConfig | null>(null);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);
  const [leftInspectorOpen, setLeftInspectorOpen] = useState(false);
  const [ggDiagramOpen, setGgDiagramOpen] = useState(false);
  const [mathChannelsOpen, setMathChannelsOpen] = useState(false);
  const [canCockpitOpen, setCanCockpitOpen] = useState(false);
  const [benchmarksOpen, setBenchmarksOpen] = useState(false);
  const [mapAlign, setMapAlign] = useState<MapAlign>({ opacity: 0.32, scale: 1, x: 0, y: 0, rotation: 0, visible: true });
  const [mapUpload, setMapUpload] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mapFileRef = useRef<HTMLInputElement>(null);
  const presetFileRef = useRef<HTMLInputElement>(null);
  const presetMenuRef = useRef<HTMLDivElement>(null);
  const trackMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const engineMenuRef = useRef<HTMLDivElement>(null);

  // Close header dropdowns and slide-out drawers on Esc or outside click
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLeftInspectorOpen(false);
        setGgDiagramOpen(false);
        setCanCockpitOpen(false);
        setEngineMenuOpen(false);
        setPresetMenuOpen(false);
        setTrackMenuOpen(false);
        setExportOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Close header dropdowns on outside click
  useEffect(() => {
    if (!presetMenuOpen && !trackMenuOpen && !exportOpen && !engineMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (presetMenuRef.current && !presetMenuRef.current.contains(target)) {
        setPresetMenuOpen(false);
      }
      if (trackMenuRef.current && !trackMenuRef.current.contains(target)) {
        setTrackMenuOpen(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(target)) {
        setExportOpen(false);
      }
      if (engineMenuRef.current && !engineMenuRef.current.contains(target)) {
        setEngineMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [presetMenuOpen, trackMenuOpen, exportOpen, engineMenuOpen]);

  // Load saved IST27 - TwoTrackSim profile and active session from localStorage on mount
  useEffect(() => {
    try {
      const rawTwoTrack = window.localStorage.getItem(STORAGE_TWOTRACK_KEY);
      let loadedTwoTrack: SavedVehicleProfile | null = null;
      if (rawTwoTrack) {
        const parsed = JSON.parse(rawTwoTrack) as SavedVehicleProfile;
        if (parsed && typeof parsed === 'object') {
          loadedTwoTrack = {
            vehPatch: parsed.vehPatch ?? {},
            ptPatch: { gearRatio: 11.8, ...(parsed.ptPatch ?? {}) },
            lambdaMu: typeof parsed.lambdaMu === 'number' ? parsed.lambdaMu : IST27_TWOTRACK_PRESET.vehicle.tire.lambdaMu,
            regen: typeof parsed.regen === 'boolean' ? parsed.regen : true,
            savedAt: parsed.savedAt,
          };
          setSavedTwoTrack(loadedTwoTrack);
        }
      }

      const rawSession = window.localStorage.getItem(STORAGE_SESSION_KEY);
      if (rawSession) {
        const sess = JSON.parse(rawSession) as {
          presetId?: VehiclePresetId;
          vehPatch?: Partial<Record<VehicleKey, number>>;
          ptPatch?: Partial<Record<PowertrainKey, number>>;
          lambdaMu?: number;
          regen?: boolean;
        };
        if (sess && typeof sess === 'object') {
          if (
            sess.presetId === 'ist26-rwd' ||
            sess.presetId === 'ist27-twotrack' ||
            sess.presetId === 'ist27' ||
            sess.presetId === 'tpsc'
          ) {
            setPresetId(sess.presetId);
            onPresetIdChange?.(sess.presetId);
          }
          if (sess.vehPatch) setVehPatch(sess.vehPatch);
          if (sess.ptPatch) setPtPatch(sess.ptPatch);
          if (typeof sess.lambdaMu === 'number') setLambdaMu(sess.lambdaMu);
          if (typeof sess.regen === 'boolean') setRegen(sess.regen);
        }
      } else if (loadedTwoTrack) {
        setVehPatch(loadedTwoTrack.vehPatch);
        setPtPatch(loadedTwoTrack.ptPatch);
        setLambdaMu(loadedTwoTrack.lambdaMu);
        setRegen(loadedTwoTrack.regen);
      }
    } catch {
      // ignore localStorage read errors
    }

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
    if (m === 'point-mass' || m === 'two-track-open' || m === 'two-track-tv') setModel(m);
    const rl = q.get('line');
    if (rl === 'centerline' || rl === 'optimal') setRacingLineMode(rl);
    const c = q.get('color');
    if (c === 'mode' || c === 'speed' || c === 'latg' || c === 'grip') setColorMode(c);
    const cur = q.get('cursor');
    if (cur) setCursor(Number(cur));
    setHydrated(true);
  }, []);

  // Auto-save active session on every parameter change so edits never disappear on refresh
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        STORAGE_SESSION_KEY,
        JSON.stringify({ presetId, vehPatch, ptPatch, lambdaMu, regen }),
      );
    } catch {
      // ignore quota errors
    }
  }, [hydrated, presetId, vehPatch, ptPatch, lambdaMu, regen]);

  const applyPreset = useCallback(
    (id: VehiclePresetId) => {
      setPresetId(id);
      onPresetIdChange?.(id);
      if (id === 'ist26-rwd') {
        setVehPatch({});
        setPtPatch({});
        setLambdaMu(IST26_RWD_PRESET.vehicle.tire.lambdaMu);
        setRegen(false);
      } else if (id === 'ist27-twotrack') {
        setVehPatch({ ...savedTwoTrack.vehPatch });
        setPtPatch({ ...savedTwoTrack.ptPatch });
        setLambdaMu(savedTwoTrack.lambdaMu);
        setRegen(savedTwoTrack.regen);
      } else if (id === 'tpsc') {
        setVehPatch({});
        setPtPatch({});
        setLambdaMu(TPSC_PRESET.vehicle.tire.lambdaMu);
        setRegen(true);
      } else {
        setVehPatch({});
        setPtPatch({});
        setLambdaMu(IST27_PRESET.vehicle.tire.lambdaMu);
        setRegen(true);
      }
    },
    [savedTwoTrack, onPresetIdChange],
  );

  // Sync when primary top bar changes externalPresetId
  useEffect(() => {
    if (!hydrated || !externalPresetId || externalPresetId === presetId) return;
    applyPreset(externalPresetId);
  }, [hydrated, externalPresetId, presetId, applyPreset]);

  const selectTrackUnified = useCallback((nextTrack: TrackSel) => {
    const isKorfez = KORFEZ_TRACKS.some((t) => t.id === nextTrack);
    setVenue(isKorfez ? 'korfez' : 'fs');
    setTrackSel(nextTrack);
    setTab((prev) => {
      if (isKorfez) return 'korfez';
      return prev === 'korfez' ? 'corners' : prev;
    });
    setCursor(null);
    setPlaying(false);
    if (!isKorfez) setMapUpload(null);
  }, []);

  const saveCurrentToTwoTrack = useCallback(() => {
    const profile: SavedVehicleProfile = {
      vehPatch: { ...vehPatch },
      ptPatch: { ...ptPatch },
      lambdaMu,
      regen,
      savedAt: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setSavedTwoTrack(profile);
    setPresetId('ist27-twotrack');
    onPresetIdChange?.('ist27-twotrack');
    try {
      window.localStorage.setItem(STORAGE_TWOTRACK_KEY, JSON.stringify(profile));
      setPresetMsg(`✓ IST27 - TwoTrackSim kaydedildi (${profile.savedAt})`);
      setTimeout(() => setPresetMsg(null), 3500);
    } catch {
      setPresetMsg('Kaydetme hatası (localStorage)');
    }
  }, [vehPatch, ptPatch, lambdaMu, regen, onPresetIdChange]);

  const basePreset =
    presetId === 'ist26-rwd'
      ? IST26_RWD_PRESET
      : presetId === 'tpsc'
        ? TPSC_PRESET
        : presetId === 'ist27-twotrack'
          ? IST27_TWOTRACK_PRESET
          : IST27_PRESET;

  const veh: VehicleParams = useMemo(() => {
    const base = basePreset.vehicle;
    return { ...base, ...vehPatch, tire: { ...base.tire, lambdaMu } };
  }, [basePreset, vehPatch, lambdaMu]);

  const pt: PowertrainParams = useMemo(() => {
    const base = basePreset.powertrain;
    return { ...base, ...ptPatch, regenEnabled: regen };
  }, [basePreset, ptPatch, regen]);

  const isTwoTrackDirty = useMemo(() => {
    if (presetId !== 'ist27-twotrack') return false;
    return (
      JSON.stringify(vehPatch) !== JSON.stringify(savedTwoTrack.vehPatch) ||
      JSON.stringify(ptPatch) !== JSON.stringify(savedTwoTrack.ptPatch) ||
      Math.abs(lambdaMu - savedTwoTrack.lambdaMu) > 1e-6 ||
      regen !== savedTwoTrack.regen
    );
  }, [presetId, vehPatch, ptPatch, lambdaMu, regen, savedTwoTrack]);

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
  const mathInputs = useMemo(() => {
    if (!mathChannelsOpen) return {};
    return {
      ...ch,
      understeerAngle: ch.understeerDegPerG.map((kus, i) => kus * Math.abs(ch.gLat[i])),
      slipRatio: ch.v.map((v, i) => {
        if (v < 0.5 || ch.pWheelKW[i] === 0) return 0;
        const left = longitudinalCoefficients(dVeh.tire, ch.fzRL[i]);
        const right = longitudinalCoefficients(dVeh.tire, ch.fzRR[i]);
        const forceN = ch.pWheelKW[i] * 1000 / v;
        const targetN = Math.abs(forceN);
        let lower = 0;
        let upper = Math.min(peakSlip(left), peakSlip(right), 1);
        for (let iteration = 0; iteration < 20; iteration++) {
          const slip = (lower + upper) / 2;
          const modeledN = magicFormula(slip, left.B, left.C, left.D, left.E) + magicFormula(slip, right.B, right.C, right.D, right.E);
          if (modeledN < targetN) lower = slip;
          else upper = slip;
        }
        return Math.sign(forceN) * (lower + upper) / 2;
      }),
    };
  }, [ch, dVeh.tire, mathChannelsOpen]);
  const closeMathChannels = useCallback(() => setMathChannelsOpen(false), []);
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
      if (now - lastPush > 16) {
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
      setVenue('fs');
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

  const handleExportDossierMd = () => {
    const b = bundle ?? generateVcuBundle(dVeh, dPt, { map: ctx.map, korfezTrackId: korfezOn ? dTrack.id : undefined });
    const md = generateFsaeDesignReport({
      track: dTrack,
      veh: dVeh,
      pt: dPt,
      lap,
      bundle: b,
      model,
      integrator,
    });
    downloadText(`FSAE_Engineering_Design_Report_${dTrack.id}.md`, md, 'text/markdown');
    setExportOpen(false);
  };

  const handleExportDossierPdf = () => {
    const b = bundle ?? generateVcuBundle(dVeh, dPt, { map: ctx.map, korfezTrackId: korfezOn ? dTrack.id : undefined });
    const md = generateFsaeDesignReport({
      track: dTrack,
      veh: dVeh,
      pt: dPt,
      lap,
      bundle: b,
      model,
      integrator,
    });
    printFsaeDesignReport(md);
    setExportOpen(false);
  };

  const handleExportVcuHeaders = () => {
    const b = bundle ?? generateVcuBundle(dVeh, dPt, { map: ctx.map, korfezTrackId: korfezOn ? dTrack.id : undefined });
    for (const f of b.files) {
      downloadText(f.name, f.content, 'text/x-c');
    }
    setExportOpen(false);
  };

  const handleExportTelemetryCsv = () => {
    downloadText(`ApexLapSim_Telemetry_${dTrack.id}.csv`, lapTelemetryToCsv(lap), 'text/csv');
    setExportOpen(false);
  };

  const pillBase =
    'px-2.5 h-7 inline-flex items-center justify-center rounded-md font-mono text-[11px] uppercase tracking-wider transition select-none whitespace-nowrap border';
  const pillActive = 'bg-slate-800/95 text-cyan-300 border-white/[0.12] shadow-sm';
  const pillIdle = 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]';

  const presetDisplayLabel =
    presetId === 'ist26-rwd'
      ? 'IST26 RWD (3.2:1)'
      : presetId === 'ist27'
        ? 'IST27 Baseline'
        : presetId === 'ist27-twotrack'
          ? 'IST27 TwoTrackSim'
          : 'TPSC Reference';

  const trackDisplayLabel =
    trackSel === 'skidpad'
      ? 'FS Skidpad (75m)'
      : trackSel === 'acceleration'
        ? 'FS Accel (75m)'
        : trackSel === 'autocross'
          ? 'FS Autocross (840m)'
          : trackSel === 'endurance'
            ? 'FS Endurance (1268m)'
            : trackSel === 'itu-havuz'
              ? 'İTÜ Havuz Otoparkı (135m)'
              : trackSel === 'korfez-gp-1950'
                ? 'TOSFED Körfez GP (1950m)'
                : trackSel === 'korfez-karting-950'
                  ? 'Körfez Karting (950m)'
                  : trackSel === 'korfez-fst-1380'
                    ? 'Körfez FST Endurance (1380m)'
                    : customTrack
                      ? `Custom: ${customTrack.name} (${Math.round(customTrack.length)}m)`
                      : `${dTrack.name} (${Math.round(dTrack.length)}m)`;

  return (
    <div className="flex min-h-screen flex-col bg-[#090a0f] text-slate-200">
      {/* ===================================================================== */}
      {/* PHASE 1: PERSISTENT MACOS UNIFIED TOP TOOLBAR (48px Glass Ribbon)      */}
      {/* ===================================================================== */}
      <header className="sticky top-0 z-30 flex h-12 min-h-[48px] max-h-[48px] items-center justify-between gap-2 border-b border-white/[0.08] bg-[#0c0d14]/70 px-3.5 backdrop-blur-xl">
        {/* 1. LEFT GROUP: SIDEBAR TOGGLE, BRANDING & WORKSPACE SWITCHER */}
        <div className="flex shrink-0 items-center gap-2">
          {/* Minimalist Sidebar Toggle Icon [ ◨ ] */}
          <button
            type="button"
            onClick={() => setLeftInspectorOpen((o) => !o)}
            title={leftInspectorOpen ? 'Hide Vehicle Setup Drawer (Esc)' : 'Open Vehicle Setup Drawer'}
            aria-label="Toggle Vehicle Setup Drawer"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition ${
              leftInspectorOpen
                ? 'border-white/[0.16] bg-slate-800/90 text-cyan-300 shadow-sm'
                : 'border-white/[0.06] bg-white/[0.03] text-slate-400 hover:border-white/[0.12] hover:bg-white/[0.06] hover:text-white'
            }`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>

          {/* Brand: "APEX" in crisp white, "LAPSIM" in subtle tracking-wide slate-500 */}
          <div className="flex shrink-0 items-baseline gap-1" title="ApexLapSim — Formula Student Lap Time Simulator">
            <span className="font-mono text-xs font-bold tracking-[0.22em] text-white">APEX</span>
            <span className="font-mono text-xs font-light tracking-widest text-slate-500">LAPSIM</span>
          </div>

          {onOpenHavuzLab && (
            <div
              className="inline-flex shrink-0 items-center rounded-lg border border-white/[0.08] bg-[#11141d]/90 p-0.5 font-mono text-[10px]"
              role="navigation"
              aria-label="Çalışma Alanı Seçimi"
            >
              <span
                className="inline-flex h-6 items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-950/60 px-2 font-semibold uppercase tracking-wider text-cyan-300 shadow-sm"
                title="Şu an buradasınız: Ana Pist Simülatörü (Körfez · FS · Havuz)"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_#22d3ee]" />
                <span className="hidden sm:inline">🏁 Pist Simülatörü</span>
                <span className="sm:hidden">🏁 Pist</span>
              </span>
              <button
                type="button"
                onClick={onOpenHavuzLab}
                title="Tıklayarak İTÜ Havuz Otoparkı Telemetri & SIL Laboratuvarına geçin"
                className="inline-flex h-6 items-center gap-1 rounded-md px-2 font-medium uppercase tracking-wider text-amber-300/90 transition hover:bg-amber-500/15 hover:text-amber-200"
              >
                <span>🅿️ Havuz Lab</span>
                <span>→</span>
              </button>
              {onOpenGuide && (
                <button
                  type="button"
                  onClick={onOpenGuide}
                  title="Çalışma Alanları Rehberi: Neredeyiz ve Nereye Geçebiliriz?"
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  <span>🧭</span>
                  <span className="hidden md:inline">Rehber</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* 2. CENTER CONTEXT SELECTORS (Subtle macOS Popover Buttons) */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" aria-pressed={mathChannelsOpen} onClick={() => setMathChannelsOpen((open) => !open)} className="h-7 rounded-md border border-white/10 bg-white/5 px-2 font-mono text-xs text-slate-200 hover:border-cyan-500/50">
            Math Channels
          </button>
          {/* Vehicle Preset Popover Button */}
          <div className="relative shrink-0" ref={presetMenuRef}>
            <button
              type="button"
              aria-label="Vehicle Preset"
              aria-expanded={presetMenuOpen}
              onClick={() => {
                setPresetMenuOpen((o) => !o);
                setTrackMenuOpen(false);
                setExportOpen(false);
                setEngineMenuOpen(false);
              }}
              title={`Vehicle Preset: ${presetDisplayLabel}`}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#11141d]/90 px-2 font-mono text-xs text-slate-200 outline-none transition hover:border-white/[0.18]"
            >
              <span className="text-[10px] text-slate-500 hidden xl:inline">Vehicle:</span>
              <span className="max-w-[120px] truncate sm:max-w-none font-medium text-white">{presetDisplayLabel}</span>
              <svg
                className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${presetMenuOpen ? 'rotate-180 text-cyan-400' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {presetMenuOpen && (
              <div className="absolute left-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-white/[0.09] bg-[#11141d]/95 p-1.5 shadow-2xl backdrop-blur-xl">
                <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Vehicle Preset
                </div>
                {(
                  [
                    { id: 'ist26-rwd', label: 'IST26 RWD (Cascadia)', badge: '335.5kg · 3.2:1' },
                    { id: 'ist27-twotrack', label: 'IST27 TwoTrackSim', badge: '11.8:1 · Saved' },
                    { id: 'ist27', label: 'IST27 Baseline', badge: '80 kW EV' },
                    { id: 'tpsc', label: 'TPSC Reference', badge: '220+ km/h' },
                  ] as const
                ).map((item) => {
                  const active = presetId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        applyPreset(item.id);
                        setPresetMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs transition ${
                        active
                          ? 'bg-slate-800/95 text-cyan-300 border border-white/[0.1]'
                          : 'border border-transparent text-slate-300 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <span>{item.label}</span>
                      <span className="text-[10px] tabular-nums text-slate-400">{item.badge}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Circuit Selector Popover Button */}
          <div className="relative shrink-0" ref={trackMenuRef}>
            <button
              type="button"
              aria-label="Circuit Selector"
              aria-expanded={trackMenuOpen}
              onClick={() => {
                setTrackMenuOpen((o) => !o);
                setPresetMenuOpen(false);
                setExportOpen(false);
                setEngineMenuOpen(false);
              }}
              title={`Active Circuit: ${dTrack.name} (${fmt(dTrack.length, 0)} m)`}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#11141d]/90 px-2 font-mono text-xs text-slate-200 outline-none transition hover:border-white/[0.18]"
            >
              <span className="text-[10px] text-slate-500 hidden xl:inline">Circuit:</span>
              <span className="max-w-[110px] truncate sm:max-w-none font-medium text-white">{trackDisplayLabel}</span>
              <svg
                className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${trackMenuOpen ? 'rotate-180 text-cyan-400' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {trackMenuOpen && (
              <div className="absolute left-0 top-full z-50 mt-1.5 w-80 rounded-xl border border-white/[0.09] bg-[#11141d]/95 p-1.5 shadow-2xl backdrop-blur-xl">
                <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-cyan-400/90">
                  Formula Student & İTÜ Havuz
                </div>
                {(
                  [
                    { id: 'itu-havuz', label: 'İTÜ Havuz Otoparkı (KDE Loop)', len: '135m' },
                    { id: 'skidpad', label: 'FS Skidpad', len: '75m' },
                    { id: 'acceleration', label: 'FS Accel', len: '75m' },
                    { id: 'autocross', label: 'FS Autocross', len: '840m' },
                    { id: 'endurance', label: 'FS Endurance', len: '1268m' },
                  ] as const
                ).map((t) => {
                  const active = trackSel === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        selectTrackUnified(t.id);
                        setTrackMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs transition ${
                        active
                          ? 'bg-slate-800/95 text-cyan-300 border border-white/[0.1]'
                          : 'border border-transparent text-slate-300 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <span>{t.label}</span>
                      <span className="text-[11px] tabular-nums text-slate-400">{t.len}</span>
                    </button>
                  );
                })}
                {customTrack && (
                  <button
                    type="button"
                    onClick={() => {
                      selectTrackUnified('custom');
                      setTrackMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs transition ${
                      trackSel === 'custom'
                        ? 'bg-slate-800/95 text-cyan-300 border border-white/[0.1]'
                        : 'border border-transparent text-slate-300 hover:bg-white/[0.04] hover:text-white'
                    }`}
                  >
                    <span>Custom: {customTrack.name}</span>
                    <span className="text-[11px] tabular-nums text-slate-400">{Math.round(customTrack.length)}m</span>
                  </button>
                )}

                <div className="my-1 border-t border-white/[0.06]" />
                <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-cyan-400/90">
                  Kocaeli — TOSFED Körfez
                </div>
                {(
                  [
                    { id: 'korfez-gp-1950', label: 'TOSFED Körfez GP', len: '1950m' },
                    { id: 'korfez-karting-950', label: 'TOSFED Körfez Karting', len: '950m' },
                    { id: 'korfez-fst-1380', label: 'TOSFED Körfez FST Endurance', len: '1380m' },
                  ] as const
                ).map((t) => {
                  const active = trackSel === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        selectTrackUnified(t.id);
                        setTrackMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs transition ${
                        active
                          ? 'bg-slate-800/95 text-cyan-300 border border-white/[0.1]'
                          : 'border border-transparent text-slate-300 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <span>{t.label}</span>
                      <span className="text-[11px] tabular-nums text-slate-400">{t.len}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Minimalist Segmented Line Toggle: [ Center | Apex ] */}
          <div
            className="hidden sm:inline-flex items-center rounded-md border border-white/[0.08] bg-[#11141d]/90 p-0.5"
            role="group"
            aria-label="Racing Line Mode"
          >
            <button
              type="button"
              onClick={() => setRacingLineMode('centerline')}
              title="Centerline — Geometric track centerline (n(s) = 0)"
              className={`${pillBase} ${racingLineMode === 'centerline' ? pillActive : pillIdle}`}
            >
              Center
            </button>
            <button
              type="button"
              onClick={() => setRacingLineMode('optimal')}
              title="Optimal Apex — Minimum-Curvature Out-In-Out racing line"
              className={`${pillBase} ${racingLineMode === 'optimal' ? pillActive : pillIdle}`}
            >
              Apex
            </button>
          </div>

          {/* Secondary Settings Popover Button [ ⚙ Engine ▾ ] */}
          <div className="relative shrink-0" ref={engineMenuRef}>
            <button
              type="button"
              aria-label="Engine Settings"
              aria-expanded={engineMenuOpen}
              onClick={() => {
                setEngineMenuOpen((o) => !o);
                setPresetMenuOpen(false);
                setTrackMenuOpen(false);
                setExportOpen(false);
              }}
              title="Solver Engine: Model & ODE Solver Settings"
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 font-mono text-xs transition ${
                engineMenuOpen
                  ? 'border-cyan-500/50 bg-slate-800 text-cyan-300'
                  : 'border-white/[0.08] bg-[#11141d]/90 text-slate-300 hover:border-white/[0.18] hover:text-white'
              }`}
            >
              <span>⚙ Engine</span>
              <span className="hidden md:inline text-[10px] text-slate-400">
                ({model === 'point-mass' ? 'Point' : model === 'two-track-open' ? 'Open' : 'TV'} · {integrator.toUpperCase()})
              </span>
              <svg
                className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${engineMenuOpen ? 'rotate-180 text-cyan-400' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {engineMenuOpen && (
              <div className="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-white/[0.09] bg-[#11141d]/95 p-2 shadow-2xl backdrop-blur-xl">
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Vehicle Dynamics Model
                </div>
                <div className="grid grid-cols-3 gap-1 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setModel('point-mass');
                      setEngineMenuOpen(false);
                    }}
                    title="Point-Mass — Single-track friction-ellipse QSS solver"
                    className={`rounded-md py-1 text-center font-mono text-xs transition ${
                      model === 'point-mass'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-medium'
                        : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
                    }`}
                  >
                    Point
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setModel('two-track-open');
                      setEngineMenuOpen(false);
                    }}
                    title="2-Track Open — 4-corner load transfer with open differential"
                    className={`rounded-md py-1 text-center font-mono text-xs transition ${
                      model === 'two-track-open'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-medium'
                        : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
                    }`}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setModel('two-track-tv');
                      setEngineMenuOpen(false);
                    }}
                    title="2-Track TV — Active direct yaw-moment torque vectoring"
                    className={`rounded-md py-1 text-center font-mono text-xs transition ${
                      model === 'two-track-tv'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-medium'
                        : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
                    }`}
                  >
                    TV
                  </button>
                </div>

                <div className="my-1.5 border-t border-white/[0.06]" />

                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Numerical ODE Solver
                </div>
                <div className="grid grid-cols-2 gap-1 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setIntegrator('rk4');
                      setEngineMenuOpen(false);
                    }}
                    title="RK4 — 4th-Order Runge-Kutta integration in v² domain"
                    className={`rounded-md py-1 text-center font-mono text-xs transition ${
                      integrator === 'rk4'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-medium'
                        : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
                    }`}
                  >
                    RK4
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIntegrator('euler');
                      setEngineMenuOpen(false);
                    }}
                    title="Euler — Explicit 1st-Order Euler integration in v² domain"
                    className={`rounded-md py-1 text-center font-mono text-xs transition ${
                      integrator === 'euler'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-medium'
                        : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
                    }`}
                  >
                    Euler
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 3. RIGHT CONTROLS: G-G DIAGRAM, CAN COCKPIT, SNAPSHOT A & EXPORT */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* G-G Diagram Drawer Toggle */}
          <button
            type="button"
            onClick={() => setGgDiagramOpen((o) => !o)}
            title={ggDiagramOpen ? 'Hide G-G Polar Studio' : 'Open G-G Polar Studio (Friction Ellipse)'}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-xs transition ${
              ggDiagramOpen
                ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                : 'border-white/[0.08] bg-[#11141d]/90 text-slate-300 hover:border-white/[0.18] hover:text-white'
            }`}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="3" x2="12" y2="21" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            <span className="hidden sm:inline">G-G Diagram</span>
          </button>

          {/* CAN Cockpit Drawer Toggle Button */}
          <button
            type="button"
            onClick={() => setCanCockpitOpen((o) => !o)}
            title="Toggle Right Drawer: CAN Bus Monitor (FDCAN1/FDCAN2), Fault Injection & VCU C Codegen"
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-xs transition ${
              canCockpitOpen
                ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.2)]'
                : 'border-white/[0.08] bg-[#11141d]/90 text-slate-300 hover:border-white/[0.18] hover:text-white'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${canCockpitOpen ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-slate-500'}`} />
            <span>⚡ CAN Cockpit</span>
          </button>

          {/* Monospace Execution Telemetry Badge */}
          <span
            className="hidden h-7 items-center rounded-md border border-white/[0.06] bg-[#11141d]/60 px-2 font-mono text-[10px] tabular-nums text-slate-400 2xl:inline-flex"
            title="Solver telemetry: setup (envelope + powertrain tables) + 3-pass QSS solve time"
          >
            {fmt(sim.setupMs, 0)}+{fmt(sim.solveMs, 0)} ms
          </span>

          {/* Snapshot Setup A Button */}
          {!baselineSolved ? (
            <button
              type="button"
              onClick={snapshotBaseline}
              title="Snapshot Setup A — Lock current setup to compare Δt and KPI deltas"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-white/[0.08] bg-[#11141d]/90 px-2 font-mono text-xs text-slate-300 transition hover:border-white/[0.18] hover:text-white"
            >
              <span className="text-cyan-400">⌖</span>
              <span className="hidden xl:inline">Snapshot Setup A</span>
            </button>
          ) : (
            <div className="inline-flex h-7 items-center rounded-md border border-cyan-500/40 bg-cyan-950/40">
              <button
                type="button"
                onClick={snapshotBaseline}
                title={`Locked (Setup A: ${fmtTime(baselineSolved.lap.lapTime)}) — Click to overwrite Setup A`}
                className="inline-flex h-full items-center gap-1 px-2 font-mono text-xs text-cyan-300 transition hover:bg-cyan-900/30"
              >
                <span>⌖</span>
                <span>Setup A</span>
              </button>
              <button
                type="button"
                onClick={() => setBaselineCfg(null)}
                title="Clear Setup A baseline snapshot"
                className="inline-flex h-full items-center border-l border-cyan-500/30 px-1.5 font-mono text-xs text-slate-400 transition hover:text-rose-400"
              >
                ✕
              </button>
            </div>
          )}

          {/* Export Data Dropdown Button */}
          <div className="relative" ref={exportMenuRef}>
            <div className="inline-flex h-7 items-center rounded-md border border-white/[0.09] bg-[#11141d]/90 font-mono text-xs text-slate-200 transition hover:border-white/[0.18]">
              <button
                type="button"
                onClick={handleExportDossierMd}
                title="Export FSAE Engineering Design Report (.md)"
                className="inline-flex h-full items-center gap-1.5 px-2"
              >
                <span className="text-emerald-400">⬇</span>
                <span className="hidden sm:inline">Export</span>
              </button>
              <button
                type="button"
                aria-label="Open Export Menu"
                onClick={() => setExportOpen((o) => !o)}
                title="More export options (.pdf, .md, VCU .h/.c, CSV telemetry)"
                className="inline-flex h-full items-center border-l border-white/[0.08] px-1 hover:bg-white/[0.04]"
              >
                <svg className="h-3 w-3 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>

            {exportOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-white/[0.09] bg-[#11141d]/95 p-1.5 shadow-2xl backdrop-blur-xl">
                <button
                  type="button"
                  onClick={handleExportDossierMd}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs text-emerald-400 transition hover:bg-white/[0.04]"
                >
                  <span>Export FSAE Report</span>
                  <span className="text-[10px] text-slate-500">.md</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportDossierPdf}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs text-slate-200 transition hover:bg-white/[0.04]"
                >
                  <span>Print / Save FSAE Report</span>
                  <span className="text-[10px] text-slate-500">.pdf</span>
                </button>
                <div className="my-1 border-t border-white/[0.06]" />
                <button
                  type="button"
                  onClick={handleExportVcuHeaders}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs text-slate-200 transition hover:bg-white/[0.04]"
                >
                  <span>Export VCU C Header</span>
                  <span className="text-[10px] text-slate-500">.h / .c</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportTelemetryCsv}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs text-slate-200 transition hover:bg-white/[0.04]"
                >
                  <span>Export CSV Telemetry</span>
                  <span className="text-[10px] text-slate-500">.csv</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {venue === 'korfez' && <KorfezFacilityBar />}

      {/* ===================================================================== */}
      {/* PHASE 3: AMBIENT KPI HERO BAR (Low-Opacity Captions & SF Numerals)     */}
      {/* ===================================================================== */}
      <div className="border-b border-white/[0.06] bg-[#090b12]/90 px-4 py-3 backdrop-blur-xl">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:divide-x lg:divide-white/[0.06]">
          {/* 1. LAP TIME */}
          <div className="flex flex-col justify-between pr-0 lg:pr-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400/80">
                LAP TIME ({dTrack.name})
              </span>
              <DeltaBadge
                delta={headline.delta != null ? headline.delta : 0}
                unit="s"
                digits={3}
              />
            </div>
            <div className="mt-1 font-mono text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight text-white drop-shadow-[0_0_20px_rgba(56,189,248,0.2)]">
              {headline.value}
            </div>
            <div className="mt-1 font-mono text-[10px] tabular-nums text-slate-400/80">
              {lap.integrator.toUpperCase()} · {lap.lateralModel} · {racingLineMode === 'optimal' ? 'Optimal Apex' : 'Centerline'}
            </div>
          </div>

          {/* 2. SPEED */}
          <div className="flex flex-col justify-between pl-0 lg:pl-4 pr-0 lg:pr-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400/80">SPEED</span>
              {baselineSolved && (
                <DeltaBadge
                  delta={kph(lap.avgSpeed - baselineSolved.lap.avgSpeed)}
                  unit=" km/h"
                  digits={1}
                  invertGood
                />
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">
                {fmt(kph(lap.avgSpeed), 1)}
              </span>
              <span className="text-xs text-slate-400/70">avg /</span>
              <span className="text-lg font-medium text-cyan-300">{fmt(kph(lap.maxSpeed), 1)}</span>
              <span className="text-xs text-slate-400/70">max km/h</span>
            </div>
            <div className="mt-1 font-mono text-[10px] tabular-nums text-slate-400/80">
              Peak {fmt(lap.peakLatG, 2)}G lat · {fmt(lap.peakLongG, 2)}G accel · {fmt(lap.peakBrakeG, 2)}G brake
            </div>
          </div>

          {/* 3. NET ENERGY */}
          <div className="flex flex-col justify-between pl-0 lg:pl-4 pr-0 lg:pr-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400/80">NET ENERGY</span>
              {baselineSolved && (
                <DeltaBadge
                  delta={(lap.energy.netKWh - baselineSolved.lap.energy.netKWh) * 1000}
                  unit=" Wh"
                  digits={1}
                />
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums">
              <span className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">
                {fmt(lap.energy.netKWh * 1000, 1)}
              </span>
              <span className="text-xs text-slate-400/70">Wh</span>
            </div>
            <div className="mt-1 font-mono text-[10px] tabular-nums text-emerald-400/90">
              {fmt(lap.energy.regenKWh * 1000, 1)} Wh regen ({fmt(lap.energy.dischargeKWh * 1000, 1)} Wh out)
            </div>
          </div>

          {/* 4. COOLING HEAT */}
          <div className="flex flex-col justify-between pl-0 lg:pl-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400/80">COOLING HEAT</span>
              <button
                type="button"
                onClick={() => setBenchmarksOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-slate-300 transition hover:border-white/[0.15] hover:text-white"
              >
                <span>Benchmarks</span>
                <span>{benchmarksOpen ? '▴' : '▾'}</span>
              </button>
            </div>
            <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">
                {fmt(lap.energy.coolingHeatKJ, 1)}
              </span>
              <span className="text-xs text-slate-400/70">kJ</span>
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                Normal
              </span>
            </div>
            <div className="mt-1 font-mono text-[10px] tabular-nums text-slate-400/80">
              + {fmt(lap.energy.batteryLossKJ, 1)} kJ accumulator I²R loss
            </div>
          </div>
        </div>

        {/* Collapsible Secondary Sub-Row: Stint & Analytic Benchmarks */}
        {benchmarksOpen && (
          <div className="mt-3 grid grid-cols-2 gap-2.5 border-t border-white/[0.06] pt-3 sm:grid-cols-4">
            <Kpi
              label="Peak lat / long / brake"
              value={`${fmt(lap.peakLatG, 2)} / ${fmt(lap.peakLongG, 2)} / ${fmt(lap.peakBrakeG, 2)}`}
              unit="G"
              sub={
                lap.hasWheelLift ? (
                  <span className="font-semibold text-rose-400">⚠ Inner Wheel Lift! ({lap.wheelLiftCount} pts)</span>
                ) : (
                  `K_us ${fmt(lap.cornerUndersteerDegPerG, 2)}°/G · SI ${fmt(lap.avgStabilityIndex * 100, 1)}%`
                )
              }
            />
            <Kpi
              label="Skidpad (analytic)"
              value={fmtTime(skid.lapTime)}
              sub={`${fmt(skid.ayG, 3)} G · μ_eff ${fmt(skid.muEffective, 3)}`}
            />
            <Kpi
              label="Accel 75 m (RK4)"
              value={fmtTime(launch.time75)}
              sub={`0–100 ${fmt(launch.time0to100, 2)} s · ${fmt(kph(launch.trapSpeed), 0)} km/h`}
            />
            <Kpi
              label={`Event · ${lap.event.laps} lap${lap.event.laps > 1 ? 's' : ''}`}
              value={fmtTime(lap.event.totalTime)}
              sub={`${fmt(lap.event.totalEnergyKWh, 2)} kWh · ${fmt(lap.event.totalHeatMJ, 2)} MJ heat`}
              accent="text-emerald-300"
            />
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* PHASE 2: COLLAPSIBLE SIDE DRAWERS (FOCUS-FIRST FULL-WIDTH STAGE)      */}
      {/* ===================================================================== */}

      {/* 1. LEFT DRAWER: VEHICLE & SETUP INSPECTOR (Slide-Out Panel - Non-modal) */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[350px] max-w-[90vw] flex-col justify-between border-r border-white/[0.09] bg-[#0c0e17]/95 shadow-2xl backdrop-blur-2xl transition-transform duration-300 ease-out pointer-events-auto ${
          leftInspectorOpen ? 'translate-x-0' : '-translate-x-full !pointer-events-none'
        }`}
        role="dialog"
        aria-label="Vehicle Setup Inspector"
      >
        {/* Drawer Header */}
        <div className="flex h-12 items-center justify-between border-b border-white/[0.08] px-4 font-mono text-xs">
          <div className="flex items-center gap-2">
            <span className="text-cyan-400">◨</span>
            <span className="font-semibold text-white">Vehicle Setup</span>
            {presetId === 'ist27-twotrack' && (
              <span className={`text-[10px] ${isTwoTrackDirty ? 'text-amber-300' : 'text-emerald-400'}`}>
                {isTwoTrackDirty ? '● Unsaved' : '✓ Saved'}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setLeftInspectorOpen(false)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.08] text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
            title="Close Drawer (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 divide-y divide-white/[0.06] overflow-y-auto">
          {/* Profile Persistence Header */}
          <div className="p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                Active Setup Profile
              </span>
              <span className="font-mono text-[10px] text-cyan-300">{presetDisplayLabel}</span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn flex-1 !py-1 text-[10px] border-cyan-500/40 text-cyan-300"
                onClick={saveCurrentToTwoTrack}
                title="Save active setup into IST27 - TwoTrackSim profile"
              >
                💾 Save TwoTrackSim
              </button>
              <button
                type="button"
                className="btn !px-2 !py-1 text-[10px]"
                onClick={() =>
                  downloadText(
                    'IST27-TwoTrackSim-setup.json',
                    JSON.stringify({ name: 'IST27 - TwoTrackSim', vehPatch, ptPatch, lambdaMu, regen, veh, pt }, null, 2),
                    'application/json',
                  )
                }
                title="Export setup as JSON"
              >
                JSON
              </button>
              <button
                type="button"
                className="btn !px-2 !py-1 text-[10px]"
                onClick={() => presetFileRef.current?.click()}
                title="Load setup from JSON"
              >
                Load
              </button>
              <input
                ref={presetFileRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    try {
                      const data = JSON.parse(await f.text());
                      if (data.vehPatch) setVehPatch(data.vehPatch);
                      if (data.ptPatch) setPtPatch(data.ptPatch);
                      if (typeof data.lambdaMu === 'number') setLambdaMu(data.lambdaMu);
                      if (typeof data.regen === 'boolean') setRegen(data.regen);
                      setPresetMsg('✓ JSON profile loaded');
                      setTimeout(() => setPresetMsg(null), 3000);
                    } catch {
                      setPresetMsg('Invalid JSON file');
                    }
                  }
                  e.target.value = '';
                }}
              />
            </div>
            {presetMsg && <div className="mt-1.5 font-mono text-[10px] text-emerald-400">{presetMsg}</div>}
          </div>

          {/* Grouped chassis/aero/powertrain inputs */}
          <VehicleForm
            veh={veh}
            onChange={(k, v) => setVehPatch((p) => ({ ...p, [k]: v }))}
            lambdaMu={lambdaMu}
            onLambdaMu={setLambdaMu}
            lap={lap}
          />

          <PowertrainForm
            pt={pt}
            onChange={(k, v) => setPtPatch((p) => ({ ...p, [k]: v }))}
            onRegen={setRegen}
          />

          <DisclosureGroup
            title="Circuit & Custom CSV"
            badge={`${fmt(dTrack.length, 0)} m`}
            defaultOpen={false}
          >
            <div className="space-y-2 font-mono text-[11px] tabular-nums">
              <div className="text-slate-200">{dTrack.name}</div>
              <div className="text-[10px] text-slate-400">{dTrack.description}</div>
              <div className="grid grid-cols-2 gap-x-2 text-slate-400">
                <span>Length ({racingLineMode === 'optimal' ? 'optimal' : 'center'})</span>
                <span className="text-right text-slate-200">{fmt(dTrack.length, 1)} m</span>
                <span>Track width</span>
                <span className="text-right text-slate-200">{fmt(dTrack.racingLine.trackWidthM, 1)} m</span>
                <span>Corners</span>
                <span className="text-right text-slate-200">{lap.corners.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  Import CSV
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => downloadText(`${dTrack.id}.csv`, trackToCsv(dTrack), 'text/csv')}
                >
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
              {csvMsg && (
                <div className={`text-[10px] ${csvMsg.startsWith('Import failed') ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {csvMsg}
                </div>
              )}
            </div>
          </DisclosureGroup>
        </div>

        {/* Sticky Reset to Defaults */}
        <div className="sticky bottom-0 z-10 border-t border-white/[0.08] bg-[#0c0e17]/95 px-3.5 py-2.5 backdrop-blur-md">
          <button
            type="button"
            onClick={() => applyPreset(presetId)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] py-2 text-xs font-medium text-slate-300 transition hover:border-white/[0.15] hover:bg-white/[0.06] hover:text-white"
          >
            <span>↺</span>
            <span>Reset to Defaults</span>
          </button>
        </div>
      </aside>

      {/* 2. RIGHT DRAWER: G-G POLAR STUDIO (Slide-Out Panel - Non-modal) */}
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-[480px] max-w-[95vw] flex-col border-l border-white/[0.09] bg-[#0c0e17]/95 shadow-2xl backdrop-blur-2xl transition-transform duration-300 ease-out pointer-events-auto ${
          ggDiagramOpen ? 'translate-x-0' : 'translate-x-full !pointer-events-none'
        }`}
        role="dialog"
        aria-label="G-G Polar Studio"
      >
        <div className="flex h-12 items-center justify-between border-b border-white/[0.08] px-4 font-mono text-xs">
          <div className="flex items-center gap-2">
            <span className="text-cyan-400">◎</span>
            <span className="font-semibold text-white">G-G Polar Studio</span>
            <span className="text-[10px] text-slate-400">Friction Ellipse & Operating Points</span>
          </div>
          <button
            type="button"
            onClick={() => setGgDiagramOpen(false)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.08] text-slate-400 transition hover:bg-white/[0.06] hover:text-white"
            title="Close Drawer (Esc)"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <GGDiagram
            lap={lap}
            ctx={ctx}
            cursor={safeCursor}
            baselineLap={baselineSolved?.lap}
            baselineCtx={baselineSolved?.ctx}
          />
        </div>
      </aside>

      {/* 3. CENTER STAGE (100% Full-Width Focus Canvas & Telemetry) */}
      <div className="flex flex-1 flex-col p-3">
        <main className="flex min-w-0 flex-1 flex-col gap-3">
          <Panel
            title="Track Map Canvas"
            right={
              <div className="flex items-center gap-2 font-mono text-[10px] text-slate-400">
                {/* Fixed-width zero-shift cursor telemetry badge */}
                <div className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#11141d]/90 px-2 py-0.5 font-mono text-[10px] tabular-nums text-slate-300 shadow-sm">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      cursor != null && !playing
                        ? 'bg-amber-400 shadow-[0_0_6px_#f59e0b]'
                        : playing
                        ? 'bg-cyan-400 animate-pulse shadow-[0_0_6px_#22d3ee]'
                        : 'bg-slate-500'
                    }`}
                  />
                  <span className="text-[9px] uppercase tracking-wider text-slate-400">
                    {cursor != null && !playing ? 'Hover' : playing ? 'Live' : 'Car'}:
                  </span>
                  <span className="font-medium text-cyan-300">s = {fmt(ch.s[safeCursor ?? 0], 1)} m</span>
                  <span className="text-slate-500">·</span>
                  <span className="font-medium text-white">{fmt(kph(ch.v[safeCursor ?? 0]), 1)} km/h</span>
                </div>
                <span>{dTrack.name} · {fmt(dTrack.length, 1)} m · {lap.corners.length} corners</span>
                <button
                  type="button"
                  onClick={() => setGgDiagramOpen(true)}
                  className="rounded border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-xs text-cyan-300 hover:bg-white/[0.06] transition"
                  title="Open G-G Polar Studio Drawer"
                >
                  ◎ G-G Studio
                </button>
              </div>
            }
            bodyClassName="relative flex h-[560px] lg:h-[620px] flex-col overflow-hidden"
          >
            {korfezOn && (
              <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-1.5 font-mono text-[10px] text-slate-400">
                <span className="uppercase tracking-wider text-cyan-400">Satellite Overlay</span>
                <button
                  type="button"
                  className={`btn !py-0.5 ${mapAlign.visible ? 'btn-active' : ''}`}
                  onClick={() => setMapAlign((m) => ({ ...m, visible: !m.visible }))}
                >
                  {mapAlign.visible ? 'Visible' : 'Hidden'}
                </button>
                <button type="button" className="btn !py-0.5" onClick={() => mapFileRef.current?.click()}>
                  Upload Map
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
                <label className="flex items-center gap-1">
                  Opacity
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(mapAlign.opacity * 100)}
                    onChange={(e) => setMapAlign((m) => ({ ...m, opacity: Number(e.target.value) / 100 }))}
                  />
                </label>
              </div>
            )}

            {/* Full Unobstructed Track Map Canvas with Generous Bottom Clearance */}
            <div className="relative min-h-0 flex-1">
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
                isPlaying={playing}
                mapAlign={korfezOn ? mapAlign : undefined}
                mapSrcOverride={mapUpload}
              />

              {/* Floating Frosted-Glass Canvas HUD Controls */}
              <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center justify-center gap-2.5 rounded-full border border-white/10 bg-slate-900/75 px-4 py-1.5 shadow-2xl backdrop-blur-md whitespace-nowrap">
                {/* Play / Pause Lap */}
                <button
                  type="button"
                  onClick={() => setPlaying((p) => !p)}
                  className={`inline-flex w-28 items-center justify-center gap-1.5 rounded-full py-1 font-mono text-xs font-medium transition ${
                    playing
                      ? 'border border-cyan-500/50 bg-cyan-500/20 text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.3)]'
                      : 'border border-white/[0.1] bg-white/[0.08] text-white hover:bg-white/[0.16]'
                  }`}
                >
                  <span className="w-3 text-center">{playing ? '❚❚' : '▶'}</span>
                  <span>{playing ? 'Pause' : 'Play Lap'}</span>
                </button>

                <div className="h-4 w-[1px] bg-white/[0.12]" />

                {/* Speed Rate Dropdown */}
                <label className="flex items-center gap-1 font-mono text-[11px] text-slate-300">
                  <span className="text-[10px] text-slate-400">Speed:</span>
                  <select
                    className="rounded-md border border-white/[0.1] bg-[#0c0e17]/90 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white outline-none cursor-pointer"
                    value={playRate}
                    onChange={(e) => setPlayRate(Number(e.target.value))}
                  >
                    {[0.5, 1, 2, 4].map((r) => (
                      <option key={r} value={r}>
                        {r}x
                      </option>
                    ))}
                  </select>
                </label>

                <div className="h-4 w-[1px] bg-white/[0.12]" />

                {/* Color Mode Segmented Pill */}
                <div
                  className="flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-[#090a0f]/80 p-0.5 font-mono text-[10px]"
                  role="group"
                  aria-label="Color Mode"
                >
                  {(
                    [
                      { value: 'speed', label: 'Speed' },
                      { value: 'latg', label: 'Lateral G' },
                      { value: 'grip', label: 'Grip' },
                      { value: 'mode', label: 'Mode' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setColorMode(m.value)}
                      className={`rounded-full px-2.5 py-0.5 uppercase tracking-wider transition ${
                        colorMode === m.value
                          ? 'border border-white/[0.14] bg-slate-800 text-cyan-300 font-medium shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <Panel
            title="Synchronized Telemetry Strip"
            right={
              safeCursor != null ? (
                <span className="font-mono text-[10px] normal-case tracking-normal tabular-nums text-cyan-300">
                  s {fmt(ch.s[safeCursor], 1)} m · {fmt(kph(ch.v[safeCursor]), 1)} km/h · {fmt(ch.gLat[safeCursor], 2)} G lat ·{' '}
                  Fz [{fmt(ch.fzFL[safeCursor], 0)}, {fmt(ch.fzFR[safeCursor], 0)}, {fmt(ch.fzRL[safeCursor], 0)}, {fmt(ch.fzRR[safeCursor], 0)}] N ·{' '}
                  K_us {fmt(ch.understeerDegPerG[safeCursor], 2)}°/G
                </span>
              ) : undefined
            }
            bodyClassName="p-2.5"
          >
            <TelemetryCharts
              lap={lap}
              baselineLap={baselineSolved?.lap ?? ghostLap}
              cursorS={safeCursor != null ? ch.s[safeCursor] : null}
              onHoverS={onHoverS}
            />
            {mathChannelsOpen && (
              <MathChannelsDrawer inputs={mathInputs} distance={ch.s} cursorS={safeCursor != null ? ch.s[safeCursor] : null} onClose={closeMathChannels} />
            )}
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
            {tab === 'endurance' && (
              <EndurancePanel
                track={dTrack}
                veh={dVeh}
                pt={dPt}
                model={model}
                integrator={integrator}
                onApplyPowerCap={(kw) => setPtPatch((p) => ({ ...p, batteryPowerLimit: kw * 1000 }))}
              />
            )}
            {tab === 'launch' && <LaunchPanel launch={launch} qssTime={dTrack.kind === 'acceleration' ? lap.lapTime : undefined} />}
            {tab === 'powertrain' && <PowertrainPanel veh={dVeh} pt={dPt} map={ctx.map} />}
            {tab === 'codegen' &&
              (bundle ? (
                <CodegenPanel
                  bundle={bundle}
                  track={dTrack}
                  veh={dVeh}
                  pt={dPt}
                  lap={lap}
                  model={model}
                  integrator={integrator}
                />
              ) : (
                <Busy />
              ))}
          </Panel>
        </main>

        {/* 4. CAN COCKPIT DRAWER (Slide-Out Bottom/Side Drawer) */}
        <CanCockpitDrawer
          open={canCockpitOpen}
          onClose={() => setCanCockpitOpen(false)}
          lap={lap}
          cursor={safeCursor}
          veh={dVeh}
          pt={dPt}
          bundle={bundle}
        />
      </div>

      <footer className="border-t border-white/[0.06] px-4 py-2 font-mono text-[10px] text-slate-500">
        ApexLapSim · Pacejka MF tires · 3-pass QSS solver (Euler / RK4 in v²) · 2-track yaw dynamics (RK4) · FDCAN1/FDCAN2 & MISRA-C VCU export
      </footer>
    </div>
  );
}

function Busy() {
  return <div className="p-6 font-mono text-xs text-slate-400">Computing…</div>;
}
