import * as THREE from 'three/webgpu';
import { LoadedAssets } from '../assets/assetManager';
import { Vec3d, distVec3 } from '../math/vec3d';
import { SpacecraftEntity, SpacecraftManager } from '../simulation/spacecraftManager';
import { ExhaustVfx } from './exhaustVfx';
import { RocketVisual } from './rocketVisual';
import { SpacecraftBreakup } from './spacecraftBreakup';
import { BreakupPreparation, disposePreparedPieces } from './breakupPreparation';

interface VisualRig {
  visual: RocketVisual;
  exhaust: ExhaustVfx;
  breakup: SpacecraftBreakup | null;
  previousVelocity: Vec3d;
  preparationSource: THREE.Object3D | null;
  prepared: SpacecraftBreakup | null;
  disposed: boolean;
}

/**
 * Dynamically creates, synchronizes, and cleans up Three.js visual rigs and exhaust VFX
 * for all simultaneously simulated spacecraft in `SpacecraftManager`.
 */
export class SpacecraftVisualManager {
  public readonly group: THREE.Group;
  private readonly assets: LoadedAssets;
  private readonly rigs = new Map<string, VisualRig>();
  private readonly preparation = new BreakupPreparation();
  public warmup: ((group: THREE.Group) => Promise<unknown>) | null = null;
  private crashSample: { start: number; last: number; max: number; frames: number } | null = null;

  constructor(assets: LoadedAssets) {
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'AllSpacecraftVisuals';
  }

  public reset(): void {
    for (const rig of this.rigs.values()) {
      rig.disposed = true;
      rig.prepared?.dispose();
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
      if (visible || !rig.preparationSource) rig.visual.update(craft, cameraPosECEF);
      const source = rig.visual.breakupSource.children[0];
      if (source && source !== rig.preparationSource) {
        rig.preparationSource = source;
        if (rig.prepared) { rig.prepared.dispose(); rig.prepared = null; }
        const currentRig = rig;
        void this.preparation.prepare(rig.visual.breakupSource, rig.visual.group).then(async pieces => {
          if (currentRig.disposed || currentRig.preparationSource !== source) { disposePreparedPieces(pieces); return; }
          const prepared = new SpacecraftBreakup(pieces, craft.dynamics.posECEF, currentRig.visual.group.quaternion, currentRig.previousVelocity);
          try { await this.warmup?.(prepared.group); }
          catch (error) { console.warn('Debris shader warmup failed', error); }
          if (currentRig.disposed || currentRig.preparationSource !== source) prepared.dispose();
          else {
            currentRig.prepared = prepared;
            if (import.meta.env.DEV) console.debug('[Breakup] prepared and shaders warmed', JSON.stringify({
              fragments: pieces.length, draws: pieces.reduce((sum, piece) => sum + piece.children.length, 0),
            }));
          }
        }).catch(error => console.error('Debris preparation failed', error));
      }
      if (crashed && !rig.breakup && rig.prepared) {
        const started = performance.now();
        rig.breakup = rig.prepared;
        rig.breakup.activate(craft.dynamics.posECEF, rig.visual.group.quaternion, rig.previousVelocity);
        rig.prepared = null;
        this.group.add(rig.breakup.group);
        if (import.meta.env.DEV) console.debug('[Breakup] impact activation ms', performance.now() - started);
        if (import.meta.env.DEV) this.crashSample = { start: performance.now(), last: performance.now(), max: 0, frames: 0 };
      }
      if (!crashed) rig.previousVelocity = { ...craft.dynamics.velECEF };
      rig.visual.group.visible = visible && !crashed;
      rig.exhaust.smokeGroup.visible = visible;
      if (rig.breakup) {
        rig.breakup.group.visible = visible;
        rig.breakup.update(cameraPosECEF, dt);
      }

      if (visible) {
        rig.exhaust.update(craft.dynamics, cameraPosECEF, dt);
      }
    }

    // Remove rigs for any craft no longer present (e.g. after reset)
    if (import.meta.env.DEV && this.crashSample) {
      const now = performance.now(), sample = this.crashSample;
      sample.max = Math.max(sample.max, now - sample.last); sample.last = now; sample.frames++;
      if (now - sample.start > 2000) {
        console.debug('[Breakup] crash frame sample', JSON.stringify({ maxFrameMs: sample.max, frames: sample.frames }));
        this.crashSample = null;
      }
    }
    for (const [id, rig] of this.rigs.entries()) {
      if (!activeIds.has(id)) {
        rig.disposed = true;
        rig.prepared?.dispose();
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
    return { visual, exhaust, breakup: null, previousVelocity: { ...craft.dynamics.velECEF }, preparationSource: null, prepared: null, disposed: false };
  }
}
