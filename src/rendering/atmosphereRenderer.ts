import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  length,
  max,
  mix,
  normalWorld,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  sub,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { LoadedAssets } from '../assets/assetManager';
import { PLANET_CONFIG } from '../config/planetConfig';
import { Vec3d, subVec3 } from '../math/vec3d';
import { CAPE_FRAME } from '../simulation/terrainHeight';

/**
 * Physical atmospheric scattering & space transition renderer:
 * 1. Rayleigh + Henyey-Greenstein Mie sky dome calibrated to Earth's real 8.5 km scale height:
 *    - 0-12 km: Rich Florida coastal blue sky with warm luminous horizon & sun aureole
 *    - 20-45 km: Deep ink-indigo stratosphere zenith, crisp thin blue horizon band, emerging stars
 *    - 65-100+ km: Pitch-black outer space with thousands of crisp stars & glowing solar disc
 * 2. Planetary Rayleigh/Mie atmospheric limb halo hugging Earth's 6,371 km curved horizon.
 * 3. Realistic coastal Florida cloud deck (~2.85 km) sampling real NASA/SSS meteorological
 *    cloud maps (two drifting octaves) instead of blobby sine waves, fading smoothly into orbit.
 * 4. Sidereal-rotating 4,000-star celestial sphere.
 */
export class AtmosphereRenderer {
  public readonly skyDome: THREE.Mesh;
  public readonly atmoLimbMesh: THREE.Mesh;
  public readonly localCloudDeck: THREE.Mesh;
  public readonly starField: THREE.Points;

  public readonly currentHorizonColor = new THREE.Color(0x95bee6);
  public readonly currentZenithColor = new THREE.Color(0x143c82);

  private readonly uSunDir = uniform(new THREE.Vector3(0.7, 0.4, 0.5));
  private readonly uLocalUp = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uRayleighScale = uniform(1.0);
  private readonly uMieScale = uniform(1.0);
  private readonly uDayFactor = uniform(1.0);
  private readonly uLimbStrength = uniform(0.0);
  private readonly uCloudFade = uniform(1.0);
  private readonly starMaterial: THREE.PointsMaterial;

  constructor(assets: LoadedAssets) {
    // 1. Camera-centered Rayleigh + Mie sky dome
    const skyGeo = new THREE.SphereGeometry(1, 64, 48);
    this.skyDome = new THREE.Mesh(skyGeo, this.createPhysicalSkyMaterial());
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -1000;

    // 2. Real-scale planetary atmospheric scattering outer shell (R = 6,371 km + 115 km)
    const limbGeo = new THREE.SphereGeometry(PLANET_CONFIG.meanRadiusM + 115_000, 144, 96);
    this.atmoLimbMesh = new THREE.Mesh(limbGeo, this.createLimbShellMaterial());
    this.atmoLimbMesh.frustumCulled = false;
    this.atmoLimbMesh.renderOrder = 6;

    // 3. Curved Florida coastal cumulus cloud canopy at 2.85 km altitude
    this.localCloudDeck = this.buildLocalCloudDeck(assets);
    this.localCloudDeck.frustumCulled = false;
    this.localCloudDeck.renderOrder = 4;

    // 4. Celestial starfield
    const { points, material } = this.createStarField();
    this.starField = points;
    this.starMaterial = material;
    this.starField.frustumCulled = false;
    this.starField.renderOrder = -990;
  }

  private createPhysicalSkyMaterial(): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.side = THREE.BackSide;
    mat.depthWrite = false;
    mat.depthTest = false;

    const dir = normalize(positionLocal);
    const up = normalize(this.uLocalUp);
    const sunDir = normalize(this.uSunDir);

    const elev = dot(dir, up);
    const clampedElev = max(elev, float(0.0));
    const sunElev = dot(sunDir, up);
    const sunCos = dot(dir, sunDir);

    // Optical air mass with true atmospheric pressure decay (uRayleighScale -> 0 in space!)
    const airMassR = float(1.0).div(clampedElev.add(0.075)).mul(this.uRayleighScale);
    const airMassM = float(1.0).div(clampedElev.add(0.042)).mul(this.uMieScale);

    // Wavelength-dependent Rayleigh extinction
    const betaR = vec3(0.058, 0.138, 0.33);
    const transR = vec3(
      exp(betaR.x.negate().mul(airMassR)),
      exp(betaR.y.negate().mul(airMassR)),
      exp(betaR.z.negate().mul(airMassR))
    );

