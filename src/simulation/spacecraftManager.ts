import { PLANET_CONFIG } from '../config/planetConfig';
import { LaunchVehicleId, SaturnAssembly, SATURN_STAGES, saturnConfig, saturnVisualFlags } from '../config/launchVehicles';
import {
  DEMO_PAYLOAD_SPEC,
  FAIRING_HALF_SPEC,
  STAGE1_BOOSTER_SPEC,
  STAGE2_UPPER_SPEC,
  SpacecraftRole,
  VisualAssemblyFlags,
  buildCompositeConfig,
} from '../config/vehicleConfig';
import {
  Vec3d,
  addScaledVec3,
  addVec3,
  distVec3,
  lenVec3,
  rotateVecByQuat,
} from '../math/vec3d';
import {
  FlightControlInput,
  NEUTRAL_FLIGHT_INPUT,
  RocketFlightDynamics,
} from './flightDynamics';
import { PlanetSimulation } from './planetSimulation';

export interface FlightEventNotice {
  id: number;
  title: string;
  detail: string;
  severity: 'info' | 'success' | 'warning' | 'danger';
  timestamp: number;
}

export interface StageFuelSummary {
  label: string;
  percent: number;
  attached: boolean;
  active: boolean;
}

export interface SpacecraftEntity {
  saturn?: SaturnAssembly;
  id: string;
  name: string;
  role: SpacecraftRole;
  visuals: VisualAssemblyFlags;
  dynamics: RocketFlightDynamics;
  /** Historical flight path breadcrumbs in ECEF (m) */
  historyECEF: Vec3d[];
  /** Stored Stage 2 fuel mass while Stage 2 is still riding atop Stage 1 */
  storedUpperPropellantKg: number;
  /** Stored payload propellant while riding inside Stage 2 */
  storedPayloadPropellantKg: number;
  /** Countdown timer for separation cold-gas puff VFX (seconds) */
  separationFxTimer: number;
  /** Local body-Y coordinate where separation puff emits */
  separationFxLocalY: number;
  /** Whether this craft is controllable by the player */
  controllable: boolean;
}

/**
 * Centralized multi-spacecraft simulation & staging manager.
 *
 * Maintains all active, detached, orbiting, descending, landed, and destroyed spacecraft
 * simultaneously under the shared planetary clock and double-precision ECEF coordinates.
 */
export class SpacecraftManager {
  public launchVehicleId: LaunchVehicleId = 'falcon9';
  public spacecraft: SpacecraftEntity[] = [];
  public activeId = 'reentry-9-main';
  public stagingCooldownS = 0;

  private nextIdCounter = 1;
  private nextEventId = 1;
  private eventQueue: FlightEventNotice[] = [];
  private historySampleTimer = 0;
  private orbitAnnouncedIds = new Set<string>();

  constructor() {
    this.reset();
  }

  public get activeSpacecraft(): SpacecraftEntity {
    return this.spacecraft.find((s) => s.id === this.activeId) ?? this.spacecraft[0];
  }

  public get activeDynamics(): RocketFlightDynamics {
    return this.activeSpacecraft.dynamics;
  }

