import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  max,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  sub,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { PLANET_CONFIG } from '../config/planetConfig';
import { LoadedAssets } from '../assets/assetManager';
import { Vec3d } from '../math/vec3d';
import { capeImageryAlbedo } from './capeImagery';

/**
 * Renders the continuous, real-scale spherical Earth (R = 6,371 km) using TSL shaders:
 * - 8K NASA / Solar System Scope day imagery with procedural grazing-light topographic relief
 * - 2K night city-lights on the dark hemisphere with crisp golden coastal/urban glow
 * - Dual-lobe ocean specular sun glint, deep atmospheric Rayleigh limb scatter, and sunset terminator
 * - Rotating planetary 8K cloud shell with cast ground/ocean shadows (fading smoothly above 16 km)
 */
export class EarthRenderer {
  public readonly group: THREE.Group;
  private readonly earthMesh: THREE.Mesh;
  private readonly cloudMesh: THREE.Mesh;

  private readonly uSunDir = uniform(new THREE.Vector3(0.7, 0.4, 0.5));
  private readonly uCloudOpacity = uniform(0.0);
  private cloudSpinRad = 0;

  constructor(assets: LoadedAssets) {
    this.group = new THREE.Group();
    this.group.name = 'EarthPlanetaryRoot';

    const earthGeo = new THREE.SphereGeometry(PLANET_CONFIG.meanRadiusM, 384, 256);
    this.earthMesh = new THREE.Mesh(earthGeo, this.createEarthMaterial(assets));
    this.earthMesh.frustumCulled = false;
    this.group.add(this.earthMesh);

    const cloudGeo = new THREE.SphereGeometry(PLANET_CONFIG.meanRadiusM + 9_500, 384, 256);
    this.cloudMesh = new THREE.Mesh(cloudGeo, this.createCloudMaterial(assets));
    this.cloudMesh.frustumCulled = false;
    this.group.add(this.cloudMesh);
  }

  private createEarthMaterial(assets: LoadedAssets): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();

    const nWorld = normalize(normalWorld);
    const sunDir = normalize(this.uSunDir);
    const viewDir = normalize(sub(cameraPosition, positionWorld));

    const ndotl = dot(nWorld, sunDir);
    const dayFactor = smoothstep(float(-0.14), float(0.18), ndotl);
    const sunDiffuse = max(ndotl, float(0.0));

    const baseUv = uv();
    const globalDay = assets.earthDayMap ? texture(assets.earthDayMap, baseUv).rgb : color(0x1f4f88);
    const lonLat = baseUv.mul(vec2(360, 180)).sub(vec2(180, 90));
    const daySample = capeImageryAlbedo(globalDay, assets, lonLat);
    const nightSample = assets.earthNightMap ? texture(assets.earthNightMap, baseUv).rgb : color(0x020308);

    const oceanScore = clamp(
      daySample.b.sub(max(daySample.r, daySample.g)).mul(5.8),
      float(0.0),
      float(1.0)
    );
    const landScore = float(1.0).sub(oceanScore);

    // Subtle topographic slope relief derived from local daymap luminance gradient (makes mountains & coasts pop!)
    const eps = float(0.00055);
    const sRight = assets.earthDayMap ? texture(assets.earthDayMap, baseUv.add(vec2(eps, float(0.0)))).rgb : daySample;
    const sUp = assets.earthDayMap ? texture(assets.earthDayMap, baseUv.add(vec2(float(0.0), eps))).rgb : daySample;
    const lumC = dot(daySample, vec3(0.299, 0.587, 0.114));
    const lumR = dot(sRight, vec3(0.299, 0.587, 0.114));
    const lumU = dot(sUp, vec3(0.299, 0.587, 0.114));
    const reliefShade = clamp(
      float(1.0).add(lumR.sub(lumC).add(lumU.sub(lumC)).mul(3.4).mul(landScore)),
      float(0.76),
      float(1.24)
    );

    // Crisp dual-lobe ocean specular reflection from orbit
    const halfVec = normalize(sunDir.add(viewDir));
    const specAngle = max(dot(nWorld, halfVec), float(0.0));
    const oceanSpec = pow(specAngle, float(84.0))
      .mul(0.85)
      .add(pow(specAngle, float(18.0)).mul(0.16))
      .mul(oceanScore)
      .mul(dayFactor);

