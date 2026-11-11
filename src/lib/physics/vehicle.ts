import { DEFAULT_TIRE, lateralCoefficients, type TireParams } from './tire';
import { aerodynamicLoads, sampleRideHeightAero, type AeroRideHeightSetup } from './aero';

export const GRAVITY = 9.81;

/**
 * Vehicle parameter registry. All values are SI (kg, m, N, s) unless the name says otherwise.
 */
export interface VehicleParams {
  name: string;
  mass: number; // kg, including driver
  frontWeightFraction: number; // static fraction of weight on the front axle
  wheelbase: number; // m
  trackWidth: number; // m (front track width; also rear unless trackWidthRear is set)
  trackWidthRear?: number; // m (optional independent rear track width)
  cgHeight: number; // m
  ClA: number; // m^2, downforce coefficient x frontal area
  CdA: number; // m^2, drag coefficient x frontal area
  airDensity: number; // kg/m^3
  aeroBalanceFront: number; // fraction of downforce acting on the front axle
  rollingResistance: number; // Crr [-]
  wheelRadius: number; // m, loaded radius
  yawInertia: number; // kg m^2
  wheelInertia: number; // kg m^2 per driven wheel incl. reflected rotor + gearbox inertia
  rollStiffnessFront: number; // front roll stiffness distribution / LLTD (default 0.52 = 52.0%)
  rollCenterFront: number; // m, front kinematic roll center height (displayed in mm, default 35 mm)
  rollCenterRear: number; // m, rear kinematic roll center height (displayed in mm, default 55 mm)
  camberFront: number; // deg, static front camber (negative = top leaned inward, default -1.8 deg)
  camberRear: number; // deg, static rear camber (negative = top leaned inward, default -1.2 deg)
  rideHeightSensitivity: number; // fraction of aero balance shift per G of longitudinal accel
  rideHeightAero?: AeroRideHeightSetup;
  tire: TireParams;
}

export const DEFAULT_VEHICLE: VehicleParams = {
  name: 'ApexLapSim FS-EV (RWD dual motor)',
  mass: 230,
  frontWeightFraction: 0.47,
  wheelbase: 1.53,
  trackWidth: 1.2,
  cgHeight: 0.26,
  ClA: 3.2,
  CdA: 1.1,
  airDensity: 1.225,
  aeroBalanceFront: 0.45,
  rollingResistance: 0.015,
  wheelRadius: 0.2,
  yawInertia: 110,
  wheelInertia: 0.3,
  rollStiffnessFront: 0.52,
  rollCenterFront: 0.035,
  rollCenterRear: 0.055,
  camberFront: -1.8,
  camberRear: -1.2,
  rideHeightSensitivity: 0.04,
  tire: DEFAULT_TIRE,
};

/** Longitudinal CG location: a = CG to front axle, b = CG to rear axle. */
export function cgLocation(p: VehicleParams): { a: number; b: number } {
  const b = p.wheelbase * p.frontWeightFraction;
  return { a: p.wheelbase - b, b };
}

export function vehicleAero(p: VehicleParams, v: number, ax = 0) {
  const aeroShift = (p.rideHeightSensitivity ?? 0) * (-ax / GRAVITY) * 0.05;
  const balance = Math.max(0.05, Math.min(0.95, p.aeroBalanceFront + aeroShift));
  const nominal = aerodynamicLoads({ clA: p.ClA, cdA: p.CdA, frontFraction: balance }, p.airDensity, v, p.wheelbase);
  const setup = p.rideHeightAero;
  if (!setup) return nominal;

  const transferN = p.mass * ax * p.cgHeight / p.wheelbase;
  const frontCompression = (nominal.downforceN * balance - transferN) / (2 * setup.frontWheelRateNPerM);
  const rearCompression = (nominal.downforceN * (1 - balance) + transferN) / (2 * setup.rearWheelRateNPerM);
  const aero = sampleRideHeightAero(setup.map, setup.staticFrontM - frontCompression, setup.staticRearM - rearCompression);
  return aerodynamicLoads(aero, p.airDensity, v, p.wheelbase);
}

