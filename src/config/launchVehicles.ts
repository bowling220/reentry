import { RocketConfig } from './rocketConfig';
import { STAGE1_BOOSTER_SPEC, VisualAssemblyFlags } from './vehicleConfig';

export type LaunchVehicleId = 'falcon9' | 'saturn-v';
export const LAUNCH_VEHICLES = [
  { id: 'falcon9', name: 'Falcon 9 / REENTRY-9' },
  { id: 'saturn-v', name: 'Saturn V / Apollo' },
] as const;

// Educational approximations, based on NASA's Saturn V characteristics and Apollo
// press kits. Upper stages and Apollo are carried as inert mass until separation.
// All vehicles currently use the game's shared Cape Canaveral launch environment.
export const SATURN_HEIGHT_M = 111;
export const SATURN_APOLLO_MASS_KG = 45_400;
export const SATURN_STAGES = [
  { name: 'S-IC', baseM: 0, heightM: 42, diameterM: 10.1, dryKg: 131_000,
    fuelKg: 2_145_000, thrustSL: 33_360_000, thrustVac: 38_700_000, ispSL: 263, ispVac: 304 },
  { name: 'S-II', baseM: 42, heightM: 26, diameterM: 10.1, dryKg: 40_100,
    fuelKg: 443_000, thrustSL: 4_000_000, thrustVac: 5_004_000, ispSL: 340, ispVac: 421 },
  { name: 'S-IVB', baseM: 68, heightM: 18.5, diameterM: 6.6, dryKg: 13_500,
    fuelKg: 107_000, thrustSL: 800_000, thrustVac: 1_023_040, ispSL: 300, ispVac: 421 },
] as const;

export interface SaturnAssembly { stageIndex: number; detached: boolean }

export function saturnVisualFlags(stageIndex: number, detached = false): VisualAssemblyFlags {
  return { hasStage1: stageIndex === 0, hasStage2: !detached && stageIndex < 2,
    hasFairingA: false, hasFairingB: false, hasPayload: !detached,
    hasLandingGear: false, hasGridFins: false };
}

export function saturnConfig(stageIndex: number, detached = false): RocketConfig {
  const stage = SATURN_STAGES[stageIndex];
  const heightM = detached ? stage.heightM : SATURN_HEIGHT_M - stage.baseM;
  const upperMass = detached ? 0 : SATURN_APOLLO_MASS_KG + SATURN_STAGES
    .slice(stageIndex + 1).reduce((sum, s) => sum + s.dryKg + s.fuelKg, 0);
  return { ...STAGE1_BOOSTER_SPEC.config,
    id: `saturn-v-${stage.name}`, name: `Saturn V ${stage.name}${detached ? ' (Spent)' : ' + Apollo'}`,
    dryMassKg: stage.dryKg + upperMass, propellantMassKg: stage.fuelKg,
    heightM, diameterM: stage.diameterM,
    comHeightFullM: heightM * 0.42, comHeightDryM: heightM * 0.5,
    maxThrustSeaLevelN: stage.thrustSL, maxThrustVacN: stage.thrustVac,
    ispSeaLevelS: stage.ispSL, ispVacS: stage.ispVac,
    minThrottle: 0.7, maxGimbalDeg: 5,
    rollTorqueNm: 4_000_000, rcsPitchYawTorqueNm: 3_000_000,
    axialAreaM2: Math.PI * (stage.diameterM / 2) ** 2,
    lateralAreaM2: stage.diameterM * heightM,
  };
}
