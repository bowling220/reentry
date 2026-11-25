import { PLANET_CONFIG } from '../config/planetConfig';
import { RocketConfig } from '../config/rocketConfig';
import {
  buildTangentFrameFromECEF,
  ecefPointToLocal,
  ecefQuatToLocal,
  ecefToGeodetic,
  ecefVectorToLocal,
  localPointToECEF,
  localQuatToECEF,
  localVectorToECEF,
} from '../math/coordinates';
import {
  DEG2RAD,
  Quatd,
  RAD2DEG,
  Vec3d,
  addScaledVec3,
  addVec3,
  clamp,
  conjQuat,
  crossVec3,
  dotVec3,
  integrateQuatBodyRate,
  lenVec3,
  normQuat,
  normVec3,
  quatIdentity,
  rotateVecByQuat,
  scaleVec3,
  vec3,
} from '../math/vec3d';
import { sampleAtmosphere } from './atmosphere';
import { computeGravityECEF } from './gravity';
import { LocalPhysicsWorld } from './localPhysics';
import { PlanetSimulation } from './planetSimulation';
import { CAPE_FRAME, LAUNCH_MOUNT_TOP_Y, getSurfaceElevationAtECEF } from './terrainHeight';

export type FlightStatus =
  | 'PRELAUNCH'
  | 'IGNITION'
  | 'ASCENT'
  | 'SPACEFLIGHT'
  | 'DESCENT'
  | 'LANDED'
  | 'CRASHED';

export type SasMode = 'OFF' | 'HOLD' | 'RETROGRADE' | 'VERTICAL';

export interface FlightControlInput {
  pitch: number;
  yaw: number;
  roll: number;
  throttleDelta: number;
  setThrottle: number | null;
  ignitePressed: boolean;
  toggleGearPressed: boolean;
  toggleSasPressed: boolean;
  cycleSasModePressed?: boolean;
}

export const NEUTRAL_FLIGHT_INPUT: FlightControlInput = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttleDelta: 0,
  setThrottle: null,
  ignitePressed: false,
  toggleGearPressed: false,
  toggleSasPressed: false,
  cycleSasModePressed: false,
};

/**
 * Independent 6-DOF aerospace flight physics engine.
 *
 * Phase 3 upgrades:
 * - 4th-order Runge-Kutta (RK4) planetary orbital propagator for long-duration orbit stability
 *   under up to 1000x time warp without energy drift.
 * - Multistage in-place reconfiguration & mid-air detached spacecraft initialization.
 * - Game-oriented stability assistance modes (HOLD / RETROGRADE / VERTICAL) for approachable
 *   manual booster reentry and propulsive landing attempts.
 * - Physical aerothermal reentry heating estimation (0..1) for reentry plasma VFX.
 */
export class RocketFlightDynamics {
  public config: RocketConfig;
  public comHeightFromBase: number;
  public hasLandingGear = true;

  // Global double-precision ECEF state (CoM position)
  public posECEF: Vec3d = vec3();
  public velECEF: Vec3d = vec3();
  public quatECEF: Quatd = quatIdentity();
  public angVelBody: Vec3d = vec3();

  public lastTotalAccelECEF: Vec3d = vec3();
  public lastFeltAccelMs2 = 9.81;
  /** Normalized convective reentry heating intensity (0..1) */
  public reentryHeatIntensity = 0;

  // Propulsion & vehicle states
  public propellantKg: number;
  public engineIgnited = false;
  public throttle = 0;
  public actualThrottle = 0;
  public currentThrustN = 0;
  public gimbalPitchRad = 0;
  public gimbalYawRad = 0;

  // Mechanisms & assists
  public gearDeployed = false;
  public gearDeployProgress = 0;
  public sasEnabled = true;
  public sasMode: SasMode = 'HOLD';

  // Flight status & mission clock
  public status: FlightStatus = 'PRELAUNCH';
  public missionElapsedTimeS = 0;
  public hasLiftedOff = false;
  public inGroundContact = true;
  public maxAltitudeM = 0;
  public crashFlashTimer = 0;

  // Audio/UI one-frame event flags
  public justIgnited = false;
  public justShutdown = false;
  public justLanded = false;
  public justCrashed = false;

  private localPhysics: LocalPhysicsWorld;
  private usingLocalPhysics = true;
  private holdDownClampsActive = true;

  private static readonly LOCAL_HANDOFF_ENTER_ALT_M = 450;
  private static readonly LOCAL_HANDOFF_EXIT_ALT_M = 520;

  constructor(config: RocketConfig, hasLandingGear = true) {
    this.config = config;
    this.hasLandingGear = hasLandingGear;
    this.comHeightFromBase = config.comHeightFullM;
    this.propellantKg = config.propellantMassKg;
    this.localPhysics = new LocalPhysicsWorld(config, this.comHeightFromBase);
    this.reset();
  }