    const rayleighPhase = float(0.75).mul(float(1.0).add(sunCos.mul(sunCos)));
    // Multiply explicitly by smooth atmospheric density envelope so sky goes PURE BLACK in space!
    const atmoPresence = smoothstep(float(0.002), float(0.18), this.uRayleighScale);
    const inScatterR = vec3(1.0)
      .sub(transR)
      .mul(vec3(0.4, 0.72, 1.2))
      .mul(rayleighPhase.mul(0.5).add(0.5))
      .mul(atmoPresence);

    // Henyey-Greenstein Mie forward scatter (g = 0.76)
    const g = float(0.76);
    const g2 = g.mul(g);
    const denom = pow(max(float(0.04), float(1.0).add(g2).sub(g.mul(2.0).mul(sunCos))), float(1.5));
    const miePhase = float(1.0).sub(g2).div(denom.mul(4.6));

    const mieAmount = float(1.0).sub(exp(airMassM.mul(-0.18))).mul(this.uMieScale);
    const sunWarmth = smoothstep(float(0.4), float(-0.04), sunElev);
    const mieTint = mix(vec3(0.92, 0.95, 1.0), vec3(1.0, 0.6, 0.3), sunWarmth);
    const inScatterM = mieTint.mul(mieAmount.mul(0.52).add(miePhase.mul(0.14).mul(this.uMieScale)));

    // Horizon aerial glow band (tightens into a razor-thin electric blue rim in the stratosphere!)
    const horizonTightness = mix(float(28.0), float(7.5), this.uRayleighScale);
    const horizonGlow = exp(clampedElev.mul(horizonTightness.negate())).mul(this.uRayleighScale).mul(0.45);
    const horizonTint = mix(vec3(0.42, 0.72, 1.0), vec3(0.98, 0.58, 0.32), sunWarmth);

    const daySky = inScatterR.add(inScatterM).add(horizonTint.mul(horizonGlow)).mul(this.uDayFactor);

    // Crisp sun disc & subtle solar corona visible even in black vacuum of space
    const sunCore = pow(max(sunCos, float(0.0)), float(1200.0)).mul(7.0);
    const sunCorona = pow(max(sunCos, float(0.0)), float(90.0)).mul(0.18);
    const sunDisc = vec3(1.0, 0.96, 0.88).mul(sunCore.add(sunCorona));

    const belowFade = smoothstep(float(-0.08), float(0.015), elev);
    const deepSpace = vec3(0.0008, 0.0012, 0.0028);
    const finalSky = mix(deepSpace, daySky, belowFade).add(sunDisc);

