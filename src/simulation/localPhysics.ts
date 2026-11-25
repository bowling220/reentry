import RAPIER from '@dimforge/rapier3d-compat';
import { LANDING_PAD_OFFSET_LOCAL } from '../config/planetConfig';
import { RocketConfig } from '../config/rocketConfig';
import { LocalTangentFrame, buildTangentFrameFromECEF } from '../math/coordinates';
import { Quatd, Vec3d, normVec3, scaleVec3 } from '../math/vec3d';
import {
  CAPE_FRAME,
  LANDING_PAD_TOP_Y,
  LAUNCH_MOUNT_TOP_Y,
  LAUNCH_PAD_DECK_Y,
  curvatureDropM,
  getCapeTerrainElevationM,
} from './terrainHeight';
import { PLANET_CONFIG } from '../config/planetConfig';

export interface LocalBodySnapshot {
  positionLocal: Vec3d;
  velocityLocal: Vec3d;
  rotationLocal: Quatd;
  angVelLocal: Vec3d;
  inContact: boolean;
  maxImpactSpeedMs: number;
}

/**
 * Rapier 3D local rigid-body physics world.
 *
 * Operates strictly in local East-Up-South meter coordinates (never astronomical ECEF values)
 * to preserve full float32 solver stability for launchpad contact, tower collisions,
 * landing leg touchdowns, tipping, and crashes.
 */
export class LocalPhysicsWorld {
  private static initialized = false;
  private world!: RAPIER.World;
  private rocketBody!: RAPIER.RigidBody;
  private bodyCollider!: RAPIER.Collider;
  private legColliders: RAPIER.Collider[] = [];
  private groundColliders: RAPIER.Collider[] = [];
  private eventQueue!: RAPIER.EventQueue;

  private activeFrame: LocalTangentFrame = CAPE_FRAME;
  private isAtCape = true;
  private gearDeployed = false;
  private readonly config: RocketConfig;
  private readonly comHeightFromBase: number;

  public static async initRapier(): Promise<void> {
    if (!LocalPhysicsWorld.initialized) {
      await RAPIER.init();
      LocalPhysicsWorld.initialized = true;
    }
  }

  constructor(config: RocketConfig, comHeightFromBase: number) {
    this.config = config;
    this.comHeightFromBase = comHeightFromBase;
    this.createWorld();
  }

  private createWorld(): void {
    // Gravity is applied explicitly per-step from our central planetary gravity model
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.eventQueue = new RAPIER.EventQueue(true);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, LAUNCH_MOUNT_TOP_Y + this.comHeightFromBase, 0)
      .setLinearDamping(0.0)
      .setAngularDamping(0.02)
      .setCanSleep(false);

    this.rocketBody = this.world.createRigidBody(bodyDesc);

    // Core fuselage cylinder collider
    const halfH = this.config.heightM * 0.5;
    const radius = this.config.diameterM * 0.5;
    const centerShiftY = halfH - this.comHeightFromBase;

    const coreDesc = RAPIER.ColliderDesc.cylinder(halfH, radius)
      .setTranslation(0, centerShiftY, 0)
      .setFriction(0.75)
      .setRestitution(0.08)
      .setDensity(0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    this.bodyCollider = this.world.createCollider(coreDesc, this.rocketBody);

    this.rebuildStaticEnvironment(true);
  }

  public getFrame(): LocalTangentFrame {
    return this.activeFrame;
  }

  /**
   * Re-anchor the local Rapier ground environment either at Cape Canaveral (with pad, tower, LZ-1)
   * or at a fresh surface tangent frame directly beneath the rocket anywhere on Earth.
   */
  public anchorFrame(posECEF: Vec3d, useCapeSite: boolean): void {
    if (useCapeSite) {
      this.activeFrame = CAPE_FRAME;
      if (!this.isAtCape) {
        this.rebuildStaticEnvironment(true);
      }
      this.isAtCape = true;
    } else {
      const surfaceOrigin = scaleVec3(normVec3(posECEF), PLANET_CONFIG.meanRadiusM);
      this.activeFrame = buildTangentFrameFromECEF(surfaceOrigin);
      this.rebuildStaticEnvironment(false);
      this.isAtCape = false;
    }
  }

