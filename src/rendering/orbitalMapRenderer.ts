import * as THREE from 'three/webgpu';
import { PLANET_CONFIG } from '../config/planetConfig';
import { Vec3d, dotVec3, lenVec3, normVec3, subVec3 } from '../math/vec3d';
import {
  computeOrbitalElements,
  samplePredictedTrajectory,
} from '../simulation/orbitalMechanics';
import { PlanetSimulation } from '../simulation/planetSimulation';
import { SpacecraftEntity, SpacecraftManager } from '../simulation/spacecraftManager';
import { CAPE_FRAME } from '../simulation/terrainHeight';

interface CraftMapLines {
  orbitLine: THREE.Line;
  historyLine: THREE.Line;
  groundTrackLine: THREE.Line;
}

/**
 * Interactive 3D Planetary Orbital Map rendered directly inside the WebGPU scene
 * with clickable HTML overlay markers for spacecraft, Apoapsis (AP), Periapsis (PE),
 * predicted surface impact, and Cape Canaveral launch site.
 *
 * Distinct visual coding:
 * - Predicted orbital trajectory: bright cyan (active) / slate blue (other vehicles)
 * - Recorded historical flight path: warm amber
 * - Projected Earth surface ground track: translucent teal
 */
export class OrbitalMapRenderer {
  public readonly group: THREE.Group;
  private readonly overlayEl: HTMLDivElement;
  private readonly onSelectCraft: (id: string) => void;

  private readonly craftLines = new Map<string, CraftMapLines>();
  private readonly labelPool = new Map<string, HTMLButtonElement>();
  private readonly projVec = new THREE.Vector3();

  private static readonly MAX_LINE_VERTS = 280;

  constructor(hudRoot: HTMLElement, onSelectCraft: (id: string) => void) {
    this.onSelectCraft = onSelectCraft;
    this.group = new THREE.Group();
    this.group.name = 'OrbitalMapOverlay3D';
    this.group.visible = false;

    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'orbital-map-overlay hidden';
    hudRoot.appendChild(this.overlayEl);
  }

  public reset(): void {
    for (const entry of this.craftLines.values()) {
      this.group.remove(entry.orbitLine, entry.historyLine, entry.groundTrackLine);
      entry.orbitLine.geometry.dispose();
      entry.historyLine.geometry.dispose();
      entry.groundTrackLine.geometry.dispose();
    }
    this.craftLines.clear();
    this.clearLabels();
  }

  private clearLabels(): void {
    for (const el of this.labelPool.values()) {
      el.remove();
    }
    this.labelPool.clear();
  }