  public reset(vehicleId: LaunchVehicleId = this.launchVehicleId): void {
    this.launchVehicleId = vehicleId;
    this.spacecraft = [];
    this.nextIdCounter = 1;
    this.stagingCooldownS = 0;
    this.historySampleTimer = 0;
    this.eventQueue = [];
    this.orbitAnnouncedIds.clear();

    if (vehicleId === 'saturn-v') {
      const dynamics = new RocketFlightDynamics(saturnConfig(0), false);
      const craft: SpacecraftEntity = {
        id: 'saturn-v-main', name: 'Saturn V / Apollo', role: 'stack',
        saturn: { stageIndex: 0, detached: false }, visuals: saturnVisualFlags(0),
        dynamics, historyECEF: [{ ...dynamics.posECEF }],
        storedUpperPropellantKg: 0, storedPayloadPropellantKg: 0,
        separationFxTimer: 0, separationFxLocalY: 0, controllable: true,
      };
      this.spacecraft.push(craft);
      this.activeId = craft.id;
      return;
    }

    const s2TotalMass =
      STAGE2_UPPER_SPEC.config.dryMassKg + STAGE2_UPPER_SPEC.config.propellantMassKg;
    const fairingsMass = FAIRING_HALF_SPEC.config.dryMassKg * 2;
    const payloadTotalMass =
      DEMO_PAYLOAD_SPEC.config.dryMassKg + DEMO_PAYLOAD_SPEC.config.propellantMassKg;

    const fullStackConfig = buildCompositeConfig(
      STAGE1_BOOSTER_SPEC,
      s2TotalMass + fairingsMass + payloadTotalMass,
      23.5, // Stage 2 + fairing height atop Stage 1 = 70.0m total
      'REENTRY-9 Orbital Stack'
    );

    const dynamics = new RocketFlightDynamics(fullStackConfig, true);

    const mainCraft: SpacecraftEntity = {
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
      dynamics,
      historyECEF: [{ ...dynamics.posECEF }],
      storedUpperPropellantKg: STAGE2_UPPER_SPEC.config.propellantMassKg,
      storedPayloadPropellantKg: DEMO_PAYLOAD_SPEC.config.propellantMassKg,
      separationFxTimer: 0,
      separationFxLocalY: 0,
      controllable: true,
    };

    this.spacecraft.push(mainCraft);
    this.activeId = mainCraft.id;
  }

  private separateSaturnStage(craft: SpacecraftEntity): boolean {
    const index = craft.saturn!.stageIndex;
    const dyn = craft.dynamics;
    const nose = rotateVecByQuat({ x: 0, y: 1, z: 0 }, dyn.quatECEF);
    const base = dyn.getBasePositionECEF();
    const velocity = { ...dyn.velECEF };
    const spentConfig = saturnConfig(index, true);
    const spent = new RocketFlightDynamics(spentConfig, false);
    spent.initializeAirborneState(
      addScaledVec3(base, nose, spentConfig.comHeightFullM), velocity,
      dyn.quatECEF, dyn.angVelBody, dyn.propellantKg, dyn.missionElapsedTimeS, true
    );
    const nextConfig = saturnConfig(index + 1);
    const offset = SATURN_STAGES[index + 1].baseM - SATURN_STAGES[index].baseM;
    const shift = offset + nextConfig.comHeightFullM - dyn.comHeightFromBase;
    dyn.reconfigureStage(nextConfig, nextConfig.propellantMassKg, shift, false, true);

    // Equal and opposite separation impulses conserve linear momentum, even if
    // the pilot stages early with a substantial amount of propellant remaining.
    const spentMass = spent.totalMassKg;
    const upperMass = dyn.totalMassKg;
    spent.velECEF = addScaledVec3(velocity, nose, -2 * upperMass / (spentMass + upperMass));
    dyn.velECEF = addScaledVec3(velocity, nose, 2 * spentMass / (spentMass + upperMass));
    this.spacecraft.push({
      id: `saturn-spent-${this.nextIdCounter++}`, name: spentConfig.name, role: 'booster',
      saturn: { stageIndex: index, detached: true }, visuals: saturnVisualFlags(index, true),
      dynamics: spent, historyECEF: [{ ...spent.posECEF }],
      storedUpperPropellantKg: 0, storedPayloadPropellantKg: 0,
      separationFxTimer: 1.8, separationFxLocalY: spentConfig.heightM - spent.comHeightFromBase,
      controllable: true,
    });
    craft.saturn = { stageIndex: index + 1, detached: false };
    craft.name = nextConfig.name;
    craft.role = 'upper_stage';
    craft.visuals = saturnVisualFlags(index + 1);
    craft.separationFxTimer = 1.8;
    craft.separationFxLocalY = -dyn.comHeightFromBase;
    this.stagingCooldownS = 1.25;
    this.pushEvent(`${SATURN_STAGES[index].name} SEPARATED`,
      `Press SPACE or Z to ignite ${SATURN_STAGES[index + 1].name}. Spent stage remains in the tracker.`, 'success');
    return true;
  }

