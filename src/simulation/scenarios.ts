import { LANDING_PAD_OFFSET_LOCAL, PLANET_CONFIG } from '../config/planetConfig';
import {
  DEMO_PAYLOAD_SPEC,
  FAIRING_HALF_SPEC,
  STAGE1_BOOSTER_SPEC,
  STAGE2_UPPER_SPEC,
  buildCompositeConfig,
} from '../config/vehicleConfig';
import {
  buildTangentFrame,
  localPointToECEF,
  localQuatToECEF,
  localVectorToECEF,
} from '../math/coordinates';
import { DEG2RAD, quatFromAxisAngle, rotateVecByQuat, vec3 } from '../math/vec3d';
import { RocketFlightDynamics } from './flightDynamics';
import { PlanetSimulation } from './planetSimulation';
import { SpacecraftEntity, SpacecraftManager } from './spacecraftManager';
import { CAPE_FRAME, LANDING_PAD_TOP_Y } from './terrainHeight';

export type ScenarioId =
  | 'prelaunch'
  | 'initial_ascent'
  | 'post_sep_booster'
  | 'high_alt_booster'
  | 'near_ground_landing'
  | 'upper_stage_orbit'
  | 'satellite_deploy';

export interface FlightScenario {
  id: ScenarioId;
  name: string;
  badge: string;
  isSandbox: boolean;
  description: string;
  recommendedProgramId?: string;
}

export const FLIGHT_SCENARIOS: FlightScenario[] = [
  {
    id: 'prelaunch',
    name: 'Cape Canaveral Prelaunch',
    badge: 'STANDARD',
    isSandbox: false,
    description: 'Full REENTRY-9 orbital stack idle on SLC-40 with full tanks. Normal continuous simulation.',
    recommendedProgramId: 'ex-js-launch',
  },
  {
    id: 'initial_ascent',
    name: 'Initial Ascent (12 km)',
    badge: 'SANDBOX',
    isSandbox: true,
    description: 'Full stack climbing at 12 km ASL, 480 m/s eastward pitch-over, 76% Stage 1 fuel.',
    recommendedProgramId: 'ex-js-telemetry',
  },
  {
    id: 'post_sep_booster',
    name: 'Post-Stage-Separation Booster',
    badge: 'SANDBOX',
    isSandbox: true,
    description: '68 km ASL immediately after MECO & Stage 1 separation. Both S1 Booster (16% fuel) & S2 Upper active.',
    recommendedProgramId: 'ex-js-telemetry',
  },
  {
    id: 'high_alt_booster',
    name: 'High-Altitude Descending Booster',
    badge: 'SANDBOX',
    isSandbox: true,
    description: 'Stage 1 Booster descending at 22 km ASL (~640 m/s) over Cape Canaveral coast with 14% fuel.',
    recommendedProgramId: 'ex-js-landing',
  },
  {
    id: 'near_ground_landing',
    name: 'Near-Ground Landing Practice',
    badge: 'SANDBOX',
    isSandbox: true,
    description: 'Stage 1 Booster positioned 950 m above LZ-1 Recovery Pad descending at -78 m/s (8% fuel).',
    recommendedProgramId: 'ex-js-landing',
  },
  {
    id: 'upper_stage_orbit',
    name: 'Upper-Stage Orbital Flight',
    badge: 'SANDBOX',
    isSandbox: true,
    description: 'Stage 2 Upper Stage + Fairing + Payload in a stable 225 km circular Low Earth Orbit.',
    recommendedProgramId: 'ex-py-telemetry',
  },
  {
    id: 'satellite_deploy',
    name: 'Satellite Deployment (LEO)',
    badge: 'SANDBOX',
    isSandbox: true,
    description: 'Stage 2 in 260 km circular orbit with fairings jettisoned and REENTRY-Sat-1 ready to deploy.',
    recommendedProgramId: 'ex-py-telemetry',
  },
];

/**
 * Loads a valid physical spacecraft state for any of the 7 built-in flight testing scenarios.
 */
