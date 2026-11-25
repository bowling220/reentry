import { RocketConfig } from './rocketConfig';

export type SpacecraftRole = 'stack' | 'booster' | 'upper_stage' | 'fairing' | 'payload';

export interface VisualAssemblyFlags {
  hasStage1: boolean;
  hasStage2: boolean;
  hasFairingA: boolean;
  hasFairingB: boolean;
  hasPayload: boolean;
  hasLandingGear: boolean;
  hasGridFins: boolean;
}

export interface StageDefinition {
  id: string;
  name: string;
  role: SpacecraftRole;
  /** Physical flight config for this stage when flying independently */
  config: RocketConfig;
  /** Visual components attached to this standalone stage */
  visuals: VisualAssemblyFlags;
  /** Relative vertical offset of this stage's base from the full stack base on the pad (m) */
  stackBaseOffsetM: number;
}

/**
 * Data-driven multistage configuration for REENTRY-9 (Falcon 9 Block 5 inspired orbital stack).
 *
 * Approximations are aerospace-inspired and tuned for educational/playable orbital mechanics:
 * - Stage 1 Booster: 9x Merlin 1D, ~411 t propellant, ~25.6 t dry (generous landing reserve margin)
 * - Stage 2 Upper: 1x Merlin Vacuum, ~107.5 t propellant, ~4.5 t dry, 348 s Vac Isp (~9.6 km/s combined Δv!)
 * - Payload Fairings: Two jettisonable 950 kg composite halves
 * - Demonstration Payload: REENTRY-Sat-1 (650 kg Starlink-class satellite with cold-gas RCS)
 */
export const STAGE1_BOOSTER_SPEC: StageDefinition = {
  id: 'stage1',
  name: 'REENTRY-9 Booster (S1)',
  role: 'booster',
  stackBaseOffsetM: 0,
  visuals: {
    hasStage1: true,
    hasStage2: false,
    hasFairingA: false,
    hasFairingB: false,
    hasPayload: false,
    hasLandingGear: true,
    hasGridFins: true,
  },
  config: {
    id: 'reentry-f9-s1',
    name: 'REENTRY-9 Booster (S1)',
    dryMassKg: 25_600,
    propellantMassKg: 411_000,
    heightM: 46.5,
    diameterM: 3.7,
    comHeightFullM: 18.5,
    comHeightDryM: 14.0,
    maxThrustSeaLevelN: 7_607_000,
    maxThrustVacN: 8_227_000,
    ispSeaLevelS: 282,
    ispVacS: 311,
    minThrottle: 0.055, // Allows single-Merlin-equivalent low hover thrust for manual booster landings
    maxGimbalDeg: 8.0,
    rollTorqueNm: 1_850_000,
    rcsPitchYawTorqueNm: 1_550_000,
    axialAreaM2: Math.PI * (3.7 / 2) ** 2,
    lateralAreaM2: 3.7 * 46.0,
    cdAxialSubsonic: 0.42,
    cdAxialTransonic: 0.78,
    cdLateral: 1.18,
    safeLandingVerticalSpeedMs: 12.0,
    safeLandingHorizontalSpeedMs: 8.5,
    safeLandingTiltDeg: 22.0,
    crashSpeedMs: 18.0,
  },
};

export const STAGE2_UPPER_SPEC: StageDefinition = {
  id: 'stage2',
  name: 'REENTRY-9 Upper Stage (S2)',
  role: 'upper_stage',
  stackBaseOffsetM: 45.2,
  visuals: {
    hasStage1: false,
    hasStage2: true,
    hasFairingA: true,
    hasFairingB: true,
    hasPayload: true,
    hasLandingGear: false,
    hasGridFins: false,
  },
  config: {
    id: 'reentry-f9-s2',
    name: 'REENTRY-9 Upper Stage (S2)',
    dryMassKg: 4_500,
    propellantMassKg: 107_500,
    heightM: 14.0,
    diameterM: 3.7,
    comHeightFullM: 6.4,
    comHeightDryM: 5.5,
    maxThrustSeaLevelN: 520_000,
    maxThrustVacN: 981_000,
    ispSeaLevelS: 220,
    ispVacS: 348,
    minThrottle: 0.2,
    maxGimbalDeg: 6.5,
    rollTorqueNm: 180_000,
    rcsPitchYawTorqueNm: 240_000,
    axialAreaM2: Math.PI * (3.7 / 2) ** 2,
    lateralAreaM2: 3.7 * 14.0,
    cdAxialSubsonic: 0.32,
    cdAxialTransonic: 0.62,
    cdLateral: 1.1,
    safeLandingVerticalSpeedMs: 8.0,
    safeLandingHorizontalSpeedMs: 5.0,
    safeLandingTiltDeg: 15.0,
    crashSpeedMs: 14.0,
  },
};