  public selectSpacecraft(id: string): boolean {
    const target = this.spacecraft.find((s) => s.id === id);
    if (!target) return false;
    this.activeId = target.id;
    this.pushEvent('VEHICLE FOCUS', `Switched control to ${target.name}`, 'info');
    return true;
  }

  public cycleSpacecraft(direction: 1 | -1): void {
    if (this.spacecraft.length <= 1) return;
    const idx = this.spacecraft.findIndex((s) => s.id === this.activeId);
    const nextIdx = (idx + direction + this.spacecraft.length) % this.spacecraft.length;
    this.selectSpacecraft(this.spacecraft[nextIdx].id);
  }

  public consumeEvents(): FlightEventNotice[] {
    if (this.eventQueue.length === 0) return [];
    const out = [...this.eventQueue];
    this.eventQueue = [];
    return out;
  }

  public pushEvent(
    title: string,
    detail: string,
    severity: FlightEventNotice['severity'] = 'info'
  ): void {
    this.eventQueue.push({
      id: this.nextEventId++,
      title,
      detail,
      severity,
      timestamp: performance.now(),
    });
  }

  /**
   * Describes the next available manual staging action for the currently active spacecraft.
   */
  public getNextStageAction(craft: SpacecraftEntity = this.activeSpacecraft): {
    available: boolean;
    label: string;
    blockedReason: string | null;
  } {
    if (craft.dynamics.status === 'CRASHED') {
      return { available: false, label: 'NO STAGE', blockedReason: 'Vehicle destroyed' };
    }
    if (craft.dynamics.status === 'PRELAUNCH') {
      return { available: false, label: craft.saturn ? 'SEPARATE S-IC' : 'STAGE 1 SEP', blockedReason: 'Liftoff required first' };
    }
    if (this.stagingCooldownS > 0.01) {
      return {
        available: false,
        label: `LOCK ${this.stagingCooldownS.toFixed(1)}s`,
        blockedReason: 'Staging safeguard active',
      };
    }

    if (craft.saturn) {
      const { stageIndex, detached } = craft.saturn;
      return !detached && stageIndex < 2
        ? { available: true, label: `SEPARATE ${SATURN_STAGES[stageIndex].name}`, blockedReason: null }
        : { available: false, label: detached ? 'SPENT STAGE' : 'ALL STAGED', blockedReason: null };
    }
    if (craft.visuals.hasStage1 && craft.visuals.hasStage2) {
      return { available: true, label: 'MECO + SEP STAGE 1', blockedReason: null };
    }
    if (!craft.visuals.hasStage1 && craft.visuals.hasStage2 && (craft.visuals.hasFairingA || craft.visuals.hasFairingB)) {
      return { available: true, label: 'JETTISON FAIRING', blockedReason: null };
    }
    if (!craft.visuals.hasStage1 && craft.visuals.hasStage2 && craft.visuals.hasPayload) {
      return { available: true, label: 'DEPLOY PAYLOAD', blockedReason: null };
    }

    return { available: false, label: 'ALL STAGED', blockedReason: null };
  }