    mat.colorNode = finalSky;
    return mat;
  }

  private createLimbShellMaterial(): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.side = THREE.BackSide;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;

    const nWorld = normalize(normalWorld);
    const sunDir = normalize(this.uSunDir);
    const viewDir = normalize(sub(cameraPosition, positionWorld));

    // On a BackSide outer atmosphere shell, dot(-nWorld, viewDir) is 0.0 at the outer vacuum edge
    // and increases inward toward Earth's horizon. Feathering to 0 at cosV=0 removes the hard white band!
    const cosV = clamp(dot(nWorld.negate(), viewDir), float(0.0), float(1.0));
    const outerFeather = pow(cosV, float(2.6));
    const horizonPeak = smoothstep(float(0.0), float(0.45), cosV);
    const limbGlow = outerFeather.mul(horizonPeak);

    const ndotl = dot(nWorld, sunDir);
    const sunLit = smoothstep(float(-0.22), float(0.32), ndotl);
    const terminator = smoothstep(float(-0.2), float(0.0), ndotl)
      .mul(float(1.0).sub(smoothstep(float(0.0), float(0.22), ndotl)));

    const deepBlue = vec3(0.07, 0.28, 0.88);
    const horizonCyan = vec3(0.26, 0.62, 1.0);
    const sunsetOrange = vec3(0.92, 0.34, 0.12);

    const scatter = mix(deepBlue, horizonCyan, smoothstep(float(0.1), float(0.75), cosV))
      .mul(limbGlow)
      .add(sunsetOrange.mul(terminator).mul(limbGlow).mul(0.65));

    mat.colorNode = scatter.mul(sunLit).mul(1.05).mul(this.uLimbStrength);
    mat.opacityNode = clamp(limbGlow.mul(sunLit).mul(0.85).mul(this.uLimbStrength), float(0.0), float(0.85));
    return mat;
  }

  private buildLocalCloudDeck(assets: LoadedAssets): THREE.Mesh {
    const radius = 125_000;
    const rings = 44;
    const sectors = 64;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const cloudAltM = 2850;
    positions.push(0, cloudAltM, 0);
    uvs.push(0.5, 0.5);

    for (let r = 1; r <= rings; r++) {
      const t = r / rings;
      const rad = Math.pow(t, 1.85) * radius;
      const drop = (rad * rad) / (2 * PLANET_CONFIG.meanRadiusM);
      for (let s = 0; s < sectors; s++) {
        const theta = (s / sectors) * Math.PI * 2;
        const x = Math.cos(theta) * rad;
        const z = Math.sin(theta) * rad;
        positions.push(x, cloudAltM - drop, z);
        uvs.push(0.5 + x / (radius * 2), 0.5 - z / (radius * 2));
      }
    }

    for (let s = 0; s < sectors; s++) {
      indices.push(0, 1 + ((s + 1) % sectors), 1 + s);
    }
    for (let r = 1; r < rings; r++) {
      const a0 = 1 + (r - 1) * sectors;
      const b0 = 1 + r * sectors;
      for (let s = 0; s < sectors; s++) {
        const n = (s + 1) % sectors;
        indices.push(a0 + s, a0 + n, b0 + n, a0 + s, b0 + n, b0 + s);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;

    const pLocal = positionLocal;
    const pWorld = positionWorld;
    const sunDir = normalize(this.uSunDir);

    // Sample genuine meteorological NASA/SSS cloud texture in two drifting scales
    const drift1 = vec2(time.mul(0.00018), time.mul(0.00007));
    const drift2 = vec2(time.mul(-0.00011), time.mul(0.00014));
    const uv1 = vec2(pLocal.x.div(78000.0).add(0.22), pLocal.z.div(78000.0).add(0.41)).add(drift1);
    const uv2 = vec2(pLocal.x.div(34000.0).add(0.67), pLocal.z.div(34000.0).add(0.18)).add(drift2);

    const c1 = assets.earthCloudsMap ? texture(assets.earthCloudsMap, uv1).r : float(0.0);
    const c2 = assets.earthCloudsMap ? texture(assets.earthCloudsMap, uv2).r : float(0.0);
    const combined = c1.mul(0.65).add(c2.mul(0.35));

    // Keep launch corridor partly open (Florida fair-weather scattered cumulus)
    const cloudAlpha = smoothstep(float(0.34), float(0.76), combined);

    const viewDir = normalize(sub(pWorld, cameraPosition));
    const forwardScatter = pow(max(dot(viewDir, sunDir), float(0.0)), float(6.0)).mul(0.28);

    const cloudShadow = vec3(0.64, 0.72, 0.82);
    const cloudSunlit = vec3(0.99, 0.98, 0.96);
    const cloudColor = mix(cloudShadow, cloudSunlit, smoothstep(float(0.15), float(0.82), cloudAlpha).mul(0.65).add(0.3))
      .add(vec3(1.0, 0.95, 0.85).mul(forwardScatter))
      .mul(this.uDayFactor.mul(0.92).add(0.06));

    const radialDist = length(vec2(pLocal.x, pLocal.z));
    const outerFade = float(1.0).sub(smoothstep(float(48000.0), float(122000.0), radialDist));
    const camDist = length(sub(cameraPosition, pWorld));
    const closeSoftFade = smoothstep(float(220.0), float(1600.0), camDist);

    mat.colorNode = cloudColor;
    mat.opacityNode = cloudAlpha.mul(outerFade).mul(closeSoftFade).mul(this.uCloudFade).mul(0.62);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.set(
      CAPE_FRAME.localToECEF.x,
      CAPE_FRAME.localToECEF.y,
      CAPE_FRAME.localToECEF.z,
      CAPE_FRAME.localToECEF.w
    );
    return mesh;
  }

  private createStarField(): { points: THREE.Points; material: THREE.PointsMaterial } {
    const starCount = 4200;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    let seed = 421987;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const starPalette = [
      [0.78, 0.88, 1.0],
      [0.96, 0.97, 1.0],
      [1.0, 0.95, 0.84],
      [1.0, 0.82, 0.64],
    ];

    for (let i = 0; i < starCount; i++) {
      const u = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);

      positions[i * 3] = r * Math.cos(phi);
      positions[i * 3 + 1] = u;
      positions[i * 3 + 2] = r * Math.sin(phi);

      const mag = Math.pow(rand(), 2.1);
      const brightness = 0.28 + 0.72 * mag;
      const tint = starPalette[Math.floor(rand() * starPalette.length)];

      colors[i * 3] = tint[0] * brightness;
      colors[i * 3 + 1] = tint[1] * brightness;
      colors[i * 3 + 2] = tint[2] * brightness;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 2.0,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    return { points: new THREE.Points(geo, material), material };
  }

  public update(
    cameraPosECEF: Vec3d,
    sunDirECEF: Vec3d,
    cameraAltitudeM: number,
    earthRotationRad: number,
    cameraFar: number
  ): void {
    const skyRadius = Math.max(5000, cameraFar * 0.56);
    this.skyDome.scale.setScalar(skyRadius);
    this.skyDome.position.set(0, 0, 0);

    const r = Math.hypot(cameraPosECEF.x, cameraPosECEF.y, cameraPosECEF.z) || 1;
    const upX = cameraPosECEF.x / r;
    const upY = cameraPosECEF.y / r;
    const upZ = cameraPosECEF.z / r;

    this.uLocalUp.value.set(upX, upY, upZ);
    this.uSunDir.value.set(sunDirECEF.x, sunDirECEF.y, sunDirECEF.z).normalize();

    // Daytime-calibrated atmospheric transition:
    // - 0-15 km: rich bright Florida coastal blue sky & soft horizon haze
    // - 20-45 km: realistic deep royal/cobalt stratosphere (NOT prematurely black at 28 km!)
    // - 55-90+ km: smooth continuous transition into pitch-black star-filled space
    const alt = Math.max(0, cameraAltitudeM);
    const rayleighFactor = Math.exp(-alt / 13_800);
    const mieFactor = Math.exp(-alt / 4_400);
    this.uRayleighScale.value = Math.max(0, Math.min(1, rayleighFactor));
    this.uMieScale.value = Math.max(0, Math.min(1, mieFactor));

    const sunDotUp = upX * sunDirECEF.x + upY * sunDirECEF.y + upZ * sunDirECEF.z;
    const dayFactor = Math.max(0.02, Math.min(1.0, (sunDotUp + 0.14) / 0.32));
    this.uDayFactor.value = dayFactor;

    const sunsetT = Math.max(0, Math.min(1, (0.35 - sunDotUp) / 0.4));
    this.currentHorizonColor.setRGB(
      (0.56 + 0.34 * sunsetT) * rayleighFactor * dayFactor,
      (0.74 - 0.14 * sunsetT) * rayleighFactor * dayFactor,
      (0.92 - 0.45 * sunsetT) * rayleighFactor * dayFactor
    );
    this.currentZenithColor.setRGB(
      0.055 * rayleighFactor * dayFactor,
      0.19 * rayleighFactor * dayFactor,
      0.52 * rayleighFactor * dayFactor
    );

    // Planetary atmospheric limb halo fades in smoothly above 24 km
    this.atmoLimbMesh.position.set(-cameraPosECEF.x, -cameraPosECEF.y, -cameraPosECEF.z);
    this.uLimbStrength.value = Math.max(0, Math.min(1, (alt - 22_000) / 48_000));

    // Coastal cumulus cloud canopy fades smoothly into 8K planetary cloud shell between 18 km and 40 km
    const capeRel = subVec3(CAPE_FRAME.originECEF, cameraPosECEF);
    this.localCloudDeck.position.set(capeRel.x, capeRel.y, capeRel.z);
    const cloudAltFade = 1 - Math.max(0, Math.min(1, (alt - 18_000) / 24_000));
    this.uCloudFade.value = cloudAltFade;

    // Stars stay suppressed against bright daytime skies (<= 35 km) and emerge smoothly between 38-80 km or at night
    this.starField.position.set(0, 0, 0);
    this.starField.scale.setScalar(skyRadius * 0.96);
    this.starField.rotation.y = -earthRotationRad;

    const skyBrightness = rayleighFactor * dayFactor;
    const starT = Math.max(0, Math.min(1, (0.095 - skyBrightness) / 0.082));
    const starVis = starT * starT * (3 - 2 * starT);
    this.starMaterial.opacity = starVis;
  }
}