export const FAIRING_HALF_SPEC: StageDefinition = {
  id: 'fairing',
  name: 'Payload Fairing Half',
  role: 'fairing',
  stackBaseOffsetM: 57.5,
  visuals: {
    hasStage1: false,
    hasStage2: false,
    hasFairingA: true,
    hasFairingB: false,
    hasPayload: false,
    hasLandingGear: false,
    hasGridFins: false,
  },
  config: {
    id: 'reentry-f9-fairing',
    name: 'Payload Fairing Half',
    dryMassKg: 950,
    propellantMassKg: 0,
    heightM: 13.1,
    diameterM: 2.6,
    comHeightFullM: 5.5,
    comHeightDryM: 5.5,
    maxThrustSeaLevelN: 0,
    maxThrustVacN: 0,
    ispSeaLevelS: 1,
    ispVacS: 1,
    minThrottle: 0,
    maxGimbalDeg: 0,
    rollTorqueNm: 0,
    rcsPitchYawTorqueNm: 0,
    axialAreaM2: 8.5,
    lateralAreaM2: 28.0,
    cdAxialSubsonic: 0.85,
    cdAxialTransonic: 1.15,
    cdLateral: 1.4,
    safeLandingVerticalSpeedMs: 12.0,
    safeLandingHorizontalSpeedMs: 10.0,
    safeLandingTiltDeg: 85.0,
    crashSpeedMs: 22.0,
  },
};

export const DEMO_PAYLOAD_SPEC: StageDefinition = {
  id: 'payload',
  name: 'REENTRY-Sat-1 (Payload)',
  role: 'payload',
  stackBaseOffsetM: 58.2,
  visuals: {
    hasStage1: false,
    hasStage2: false,
    hasFairingA: false,
    hasFairingB: false,
    hasPayload: true,
    hasLandingGear: false,
    hasGridFins: false,
  },
  config: {
    id: 'reentry-sat-1',
    name: 'REENTRY-Sat-1 (Payload)',
    dryMassKg: 650,
    propellantMassKg: 85, // Station-keeping Hall/monoprop maneuvering reserve
    heightM: 3.4,
    diameterM: 2.2,
    comHeightFullM: 1.7,
    comHeightDryM: 1.7,
    maxThrustSeaLevelN: 450,
    maxThrustVacN: 1_200,
    ispSeaLevelS: 160,
    ispVacS: 295,
    minThrottle: 0.1,
    maxGimbalDeg: 2.0,
    rollTorqueNm: 1_800,
    rcsPitchYawTorqueNm: 2_400,
    axialAreaM2: 3.8,
    lateralAreaM2: 6.2,
    cdAxialSubsonic: 0.9,
    cdAxialTransonic: 1.2,
    cdLateral: 1.35,
    safeLandingVerticalSpeedMs: 4.0,
    safeLandingHorizontalSpeedMs: 3.0,
    safeLandingTiltDeg: 20.0,
    crashSpeedMs: 8.0,
  },
};

/**
 * Helper to build the combined `RocketConfig` for a connected multistage stack
 * from its active firing stage + any attached upper mass (upper stage, fairings, payload).
 */
export function buildCompositeConfig(
  activeStage: StageDefinition,
  attachedUpperMassKg: number,
  extraHeightM: number,
  displayName: string
): RocketConfig {
  const base = activeStage.config;
  const totalHeight = base.heightM + extraHeightM;
  return {
    ...base,
    name: displayName,
    dryMassKg: base.dryMassKg + attachedUpperMassKg,
    heightM: totalHeight,
    comHeightFullM: base.comHeightFullM + extraHeightM * 0.28,
    comHeightDryM: base.comHeightDryM + extraHeightM * 0.32,
    lateralAreaM2: base.diameterM * totalHeight * 0.92,
  };
}
