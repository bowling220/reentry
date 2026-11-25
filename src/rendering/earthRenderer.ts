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

/**
 * Renders the continuous, real-scale spherical Earth (R = 6,371 km) using TSL shaders:
 * - 8K NASA / Solar System Scope day imagery
 * - 2K night city-lights on the dark hemisphere
 * - Ocean specular glint, bright atmospheric Rayleigh limb scatter, and golden terminator glow
 * - Rotating planetary 2K cloud shell (always mounted; smoothly fades in via uniform above 14 km)
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

    const earthGeo = new THREE.SphereGeometry(PLANET_CONFIG.meanRadiusM, 192, 128);
    this.earthMesh = new THREE.Mesh(earthGeo, this.createEarthMaterial(assets));
    this.earthMesh.frustumCulled = false;
    this.group.add(this.earthMesh);

    const cloudGeo = new THREE.SphereGeometry(PLANET_CONFIG.meanRadiusM + 9_500, 128, 96);
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

    const daySample = assets.earthDayMap ? texture(assets.earthDayMap).rgb : color(0x1f4f88);
    const nightSample = assets.earthNightMap ? texture(assets.earthNightMap).rgb : color(0x020308);

    const oceanScore = clamp(
      daySample.b.sub(max(daySample.r, daySample.g)).mul(5.5),
      float(0.0),
      float(1.0)
    );

    const halfVec = normalize(sunDir.add(viewDir));
    const specAngle = max(dot(nWorld, halfVec), float(0.0));
    const oceanSpec = pow(specAngle, float(54.0)).mul(oceanScore).mul(dayFactor).mul(0.7);

    // Delicate blue Rayleigh atmospheric haze wrapping Earth's curved limb without washing out oceans/continents
    const ndotv = clamp(dot(nWorld, viewDir), float(0.0), float(1.0));
    const fresnel = pow(float(1.0).sub(ndotv), float(4.0));
    const limbScatter = vec3(0.16, 0.48, 0.98).mul(fresnel).mul(dayFactor.mul(0.75).add(0.03));

    const terminatorBand = smoothstep(float(-0.18), float(0.0), ndotl)
      .mul(float(1.0).sub(smoothstep(float(0.0), float(0.22), ndotl)));
    const terminatorGlow = vec3(0.96, 0.36, 0.12).mul(terminatorBand).mul(0.32);

    // Subtle 8K cloud shadow cast onto Earth's oceans & continents for genuine orbital depth
    const cloudShadowSample = assets.earthCloudsMap
      ? texture(assets.earthCloudsMap, uv().add(vec2(0.0018, -0.0012))).r
      : float(0.0);
    const cloudShadowMask = float(1.0).sub(
      smoothstep(float(0.32), float(0.85), cloudShadowSample).mul(0.28).mul(this.uCloudOpacity)
    );

    const dayLit = daySample
      .mul(sunDiffuse.mul(1.1).add(0.032))
      .mul(cloudShadowMask)
      .add(vec3(1.0, 0.96, 0.88).mul(oceanSpec).mul(cloudShadowMask));
    const nightLit = daySample.mul(0.009).add(nightSample.mul(vec3(1.25, 0.94, 0.62)).mul(1.65));

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
    // Crisp meteorological cloud contrast so deep blue oceans & continents shine clearly through gaps
    const cloudVal = smoothstep(float(0.22), float(0.84), cloudRaw);

    const sunsetTint = smoothstep(float(-0.15), float(0.02), ndotl)
      .mul(float(1.0).sub(smoothstep(float(0.02), float(0.22), ndotl)));

    const cloudColor = vec3(0.96, 0.97, 1.0)
      .mul(sunLit.mul(0.96).add(0.04))
      .add(vec3(0.92, 0.42, 0.18).mul(sunsetTint).mul(0.35));

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

    // Slight radius offset below 35 km prevents any z-fighting underneath USGS regional terrain
    const lowAltBias = Math.max(0, 1 - cameraAltitudeM / 35_000);
    const earthScale = 1 - (65 * lowAltBias) / PLANET_CONFIG.meanRadiusM;
    this.earthMesh.scale.setScalar(earthScale);

    // Cross-fade global 2K weather clouds in smoothly from 14 km -> 34 km
    const globalCloudFade = Math.max(0, Math.min(0.62, (cameraAltitudeM - 14_000) / 22_000));
    this.uCloudOpacity.value = globalCloudFade;
  }
}
