/**
 * Aerospace-inspired Falcon 9 Block 5 class reusable rocket configuration.
 *
 * NOTE: These parameters are realistic aerospace-inspired approximations for Phase 1
 * single-stack flight rather than an exact proprietary SpaceX engineering model.
 * In Phase 1, the full vehicle flies as a unified stack with generous delta-V and
 * throttle range so players can experience liftoff, atmospheric ascent, gravity turns,
 * spaceflight past the Kármán line (100 km), engine restart, and powered landing attempts.
 */
export interface RocketConfig {
  id: string;
  name: string;
  /** Dry structural mass including upper stage & payload fairing (kg) */
  dryMassKg: number;
  /** Usable propellant mass (LOX + RP-1 combined, kg) */
  propellantMassKg: number;
  /** Total vehicle height from engine nozzle exit plane to fairing tip (m) */
  heightM: number;
  /** Core booster fuselage diameter (m) */
  diameterM: number;
  /** Approximate vertical center of mass from base when full (m) */
  comHeightFullM: number;
  /** Approximate vertical center of mass from base when dry (m) */
  comHeightDryM: number;
  /** Maximum vacuum thrust (N) */
  maxThrustVacN: number;
  /** Maximum sea-level thrust (N) */
  maxThrustSeaLevelN: number;
  /** Sea-level specific impulse (s) */
  ispSeaLevelS: number;
  /** Vacuum specific impulse (s) */
  ispVacS: number;
  /** Minimum throttle fraction while engine is ignited (0..1) */
  minThrottle: number;
  /** Maximum engine gimbal deflection angle (degrees) */
  maxGimbalDeg: number;
  /** Attitude control thruster / grid-fin / RCS roll torque (N*m) */
  rollTorqueNm: number;
  /** Reaction control / cold gas pitch & yaw torque for space/coast attitude control (N*m) */
  rcsPitchYawTorqueNm: number;
  /** Reference aerodynamic cross-section area for axial drag (m^2) */
  axialAreaM2: number;
  /** Reference aerodynamic cross-section area for lateral/broadside drag (m^2) */
  lateralAreaM2: number;
  /** Subsonic axial drag coefficient */
  cdAxialSubsonic: number;
  /** Transonic/supersonic peak axial drag coefficient */
  cdAxialTransonic: number;
  /** Lateral broadside drag coefficient */
  cdLateral: number;
  /** Safe touchdown vertical speed limit (m/s) */
  safeLandingVerticalSpeedMs: number;
  /** Safe touchdown horizontal speed limit (m/s) */
  safeLandingHorizontalSpeedMs: number;
  /** Safe touchdown tilt limit from vertical (degrees) */
  safeLandingTiltDeg: number;
  /** Crash impact speed threshold (m/s) */
  crashSpeedMs: number;
}

export const FALCON9_CLASS_CONFIG: RocketConfig = {
  id: 'reentry-f9-block5',
  name: 'REENTRY-9 (Falcon 9 Class)',
  // Full stack ~549,000 kg liftoff mass (~52,000 kg dry + ~497,000 kg propellant)
  // Real F9 first stage thrust ~7,607 kN SL -> TWR ≈ 1.41 at liftoff!
  dryMassKg: 52_000,
  propellantMassKg: 497_000,
  heightM: 70.0,
  diameterM: 3.7,
  comHeightFullM: 25.5,
  comHeightDryM: 21.0,
  maxThrustSeaLevelN: 7_607_000,
  maxThrustVacN: 8_227_000,
  ispSeaLevelS: 282,
  ispVacS: 311,
  minThrottle: 0.08, // Allows single-engine-equivalent low hover thrust for landing tests
  maxGimbalDeg: 7.5,
  rollTorqueNm: 1_800_000,
  rcsPitchYawTorqueNm: 1_400_000,
  axialAreaM2: Math.PI * (3.7 / 2) ** 2,
  lateralAreaM2: 3.7 * 62.0,
  cdAxialSubsonic: 0.34,
  cdAxialTransonic: 0.68,
  cdLateral: 1.15,
  safeLandingVerticalSpeedMs: 12.0,
  safeLandingHorizontalSpeedMs: 8.0,
  safeLandingTiltDeg: 20.0,
  crashSpeedMs: 18.0,
};