export function downforce(p: VehicleParams, v: number): number {
  return p.rideHeightAero ? vehicleAero(p, v).downforceN : 0.5 * p.airDensity * p.ClA * v * v;
}

export function dragForce(p: VehicleParams, v: number): number {
  return p.rideHeightAero ? vehicleAero(p, v).dragN : 0.5 * p.airDensity * p.CdA * v * v;
}

export function rollingResistanceForce(p: VehicleParams, v: number): number {
  return p.rollingResistance * (p.mass * GRAVITY + downforce(p, v));
}

/** Total longitudinal resistance (aero drag + rolling resistance). */
export function resistanceForce(p: VehicleParams, v: number): number {
  return dragForce(p, v) + rollingResistanceForce(p, v);
}

export interface WheelLoads {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
  /** True if any inner wheel reached 0 N vertical load (wheel lift). */
  wheelLift?: boolean;
  /** Quasi-static body roll angle [deg], positive in left turn (roll to right). */
  rollDeg?: number;
}

/**
 * Effective front lateral load transfer share combining front roll stiffness distribution (LLTD),
 * unsprung/jacking baseline offset, and kinematic roll center heights (rollCenterFront, rollCenterRear).
 */
export function effectiveFrontLateralShare(p: VehicleParams): number {
  const hRcF = p.rollCenterFront ?? 0.035;
  const hRcR = p.rollCenterRear ?? 0.055;
  const hCg = Math.max(0.08, p.cgHeight);
  const rcDelta = (p.frontWeightFraction * (hRcF - 0.035) - (1 - p.frontWeightFraction) * (hRcR - 0.055)) / hCg;
  return Math.max(0.05, Math.min(0.95, p.rollStiffnessFront + 0.03 + rcDelta));
}

/**
 * Quasi-static 4-corner vertical wheel loads (Fz_FL, Fz_FR, Fz_RL, Fz_RR).
 *  - ax > 0 is acceleration (load moves rearwards), ay > 0 is a left turn (load moves to the right).
 *  - Includes longitudinal weight transfer (m * ax * h_cg / L) + aero pitch sensitivity,
 *    and lateral weight transfer proportioned by LLTD (rollStiffnessFront), kinematic roll center
 *    heights (rollCenterFront, rollCenterRear), and track width (t_f, t_r).
 *  - Clamps inner wheel lift at 0 N while conserving total vertical load (sum(Fz) = m*g + F_downforce).
 */
export function wheelLoads(p: VehicleParams, v: number, ax: number, ay: number): WheelLoads {
  const W = p.mass * GRAVITY;
  const aero = vehicleAero(p, v, ax);
  const DF = aero.downforceN;
  const FzTotal = W + DF;
  const longTransfer = (p.mass * ax * p.cgHeight) / p.wheelbase;

  const frontRaw = W * p.frontWeightFraction + DF * aero.frontFraction - longTransfer;
  const front = Math.max(0, Math.min(FzTotal, frontRaw));
  const rear = FzTotal - front;

  const tf = p.trackWidth;
  const tr = p.trackWidthRear ?? p.trackWidth;
  const hRcF = p.rollCenterFront ?? 0.035;
  const hRcR = p.rollCenterRear ?? 0.055;
  const hRc = p.frontWeightFraction * hRcF + (1 - p.frontWeightFraction) * hRcR;
  const hRoll = Math.max(0, p.cgHeight - hRc);

  const shareF = effectiveFrontLateralShare(p);
  const dF = ((p.mass * ay * p.cgHeight) / tf) * shareF;
  const dR = ((p.mass * ay * p.cgHeight) / tr) * (1 - shareF);

  const flUnclamped = front / 2 - dF;
  const rlUnclamped = rear / 2 - dR;
  const liftFront = front > 0 && Math.abs(dF) >= front / 2;
  const liftRear = rear > 0 && Math.abs(dR) >= rear / 2;

  const fl = Math.max(0, Math.min(front, flUnclamped));
  const fr = front - fl;
  const rl = Math.max(0, Math.min(rear, rlUnclamped));
  const rr = rear - rl;

  // Quasi-static roll angle estimate (~1.2 deg/G nominal FS roll gradient scaled by h_roll)
  const rollDeg = (ay / GRAVITY) * (hRoll / 0.215) * 1.15;

  return {
    fl,
    fr,
    rl,
    rr,
    wheelLift: liftFront || liftRear,
    rollDeg,
  };
}