  /**
   * Stage propellant summary for HUD stage indicators.
   */
  public getStageSummaries(craft: SpacecraftEntity = this.activeSpacecraft): StageFuelSummary[] {
    if (craft.saturn) {
      const { stageIndex, detached } = craft.saturn;
      return SATURN_STAGES.slice(stageIndex, detached ? stageIndex + 1 : undefined).map((s, i) => ({
        label: s.name, percent: i === 0 ? craft.dynamics.fuelFraction * 100 : 100,
        attached: true, active: i === 0,
      }));
    }
    const list: StageFuelSummary[] = [];
    if (craft.visuals.hasStage1) {
      list.push({
        label: 'S1 BOOSTER',
        percent: craft.dynamics.fuelFraction * 100,
        attached: true,
        active: true,
      });
    }
    if (craft.visuals.hasStage2) {
      const s2Pct = craft.visuals.hasStage1
        ? (craft.storedUpperPropellantKg / STAGE2_UPPER_SPEC.config.propellantMassKg) * 100
        : craft.dynamics.fuelFraction * 100;
      list.push({
        label: 'S2 UPPER',
        percent: s2Pct,
        attached: true,
        active: !craft.visuals.hasStage1,
      });
    }
    if (craft.visuals.hasFairingA || craft.visuals.hasFairingB) {
      list.push({ label: 'FAIRING', percent: 100, attached: true, active: false });
    }
    if (craft.visuals.hasPayload) {
      const pPct =
        !craft.visuals.hasStage1 && !craft.visuals.hasStage2
          ? craft.dynamics.fuelFraction * 100
          : (craft.storedPayloadPropellantKg / DEMO_PAYLOAD_SPEC.config.propellantMassKg) * 100;
      list.push({
        label: 'PAYLOAD',
        percent: pPct,
        attached: true,
        active: !craft.visuals.hasStage1 && !craft.visuals.hasStage2,
      });
    }
    return list;
  }