  private createDynamicLine(colorHex: number, opacity: number, renderOrder: number): THREE.Line {
    const positions = new Float32Array(OrbitalMapRenderer.MAX_LINE_VERTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setDrawRange(0, 0);

    const mat = new THREE.LineBasicMaterial({
      color: colorHex,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = renderOrder;
    return line;
  }

  private updateLinePoints(line: THREE.Line, pointsECEF: Vec3d[], cameraPosECEF: Vec3d): void {
    const posAttr = line.geometry.attributes.position as THREE.BufferAttribute;
    const count = Math.min(pointsECEF.length, OrbitalMapRenderer.MAX_LINE_VERTS);
    for (let i = 0; i < count; i++) {
      const p = pointsECEF[i];
      posAttr.setXYZ(i, p.x - cameraPosECEF.x, p.y - cameraPosECEF.y, p.z - cameraPosECEF.z);
    }
    posAttr.needsUpdate = true;
    line.geometry.setDrawRange(0, count);
    line.visible = count >= 2;
  }

  private ensureLines(craft: SpacecraftEntity): CraftMapLines {
    let entry = this.craftLines.get(craft.id);
    if (!entry) {
      entry = {
        orbitLine: this.createDynamicLine(0x48c6ff, 0.92, 40),
        historyLine: this.createDynamicLine(0xf5a638, 0.85, 41),
        groundTrackLine: this.createDynamicLine(0x2ad1a8, 0.52, 39),
      };
      this.group.add(entry.orbitLine, entry.historyLine, entry.groundTrackLine);
      this.craftLines.set(craft.id, entry);
    }
    return entry;
  }

  public update(
    visible: boolean,
    manager: SpacecraftManager,
    planet: PlanetSimulation,
    camera: THREE.PerspectiveCamera,
    cameraPosECEF: Vec3d
  ): void {
    this.group.visible = visible;
    this.overlayEl.classList.toggle('hidden', !visible);

    if (!visible) return;

    const usedLabelKeys = new Set<string>();
    const activeIds = new Set<string>();
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    // 1. Cape Canaveral launch site marker
    this.placeMarker(
      'site-slc40',
      'CAPE CANAVERAL SLC-40',
      'site',
      CAPE_FRAME.originECEF,
      camera,
      cameraPosECEF,
      vpW,
      vpH,
      usedLabelKeys
    );

    // 2. Render predicted orbits, historical flight trails, ground tracks & AP/PE/Impact markers
    for (const craft of manager.spacecraft) {
      activeIds.add(craft.id);
      const isSelected = craft.id === manager.activeId;
      const lines = this.ensureLines(craft);
      const dyn = craft.dynamics;

      const altASL = dyn.getAltitudeASL();
      const up = normVec3(dyn.posECEF);
      const vertVel = dotVec3(dyn.velECEF, up);
      const elements = computeOrbitalElements(
        dyn.posECEF,
        dyn.velECEF,
        planet.earthRotationRad,
        dyn.status,
        altASL,
        vertVel
      );

      // Update predicted trajectory & ground track
      const orbitMat = lines.orbitLine.material as THREE.LineBasicMaterial;
      orbitMat.color.setHex(isSelected ? 0x4cc9ff : 0x5c7394);
      orbitMat.opacity = isSelected ? 0.95 : 0.45;

      const pred = samplePredictedTrajectory(elements, planet.earthRotationRad, isSelected ? 180 : 96);
      this.updateLinePoints(lines.orbitLine, pred.pointsECEF, cameraPosECEF);
      this.updateLinePoints(
        lines.groundTrackLine,
        isSelected ? pred.groundTrackECEF : [],
        cameraPosECEF
      );
      this.updateLinePoints(
        lines.historyLine,
        isSelected ? craft.historyECEF : [],
        cameraPosECEF
      );

      // Clickable spacecraft marker badge
      const altKm = altASL / 1000;
      const badgeLabel = `${craft.name} (${altKm >= 10 ? altKm.toFixed(0) + ' km' : Math.round(altASL) + ' m'})`;
      this.placeMarker(
        `craft-${craft.id}`,
        badgeLabel,
        isSelected ? 'craft-active' : 'craft',
        dyn.posECEF,
        camera,
        cameraPosECEF,
        vpW,
        vpH,
        usedLabelKeys,
        () => this.onSelectCraft(craft.id)
      );

      // AP / PE / Surface Impact markers for the active spacecraft
      if (isSelected && elements.valid) {
        if (pred.apoapsisECEF && elements.apoapsisAltM !== null && elements.apoapsisAltM > 5000) {
          this.placeMarker(
            'marker-ap',
            `AP ${(elements.apoapsisAltM / 1000).toFixed(1)} km`,
            'ap',
            pred.apoapsisECEF,
            camera,
            cameraPosECEF,
            vpW,
            vpH,
            usedLabelKeys
          );
        }
        if (pred.periapsisECEF && elements.periapsisAltM !== null && elements.periapsisAltM > 5000) {
          this.placeMarker(
            'marker-pe',
            `PE ${(elements.periapsisAltM / 1000).toFixed(1)} km`,
            'pe',
            pred.periapsisECEF,
            camera,
            cameraPosECEF,
            vpW,
            vpH,
            usedLabelKeys
          );
        }
        if (pred.impactECEF) {
          this.placeMarker(
            'marker-impact',
            'SURFACE IMPACT',
            'impact',
            pred.impactECEF,
            camera,
            cameraPosECEF,
            vpW,
            vpH,
            usedLabelKeys
          );
        }
      }
    }

    // Clean up stale lines & labels
    for (const [id, entry] of this.craftLines.entries()) {
      if (!activeIds.has(id)) {
        this.group.remove(entry.orbitLine, entry.historyLine, entry.groundTrackLine);
        this.craftLines.delete(id);
      }
    }
    for (const [key, el] of this.labelPool.entries()) {
      if (!usedLabelKeys.has(key)) {
        el.remove();
        this.labelPool.delete(key);
      }
    }
  }

  private placeMarker(
    key: string,
    text: string,
    kind: 'craft' | 'craft-active' | 'ap' | 'pe' | 'impact' | 'site',
    posECEF: Vec3d,
    camera: THREE.PerspectiveCamera,
    cameraPosECEF: Vec3d,
    vpW: number,
    vpH: number,
    usedKeys: Set<string>,
    onClick?: () => void
  ): void {
    // Horizon occlusion check against Earth's sphere so markers on the far side of Earth dim/hide cleanly
    const camToPt = subVec3(posECEF, cameraPosECEF);
    const ptDist = lenVec3(camToPt);
    const camDist = lenVec3(cameraPosECEF);
    const camToEarth = { x: -cameraPosECEF.x, y: -cameraPosECEF.y, z: -cameraPosECEF.z };
    const rayDir = { x: camToPt.x / Math.max(1, ptDist), y: camToPt.y / Math.max(1, ptDist), z: camToPt.z / Math.max(1, ptDist) };
    const tClosest = dotVec3(camToEarth, rayDir);
    let occluded = false;
    if (tClosest > 0 && tClosest < ptDist - 40_000) {
      const perpSq = camDist * camDist - tClosest * tClosest;
      const rOcc = PLANET_CONFIG.meanRadiusM * 0.985;
      if (perpSq < rOcc * rOcc) occluded = true;
    }

    this.projVec.set(camToPt.x, camToPt.y, camToPt.z).project(camera);
    if (this.projVec.z > 1 || this.projVec.z < -1) return;

    const sx = (this.projVec.x * 0.5 + 0.5) * vpW;
    const sy = (-this.projVec.y * 0.5 + 0.5) * vpH;
    if (sx < -60 || sx > vpW + 60 || sy < -30 || sy > vpH + 30) return;

    usedKeys.add(key);
    let el = this.labelPool.get(key);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      if (onClick) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick();
        });
      }
      this.overlayEl.appendChild(el);
      this.labelPool.set(key, el);
    }

    el.className = `map-marker marker-${kind}${occluded ? ' occluded' : ''}`;
    el.textContent = text;
    el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
  }
}