  public get totalMassKg(): number {
    return this.config.dryMassKg + this.propellantKg;
  }

  public get fuelFraction(): number {
    if (this.config.propellantMassKg <= 0) return 0;
    return clamp(this.propellantKg / this.config.propellantMassKg, 0, 1);
  }

  public get isPhysicsUnstableForWarp(): boolean {
    return (
      this.usingLocalPhysics ||
      this.actualThrottle > 0.01 ||
      this.inGroundContact ||
      this.status === 'CRASHED' ||
      this.getAltitudeASL() < PLANET_CONFIG.karmanLineM ||
      lenVec3(this.angVelBody) > 0.35
    );
  }

  public getBasePositionECEF(): Vec3d {
    const downBody = rotateVecByQuat({ x: 0, y: -this.comHeightFromBase, z: 0 }, this.quatECEF);
    return addVec3(this.posECEF, downBody);
  }

  public getAltitudeASL(): number {
    const basePos = this.getBasePositionECEF();
    return lenVec3(basePos) - PLANET_CONFIG.meanRadiusM;
  }

  public getAltitudeAGL(): number {
    const basePos = this.getBasePositionECEF();
    const asl = lenVec3(basePos) - PLANET_CONFIG.meanRadiusM;
    const terrainY = getSurfaceElevationAtECEF(basePos);
    return Math.max(0, asl - terrainY);
  }

  public reset(): void {
    this.propellantKg = this.config.propellantMassKg;
    this.engineIgnited = false;
    this.throttle = 0;
    this.actualThrottle = 0;
    this.currentThrustN = 0;
    this.gimbalPitchRad = 0;
    this.gimbalYawRad = 0;
    this.gearDeployed = false;
    this.gearDeployProgress = 0;
    this.sasEnabled = true;
    this.sasMode = 'HOLD';
    this.status = 'PRELAUNCH';
    this.missionElapsedTimeS = 0;
    this.hasLiftedOff = false;
    this.inGroundContact = true;
    this.holdDownClampsActive = true;
    this.maxAltitudeM = 0;
    this.crashFlashTimer = 0;
    this.reentryHeatIntensity = 0;
    this.lastTotalAccelECEF = vec3();
    this.lastFeltAccelMs2 = PLANET_CONFIG.surfaceGravity;
    this.clearEventFlags();

    const startLocalPos = { x: 0, y: LAUNCH_MOUNT_TOP_Y + this.comHeightFromBase, z: 0 };
    this.posECEF = localPointToECEF(startLocalPos, CAPE_FRAME);
    this.velECEF = vec3();
    this.quatECEF = CAPE_FRAME.localToECEF;
    this.angVelBody = vec3();

    this.localPhysics.anchorFrame(this.posECEF, true);
    this.localPhysics.setLandingGearDeployed(false);
    this.localPhysics.setMassProperties(this.totalMassKg);
    this.localPhysics.setKinematicState(startLocalPos, vec3(), quatIdentity(), vec3());
    this.usingLocalPhysics = true;
  }

  /**
   * Initialize a newly separated spacecraft directly in flight inheriting parent position & momentum.
   */
  public initializeAirborneState(
    posECEF: Vec3d,
    velECEF: Vec3d,
    quatECEF: Quatd,
    angVelBody: Vec3d,
    propellantKg: number,
    missionElapsedTimeS: number,
    sasEnabled: boolean
  ): void {
    this.posECEF = { ...posECEF };
    this.velECEF = { ...velECEF };
    this.quatECEF = normQuat(quatECEF);
    this.angVelBody = { ...angVelBody };
    this.propellantKg = clamp(propellantKg, 0, this.config.propellantMassKg);
    this.missionElapsedTimeS = missionElapsedTimeS;
    this.engineIgnited = false;
    this.throttle = 0;
    this.actualThrottle = 0;
    this.currentThrustN = 0;
    this.gimbalPitchRad = 0;
    this.gimbalYawRad = 0;
    this.hasLiftedOff = true;
    this.holdDownClampsActive = false;
    this.inGroundContact = false;
    this.sasEnabled = sasEnabled;
    this.sasMode = sasEnabled ? 'HOLD' : 'OFF';
    this.maxAltitudeM = Math.max(0, this.getAltitudeASL());
    this.status = this.maxAltitudeM >= PLANET_CONFIG.karmanLineM ? 'SPACEFLIGHT' : 'ASCENT';
    this.usingLocalPhysics = false;
    this.clearEventFlags();

    if (this.getAltitudeAGL() < RocketFlightDynamics.LOCAL_HANDOFF_ENTER_ALT_M) {
      this.enterLocalPhysicsMode();
    }
  }