    // Realistic orbital Rayleigh atmospheric veil wrapping Earth's curved horizon
    const ndotv = clamp(dot(nWorld, viewDir), float(0.0), float(1.0));
    const fresnel = pow(float(1.0).sub(ndotv), float(3.8));
    const limbScatter = vec3(0.18, 0.52, 1.0).mul(fresnel).mul(dayFactor.mul(0.82).add(0.025));

    // Warm golden-red sunset terminator scatter band
    const terminatorBand = smoothstep(float(-0.18), float(0.0), ndotl)
      .mul(float(1.0).sub(smoothstep(float(0.0), float(0.22), ndotl)));
    const terminatorGlow = vec3(0.98, 0.38, 0.12).mul(terminatorBand).mul(0.36);

    // 8K cloud shadow cast onto oceans & continents for orbital depth
    const cloudShadowSample = assets.earthCloudsMap
      ? texture(assets.earthCloudsMap, baseUv.add(vec2(0.0018, -0.0012))).r
      : float(0.0);
    const cloudShadowMask = float(1.0).sub(
      smoothstep(float(0.3), float(0.85), cloudShadowSample).mul(0.32).mul(this.uCloudOpacity)
    );

    const dayLit = daySample
      .mul(reliefShade)
      .mul(sunDiffuse.mul(1.14).add(0.028))
      .mul(cloudShadowMask)
      .add(vec3(1.0, 0.96, 0.88).mul(oceanSpec).mul(cloudShadowMask));
    const nightLit = daySample.mul(0.007).add(nightSample.mul(vec3(1.28, 0.92, 0.58)).mul(1.75));

    mat.colorNode = mix(nightLit, dayLit, dayFactor).add(limbScatter).add(terminatorGlow);
    return mat;
  }

  private createCloudMaterial(assets: LoadedAssets): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;

    const nWorld = normalize(normalWorld);
    const sunDir = normalize(this.uSunDir);
    const ndotl = dot(nWorld, sunDir);
    const sunLit = smoothstep(float(-0.18), float(0.25), ndotl);

    const cloudRaw = assets.earthCloudsMap ? texture(assets.earthCloudsMap).r : float(0.0);
    const cloudVal = smoothstep(float(0.22), float(0.84), cloudRaw);

    const sunsetTint = smoothstep(float(-0.15), float(0.02), ndotl)
      .mul(float(1.0).sub(smoothstep(float(0.02), float(0.22), ndotl)));

    const cloudColor = vec3(0.97, 0.98, 1.0)
      .mul(sunLit.mul(0.96).add(0.04))
      .add(vec3(0.94, 0.44, 0.18).mul(sunsetTint).mul(0.38));

    mat.colorNode = cloudColor;
    mat.opacityNode = cloudVal.mul(this.uCloudOpacity).mul(sunLit.mul(0.9).add(0.1));
    return mat;
  }

  public update(
    cameraPosECEF: Vec3d,
    sunDirECEF: Vec3d,
    cameraAltitudeM: number,
    dt: number
  ): void {
    this.group.position.set(-cameraPosECEF.x, -cameraPosECEF.y, -cameraPosECEF.z);
    this.uSunDir.value.set(sunDirECEF.x, sunDirECEF.y, sunDirECEF.z).normalize();

    this.cloudSpinRad += dt * 0.000045;
    this.cloudMesh.rotation.y = this.cloudSpinRad;

    // Slight radius offset below 35 km prevents any z-fighting underneath regional procedural Cape terrain
    const lowAltBias = Math.max(0, 1 - cameraAltitudeM / 35_000);
    const earthScale = 1 - (65 * lowAltBias) / PLANET_CONFIG.meanRadiusM;
    this.earthMesh.scale.setScalar(earthScale);

    // Cross-fade global 8K planetary cloud shell cleanly from 16 km -> 38 km
    const globalCloudFade = Math.max(0, Math.min(0.66, (cameraAltitudeM - 16_000) / 22_000));
    this.uCloudOpacity.value = globalCloudFade;
  }
}