/**
 * Camber cornering stiffness modifier for an axle given static camber [deg] and body roll [deg].
 * Optimal negative camber (~ -1.8 deg) maximizes effective cornering stiffness under cornering roll.
 */
export function camberStiffnessMultiplier(staticCamberDeg: number, rollDeg = 0): number {
  const effCamber = staticCamberDeg + 0.65 * Math.abs(rollDeg);
  const deltaFromOpt = effCamber - (-1.6);
  return Math.max(0.82, Math.min(1.08, 1.03 - 0.012 * deltaFromOpt * deltaFromOpt));
}

export interface CorneringBalanceMetrics {
  /** Front axle cornering stiffness [N/rad]. */
  cf: number;
  /** Rear axle cornering stiffness [N/rad]. */
  cr: number;
  /** Instantaneous understeer gradient K_us [deg/G]. Positive = understeer, negative = oversteer. */
  understeerDegPerG: number;
  /** Yaw stability index (static margin): (b*Cr - a*Cf) / (L*(Cf + Cr)). Positive = stable. */
  stabilityIndex: number;
  /** True if any inner wheel is lifting (Fz == 0). */
  wheelLift: boolean;
  /** Quasi-static body roll angle [deg]. */
  rollDeg: number;
}

/**
 * Evaluates 4-wheel Pacejka load-sensitive cornering stiffnesses, camber effect,
 * instantaneous Understeer Gradient (deg/G) and Yaw Stability Index at state (v, ax, ay).
 */
export function evaluateCorneringBalance(
  p: VehicleParams,
  v: number,
  ax: number,
  ay: number,
): CorneringBalanceMetrics {
  const L = wheelLoads(p, v, ax, ay);
  const { a, b } = cgLocation(p);
  const rollAbs = Math.abs(L.rollDeg ?? 0);

  const cFL = lateralCoefficients(p.tire, L.fl);
  const cFR = lateralCoefficients(p.tire, L.fr);
  const cRL = lateralCoefficients(p.tire, L.rl);
  const cRR = lateralCoefficients(p.tire, L.rr);

  const kCamF = camberStiffnessMultiplier(p.camberFront ?? -1.8, rollAbs);
  const kCamR = camberStiffnessMultiplier(p.camberRear ?? -1.2, rollAbs);

  const cf = Math.max(1e3, (cFL.B * cFL.C * cFL.D + cFR.B * cFR.C * cFR.D) * kCamF);
  const cr = Math.max(1e3, (cRL.B * cRL.C * cRL.D + cRR.B * cRR.C * cRR.D) * kCamR);

  // Effective axle load shares for understeer gradient K_us = (Wf/Cf - Wr/Cr) in deg/G
  const W = p.mass * GRAVITY;
  const Wf = W * p.frontWeightFraction;
  const Wr = W * (1 - p.frontWeightFraction);
  const kusRadPerG = Wf / cf - Wr / cr;
  const understeerDegPerG = (kusRadPerG * 180) / Math.PI;
  const stabilityIndex = (b * cr - a * cf) / (p.wheelbase * (cf + cr));

  return {
    cf,
    cr,
    understeerDegPerG,
    stabilityIndex,
    wheelLift: Boolean(L.wheelLift),
    rollDeg: L.rollDeg ?? 0,
  };
}

/** Top speed limited by the motor speed ceiling (single-speed reduction). */
export function speedFromMotorRpm(p: VehicleParams, rpm: number, gearRatio: number): number {
  return ((rpm * 2 * Math.PI) / 60 / gearRatio) * p.wheelRadius;
}

export function motorRpmFromSpeed(p: VehicleParams, v: number, gearRatio: number): number {
  return ((v / p.wheelRadius) * gearRatio * 60) / (2 * Math.PI);
}

export function cloneVehicle(p: VehicleParams, patch: Partial<VehicleParams> = {}): VehicleParams {
  return { ...p, ...patch, tire: patch.tire ? { ...p.tire, ...patch.tire } : p.tire };
}