  /**
   * Reconfigure this spacecraft's physical config & propellant in place (e.g. after staging or fairing jettison)
   * without breaking momentum, orientation, or floating-origin continuity.
   */
  public reconfigureStage(
    newConfig: RocketConfig,
    newPropellantKg: number,
    comShiftAlongBodyY: number,
    hasLandingGear: boolean,
    cutEngine: boolean
  ): void {
    // Shift CoM along body +Y so the visual hardware stays pinned at the exact same physical location!
    if (Math.abs(comShiftAlongBodyY) > 1e-4) {
      const shiftECEF = rotateVecByQuat({ x: 0, y: comShiftAlongBodyY, z: 0 }, this.quatECEF);
      this.posECEF = addVec3(this.posECEF, shiftECEF);
    }

    this.config = newConfig;
    this.comHeightFromBase = newConfig.comHeightFullM;
    this.hasLandingGear = hasLandingGear;
    this.propellantKg = clamp(newPropellantKg, 0, newConfig.propellantMassKg);
    if (!hasLandingGear) {
      this.gearDeployed = false;
      this.gearDeployProgress = 0;
    }
    if (cutEngine) {
      this.engineIgnited = false;
      this.throttle = 0;
      this.actualThrottle = 0;
      this.currentThrustN = 0;
    }

    this.localPhysics = new LocalPhysicsWorld(this.config, this.comHeightFromBase);
    if (this.usingLocalPhysics) {
      this.enterLocalPhysicsMode();
    }
  }

  public clearEventFlags(): void {
    this.justIgnited = false;
    this.justShutdown = false;
    this.justLanded = false;
    this.justCrashed = false;
  }

  public triggerLaunchOrIgnition(): void {
    if (this.status === 'CRASHED') return;
    if (this.propellantKg <= 0 || this.config.maxThrustVacN <= 0) return;

    if (!this.engineIgnited) {
      this.engineIgnited = true;
      this.justIgnited = true;
      if (this.throttle < 0.15) {
        this.throttle = this.status === 'PRELAUNCH' ? 1.0 : 0.65;
      }
      if (this.status === 'PRELAUNCH') {
        this.status = 'IGNITION';
      }
    } else if (this.status === 'PRELAUNCH' || this.status === 'IGNITION') {
      this.throttle = 1.0;
    }
  }

  public setLandingGear(deployed: boolean): void {
    if (!this.hasLandingGear || this.status === 'CRASHED') return;
    this.gearDeployed = deployed;
    this.localPhysics.setLandingGearDeployed(deployed);
  }

  public setSasMode(mode: SasMode): void {
    this.sasMode = mode;
    this.sasEnabled = mode !== 'OFF';
  }

  public toggleSas(): void {
    this.sasEnabled = !this.sasEnabled;
    if (!this.sasEnabled) {
      this.sasMode = 'OFF';
    } else if (this.sasMode === 'OFF') {
      this.sasMode = 'HOLD';
    }
  }

  public cycleSasMode(): SasMode {
    const order: SasMode[] = ['HOLD', 'RETROGRADE', 'VERTICAL', 'OFF'];
    const idx = order.indexOf(this.sasMode);
    const next = order[(idx + 1) % order.length];
    this.setSasMode(next);
    return next;
  }

