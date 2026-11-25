import * as THREE from 'three/webgpu';
import { PLANET_CONFIG } from '../config/planetConfig';
import { buildTangentFrameFromECEF, localPointToECEF } from '../math/coordinates';
import {
  Vec3d,
  addScaledVec3,
  addVec3,
  clamp,
  lenVec3,
  normVec3,
  rotateVecByQuat,
  subVec3,
} from '../math/vec3d';
import { RocketFlightDynamics } from '../simulation/flightDynamics';
import { CAPE_FRAME } from '../simulation/terrainHeight';

export type CameraMode =
  | 'FOLLOW'
  | 'FREE_ORBIT'
  | 'GROUND_TRACK'
  | 'ENGINE_CLOSEUP'
  | 'CINEMATIC_WIDE';

export const CAMERA_MODE_LIST: { id: CameraMode; label: string }[] = [
  { id: 'FOLLOW', label: 'Follow' },
  { id: 'FREE_ORBIT', label: 'Free Orbit' },
  { id: 'GROUND_TRACK', label: 'Ground Track' },
  { id: 'ENGINE_CLOSEUP', label: 'Engine Cam' },
  { id: 'CINEMATIC_WIDE', label: 'Cinematic' },
];

/**
 * 5-mode flight camera + interactive 3D planetary orbital map camera in double-precision ECEF.
 */
export class CameraController {
  public readonly camera: THREE.PerspectiveCamera;
  public mode: CameraMode = 'FOLLOW';
  public mapMode = false;
  public cameraPosECEF: Vec3d = { x: 0, y: 0, z: 0 };

  // Flight camera spherical orbit state
  private azimuthRad = 0.44;
  private elevationRad = 0.16;
  private targetAzimuthRad = 0.44;
  private targetElevationRad = 0.16;
  private distanceM = 128;
  private targetDistanceM = 128;
  private targetFov = 48;

  // Interactive planetary Orbital Map spherical coordinates (around Earth center)
  private mapLonRad = -1.4; // Starts centered over Cape Canaveral / Americas!
  private mapLatRad = 0.48;
  private targetMapLonRad = -1.4;
  private targetMapLatRad = 0.48;
  private mapRadiusM = 18_500_000;
  private targetMapRadiusM = 18_500_000;

  private isDragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private hasInitializedPos = false;
  private modeBlendTimer = 0;
  private cinematicTime = 0;

  private readonly groundTrackSiteECEF: Vec3d;

  constructor(viewportEl: HTMLElement) {
    const aspect =
      (viewportEl.clientWidth || window.innerWidth) /
      Math.max(1, viewportEl.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(48, aspect, 0.5, 45_000_000);
    this.camera.position.set(0, 0, 0);

    this.groundTrackSiteECEF = localPointToECEF({ x: 178, y: 14, z: 95 }, CAPE_FRAME);
    this.bindPointerControls(viewportEl);
  }

  private bindPointerControls(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.isDragging = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;

      if (this.mapMode) {
        this.targetMapLonRad -= dx * 0.0052;
        this.targetMapLatRad = clamp(this.targetMapLatRad + dy * 0.0052, -1.45, 1.45);
      } else {
        this.targetAzimuthRad -= dx * 0.0055;
        this.targetElevationRad = clamp(this.targetElevationRad + dy * 0.0055, -1.42, 1.48);
      }
    });