export function loadFlightScenario(
  scenarioId: ScenarioId,
  manager: SpacecraftManager,
  planet: PlanetSimulation,
  launchVehicle: import('../config/launchVehicles').LaunchVehicleId = 'falcon9'
): FlightScenario {
  const meta = FLIGHT_SCENARIOS.find((s) => s.id === scenarioId) ?? FLIGHT_SCENARIOS[0];
  planet.reset();
  manager.reset(scenarioId === 'prelaunch' ? launchVehicle : 'falcon9');

  if (scenarioId === 'prelaunch') {
    return meta;
  }

  // Clear default prelaunch stack and construct exact valid scenario craft
  manager.spacecraft = [];

  if (scenarioId === 'initial_ascent') {
    const s2Total = STAGE2_UPPER_SPEC.config.dryMassKg + STAGE2_UPPER_SPEC.config.propellantMassKg;
    const fairMass = FAIRING_HALF_SPEC.config.dryMassKg * 2;
    const satMass = DEMO_PAYLOAD_SPEC.config.dryMassKg + DEMO_PAYLOAD_SPEC.config.propellantMassKg;
    const stackCfg = buildCompositeConfig(
      STAGE1_BOOSTER_SPEC,
      s2Total + fairMass + satMass,
      23.5,
      'REENTRY-9 Stack'
    );
    const dyn = new RocketFlightDynamics(stackCfg, true);
    const frame = buildTangentFrame(28.562, -80.52, 12_000);
    // Pitched 18 degrees eastward (around local -Z)
    const tiltLocal = quatFromAxisAngle({ x: 0, y: 0, z: -1 }, 18 * DEG2RAD);
    const quatECEF = localQuatToECEF(tiltLocal, frame);
    const velECEF = localVectorToECEF({ x: 165, y: 455, z: 0 }, frame);

    dyn.initializeAirborneState(
      frame.originECEF,
      velECEF,
      quatECEF,
      vec3(),
      stackCfg.propellantMassKg * 0.76,
      58,
      true
    );
    dyn.engineIgnited = true;
    dyn.throttle = 1.0;
    dyn.actualThrottle = 1.0;
    dyn.status = 'ASCENT';

    const craft: SpacecraftEntity = {
      id: 'reentry-9-main',
      name: 'REENTRY-9 Stack',
      role: 'stack',
      visuals: {
        hasStage1: true,
        hasStage2: true,
        hasFairingA: true,
        hasFairingB: true,
        hasPayload: true,
        hasLandingGear: true,
        hasGridFins: true,
      },
      dynamics: dyn,
      historyECEF: [{ ...frame.originECEF }],
      storedUpperPropellantKg: STAGE2_UPPER_SPEC.config.propellantMassKg,
      storedPayloadPropellantKg: DEMO_PAYLOAD_SPEC.config.propellantMassKg,
      separationFxTimer: 0,
      separationFxLocalY: 0,
      controllable: true,
    };
    manager.spacecraft.push(craft);
    manager.activeId = craft.id;
    return meta;
  }

  if (scenarioId === 'post_sep_booster') {
    const frame = buildTangentFrame(28.56, -79.85, 68_000);
    const tiltLocal = quatFromAxisAngle({ x: 0, y: 0, z: -1 }, 56 * DEG2RAD);
    const quatECEF = localQuatToECEF(tiltLocal, frame);
    const noseECEF = rotateVecByQuat({ x: 0, y: 1, z: 0 }, quatECEF);

    // 1. Detached Stage 1 Booster (focused)
    const bDyn = new RocketFlightDynamics(STAGE1_BOOSTER_SPEC.config, true);
    const bVel = localVectorToECEF({ x: 1480, y: 820, z: 0 }, frame);
    bDyn.initializeAirborneState(
      frame.originECEF,
      bVel,
      quatECEF,
      vec3(),
      STAGE1_BOOSTER_SPEC.config.propellantMassKg * 0.16,
      152,
      true
    );
    const booster: SpacecraftEntity = {
      id: 'booster-sandbox',
      name: STAGE1_BOOSTER_SPEC.name,
      role: 'booster',
      visuals: { ...STAGE1_BOOSTER_SPEC.visuals },
      dynamics: bDyn,
      historyECEF: [{ ...frame.originECEF }],
      storedUpperPropellantKg: 0,
      storedPayloadPropellantKg: 0,
      separationFxTimer: 1.0,
      separationFxLocalY: 26,
      controllable: true,
    };

    // 2. Stage 2 Upper Stage separating 48 m ahead
    const fairMass = FAIRING_HALF_SPEC.config.dryMassKg * 2;
    const satMass = DEMO_PAYLOAD_SPEC.config.dryMassKg + DEMO_PAYLOAD_SPEC.config.propellantMassKg;
    const s2Cfg = buildCompositeConfig(STAGE2_UPPER_SPEC, fairMass + satMass, 12.2, STAGE2_UPPER_SPEC.name);
    const s2Dyn = new RocketFlightDynamics(s2Cfg, false);
    const s2Pos = {
      x: frame.originECEF.x + noseECEF.x * 52,
      y: frame.originECEF.y + noseECEF.y * 52,
      z: frame.originECEF.z + noseECEF.z * 52,
    };
    const s2Vel = {
      x: bVel.x + noseECEF.x * 4.2,
      y: bVel.y + noseECEF.y * 4.2,
      z: bVel.z + noseECEF.z * 4.2,
    };
    s2Dyn.initializeAirborneState(s2Pos, s2Vel, quatECEF, vec3(), s2Cfg.propellantMassKg, 152, true);

    const upper: SpacecraftEntity = {
      id: 'upper-sandbox',
      name: STAGE2_UPPER_SPEC.name,
      role: 'upper_stage',
      visuals: { ...STAGE2_UPPER_SPEC.visuals },
      dynamics: s2Dyn,
      historyECEF: [{ ...s2Pos }],
      storedUpperPropellantKg: 0,
      storedPayloadPropellantKg: DEMO_PAYLOAD_SPEC.config.propellantMassKg,
      separationFxTimer: 1.0,
      separationFxLocalY: -s2Dyn.comHeightFromBase,
      controllable: true,
    };

    manager.spacecraft.push(booster, upper);
    manager.activeId = booster.id;
    return meta;
  }

  if (scenarioId === 'high_alt_booster') {
    const frame = buildTangentFrame(28.562, -80.42, 22_000);
    // Tail-first retrograde entry orientation
    const quatECEF = frame.localToECEF;
    const velECEF = localVectorToECEF({ x: -240, y: -580, z: 0 }, frame);
    const bDyn = new RocketFlightDynamics(STAGE1_BOOSTER_SPEC.config, true);
    bDyn.initializeAirborneState(
      frame.originECEF,
      velECEF,
      quatECEF,
      vec3(),
      STAGE1_BOOSTER_SPEC.config.propellantMassKg * 0.14,
      385,
      true
    );
    bDyn.setSasMode('RETROGRADE');
    bDyn.status = 'DESCENT';

    const booster: SpacecraftEntity = {
      id: 'booster-reentry',
      name: STAGE1_BOOSTER_SPEC.name,
      role: 'booster',
      visuals: { ...STAGE1_BOOSTER_SPEC.visuals },
      dynamics: bDyn,
      historyECEF: [{ ...frame.originECEF }],
      storedUpperPropellantKg: 0,
      storedPayloadPropellantKg: 0,
      separationFxTimer: 0,
      separationFxLocalY: 0,
      controllable: true,
    };
    manager.spacecraft.push(booster);
    manager.activeId = booster.id;
    return meta;
  }

  if (scenarioId === 'near_ground_landing') {
    // Positioned directly above Cape Canaveral LZ-1 Recovery Pad at 950m AGL!
    const bDyn = new RocketFlightDynamics(STAGE1_BOOSTER_SPEC.config, true);
    const posLocal = {
      x: LANDING_PAD_OFFSET_LOCAL.eastM,
      y: LANDING_PAD_TOP_Y + 950 + STAGE1_BOOSTER_SPEC.config.comHeightFullM,
      z: LANDING_PAD_OFFSET_LOCAL.southM,
    };
    const posECEF = localPointToECEF(posLocal, CAPE_FRAME);
    const velECEF = localVectorToECEF({ x: 0, y: -78, z: 0 }, CAPE_FRAME);
    bDyn.initializeAirborneState(
      posECEF,
      velECEF,
      CAPE_FRAME.localToECEF,
      vec3(),
      STAGE1_BOOSTER_SPEC.config.propellantMassKg * 0.08,
      460,
      true
    );
    bDyn.setSasMode('VERTICAL');
    bDyn.status = 'DESCENT';

    const booster: SpacecraftEntity = {
      id: 'booster-lz1',
      name: STAGE1_BOOSTER_SPEC.name,
      role: 'booster',
      visuals: { ...STAGE1_BOOSTER_SPEC.visuals },
      dynamics: bDyn,
      historyECEF: [{ ...posECEF }],
      storedUpperPropellantKg: 0,
      storedPayloadPropellantKg: 0,
      separationFxTimer: 0,
      separationFxLocalY: 0,
      controllable: true,
    };
    manager.spacecraft.push(booster);
    manager.activeId = booster.id;
    return meta;
  }

  // Circular LEO scenarios (upper_stage_orbit or satellite_deploy)
  const isDeploy = scenarioId === 'satellite_deploy';
  const orbitAltM = isDeploy ? 260_000 : 225_000;
  const rOrbit = PLANET_CONFIG.meanRadiusM + orbitAltM;
  const vCircularInertial = Math.sqrt(PLANET_CONFIG.mu / rOrbit);

  const latDeg = 28.562;
  const lonDeg = -76.5;
  const frame = buildTangentFrame(latDeg, lonDeg, orbitAltM);
  // Subtract Earth's eastward surface rotation at orbit radius so inertial speed equals exact circular velocity!
  const vRotEast = PLANET_CONFIG.rotationRateRadPerSec * rOrbit * Math.cos(latDeg * DEG2RAD);
  const vSurfaceEast = vCircularInertial - vRotEast;

  // Point nose prograde (eastward along +X_local = rotate -90 deg around +Z_local)
  const progradeLocalQ = quatFromAxisAngle({ x: 0, y: 0, z: -1 }, Math.PI / 2);
  const quatECEF = localQuatToECEF(progradeLocalQ, frame);
  const velECEF = localVectorToECEF({ x: vSurfaceEast, y: 0, z: 0 }, frame);

  const fairMass = isDeploy ? 0 : FAIRING_HALF_SPEC.config.dryMassKg * 2;
  const satMass = DEMO_PAYLOAD_SPEC.config.dryMassKg + DEMO_PAYLOAD_SPEC.config.propellantMassKg;
  const s2Cfg = buildCompositeConfig(
    STAGE2_UPPER_SPEC,
    fairMass + satMass,
    isDeploy ? 2.2 : 12.2,
    STAGE2_UPPER_SPEC.name
  );
  const s2Dyn = new RocketFlightDynamics(s2Cfg, false);
  s2Dyn.initializeAirborneState(
    frame.originECEF,
    velECEF,
    quatECEF,
    vec3(),
    s2Cfg.propellantMassKg * (isDeploy ? 0.22 : 0.35),
    540,
    true
  );
  s2Dyn.status = 'SPACEFLIGHT';

  const upper: SpacecraftEntity = {
    id: isDeploy ? 'upper-deploy-leo' : 'upper-orbit-leo',
    name: STAGE2_UPPER_SPEC.name,
    role: 'upper_stage',
    visuals: {
      hasStage1: false,
      hasStage2: true,
      hasFairingA: !isDeploy,
      hasFairingB: !isDeploy,
      hasPayload: true,
      hasLandingGear: false,
      hasGridFins: false,
    },
    dynamics: s2Dyn,
    historyECEF: [{ ...frame.originECEF }],
    storedUpperPropellantKg: 0,
    storedPayloadPropellantKg: DEMO_PAYLOAD_SPEC.config.propellantMassKg,
    separationFxTimer: 0,
    separationFxLocalY: 0,
    controllable: true,
  };

  manager.spacecraft.push(upper);
  manager.activeId = upper.id;
  return meta;
}