  public step(dt: number, input: FlightControlInput, planet: PlanetSimulation): void {
    this.clearEventFlags();

    if (this.crashFlashTimer > 0) {
      this.crashFlashTimer = Math.max(0, this.crashFlashTimer - dt);
    }

    // Handle discrete toggles
    if (input.toggleGearPressed) {
      this.setLandingGear(!this.gearDeployed);
    }
    if (input.toggleSasPressed) {
      this.toggleSas();
    }
    if (input.cycleSasModePressed) {
      this.cycleSasMode();
    }
    if (input.ignitePressed) {
      this.triggerLaunchOrIgnition();
    }

    // Animate landing gear deployment progress (3.2 s full swing)
    const targetGear = this.hasLandingGear && this.gearDeployed ? 1 : 0;
    const gearRate = 1 / 3.2;
    if (this.gearDeployProgress < targetGear) {
      this.gearDeployProgress = Math.min(targetGear, this.gearDeployProgress + gearRate * dt);
    } else if (this.gearDeployProgress > targetGear) {
      this.gearDeployProgress = Math.max(targetGear, this.gearDeployProgress - gearRate * dt);
    }

    const wasIgnited = this.engineIgnited;

    // Throttle adjustments
    if (this.status !== 'CRASHED' && this.config.maxThrustVacN > 0) {
      if (input.setThrottle !== null) {
        this.throttle = clamp(input.setThrottle, 0, 1);
        if (this.throttle <= 0.001) {
          this.engineIgnited = false;
        } else if (this.propellantKg > 0 && !this.engineIgnited && input.setThrottle > 0.5) {
          this.engineIgnited = true;
        }
      } else if (input.throttleDelta !== 0) {
        this.throttle = clamp(this.throttle + input.throttleDelta * 0.55 * dt, 0, 1);
        if (this.throttle <= 0.001) {
          this.engineIgnited = false;
        }
      }
    } else {
      this.throttle = 0;
      this.engineIgnited = false;
    }

    // Propellant starvation cuts engine
    if (this.propellantKg <= 0.1) {
      this.propellantKg = 0;
      this.engineIgnited = false;
      this.throttle = 0;
    }

    if (!wasIgnited && this.engineIgnited) this.justIgnited = true;
    if (wasIgnited && !this.engineIgnited) this.justShutdown = true;

    // Engine spool dynamics
    const targetActual =
      this.engineIgnited && this.propellantKg > 0
        ? Math.max(this.config.minThrottle, this.throttle)
        : 0;
    const spoolRate = targetActual > this.actualThrottle ? 2.8 : 4.5;
    this.actualThrottle += clamp(targetActual - this.actualThrottle, -spoolRate * dt, spoolRate * dt);
    if (this.actualThrottle < 0.002 && targetActual === 0) {
      this.actualThrottle = 0;
    }

    const altASL = this.getAltitudeASL();
    const altAGL = this.getAltitudeAGL();
    const atmo = sampleAtmosphere(Math.max(0, altASL));
    const gravityECEF = computeGravityECEF(this.posECEF);

    // Thrust & mass flow
    const pRatio = atmo.pressureRatio;
    const maxThrustNow =
      this.config.maxThrustVacN * (1 - pRatio) + this.config.maxThrustSeaLevelN * pRatio;
    const ispNow =
      this.config.ispVacS * (1 - pRatio) + this.config.ispSeaLevelS * pRatio;

    this.currentThrustN = this.actualThrottle * maxThrustNow;
    if (this.currentThrustN > 0 && ispNow > 1) {
      const massFlowKgS = this.currentThrustN / (ispNow * PLANET_CONFIG.surfaceGravity);
      this.propellantKg = Math.max(0, this.propellantKg - massFlowKgS * dt);
    }

    const mass = Math.max(10, this.totalMassKg);
    const gravityMag = lenVec3(gravityECEF);

    // Launchpad hold-down clamps
    if (this.holdDownClampsActive) {
      if (this.currentThrustN > mass * gravityMag * 1.03) {
        this.holdDownClampsActive = false;
        this.hasLiftedOff = true;
        this.status = 'ASCENT';
      } else {
        if (this.engineIgnited) {
          this.missionElapsedTimeS += dt;
          this.status = 'IGNITION';
        }
        this.lastTotalAccelECEF = vec3();
        this.lastFeltAccelMs2 = gravityMag;
        this.reentryHeatIntensity = 0;
        return;
      }
    }

    if (this.hasLiftedOff && this.status !== 'CRASHED' && this.status !== 'LANDED') {
      this.missionElapsedTimeS += dt;
    }

    // Attitude & SAS commands
    const maxGimbalRad = this.config.maxGimbalDeg * DEG2RAD;
    let pitchCmd = clamp(input.pitch, -1, 1);
    let yawCmd = clamp(input.yaw, -1, 1);
    let rollCmd = clamp(input.roll, -1, 1);

    const hasManualAttitude =
      Math.abs(pitchCmd) > 0.05 || Math.abs(yawCmd) > 0.05 || Math.abs(rollCmd) > 0.05;

    if (this.sasEnabled && this.status !== 'CRASHED' && !this.inGroundContact) {
      const dampingGain = 2.6;
      const effectiveMode = this.sasMode === 'OFF' ? 'HOLD' : this.sasMode;

      // Optional recovery guidance target vector (RETROGRADE or VERTICAL) when stick is centered
      let guidePitch = 0;
      let guideYaw = 0;
      if (!hasManualAttitude && (effectiveMode === 'RETROGRADE' || effectiveMode === 'VERTICAL')) {
        let targetDirECEF: Vec3d | null = null;
        if (effectiveMode === 'VERTICAL') {
          targetDirECEF = normVec3(this.posECEF);
        } else if (effectiveMode === 'RETROGRADE') {
          const spd = lenVec3(this.velECEF);
          if (spd > 8.0) {
            targetDirECEF = scaleVec3(this.velECEF, -1 / spd);
          } else {
            targetDirECEF = normVec3(this.posECEF);
          }
        }
        if (targetDirECEF) {
          const targetBody = rotateVecByQuat(targetDirECEF, conjQuat(this.quatECEF));
          // Body +Y is nose: positive targetBody.z requires positive X rotation (pitchCmd < 0),
          // positive targetBody.x requires negative Z rotation (yawCmd < 0)
          guidePitch = clamp(-targetBody.z * 2.2, -0.7, 0.7);
          guideYaw = clamp(-targetBody.x * 2.2, -0.7, 0.7);
        }
      }

      if (Math.abs(pitchCmd) < 0.05) {
        pitchCmd = clamp(guidePitch + this.angVelBody.x * dampingGain, -0.8, 0.8);
      }
      if (Math.abs(yawCmd) < 0.05) {
        yawCmd = clamp(guideYaw - this.angVelBody.z * dampingGain, -0.8, 0.8);
      }
      if (Math.abs(rollCmd) < 0.05) {
        rollCmd = clamp(this.angVelBody.y * dampingGain, -0.8, 0.8);
      }
    }

    // Smooth gimbal actuator
    const targetGimbalPitch = pitchCmd * maxGimbalRad;
    const targetGimbalYaw = yawCmd * maxGimbalRad;
    const gimbalSpeed = 12 * dt;
    this.gimbalPitchRad += clamp(targetGimbalPitch - this.gimbalPitchRad, -gimbalSpeed, gimbalSpeed);
    this.gimbalYawRad += clamp(targetGimbalYaw - this.gimbalYawRad, -gimbalSpeed, gimbalSpeed);

    const thrustDirBody = normVec3({
      x: Math.sin(this.gimbalYawRad),
      y: Math.cos(this.gimbalPitchRad) * Math.cos(this.gimbalYawRad),
      z: Math.sin(this.gimbalPitchRad),
    });
    const thrustBodyN = scaleVec3(thrustDirBody, this.currentThrustN);
    const thrustECEF = rotateVecByQuat(thrustBodyN, this.quatECEF);

    // Aerodynamic drag & reentry aerothermal heating
    const speed = lenVec3(this.velECEF);
    const { dragECEF, aeroRestoreTorqueBody } = this.computeAeroForces(
      this.velECEF,
      atmo.densityKgM3,
      atmo.speedOfSoundMs
    );

    // Convective reentry heating visual indicator (Sutton-Graves ~ sqrt(rho) * v^3)
    if (atmo.densityKgM3 > 1e-7 && speed > 950 && altASL < 95_000) {
      const heatFlux = Math.sqrt(atmo.densityKgM3) * Math.pow(speed / 1000, 3);
      // Starts visibly glowing around Mach 3.5+ in upper/mid atmosphere, peaks during orbital reentry
      this.reentryHeatIntensity = clamp((heatFlux - 0.14) / 1.45, 0, 1);
    } else {
      this.reentryHeatIntensity = Math.max(0, this.reentryHeatIntensity - dt * 1.5);
    }

    // Torques in body frame
    const leverArmM = this.comHeightFromBase * 0.85;
    const gimbalTorqueBody: Vec3d = {
      x: -thrustBodyN.z * leverArmM,
      y: 0,
      z: thrustBodyN.x * leverArmM,
    };

    const rcsFactor = this.status === 'CRASHED' ? 0 : 1;
    const rcsTorqueBody: Vec3d = {
      x: -pitchCmd * this.config.rcsPitchYawTorqueNm * rcsFactor,
      y: -rollCmd * this.config.rollTorqueNm * rcsFactor,
      z: yawCmd * this.config.rcsPitchYawTorqueNm * rcsFactor,
    };

    const angAeroDamp = atmo.densityKgM3 * Math.max(8_000, this.config.lateralAreaM2 * 520);
    const torqueBody: Vec3d = {
      x: gimbalTorqueBody.x + rcsTorqueBody.x + aeroRestoreTorqueBody.x - this.angVelBody.x * angAeroDamp,
      y: rcsTorqueBody.y - this.angVelBody.y * angAeroDamp * 0.4,
      z: gimbalTorqueBody.z + rcsTorqueBody.z + aeroRestoreTorqueBody.z - this.angVelBody.z * angAeroDamp,
    };

    const omega = planet.getAngularVelocityECEF();
    const coriolisAcc = scaleVec3(crossVec3(omega, this.velECEF), -2);
    const centrifugalAcc = scaleVec3(crossVec3(omega, crossVec3(omega, this.posECEF)), -1);

    const gravForceECEF = scaleVec3(gravityECEF, mass);
    const nonInertialForceECEF = scaleVec3(addVec3(coriolisAcc, centrifugalAcc), mass);
    const totalForceECEF = addVec3(
      addVec3(gravForceECEF, thrustECEF),
      addVec3(dragECEF, nonInertialForceECEF)
    );

    const nonGravAccECEF = scaleVec3(addVec3(thrustECEF, dragECEF), 1 / mass);
    this.lastTotalAccelECEF = scaleVec3(totalForceECEF, 1 / mass);
    this.lastFeltAccelMs2 = this.inGroundContact
      ? Math.max(gravityMag, lenVec3(nonGravAccECEF))
      : lenVec3(nonGravAccECEF);

    // Local Rapier vs Global RK4 Orbital Handoff
    if (this.usingLocalPhysics && altAGL > RocketFlightDynamics.LOCAL_HANDOFF_EXIT_ALT_M) {
      this.usingLocalPhysics = false;
      this.inGroundContact = false;
    } else if (!this.usingLocalPhysics && altAGL < RocketFlightDynamics.LOCAL_HANDOFF_ENTER_ALT_M) {
      this.enterLocalPhysicsMode();
    }

    if (this.usingLocalPhysics) {
      this.stepLocalRapier(dt, totalForceECEF, torqueBody, mass);
    } else {
      this.stepGlobalOrbitalRK4(dt, thrustECEF, torqueBody, mass, omega);
    }

    const newAltASL = this.getAltitudeASL();
    const newAltAGL = this.getAltitudeAGL();
    if (newAltASL > this.maxAltitudeM) {
      this.maxAltitudeM = newAltASL;
    }
    this.updateFlightStatus(newAltASL, newAltAGL);
  }