    const endDrag = () => {
      this.isDragging = false;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const zoomFactor = Math.exp(e.deltaY * 0.00115);
        if (this.mapMode) {
          this.targetMapRadiusM = clamp(
            this.targetMapRadiusM * zoomFactor,
            PLANET_CONFIG.meanRadiusM + 1_100_000,
            68_000_000
          );
        } else {
          const minDist = this.mode === 'ENGINE_CLOSEUP' ? 8 : 14;
          const maxDist = this.mode === 'FREE_ORBIT' ? 28_000_000 : 15_000_000;
          this.targetDistanceM = clamp(this.targetDistanceM * zoomFactor, minDist, maxDist);
        }
      },
      { passive: false }
    );
  }

  public setMapMode(enabled: boolean, focusRocket?: RocketFlightDynamics): void {
    if (enabled === this.mapMode) return;
    this.mapMode = enabled;
    if (enabled && focusRocket) {
      // Orient planetary map smoothly toward the active spacecraft's longitude & latitude
      const geo = focusRocket.getGeodetic();
      this.targetMapLonRad = (geo.longitudeDeg * Math.PI) / 180;
      this.targetMapLatRad = clamp((geo.latitudeDeg * Math.PI) / 180, -1.2, 1.2);
      this.mapLonRad = this.targetMapLonRad;
      this.mapLatRad = this.targetMapLatRad;
      this.targetFov = 45;
    } else {
      this.modeBlendTimer = 0.25;
      this.targetFov = 48;
    }
  }

  public toggleMapMode(focusRocket?: RocketFlightDynamics): boolean {
    this.setMapMode(!this.mapMode, focusRocket);
    return this.mapMode;
  }

  public adaptDistanceForCraft(rocket: RocketFlightDynamics): void {
    // Frame smaller vehicles (Stage 2, Starlink payload, fairings) naturally on switch!
    const ideal = clamp(rocket.config.heightM * 1.9 + 14, 18, 138);
    if (!this.mapMode && this.mode === 'FOLLOW') {
      this.targetDistanceM = ideal;
    }
  }

  public setMode(newMode: CameraMode): void {
    if (this.mapMode) this.mapMode = false;
    if (newMode === this.mode) return;
    this.mode = newMode;
    this.modeBlendTimer = 0.55;

    switch (newMode) {
      case 'FOLLOW':
        this.targetDistanceM = clamp(this.targetDistanceM, 35, 195);
        this.targetElevationRad = 0.16;
        this.targetFov = 48;
        break;
      case 'FREE_ORBIT':
        this.targetFov = 48;
        break;
      case 'GROUND_TRACK':
        this.targetFov = 42;
        break;
      case 'ENGINE_CLOSEUP':
        this.targetDistanceM = 22;
        this.targetElevationRad = -0.1;
        this.targetAzimuthRad = 0.55;
        this.targetFov = 54;
        break;
      case 'CINEMATIC_WIDE':
        this.targetDistanceM = 168;
        this.targetAzimuthRad = 2.55;
        this.targetElevationRad = 0.24;
        this.targetFov = 46;
        break;
    }
  }

  public cycleMode(): CameraMode {
    const idx = CAMERA_MODE_LIST.findIndex((m) => m.id === this.mode);
    const next = CAMERA_MODE_LIST[(idx + 1) % CAMERA_MODE_LIST.length].id;
    this.setMode(next);
    return next;
  }

  public resetView(): void {
    this.mapMode = false;
    this.mode = 'FOLLOW';
    this.azimuthRad = 0.44;
    this.targetAzimuthRad = 0.44;
    this.elevationRad = 0.16;
    this.targetElevationRad = 0.16;
    this.distanceM = 128;
    this.targetDistanceM = 128;
    this.targetFov = 48;
    this.camera.fov = 48;
    this.camera.updateProjectionMatrix();
    this.hasInitializedPos = false;
    this.modeBlendTimer = 0;
  }

  public update(rocket: RocketFlightDynamics, dt: number): void {
    const safeDt = Math.max(0.001, Math.min(0.1, dt));
    const damp = 1 - Math.exp(-10 * safeDt);

    if (this.mapMode) {
      this.updateOrbitalMapCamera(damp, safeDt);
      return;
    }

    this.cinematicTime += safeDt;
    if (this.modeBlendTimer > 0) {
      this.modeBlendTimer = Math.max(0, this.modeBlendTimer - safeDt);
    }

    this.distanceM += (this.targetDistanceM - this.distanceM) * damp;
    this.azimuthRad += (this.targetAzimuthRad - this.azimuthRad) * damp;
    this.elevationRad += (this.targetElevationRad - this.elevationRad) * damp;

    const horizonFrame = buildTangentFrameFromECEF(rocket.posECEF);
    const rocketNose = rotateVecByQuat({ x: 0, y: 1, z: 0 }, rocket.quatECEF);
    // Slight upward framing offset scaled cleanly to vehicle height (so small payloads & 70m stacks both center cleanly!)
    const visualCenterOffset = rocket.config.heightM * 0.12;
    const visualCenterECEF = addScaledVec3(rocket.posECEF, rocketNose, visualCenterOffset);
    const engineBaseECEF = rocket.getBasePositionECEF();

    const lookTargetECEF =
      this.mode === 'ENGINE_CLOSEUP'
        ? addScaledVec3(engineBaseECEF, rocketNose, 2.5)
        : visualCenterECEF;

    let desiredCamPosECEF: Vec3d;
    let camUpVec: Vec3d = horizonFrame.up;

    if (this.mode === 'GROUND_TRACK') {
      desiredCamPosECEF = this.groundTrackSiteECEF;
      camUpVec = CAPE_FRAME.up;
      const rangeM = lenVec3(subVec3(lookTargetECEF, desiredCamPosECEF));
      this.targetFov = clamp(45 - Math.log10(Math.max(120, rangeM) / 120) * 14, 9, 46);
    } else if (this.mode === 'CINEMATIC_WIDE') {
      const slowSweep = this.azimuthRad + Math.sin(this.cinematicTime * 0.14) * 0.25;
      const altM = Math.max(0, rocket.getAltitudeASL());
      const spaceT = clamp((altM - 25_000) / 55_000, 0, 1);
      const cinematicEl = this.elevationRad * (1 - spaceT) + 0.34 * spaceT;
      const dynamicDist = Math.max(this.distanceM, clamp(rocket.config.heightM * 2.2, 30, 165) + spaceT * 40);
      const offset = this.sphericalOffsetInFrame(horizonFrame, slowSweep, cinematicEl, dynamicDist);
      desiredCamPosECEF = addVec3(lookTargetECEF, offset);
    } else if (this.mode === 'ENGINE_CLOSEUP') {
      const rRight = rotateVecByQuat({ x: 1, y: 0, z: 0 }, rocket.quatECEF);
      const rBack = rotateVecByQuat({ x: 0, y: 0, z: 1 }, rocket.quatECEF);
      const cosEl = Math.cos(this.elevationRad);
      const ox = Math.cos(this.azimuthRad) * cosEl * this.distanceM;
      const oy = Math.sin(this.elevationRad) * this.distanceM;
      const oz = Math.sin(this.azimuthRad) * cosEl * this.distanceM;
      desiredCamPosECEF = {
        x: lookTargetECEF.x + rRight.x * ox + rocketNose.x * oy + rBack.x * oz,
        y: lookTargetECEF.y + rRight.y * ox + rocketNose.y * oy + rBack.y * oz,
        z: lookTargetECEF.z + rRight.z * ox + rocketNose.z * oy + rBack.z * oz,
      };
      camUpVec = rocketNose;
    } else {
      const offset = this.sphericalOffsetInFrame(
        horizonFrame,
        this.azimuthRad,
        this.elevationRad,
        this.distanceM
      );
      desiredCamPosECEF = addVec3(lookTargetECEF, offset);
    }

    const minSurfaceR = PLANET_CONFIG.meanRadiusM + 4.5;
    const camR = lenVec3(desiredCamPosECEF);
    if (camR < minSurfaceR) {
      const s = minSurfaceR / Math.max(1, camR);
      desiredCamPosECEF = {
        x: desiredCamPosECEF.x * s,
        y: desiredCamPosECEF.y * s,
        z: desiredCamPosECEF.z * s,
      };
    }

    if (!this.hasInitializedPos || this.modeBlendTimer <= 0) {
      this.cameraPosECEF = desiredCamPosECEF;
      this.hasInitializedPos = true;
    } else {
      const blend = 1 - Math.exp(-9 * safeDt);
      this.cameraPosECEF = {
        x: this.cameraPosECEF.x + (desiredCamPosECEF.x - this.cameraPosECEF.x) * blend,
        y: this.cameraPosECEF.y + (desiredCamPosECEF.y - this.cameraPosECEF.y) * blend,
        z: this.cameraPosECEF.z + (desiredCamPosECEF.z - this.cameraPosECEF.z) * blend,
      };
    }

    if (Math.abs(this.camera.fov - this.targetFov) > 0.05) {
      this.camera.fov += (this.targetFov - this.camera.fov) * Math.min(1, safeDt * 6);
      this.camera.updateProjectionMatrix();
    }

    const lookRel = subVec3(lookTargetECEF, this.cameraPosECEF);
    const upNorm = normVec3(camUpVec);
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(upNorm.x, upNorm.y, upNorm.z);
    this.camera.lookAt(lookRel.x, lookRel.y, lookRel.z);

    const camAltM = Math.max(0, lenVec3(this.cameraPosECEF) - PLANET_CONFIG.meanRadiusM);
    const distToTarget = Math.max(1, lenVec3(lookRel));
    const desiredNear = clamp(
      Math.min(distToTarget * 0.04, Math.max(0.5, camAltM * 0.008)),
      0.5,
      4_000
    );
    const desiredFar = Math.max(45_000_000, camAltM * 14 + 45_000_000);

    if (
      Math.abs(this.camera.near - desiredNear) / this.camera.near > 0.15 ||
      Math.abs(this.camera.far - desiredFar) / this.camera.far > 0.15
    ) {
      this.camera.near = desiredNear;
      this.camera.far = desiredFar;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateOrbitalMapCamera(damp: number, safeDt: number): void {
    this.mapLonRad += (this.targetMapLonRad - this.mapLonRad) * damp;
    this.mapLatRad += (this.targetMapLatRad - this.mapLatRad) * damp;
    this.mapRadiusM += (this.targetMapRadiusM - this.mapRadiusM) * damp;

    const cosLat = Math.cos(this.mapLatRad);
    this.cameraPosECEF = {
      x: this.mapRadiusM * cosLat * Math.cos(this.mapLonRad),
      y: this.mapRadiusM * Math.sin(this.mapLatRad),
      z: -this.mapRadiusM * cosLat * Math.sin(this.mapLonRad),
    };

    if (Math.abs(this.camera.fov - 45) > 0.05) {
      this.camera.fov += (45 - this.camera.fov) * Math.min(1, safeDt * 8);
      this.camera.updateProjectionMatrix();
    }

    // Look directly at Earth center (0,0,0) in camera-relative coords
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(-this.cameraPosECEF.x, -this.cameraPosECEF.y, -this.cameraPosECEF.z);

    const desiredNear = Math.max(10_000, this.mapRadiusM * 0.002);
    const desiredFar = Math.max(140_000_000, this.mapRadiusM * 8);
    if (
      Math.abs(this.camera.near - desiredNear) / this.camera.near > 0.15 ||
      Math.abs(this.camera.far - desiredFar) / this.camera.far > 0.15
    ) {
      this.camera.near = desiredNear;
      this.camera.far = desiredFar;
      this.camera.updateProjectionMatrix();
    }
  }

  private sphericalOffsetInFrame(
    frame: ReturnType<typeof buildTangentFrameFromECEF>,
    az: number,
    el: number,
    dist: number
  ): Vec3d {
    const cosEl = Math.cos(el);
    const east = Math.cos(az) * cosEl * dist;
    const up = Math.sin(el) * dist;
    const south = Math.sin(az) * cosEl * dist;
    return {
      x: frame.east.x * east + frame.up.x * up + frame.south.x * south,
      y: frame.east.y * east + frame.up.y * up + frame.south.y * south,
      z: frame.east.z * east + frame.up.z * up + frame.south.z * south,
    };
  }
}
