import * as THREE from 'three/webgpu';
import { LoadedAssets } from '../assets/assetManager';
import { PlanetSimulation } from '../simulation/planetSimulation';
import { SpacecraftManager } from '../simulation/spacecraftManager';
import { Vec3d, lenVec3, subVec3 } from '../math/vec3d';
import { PLANET_CONFIG } from '../config/planetConfig';
import { EarthRenderer } from './earthRenderer';
import { AtmosphereRenderer } from './atmosphereRenderer';
import { CapeCanaveralScene } from './capeCanaveralScene';
import { SpacecraftVisualManager } from './spacecraftVisualManager';
import { OrbitalMapRenderer } from './orbitalMapRenderer';

/**
 * Coordinates the Three.js WebGPU scene graph using camera-relative floating-origin positioning
 * for Earth, Atmosphere, Cape Canaveral, ALL independently simulated spacecraft, and the 3D Orbital Map.
 *
 * WebGPU stability invariants preserved:
 * - Never toggle `sunLight.castShadow` at runtime.
 * - Persistent equirectangular environment reflection texture (no disposed PMREM render targets).
 */
export class SceneController {
  public readonly scene: THREE.Scene;
  public readonly earth: EarthRenderer;
  public readonly atmosphere: AtmosphereRenderer;
  public readonly capeCanaveral: CapeCanaveralScene;
  public readonly spacecraftVisuals: SpacecraftVisualManager;
  public readonly orbitalMap: OrbitalMapRenderer;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly sunTarget: THREE.Object3D;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly fillLight: THREE.DirectionalLight;

  constructor(
    assets: LoadedAssets,
    hudRoot: HTMLElement,
    onSelectCraftFromMap: (id: string) => void
  ) {
    this.scene = new THREE.Scene();
    this.setupEnvironmentReflection();

    this.sunLight = new THREE.DirectionalLight(0xfff7ea, 3.35);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 20;
    this.sunLight.shadow.camera.far = 820;
    const d = 125;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.00045;
    this.sunLight.shadow.normalBias = 0.04;

    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sunTarget);
    this.sunLight.target = this.sunTarget;
    this.scene.add(this.sunLight);

    this.hemiLight = new THREE.HemisphereLight(0x7fb2ec, 0x3b4436, 0.82);
    this.scene.add(this.hemiLight);

    this.fillLight = new THREE.DirectionalLight(0x88b4e8, 0.4);
    this.scene.add(this.fillLight);

    this.atmosphere = new AtmosphereRenderer(assets);
    this.scene.add(this.atmosphere.skyDome);
    this.scene.add(this.atmosphere.starField);
    this.scene.add(this.atmosphere.atmoLimbMesh);
    this.scene.add(this.atmosphere.localCloudDeck);

    this.earth = new EarthRenderer(assets);
    this.scene.add(this.earth.group);

    this.capeCanaveral = new CapeCanaveralScene(assets);
    this.scene.add(this.capeCanaveral.group);

    this.spacecraftVisuals = new SpacecraftVisualManager(assets);
    this.scene.add(this.spacecraftVisuals.group);

    this.orbitalMap = new OrbitalMapRenderer(hudRoot, onSelectCraftFromMap);
    this.scene.add(this.orbitalMap.group);
  }

  private setupEnvironmentReflection(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, '#10326a');
    grad.addColorStop(0.36, '#3b79bc');
    grad.addColorStop(0.5, '#b8d5ef');
    grad.addColorStop(0.54, '#244b68');
    grad.addColorStop(1.0, '#18241d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 256);

    const sunSpot = ctx.createRadialGradient(365, 84, 4, 365, 84, 46);
    sunSpot.addColorStop(0.0, 'rgba(255, 250, 236, 1.0)');
    sunSpot.addColorStop(0.38, 'rgba(255, 236, 200, 0.5)');
    sunSpot.addColorStop(1.0, 'rgba(255, 236, 200, 0.0)');
    ctx.fillStyle = sunSpot;
    ctx.fillRect(300, 20, 140, 140);

    const envTex = new THREE.CanvasTexture(canvas);
    envTex.colorSpace = THREE.SRGBColorSpace;
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.needsUpdate = true;

    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.65;
  }

  public reset(): void {
    this.spacecraftVisuals.reset();
    this.orbitalMap.reset();
  }

  public update(
    manager: SpacecraftManager,
    planet: PlanetSimulation,
    camera: THREE.PerspectiveCamera,
    cameraPosECEF: Vec3d,
    inMapView: boolean,
    dt: number
  ): void {
    const activeRocket = manager.activeDynamics;
    const sunDir = planet.getSunDirectionECEF();
    const cameraAltitudeM = Math.max(0, lenVec3(cameraPosECEF) - PLANET_CONFIG.meanRadiusM);
    const rocketAltM = Math.max(0, activeRocket.getAltitudeASL());

    this.atmosphere.update(
      cameraPosECEF,
      sunDir,
      cameraAltitudeM,
      planet.earthRotationRad,
      camera.far
    );

    this.earth.update(cameraPosECEF, sunDir, cameraAltitudeM, dt);
    this.capeCanaveral.update(
      cameraPosECEF,
      sunDir,
      this.atmosphere.currentHorizonColor,
      this.atmosphere.currentZenithColor,
      inMapView ? 250_000 : cameraAltitudeM,
      dt
    );

    this.spacecraftVisuals.update(manager, cameraPosECEF, dt, inMapView);
    this.orbitalMap.update(inMapView, manager, planet, camera, cameraPosECEF);

    const rocketRel = subVec3(activeRocket.posECEF, cameraPosECEF);
    this.sunTarget.position.set(rocketRel.x, rocketRel.y, rocketRel.z);
    this.sunLight.position.set(
      rocketRel.x + sunDir.x * 360,
      rocketRel.y + sunDir.y * 360,
      rocketRel.z + sunDir.z * 360
    );

    this.fillLight.position.set(
      rocketRel.x - sunDir.x * 200,
      rocketRel.y - sunDir.y * 200,
      rocketRel.z - sunDir.z * 200
    );

    const atmoFill = Math.exp(-rocketAltM / 20_000);
    this.hemiLight.intensity = 0.08 + 0.76 * atmoFill;
    this.fillLight.intensity = 0.08 + 0.34 * atmoFill;
    this.scene.environmentIntensity = 0.22 + 0.45 * atmoFill;
  }
}
