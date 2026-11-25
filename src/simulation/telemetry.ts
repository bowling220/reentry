import { PLANET_CONFIG } from '../config/planetConfig';
import {
  buildTangentFrameFromECEF,
  ecefVectorToLocal,
  surfaceDistanceM,
} from '../math/coordinates';
import { Vec3d, crossVec3, dotVec3, lenVec3, normVec3 } from '../math/vec3d';
import { sampleAtmosphere } from './atmosphere';
import { FlightStatus, RocketFlightDynamics, SasMode } from './flightDynamics';
import { computeGravityMagnitude } from './gravity';
import { OrbitalElements, computeOrbitalElements } from './orbitalMechanics';
import { PlanetSimulation } from './planetSimulation';
import { CAPE_FRAME } from './terrainHeight';

export interface TelemetrySnapshot {
  altitudeASLM: number;
  altitudeAGLM: number;
  verticalVelocityMs: number;
  horizontalVelocityMs: number;
  totalVelocityMs: number;
  inertialVelocityMs: number;
  accelerationMs2: number;
  gForce: number;
  throttlePercent: number;
  fuelPercent: number;
  fuelKg: number;
  totalMassKg: number;
  thrustKN: number;
  engineIgnited: boolean;
  missionElapsedTimeS: number;
  pitchDeg: number;
  yawHeadingDeg: number;
  rollDeg: number;
  tiltFromVerticalDeg: number;
  latitudeDeg: number;
  longitudeDeg: number;
  distanceFromLaunchM: number;
  atmosphericDensityKgM3: number;
  dynamicPressureKPa: number;
  machNumber: number;
  gravityMs2: number;
  flightStatus: FlightStatus;
  sasEnabled: boolean;
  sasMode: SasMode;
  gearDeployed: boolean;
  hasLandingGear: boolean;
  inSpace: boolean;
  reentryHeatIntensity: number;
  orbital: OrbitalElements;
  progradeLocal: Vec3d;
  noseLocal: Vec3d;
  rightLocal: Vec3d;
}

export function computeTelemetry(
  rocket: RocketFlightDynamics,
  planet: PlanetSimulation
): TelemetrySnapshot {
  const geo = rocket.getGeodetic();
  const altASL = rocket.getAltitudeASL();
  const altAGL = rocket.getAltitudeAGL();
  const atmo = sampleAtmosphere(Math.max(0, altASL));
  const gravityMs2 = computeGravityMagnitude(altASL);

  const localFrame = buildTangentFrameFromECEF(rocket.posECEF);
  const velLocal = ecefVectorToLocal(rocket.velECEF, localFrame);

  const verticalVelocityMs = velLocal.y;
  const horizontalVelocityMs = Math.hypot(velLocal.x, velLocal.z);
  const totalVelocityMs = lenVec3(rocket.velECEF);

  const rotVel = crossVec3(planet.getAngularVelocityECEF(), rocket.posECEF);
  const inertialVelocityMs = Math.hypot(
    rocket.velECEF.x + rotVel.x,
    rocket.velECEF.y + rotVel.y,
    rocket.velECEF.z + rotVel.z
  );

  const dynamicPressurePa = 0.5 * atmo.densityKgM3 * totalVelocityMs * totalVelocityMs;
  const machNumber = totalVelocityMs / Math.max(100, atmo.speedOfSoundMs);

  const attitude = rocket.getLocalAttitudeDeg();
  const distanceFromLaunchM = surfaceDistanceM(rocket.posECEF, CAPE_FRAME.originECEF);

  const orbital = computeOrbitalElements(
    rocket.posECEF,
    rocket.velECEF,
    planet.earthRotationRad,
    rocket.status,
    altASL,
    verticalVelocityMs
  );

  const noseECEF = {
    x: 2 * (rocket.quatECEF.x * rocket.quatECEF.y - rocket.quatECEF.w * rocket.quatECEF.z),
    y: 1 - 2 * (rocket.quatECEF.x * rocket.quatECEF.x + rocket.quatECEF.z * rocket.quatECEF.z),
    z: 2 * (rocket.quatECEF.y * rocket.quatECEF.z + rocket.quatECEF.w * rocket.quatECEF.x),
  };
  const rightECEF = {
    x: 1 - 2 * (rocket.quatECEF.y * rocket.quatECEF.y + rocket.quatECEF.z * rocket.quatECEF.z),
    y: 2 * (rocket.quatECEF.x * rocket.quatECEF.y + rocket.quatECEF.w * rocket.quatECEF.z),
    z: 2 * (rocket.quatECEF.x * rocket.quatECEF.z - rocket.quatECEF.w * rocket.quatECEF.y),
  };

  const noseLocal = normVec3(ecefVectorToLocal(noseECEF, localFrame));
  const rightLocal = normVec3(ecefVectorToLocal(rightECEF, localFrame));
  const progradeLocal =
    totalVelocityMs > 1.0 ? normVec3(velLocal) : { x: 0, y: 1, z: 0 };

  void dotVec3;

  return {
    altitudeASLM: altASL,
    altitudeAGLM: altAGL,
    verticalVelocityMs,
    horizontalVelocityMs,
    totalVelocityMs,
    inertialVelocityMs,
    accelerationMs2: rocket.lastFeltAccelMs2,
    gForce: rocket.lastFeltAccelMs2 / PLANET_CONFIG.surfaceGravity,
    throttlePercent: rocket.actualThrottle * 100,
    fuelPercent: rocket.fuelFraction * 100,
    fuelKg: rocket.propellantKg,
    totalMassKg: rocket.totalMassKg,
    thrustKN: rocket.currentThrustN / 1000,
    engineIgnited: rocket.engineIgnited,
    missionElapsedTimeS: rocket.missionElapsedTimeS,
    pitchDeg: attitude.pitchDeg,
    yawHeadingDeg: attitude.headingDeg,
    rollDeg: attitude.rollDeg,
    tiltFromVerticalDeg: attitude.tiltFromVerticalDeg,
    latitudeDeg: geo.latitudeDeg,
    longitudeDeg: geo.longitudeDeg,
    distanceFromLaunchM,
    atmosphericDensityKgM3: atmo.densityKgM3,
    dynamicPressureKPa: dynamicPressurePa / 1000,
    machNumber,
    gravityMs2,
    flightStatus: rocket.status,
    sasEnabled: rocket.sasEnabled,
    sasMode: rocket.sasMode,
    gearDeployed: rocket.gearDeployed,
    hasLandingGear: rocket.hasLandingGear,
    inSpace: altASL >= PLANET_CONFIG.karmanLineM,
    reentryHeatIntensity: rocket.reentryHeatIntensity,
    orbital,
    progradeLocal,
    noseLocal,
    rightLocal,
  };
}