  /**
   * Executes manual staging for the active spacecraft with safeguard cooldown.
   * Returns true if a staging separation occurred.
   */
  public triggerStage(): boolean {
    const craft = this.activeSpacecraft;
    const action = this.getNextStageAction(craft);
    if (!action.available) return false;
    if (craft.saturn) return this.separateSaturnStage(craft);

    const dyn = craft.dynamics;
    const noseECEF = rotateVecByQuat({ x: 0, y: 1, z: 0 }, dyn.quatECEF);
    const rightECEF = rotateVecByQuat({ x: 1, y: 0, z: 0 }, dyn.quatECEF);

    // 1. STAGE 1 MECO + SEPARATION
    if (craft.visuals.hasStage1 && craft.visuals.hasStage2) {
      const remainingS1FuelKg = dyn.propellantKg;
      const oldStackBaseECEF = dyn.getBasePositionECEF();
      const oldPosECEF = { ...dyn.posECEF };
      const oldVelECEF = { ...dyn.velECEF };
      const oldQuatECEF = { ...dyn.quatECEF };
      const oldAngVel = { ...dyn.angVelBody };
      const met = dyn.missionElapsedTimeS;

      // Spawn detached Stage 1 Booster at exact physical Stage 1 CoM!
      const s1Dyn = new RocketFlightDynamics(STAGE1_BOOSTER_SPEC.config, true);
      const s1ComECEF = addScaledVec3(oldStackBaseECEF, noseECEF, STAGE1_BOOSTER_SPEC.config.comHeightFullM);
      const s1SepVel = addScaledVec3(oldVelECEF, noseECEF, -2.0);
      s1Dyn.initializeAirborneState(
        s1ComECEF,
        s1SepVel,
        oldQuatECEF,
        oldAngVel,
        remainingS1FuelKg,
        met,
        true
      );

      const boosterEntity: SpacecraftEntity = {
        id: `booster-${this.nextIdCounter++}`,
        name: STAGE1_BOOSTER_SPEC.name,
        role: 'booster',
        visuals: { ...STAGE1_BOOSTER_SPEC.visuals },
        dynamics: s1Dyn,
        historyECEF: [...craft.historyECEF.slice(-60), { ...s1ComECEF }],
        storedUpperPropellantKg: 0,
        storedPayloadPropellantKg: 0,
        separationFxTimer: 1.8,
        separationFxLocalY: STAGE1_BOOSTER_SPEC.config.heightM - STAGE1_BOOSTER_SPEC.config.comHeightFullM,
        controllable: true,
      };
      this.spacecraft.push(boosterEntity);

      // Reconfigure active spacecraft into Stage 2 Upper Stage (+ Fairing + Payload)
      const fairingsMass =
        (craft.visuals.hasFairingA ? FAIRING_HALF_SPEC.config.dryMassKg : 0) +
        (craft.visuals.hasFairingB ? FAIRING_HALF_SPEC.config.dryMassKg : 0);
      const payloadMass = craft.visuals.hasPayload
        ? DEMO_PAYLOAD_SPEC.config.dryMassKg + craft.storedPayloadPropellantKg
        : 0;
      const extraH = craft.visuals.hasFairingA || craft.visuals.hasFairingB ? 12.2 : 2.0;

      const s2Config = buildCompositeConfig(
        STAGE2_UPPER_SPEC,
        fairingsMass + payloadMass,
        extraH,
        STAGE2_UPPER_SPEC.name
      );

      // Align Stage 2 base cleanly to where Stage 2 sat atop Stage 1 (~44.5m above old stack base)
      const s2TargetComECEF = addScaledVec3(
        oldStackBaseECEF,
        noseECEF,
        STAGE2_UPPER_SPEC.stackBaseOffsetM + s2Config.comHeightFullM
      );
      const comShiftY = distVec3(s2TargetComECEF, oldPosECEF);

      dyn.reconfigureStage(s2Config, craft.storedUpperPropellantKg, comShiftY, false, true);
      dyn.velECEF = addScaledVec3(oldVelECEF, noseECEF, 1.4);

      craft.name = STAGE2_UPPER_SPEC.name;
      craft.role = 'upper_stage';
      craft.visuals = {
        ...craft.visuals,
        hasStage1: false,
        hasLandingGear: false,
        hasGridFins: false,
      };
      craft.storedUpperPropellantKg = 0;
      craft.separationFxTimer = 1.8;
      craft.separationFxLocalY = -dyn.comHeightFromBase;

      this.stagingCooldownS = 1.25;
      this.pushEvent(
        'MECO — STAGE 1 SEPARATED',
        'Press SPACE or Z to ignite Stage 2 MVac. Switch to S1 Booster in tracker for recovery.',
        'success'
      );
      return true;
    }

    // 2. PAYLOAD FAIRING JETTISON
    if (!craft.visuals.hasStage1 && craft.visuals.hasStage2 && (craft.visuals.hasFairingA || craft.visuals.hasFairingB)) {
      const baseECEF = dyn.getBasePositionECEF();
      const oldVel = { ...dyn.velECEF };
      const oldQuat = { ...dyn.quatECEF };
      const met = dyn.missionElapsedTimeS;

      for (const side of [-1, 1] as const) {
        const isA = side === 1;
        const fDyn = new RocketFlightDynamics(FAIRING_HALF_SPEC.config, false);
        const fPos = addVec3(
          addScaledVec3(baseECEF, noseECEF, 17.5),
          rotateVecByQuat({ x: side * 1.6, y: 0, z: 0 }, oldQuat)
        );
        const fVel = addVec3(
          addScaledVec3(oldVel, rightECEF, side * 4.4),
          rotateVecByQuat({ x: 0, y: 0.6, z: 0 }, oldQuat)
        );
        fDyn.initializeAirborneState(
          fPos,
          fVel,
          oldQuat,
          { x: 0.08 * side, y: 0.04, z: -0.28 * side },
          0,
          met,
          false
        );

        this.spacecraft.push({
          id: `fairing-${isA ? 'a' : 'b'}-${this.nextIdCounter++}`,
          name: `Fairing Half ${isA ? 'A' : 'B'}`,
          role: 'fairing',
          visuals: {
            hasStage1: false,
            hasStage2: false,
            hasFairingA: isA,
            hasFairingB: !isA,
            hasPayload: false,
            hasLandingGear: false,
            hasGridFins: false,
          },
          dynamics: fDyn,
          historyECEF: [{ ...fPos }],
          storedUpperPropellantKg: 0,
          storedPayloadPropellantKg: 0,
          separationFxTimer: 1.2,
          separationFxLocalY: 0,
          controllable: false,
        });
      }

      // Remove fairing mass from Stage 2 without interrupting an ongoing orbital insertion burn!
      const payloadMass = craft.visuals.hasPayload
        ? DEMO_PAYLOAD_SPEC.config.dryMassKg + craft.storedPayloadPropellantKg
        : 0;
      const newS2Config = buildCompositeConfig(
        STAGE2_UPPER_SPEC,
        payloadMass,
        craft.visuals.hasPayload ? 2.2 : 0,
        STAGE2_UPPER_SPEC.name
      );
      const savedThrottle = dyn.throttle;
      const savedIgnited = dyn.engineIgnited;
      const savedActual = dyn.actualThrottle;

      dyn.reconfigureStage(newS2Config, dyn.propellantKg, 0, false, false);
      dyn.throttle = savedThrottle;
      dyn.engineIgnited = savedIgnited;
      dyn.actualThrottle = savedActual;

      craft.visuals.hasFairingA = false;
      craft.visuals.hasFairingB = false;
      craft.separationFxTimer = 1.4;
      craft.separationFxLocalY = 7.5;

      this.stagingCooldownS = 1.1;
      this.pushEvent(
        'FAIRING JETTISONED',
        'Payload fairing halves separated — REENTRY-Sat-1 exposed.',
        'info'
      );
      return true;
    }

    // 3. PAYLOAD DEPLOYMENT
    if (!craft.visuals.hasStage1 && craft.visuals.hasStage2 && craft.visuals.hasPayload) {
      const baseECEF = dyn.getBasePositionECEF();
      const oldVel = { ...dyn.velECEF };
      const oldQuat = { ...dyn.quatECEF };
      const met = dyn.missionElapsedTimeS;

      const satDyn = new RocketFlightDynamics(DEMO_PAYLOAD_SPEC.config, false);
      const satPos = addScaledVec3(baseECEF, noseECEF, 14.2);
      const satVel = addScaledVec3(oldVel, noseECEF, 1.8);
      satDyn.initializeAirborneState(
        satPos,
        satVel,
        oldQuat,
        { x: 0, y: 0.03, z: 0 },
        craft.storedPayloadPropellantKg,
        met,
        true
      );

      const satEntity: SpacecraftEntity = {
        id: `payload-${this.nextIdCounter++}`,
        name: DEMO_PAYLOAD_SPEC.name,
        role: 'payload',
        visuals: { ...DEMO_PAYLOAD_SPEC.visuals },
        dynamics: satDyn,
        historyECEF: [...craft.historyECEF.slice(-60), { ...satPos }],
        storedUpperPropellantKg: 0,
        storedPayloadPropellantKg: 0,
        separationFxTimer: 1.4,
        separationFxLocalY: -1.2,
        controllable: true,
      };
      this.spacecraft.push(satEntity);

      // Update Stage 2 dry mass
      const bareS2Config = buildCompositeConfig(STAGE2_UPPER_SPEC, 0, 0, STAGE2_UPPER_SPEC.name);
      dyn.reconfigureStage(bareS2Config, dyn.propellantKg, 0, false, false);
      dyn.velECEF = addScaledVec3(oldVel, noseECEF, -0.35);

      craft.visuals.hasPayload = false;
      craft.storedPayloadPropellantKg = 0;
      craft.separationFxTimer = 1.4;
      craft.separationFxLocalY = 7.5;

      // Focus deployed satellite automatically so player sees deployment clearly (can switch back anytime!)
      this.activeId = satEntity.id;
      this.stagingCooldownS = 1.1;
      this.pushEvent(
        'PAYLOAD DEPLOYED',
        'REENTRY-Sat-1 deployed into independent flight!',
        'success'
      );
      return true;
    }

    return false;
  }

