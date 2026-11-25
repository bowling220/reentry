import { LANDING_PAD_OFFSET_LOCAL } from '../config/planetConfig';
import { ecefPointToLocal, ecefVectorToLocal, buildTangentFrameFromECEF } from '../math/coordinates';
import { PlanetSimulation } from '../simulation/planetSimulation';
import { SpacecraftEntity, SpacecraftManager } from '../simulation/spacecraftManager';
import { TelemetrySnapshot } from '../simulation/telemetry';
import { CAPE_FRAME, LANDING_PAD_TOP_Y } from '../simulation/terrainHeight';
import { FLIGHT_API_VERSION, ReentryTelemetry } from './apiTypes';
import { sampleAtmosphere } from '../simulation/atmosphere';

/**
 * Builds a plain, read-only JSON-serializable REENTRY Flight API v1.0.0 telemetry snapshot
 * for a single spacecraft. Exposes zero internal simulation references.
 */
export function buildProgramTelemetry(
  craft: SpacecraftEntity,
  t: TelemetrySnapshot,
  manager: SpacecraftManager,
  planet: PlanetSimulation,
  dt: number
): ReentryTelemetry {
  const dyn = craft.dynamics;
  const pressure = sampleAtmosphere(Math.max(0, t.altitudeASLM)).pressureRatio;
  const stageAction = manager.getNextStageAction(craft);

  // Local East-Up-South velocity
  const localFrame = buildTangentFrameFromECEF(dyn.posECEF);
  const velLocal = ecefVectorToLocal(dyn.velECEF, localFrame);

  // Relative offset to Cape Canaveral LZ-1 Recovery Pad
  const posCape = ecefPointToLocal(dyn.posECEF, CAPE_FRAME);
  const relEastM = LANDING_PAD_OFFSET_LOCAL.eastM - posCape.x;
  const relSouthM = LANDING_PAD_OFFSET_LOCAL.southM - posCape.z;
  const targetDistM = Math.hypot(relEastM, relSouthM);

  return {
    apiVersion: FLIGHT_API_VERSION,
    simTime: planet.planetTimeS,
    met: t.missionElapsedTimeS,
    dt,
    vehicle: {
      id: craft.id,
      name: craft.name,
      role: craft.role,
      status: t.flightStatus,
      massKg: t.totalMassKg,
      propellantKg: t.fuelKg,
      propellantCapacityKg: dyn.config.propellantMassKg,
      propellantFraction: dyn.fuelFraction,
      hasLandingGear: t.hasLandingGear,
      canStage: stageAction.available,
      nextStageLabel: stageAction.label,
    },
    position: {
      altitudeASL: t.altitudeASLM,
      altitudeAGL: t.altitudeAGLM,
      latitudeDeg: t.latitudeDeg,
      longitudeDeg: t.longitudeDeg,
      distanceFromPadM: t.distanceFromLaunchM,
    },
    velocity: {
      vertical: t.verticalVelocityMs,
      horizontal: t.horizontalVelocityMs,
      surfaceSpeed: t.totalVelocityMs,
      inertialSpeed: t.inertialVelocityMs,
      mach: t.machNumber,
      surfaceLocal: {
        east: velLocal.x,
        up: velLocal.y,
        south: velLocal.z,
      },
    },
    attitude: {
      pitchDeg: t.pitchDeg,
      headingDeg: t.yawHeadingDeg,
      rollDeg: t.rollDeg,
      tiltFromVerticalDeg: t.tiltFromVerticalDeg,
      noseLocal: { ...t.noseLocal },
      rightLocal: { ...t.rightLocal },
      angularVelocityBody: {
        x: dyn.angVelBody.x,
        y: dyn.angVelBody.y,
        z: dyn.angVelBody.z,
      },
    },
    acceleration: {
      feltMs2: t.accelerationMs2,
      gForce: t.gForce,
    },
    propulsion: {
      engineIgnited: t.engineIgnited,
      throttle: dyn.actualThrottle,
      thrustN: dyn.currentThrustN,
      availableThrustN: dyn.config.maxThrustSeaLevelN * pressure + dyn.config.maxThrustVacN * (1 - pressure),
      specificImpulseS: dyn.config.ispSeaLevelS * pressure + dyn.config.ispVacS * (1 - pressure),
      minimumThrottle: dyn.config.minThrottle,
    },
    environment: {
      atmosphericDensity: t.atmosphericDensityKgM3,
      dynamicPressurePa: t.dynamicPressureKPa * 1000,
      gravityMs2: t.gravityMs2,
      inSpace: t.inSpace,
      reentryHeat: t.reentryHeatIntensity,
    },
    orbit: {
      valid: t.orbital.valid,
      classification: t.orbital.classification,
      apoapsisM: t.orbital.apoapsisAltM,
      periapsisM: t.orbital.periapsisAltM,
      inclinationDeg: t.orbital.inclinationDeg,
      eccentricity: t.orbital.eccentricity,
      periodS: t.orbital.periodS,
      timeToApoapsisS: t.orbital.timeToApoapsisS,
      timeToPeriapsisS: t.orbital.timeToPeriapsisS,
    },
    controls: {
      sasMode: t.sasMode,
      gearDeployed: t.gearDeployed,
    },
    landingTarget: {
      name: 'LZ-1 Recovery Pad',
      distanceM: targetDistM,
      relativeEastM: relEastM,
      relativeSouthM: relSouthM,
      elevationM: LANDING_PAD_TOP_Y,
    },
  };
}