  private computeAeroForces(
    velECEF: Vec3d,
    densityKgM3: number,
    speedOfSoundMs: number
  ): { dragECEF: Vec3d; aeroRestoreTorqueBody: Vec3d } {
    const speed = lenVec3(velECEF);
    if (densityKgM3 <= 1e-8 || speed <= 0.2) {
      return { dragECEF: vec3(), aeroRestoreTorqueBody: vec3() };
    }

    const qDyn = 0.5 * densityKgM3 * speed * speed;
    const velDirECEF = scaleVec3(velECEF, 1 / speed);
    const velDirBody = rotateVecByQuat(velDirECEF, conjQuat(this.quatECEF));

    const axialComponent = Math.abs(velDirBody.y);
    const lateralComponent = Math.hypot(velDirBody.x, velDirBody.z);

    const mach = speed / Math.max(100, speedOfSoundMs);
    const transonicBump = Math.exp(-Math.pow((mach - 1.05) / 0.35, 2));
    const cdAxial =
      this.config.cdAxialSubsonic +
      (this.config.cdAxialTransonic - this.config.cdAxialSubsonic) * transonicBump;

    const gearDragArea = this.gearDeployProgress * 11.5;

    const dragMag =
      qDyn *
      (axialComponent * cdAxial * (this.config.axialAreaM2 + gearDragArea) +
        lateralComponent * this.config.cdLateral * this.config.lateralAreaM2);
    const dragECEF = scaleVec3(velDirECEF, -dragMag);

    const copOffsetM = -2.2;
    const aeroTorqueScale = -qDyn * 18.0 * copOffsetM;
    const aeroRestoreTorqueBody: Vec3d = {
      x: clamp(velDirBody.z * aeroTorqueScale, -2.5e6, 2.5e6),
      y: 0,
      z: clamp(-velDirBody.x * aeroTorqueScale, -2.5e6, 2.5e6),
    };

    return { dragECEF, aeroRestoreTorqueBody };
  }