  /**
   * Computes maximum safe time acceleration across all active/nearby spacecraft.
   */
  public computeMaxSafeWarp(): { maxWarp: number; reason: string | null } {
    const active = this.activeSpacecraft;
    const dyn = active.dynamics;

    if (this.stagingCooldownS > 0.05) {
      return { maxWarp: 1, reason: 'STAGING' };
    }

    // Check close proximity to any other airborne spacecraft (< 350 m)
    for (const other of this.spacecraft) {
      if (other.id === active.id) continue;
      if (other.dynamics.status === 'CRASHED' || other.dynamics.status === 'LANDED') continue;
      const d = distVec3(dyn.posECEF, other.dynamics.posECEF);
      if (d < 350) {
        return { maxWarp: 1, reason: 'PROXIMITY' };
      }
    }

    if (dyn.inGroundContact || dyn.status === 'PRELAUNCH' || dyn.status === 'LANDED') {
      return { maxWarp: 2, reason: 'SURFACE' };
    }
    if (dyn.actualThrottle > 0.01) {
      return { maxWarp: 2, reason: 'THRUST' };
    }
    if (dyn.getAltitudeASL() < PLANET_CONFIG.karmanLineM) {
      return { maxWarp: 2, reason: 'ATMO' };
    }
    if (lenVec3(dyn.angVelBody) > 0.4) {
      return { maxWarp: 5, reason: 'SPIN' };
    }

    return { maxWarp: 1000, reason: null };
  }

