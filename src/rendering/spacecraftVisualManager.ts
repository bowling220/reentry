import * as THREE from 'three/webgpu';
import { LoadedAssets } from '../assets/assetManager';
import { Vec3d, distVec3 } from '../math/vec3d';
import { SpacecraftEntity, SpacecraftManager } from '../simulation/spacecraftManager';
import { ExhaustVfx } from './exhaustVfx';
import { RocketVisual } from './rocketVisual';
import { SpacecraftBreakup } from './spacecraftBreakup';

interface VisualRig {
  visual: RocketVisual;
  exhaust: ExhaustVfx;
  breakup: SpacecraftBreakup | null;
  previousVelocity: Vec3d;
}

/**
 * Dynamically creates, synchronizes, and cleans up Three.js visual rigs and exhaust VFX
 * for all simultaneously simulated spacecraft in `SpacecraftManager`.
 */
export class SpacecraftVisualManager {
  public readonly group: THREE.Group;
  private readonly assets: LoadedAssets;
  private readonly rigs = new Map<string, VisualRig>();

  constructor(assets: LoadedAssets) {
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'AllSpacecraftVisuals';
  }

  public reset(): void {
    for (const rig of this.rigs.values()) {
      rig.exhaust.reset();
      if (rig.breakup) { this.group.remove(rig.breakup.group); rig.breakup.dispose(); }
      this.group.remove(rig.visual.group);
      this.group.remove(rig.exhaust.smokeGroup);
    }
    this.rigs.clear();
  }

  public update(
    manager: SpacecraftManager,
    cameraPosECEF: Vec3d,
    dt: number,
    inMapView: boolean
  ): void {
    const activeIds = new Set<string>();

    for (const craft of manager.spacecraft) {
      activeIds.add(craft.id);
      let rig = this.rigs.get(craft.id);
      if (!rig) {
        rig = this.createRig(craft);
        this.rigs.set(craft.id, rig);
      }

      const d = distVec3(craft.dynamics.posECEF, cameraPosECEF);
      // Hide tiny 3D vehicle meshes when looking at Earth from deep orbital map distance (> 150 km away)
      const visible = !inMapView && d < 150_000;
      const crashed = craft.dynamics.status === 'CRASHED';
      if (crashed && !rig.breakup) {
        rig.visual.update(craft, cameraPosECEF);
        rig.breakup = new SpacecraftBreakup(rig.visual.breakupSource, rig.visual.group,
          craft.dynamics.posECEF, rig.visual.group.quaternion, rig.previousVelocity);
        this.group.add(rig.breakup.group);
      }
      if (!crashed) rig.previousVelocity = { ...craft.dynamics.velECEF };
      rig.visual.group.visible = visible && !crashed;
      rig.exhaust.smokeGroup.visible = visible;
      if (rig.breakup) {
        rig.breakup.group.visible = visible;
        rig.breakup.update(cameraPosECEF, dt);
      }

      if (visible) {
        rig.visual.update(craft, cameraPosECEF);
        rig.exhaust.update(craft.dynamics, cameraPosECEF, dt);
      }
    }

    // Remove rigs for any craft no longer present (e.g. after reset)
    for (const [id, rig] of this.rigs.entries()) {
      if (!activeIds.has(id)) {
        if (rig.breakup) { this.group.remove(rig.breakup.group); rig.breakup.dispose(); }
        this.group.remove(rig.visual.group);
        this.group.remove(rig.exhaust.smokeGroup);
        this.rigs.delete(id);
      }
    }
  }

  private createRig(craft: SpacecraftEntity): VisualRig {
    const visual = new RocketVisual(this.assets, craft);
    const enableFullSmoke = craft.role === 'stack' || craft.role === 'booster';
    const exhaust = new ExhaustVfx(enableFullSmoke);
    visual.engineNozzleAnchor.add(exhaust.plumeGroup);
    this.group.add(visual.group);
    this.group.add(exhaust.smokeGroup);
    return { visual, exhaust, breakup: null, previousVelocity: { ...craft.dynamics.velECEF } };
  }
}