  private enterLocalPhysicsMode(): void {
    const localFromCape = ecefPointToLocal(this.posECEF, CAPE_FRAME);
    const nearCape = Math.hypot(localFromCape.x, localFromCape.z) < 8_000;
    this.localPhysics.anchorFrame(this.posECEF, nearCape);
    this.localPhysics.setLandingGearDeployed(this.hasLandingGear && this.gearDeployed);
    this.localPhysics.setMassProperties(this.totalMassKg);
    const frame = this.localPhysics.getFrame();

    const posLocal = ecefPointToLocal(this.posECEF, frame);
    const velLocal = ecefVectorToLocal(this.velECEF, frame);
    const rotLocal = ecefQuatToLocal(this.quatECEF, frame);
    const angVelLocal = rotateVecByQuat(this.angVelBody, rotLocal);

    this.localPhysics.setKinematicState(posLocal, velLocal, rotLocal, angVelLocal);
    this.usingLocalPhysics = true;
  }

  private stepLocalRapier(
    dt: number,
    totalForceECEF: Vec3d,
    torqueBody: Vec3d,
    mass: number
  ): void {
    const frame = this.localPhysics.getFrame();
    this.localPhysics.setMassProperties(mass);

    const prevVelLocal = ecefVectorToLocal(this.velECEF, frame);
    const forceLocal = ecefVectorToLocal(totalForceECEF, frame);
    const rotLocal = ecefQuatToLocal(this.quatECEF, frame);
    const torqueLocal = rotateVecByQuat(torqueBody, rotLocal);

    const snap = this.localPhysics.step(dt, forceLocal, torqueLocal, prevVelLocal);

    this.posECEF = localPointToECEF(snap.positionLocal, frame);
    this.velECEF = localVectorToECEF(snap.velocityLocal, frame);
    this.quatECEF = normQuat(localQuatToECEF(snap.rotationLocal, frame));
    this.angVelBody = rotateVecByQuat(snap.angVelLocal, conjQuat(snap.rotationLocal));

    const justHitGround = snap.inContact && !this.inGroundContact;
    this.inGroundContact = snap.inContact;

    if (snap.inContact && this.hasLiftedOff && this.status !== 'CRASHED') {
      const upLocal = normVec3(this.posECEF);
      const rocketUpECEF = rotateVecByQuat({ x: 0, y: 1, z: 0 }, this.quatECEF);
      const tiltDeg = Math.acos(clamp(dotVec3(upLocal, rocketUpECEF), -1, 1)) * RAD2DEG;

      const preSpeed = lenVec3(prevVelLocal);
      const preVertSpeed = Math.abs(prevVelLocal.y);
      const preHorizSpeed = Math.hypot(prevVelLocal.x, prevVelLocal.z);

      const severeImpact =
        snap.maxImpactSpeedMs > this.config.crashSpeedMs ||
        (justHitGround && preSpeed > this.config.crashSpeedMs) ||
        (justHitGround && this.hasLandingGear && !this.gearDeployed && preVertSpeed > 14.0) ||
        (tiltDeg > 52 && this.getAltitudeAGL() < 35 && preSpeed > 4.0);

      if (severeImpact) {
        this.status = 'CRASHED';
        this.justCrashed = true;
        this.engineIgnited = false;
        this.throttle = 0;
        this.actualThrottle = 0;
        this.crashFlashTimer = 2.5;
      } else if (
        this.actualThrottle < 0.05 &&
        preVertSpeed < this.config.safeLandingVerticalSpeedMs &&
        preHorizSpeed < this.config.safeLandingHorizontalSpeedMs &&
        tiltDeg < this.config.safeLandingTiltDeg &&
        lenVec3(this.velECEF) < 1.2 &&
        this.maxAltitudeM > 25
      ) {
        if (this.status !== 'LANDED') this.justLanded = true;
        this.status = 'LANDED';
      }
    }
  }