  /**
   * Step ALL simulated spacecraft forward by `dt` seconds.
   * Optional `resolveInput` allows per-spacecraft virtual flight computers to drive
   * multiple vehicles simultaneously alongside manual pilot controls.
   */
  public stepAll(
    dt: number,
    activeInput: FlightControlInput,
    planet: PlanetSimulation,
    resolveInput?: (craft: SpacecraftEntity, isPlayerControlled: boolean) => FlightControlInput
  ): void {
    if (this.stagingCooldownS > 0) {
      this.stagingCooldownS = Math.max(0, this.stagingCooldownS - dt);
    }

    for (const craft of this.spacecraft) {
      if (craft.separationFxTimer > 0) {
        craft.separationFxTimer = Math.max(0, craft.separationFxTimer - dt);
      }

      const isPlayerControlled = craft.id === this.activeId && craft.controllable;
      const input = resolveInput
        ? resolveInput(craft, isPlayerControlled)
        : isPlayerControlled
          ? activeInput
          : NEUTRAL_FLIGHT_INPUT;
      craft.dynamics.step(dt, input, planet);

      // Emit flight notifications for notable touchdown / impact events
      if (craft.dynamics.justLanded) {
        this.pushEvent('TOUCHDOWN', `${craft.name} landed safely!`, 'success');
      } else if (craft.dynamics.justCrashed) {
        this.pushEvent('LOSS OF VEHICLE', `${craft.name} impacted terrain.`, 'danger');
      }
    }

    // Record compact ECEF historical flight path breadcrumbs
    this.historySampleTimer += dt;
    if (this.historySampleTimer >= 1.25) {
      this.historySampleTimer = 0;
      for (const craft of this.spacecraft) {
        if (craft.dynamics.status === 'PRELAUNCH') continue;
        const hist = craft.historyECEF;
        const last = hist[hist.length - 1];
        if (!last || distVec3(last, craft.dynamics.posECEF) > 1200) {
          hist.push({ ...craft.dynamics.posECEF });
          if (hist.length > 260) hist.shift();
        }
      }
    }
  }

  /**
   * Notify once when a spacecraft achieves a stable closed orbit (periapsis >= 100 km).
   */
  public notifyOrbitAchievedIfNew(craft: SpacecraftEntity): void {
    if (this.orbitAnnouncedIds.has(craft.id)) return;
    this.orbitAnnouncedIds.add(craft.id);
    this.pushEvent(
      'ORBIT ACHIEVED',
      `${craft.name} has established a stable Earth orbit!`,
      'success'
    );
  }
}