  private rebuildStaticEnvironment(includeCapeStructures: boolean): void {
    for (const c of this.groundColliders) {
      this.world.removeCollider(c, true);
    }
    this.groundColliders = [];

    if (includeCapeStructures) {
      // Wide coastal terrain plane (y = 2.0m baseline)
      const groundBase = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(6000, 1.0, 6000)
          .setTranslation(0, 1.0, 0)
          .setFriction(0.85)
          .setRestitution(0.05)
      );
      this.groundColliders.push(groundBase);

      // Launch pad concrete apron (top at LAUNCH_PAD_DECK_Y = 6.0m)
      const padApron = this.world.createCollider(
        RAPIER.ColliderDesc.cylinder(LAUNCH_PAD_DECK_Y * 0.5, 34)
          .setTranslation(0, LAUNCH_PAD_DECK_Y * 0.5, 0)
          .setFriction(0.9)
          .setRestitution(0.04)
      );
      this.groundColliders.push(padApron);

      // Launch mount hold-down ring deck (top at LAUNCH_MOUNT_TOP_Y = 7.0m)
      const mountDeck = this.world.createCollider(
        RAPIER.ColliderDesc.cylinder(0.5, 7.5)
          .setTranslation(0, LAUNCH_MOUNT_TOP_Y - 0.5, 0)
          .setFriction(0.95)
          .setRestitution(0.02)
      );
      this.groundColliders.push(mountDeck);

      // Launch tower structure (positioned at X = -18m, Z = -6m so rocket clears cleanly vertically)
      const towerCollider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(4.5, 39.0, 4.5)
          .setTranslation(-18.5, LAUNCH_PAD_DECK_Y + 39.0, -6.0)
          .setFriction(0.7)
          .setRestitution(0.1)
      );
      this.groundColliders.push(towerCollider);