  /**
   * 4th-order Runge-Kutta (RK4) planetary orbital integrator in double-precision ECEF.
   * Preserves Keplerian orbital energy cleanly across long orbits and up to 1000x time warp!
   */
  private stepGlobalOrbitalRK4(
    dt: number,
    thrustECEF: Vec3d,
    torqueBody: Vec3d,
    mass: number,
    omega: Vec3d
  ): void {
    const thrustAcc = scaleVec3(thrustECEF, 1 / mass);

    const evalAccel = (r: Vec3d, v: Vec3d): Vec3d => {
      const g = computeGravityECEF(r);
      const cor = scaleVec3(crossVec3(omega, v), -2);
      const cen = scaleVec3(crossVec3(omega, crossVec3(omega, r)), -1);

      const altM = lenVec3(r) - PLANET_CONFIG.meanRadiusM;
      let dragAcc = vec3();
      if (altM < PLANET_CONFIG.atmosphereTopM) {
        const atmo = sampleAtmosphere(Math.max(0, altM));
        if (atmo.densityKgM3 > 1e-9) {
          const { dragECEF } = this.computeAeroForces(v, atmo.densityKgM3, atmo.speedOfSoundMs);
          dragAcc = scaleVec3(dragECEF, 1 / mass);
        }
      }

      return {
        x: g.x + cor.x + cen.x + thrustAcc.x + dragAcc.x,
        y: g.y + cor.y + cen.y + thrustAcc.y + dragAcc.y,
        z: g.z + cor.z + cen.z + thrustAcc.z + dragAcc.z,
      };
    };

    const r0 = this.posECEF;
    const v0 = this.velECEF;

    const a1 = evalAccel(r0, v0);
    const r2 = addScaledVec3(r0, v0, dt * 0.5);
    const v2 = addScaledVec3(v0, a1, dt * 0.5);

    const a2 = evalAccel(r2, v2);
    const r3 = addScaledVec3(r0, v2, dt * 0.5);
    const v3 = addScaledVec3(v0, a2, dt * 0.5);

    const a3 = evalAccel(r3, v3);
    const r4 = addScaledVec3(r0, v3, dt);
    const v4 = addScaledVec3(v0, a3, dt);

    const a4 = evalAccel(r4, v4);

    const dt6 = dt / 6;
    this.posECEF = {
      x: r0.x + (v0.x + 2 * v2.x + 2 * v3.x + v4.x) * dt6,
      y: r0.y + (v0.y + 2 * v2.y + 2 * v3.y + v4.y) * dt6,
      z: r0.z + (v0.z + 2 * v2.z + 2 * v3.z + v4.z) * dt6,
    };
    this.velECEF = {
      x: v0.x + (a1.x + 2 * a2.x + 2 * a3.x + a4.x) * dt6,
      y: v0.y + (a1.y + 2 * a2.y + 2 * a3.y + a4.y) * dt6,
      z: v0.z + (a1.z + 2 * a2.z + 2 * a3.z + a4.z) * dt6,
    };

    // Rotational dynamics in body principal axes
    const r = this.config.diameterM * 0.5;
    const h = this.config.heightM;
    const iPitchYaw = Math.max(100, (1 / 12) * mass * (3 * r * r + h * h));
    const iRoll = Math.max(50, 0.5 * mass * r * r);

    this.angVelBody = {
      x: this.angVelBody.x + (torqueBody.x / iPitchYaw) * dt,
      y: this.angVelBody.y + (torqueBody.y / iRoll) * dt,
      z: this.angVelBody.z + (torqueBody.z / iPitchYaw) * dt,
    };

    const maxSpin = 6.0;
    this.angVelBody.x = clamp(this.angVelBody.x, -maxSpin, maxSpin);
    this.angVelBody.y = clamp(this.angVelBody.y, -maxSpin, maxSpin);
    this.angVelBody.z = clamp(this.angVelBody.z, -maxSpin, maxSpin);

    this.quatECEF = integrateQuatBodyRate(this.quatECEF, this.angVelBody, dt);
    this.inGroundContact = false;
  }

  private updateFlightStatus(altASL: number, altAGL: number): void {
    if (this.status === 'CRASHED' || this.status === 'PRELAUNCH') return;
    // Landing gear can briefly lose contact or slide as Rapier settles. Keep a
    // confirmed touchdown latched through that motion instead of alternating
    // LANDED / ASCENT and emitting a fresh touchdown every physics step.
    if (this.status === 'LANDED' && !this.engineIgnited && altAGL < 5) return;

    const up = normVec3(this.posECEF);
    const vertVel = dotVec3(this.velECEF, up);

    if (
      this.inGroundContact &&
      this.actualThrottle < 0.05 &&
      lenVec3(this.velECEF) < 0.8 &&
      this.maxAltitudeM > 20
    ) {
      if (this.status !== 'LANDED') this.justLanded = true;
      this.status = 'LANDED';
      return;
    }

    if (altASL >= PLANET_CONFIG.karmanLineM) {
      this.status = 'SPACEFLIGHT';
    } else if (vertVel < -3.0 && altAGL > 5) {
      this.status = 'DESCENT';
    } else if (this.hasLiftedOff) {
      this.status = 'ASCENT';
    }
  }

  public getLocalAttitudeDeg(): {
    pitchDeg: number;
    headingDeg: number;
    rollDeg: number;
    tiltFromVerticalDeg: number;
  } {
    const localFrame = buildTangentFrameFromECEF(this.posECEF);
    const noseECEF = rotateVecByQuat({ x: 0, y: 1, z: 0 }, this.quatECEF);
    const rightECEF = rotateVecByQuat({ x: 1, y: 0, z: 0 }, this.quatECEF);

    const noseLocal = ecefVectorToLocal(noseECEF, localFrame);
    const rightLocal = ecefVectorToLocal(rightECEF, localFrame);

    const pitchDeg = Math.asin(clamp(noseLocal.y, -1, 1)) * RAD2DEG;
    const tiltFromVerticalDeg = 90 - pitchDeg;

    const horizontalNose = Math.hypot(noseLocal.x, noseLocal.z);
    const hasHeading = horizontalNose > 0.01;
    let headingDeg =
      (hasHeading
        ? Math.atan2(noseLocal.x, -noseLocal.z)
        : Math.atan2(rightLocal.z, rightLocal.x)) * RAD2DEG;
    if (headingDeg < 0) headingDeg += 360;
    if (headingDeg > 359.999) headingDeg = 0;

    const referenceRight = hasHeading
      ? normVec3(crossVec3(noseLocal, { x: 0, y: 1, z: 0 }))
      : rightLocal;
    const referenceUp = crossVec3(referenceRight, noseLocal);
    const rollDeg = hasHeading
      ? Math.atan2(dotVec3(rightLocal, referenceUp), dotVec3(rightLocal, referenceRight)) * RAD2DEG
      : 0;

    return { pitchDeg, headingDeg, rollDeg, tiltFromVerticalDeg };
  }

  public getGeodetic() {
    return ecefToGeodetic(this.getBasePositionECEF());
  }
}