      // Nearby LZ-1 concrete landing pad (top at LANDING_PAD_TOP_Y = 2.5m)
      const lzDrop = curvatureDropM(
        LANDING_PAD_OFFSET_LOCAL.eastM,
        LANDING_PAD_OFFSET_LOCAL.southM
      );
      const lzCollider = this.world.createCollider(
        RAPIER.ColliderDesc.cylinder(1.25, LANDING_PAD_OFFSET_LOCAL.radiusM)
          .setTranslation(
            LANDING_PAD_OFFSET_LOCAL.eastM,
            LANDING_PAD_TOP_Y - 1.25 - lzDrop,
            LANDING_PAD_OFFSET_LOCAL.southM
          )
          .setFriction(0.92)
          .setRestitution(0.03)
      );
      this.groundColliders.push(lzCollider);
    } else {
      // Generic planetary surface tangent plane at y = 0 (sea level)
      const genericGround = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(5000, 1.0, 5000)
          .setTranslation(0, -1.0, 0)
          .setFriction(0.85)
          .setRestitution(0.05)
      );
      this.groundColliders.push(genericGround);
    }
  }

  /**
   * Adds or removes four wide-stance landing leg footpads on the Rapier rigid body.
   */
  public setLandingGearDeployed(deployed: boolean): void {
    if (deployed === this.gearDeployed) return;
    this.gearDeployed = deployed;

    for (const c of this.legColliders) {
      this.world.removeCollider(c, true);
    }
    this.legColliders = [];

    if (deployed) {
      const footY = -this.comHeightFromBase - 1.2; // Extends 1.2m below engine nozzles
      const spreadR = 8.4; // Wide Falcon 9 deployed leg footprint (~18m span)
      for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2 + Math.PI / 4;
        const fx = Math.cos(angle) * spreadR;
        const fz = Math.sin(angle) * spreadR;
        const footDesc = RAPIER.ColliderDesc.ball(0.75)
          .setTranslation(fx, footY, fz)
          .setFriction(1.1)
          .setRestitution(0.02)
          .setDensity(0)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        this.legColliders.push(this.world.createCollider(footDesc, this.rocketBody));
      }
    }
  }

  /**
   * Synchronize Rapier rigid body state from planetary kinematics (e.g. reset or reentry handoff).
   */
  public setKinematicState(
    posLocal: Vec3d,
    velLocal: Vec3d,
    rotLocal: Quatd,
    angVelLocal: Vec3d
  ): void {
    this.rocketBody.setTranslation(posLocal, true);
    this.rocketBody.setLinvel(velLocal, true);
    this.rocketBody.setRotation(rotLocal, true);
    this.rocketBody.setAngvel(angVelLocal, true);
    this.rocketBody.resetForces(true);
    this.rocketBody.resetTorques(true);
  }

  /**
   * Update dynamic mass properties as propellant burns.
   */
  public setMassProperties(totalMassKg: number): void {
    const r = this.config.diameterM * 0.5;
    const h = this.config.heightM;
    // Cylinder inertia tensor approximation around CoM
    const iPitchYaw = (1 / 12) * totalMassKg * (3 * r * r + h * h);
    const iRoll = 0.5 * totalMassKg * r * r;

    this.rocketBody.setAdditionalMassProperties(
      totalMassKg,
      { x: 0, y: 0, z: 0 },
      { x: iPitchYaw, y: iRoll, z: iPitchYaw },
      { x: 0, y: 0, z: 0, w: 1 },
      false
    );

    // Colliders are collision shapes only. Their density must remain zero:
    // adding collider inertia here would double the supplied inertia and move
    // the center of mass away from the simulation's body-frame origin.
  }

  /**
   * Step Rapier forward by fixed timestep `dt` with aerospace forces & torques applied.
   */
  public step(
    dt: number,
    forceLocalN: Vec3d,
    torqueLocalNm: Vec3d,
    prevVelLocal: Vec3d
  ): LocalBodySnapshot {
    this.world.timestep = dt;
    this.rocketBody.resetForces(true);
    this.rocketBody.resetTorques(true);
    this.rocketBody.addForce(forceLocalN, true);
    this.rocketBody.addTorque(torqueLocalNm, true);

    this.world.step(this.eventQueue);

    // Check ground/structure contacts
    let inContact = false;
    const rocketHandles = new Set<number>([
      this.bodyCollider.handle,
      ...this.legColliders.map((c) => c.handle),
    ]);

    for (const ground of this.groundColliders) {
      this.world.contactPair(this.bodyCollider, ground, () => {
        inContact = true;
      });
      for (const leg of this.legColliders) {
        this.world.contactPair(leg, ground, () => {
          inContact = true;
        });
      }
    }

    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (started && (rocketHandles.has(h1) || rocketHandles.has(h2))) {
        inContact = true;
      }
    });

    const t = this.rocketBody.translation();
    const v = this.rocketBody.linvel();
    const q = this.rocketBody.rotation();
    const w = this.rocketBody.angvel();

    // Detect local ground plane correction if over Cape terrain away from pad/LZ-1
    if (this.isAtCape) {
      const terrainY = getCapeTerrainElevationM(t.x, t.z) - curvatureDropM(t.x, t.z);
      const lowestFootOffset = this.gearDeployed
        ? this.comHeightFromBase + 1.9
        : this.comHeightFromBase;
      if (t.y - lowestFootOffset <= terrainY + 0.15) {
        inContact = true;
      }
    }

    // Impact velocity estimate from sudden velocity delta on contact
    const dvx = v.x - prevVelLocal.x;
    const dvy = v.y - prevVelLocal.y;
    const dvz = v.z - prevVelLocal.z;
    const maxImpactSpeedMs = inContact ? Math.hypot(dvx, dvy, dvz) : 0;

    return {
      positionLocal: { x: t.x, y: t.y, z: t.z },
      velocityLocal: { x: v.x, y: v.y, z: v.z },
      rotationLocal: { x: q.x, y: q.y, z: q.z, w: q.w },
      angVelLocal: { x: w.x, y: w.y, z: w.z },
      inContact,
      maxImpactSpeedMs,
    };
  }
}
