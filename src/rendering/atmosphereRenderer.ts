import * as THREE from 'three/webgpu';
import {
  abs,
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
  uniform,
  vec3,
} from 'three/tsl';
import { LoadedAssets } from '../assets/assetManager';
import { PLANET_CONFIG } from '../config/planetConfig';
import { Vec3d, subVec3 } from '../math/vec3d';
import { CAPE_FRAME, curvatureDropM } from '../simulation/terrainHeight';

/**
 * Physical atmospheric scattering, 3D volumetric-style cumulus clouds, & space transition renderer:
 * 1. Rayleigh + Henyey-Greenstein Mie sky dome calibrated to Earth's atmospheric scale height.
 * 2. Planetary Rayleigh/Mie atmospheric limb halo hugging Earth's 6,371 km curved horizon.
 * 3. True 3D multi-lobe Florida coastal cumulus cloud formations (zero flat 2D ceiling sheets!)
 *    with soft Fresnel edge dissolution, warm sunlit crowns, cool shadowed undersides,
 *    silver-lining forward scatter, and gentle coastal wind drift.
 * 4. Sidereal-rotating 5,600-star celestial sphere with Milky Way band & spectral colors.
 */
export class AtmosphereRenderer {
  public readonly skyDome: THREE.Mesh;
  public readonly atmoLimbMesh: THREE.Mesh;
  public readonly localCloudDeck: THREE.Group;
  public readonly starField: THREE.Points;

  public readonly currentHorizonColor = new THREE.Color(0x95bee6);
  public readonly currentZenithColor = new THREE.Color(0x143c82);

  private readonly uSunDir = uniform(new THREE.Vector3(0.7, 0.4, 0.5));
  private readonly uLocalUp = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uHorizonColor = uniform(new THREE.Vector3(0.56, 0.74, 0.92));
  private readonly uRayleighScale = uniform(1.0);
  private readonly uMieScale = uniform(1.0);
  private readonly uDayFactor = uniform(1.0);
  private readonly uLimbStrength = uniform(0.0);
  private readonly uCloudFade = uniform(1.0);
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly cloudInstancedMesh: THREE.InstancedMesh;
  private cloudDriftClock = 0;

  constructor(_assets: LoadedAssets) {
    // 1. Camera-centered Rayleigh + Mie sky dome
    const skyGeo = new THREE.SphereGeometry(1, 64, 48);
    this.skyDome = new THREE.Mesh(skyGeo, this.createPhysicalSkyMaterial());
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -1000;

    // 2. Real-scale planetary atmospheric scattering outer shell (R = 6,371 km + 115 km)
    const limbGeo = new THREE.SphereGeometry(PLANET_CONFIG.meanRadiusM + 115_000, 384, 256);
    this.atmoLimbMesh = new THREE.Mesh(limbGeo, this.createLimbShellMaterial());
    this.atmoLimbMesh.frustumCulled = false;
    this.atmoLimbMesh.renderOrder = 6;

    // 3. True 3D volumetric-style coastal Florida cumulus cloud field (NO flat 2D cloud image sheet!)
    const { group, instanced } = this.build3DCumulusCloudField();
    this.localCloudDeck = group;
    this.cloudInstancedMesh = instanced;

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
    const airMassR = float(1.0).div(clampedElev.add(0.072)).mul(this.uRayleighScale);
    const airMassM = float(1.0).div(clampedElev.add(0.038)).mul(this.uMieScale);

    // Wavelength-dependent Rayleigh extinction
    const betaR = vec3(0.056, 0.136, 0.335);
    const transR = vec3(
      exp(betaR.x.negate().mul(airMassR)),
      exp(betaR.y.negate().mul(airMassR)),
      exp(betaR.z.negate().mul(airMassR))
    );

    const rayleighPhase = float(0.75).mul(float(1.0).add(sunCos.mul(sunCos)));
    const atmoPresence = smoothstep(float(0.002), float(0.18), this.uRayleighScale);
    const inScatterR = vec3(1.0)
      .sub(transR)
      .mul(vec3(0.39, 0.72, 1.24))
      .mul(rayleighPhase.mul(0.5).add(0.5))
      .mul(atmoPresence);

    // Henyey-Greenstein Mie forward scatter (g = 0.78)
    const g = float(0.78);
    const g2 = g.mul(g);
    const denom = pow(max(float(0.035), float(1.0).add(g2).sub(g.mul(2.0).mul(sunCos))), float(1.5));
    const miePhase = float(1.0).sub(g2).div(denom.mul(4.8));

    const mieAmount = float(1.0).sub(exp(airMassM.mul(-0.19))).mul(this.uMieScale);
    const sunWarmth = smoothstep(float(0.42), float(-0.04), sunElev);
    const mieTint = mix(vec3(0.93, 0.96, 1.0), vec3(1.0, 0.58, 0.28), sunWarmth);
    const inScatterM = mieTint.mul(mieAmount.mul(0.5).add(miePhase.mul(0.15).mul(this.uMieScale)));

    // Crisp horizon aerial glow band (tightens into a razor-thin electric blue rim in the stratosphere!)
    const horizonTightness = mix(float(30.0), float(7.2), this.uRayleighScale);
    const horizonGlow = exp(clampedElev.mul(horizonTightness.negate())).mul(this.uRayleighScale).mul(0.46);
    const horizonTint = mix(vec3(0.44, 0.74, 1.0), vec3(0.98, 0.56, 0.3), sunWarmth);

    const daySky = inScatterR.add(inScatterM).add(horizonTint.mul(horizonGlow)).mul(this.uDayFactor);

    // Crisp solar disc & soft corona visible even in deep black vacuum of space
    const sunCore = pow(max(sunCos, float(0.0)), float(1500.0)).mul(8.0);
    const sunCorona = pow(max(sunCos, float(0.0)), float(95.0)).mul(0.2);
    const sunDisc = vec3(1.0, 0.96, 0.88).mul(sunCore.add(sunCorona));

    const belowFade = smoothstep(float(-0.08), float(0.015), elev);
    const deepSpace = vec3(0.0007, 0.001, 0.0024);
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

    const cosV = clamp(dot(nWorld.negate(), viewDir), float(0.0), float(1.0));
    const outerFeather = pow(cosV, float(2.5));
    const horizonPeak = smoothstep(float(0.0), float(0.42), cosV);
    const limbGlow = outerFeather.mul(horizonPeak);

    const ndotl = dot(nWorld, sunDir);
    const sunLit = smoothstep(float(-0.22), float(0.32), ndotl);
    const terminator = smoothstep(float(-0.2), float(0.0), ndotl)
      .mul(float(1.0).sub(smoothstep(float(0.0), float(0.22), ndotl)));

    const deepBlue = vec3(0.06, 0.27, 0.9);
    const horizonCyan = vec3(0.28, 0.65, 1.0);
    const sunsetOrange = vec3(0.95, 0.35, 0.12);

    const scatter = mix(deepBlue, horizonCyan, smoothstep(float(0.08), float(0.72), cosV))
      .mul(limbGlow)
      .add(sunsetOrange.mul(terminator).mul(limbGlow).mul(0.7));

    mat.colorNode = scatter.mul(sunLit).mul(1.12).mul(this.uLimbStrength);
    mat.opacityNode = clamp(limbGlow.mul(sunLit).mul(0.88).mul(this.uLimbStrength), float(0.0), float(0.88));
    return mat;
  }

  /**
   * Generates a sculpted bumpy 3D cloud puff geometry with a slightly flattened condensation base.
   */
  private createSculptedCloudLobeGeometry(): THREE.BufferGeometry {
    const geo = new THREE.IcosahedronGeometry(1.0, 2);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // Organic multi-frequency billow displacement
      const bump =
        1.0 +
        0.16 * Math.sin(v.x * 3.7 + v.y * 2.9) +
        0.12 * Math.cos(v.z * 4.3 - v.x * 3.1) +
        0.08 * Math.sin(v.y * 5.2 + v.z * 4.1);
      v.multiplyScalar(bump);
      // Flatten cloud underside like real cumulus condensation level
      if (v.y < 0) {
        v.y *= 0.48;
      } else {
        v.y *= 0.88;
      }
      pos.setXYZ(i, v.x, v.y, v.z);
    }

    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Builds a true 3D Florida coastal cumulus cloud field (instanced multi-lobe volumetric formations).
   */
  private build3DCumulusCloudField(): { group: THREE.Group; instanced: THREE.InstancedMesh } {
    const group = new THREE.Group();
    group.name = 'Coastal3DCumulusField';
    group.quaternion.set(
      CAPE_FRAME.localToECEF.x,
      CAPE_FRAME.localToECEF.y,
      CAPE_FRAME.localToECEF.z,
      CAPE_FRAME.localToECEF.w
    );

    const lobeGeo = this.createSculptedCloudLobeGeometry();
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;

    const nWorld = normalize(normalWorld);
    const pWorld = positionWorld;
    const sunDir = normalize(this.uSunDir);
    const up = normalize(this.uLocalUp);
    const viewDir = normalize(sub(cameraPosition, pWorld));
    const camDist = length(sub(cameraPosition, pWorld));

    // Soft volumetric Fresnel edge dissolution so overlapping 3D lobes blend like real vapor
    const facing = clamp(abs(dot(nWorld, viewDir)), float(0.001), float(1.0));
    const softVolume = pow(facing, float(1.45));

    // Dual-tone cumulus shading: warm sunlit crown + cool blue-slate shadowed cloud belly
    const sunN = dot(nWorld, sunDir).mul(0.5).add(0.5);
    const upN = dot(nWorld, up).mul(0.5).add(0.5);
    const lightMix = clamp(sunN.mul(0.68).add(upN.mul(0.32)), float(0.0), float(1.0));

    // Silver-lining Henyey-Greenstein forward scattering when viewing clouds near the Sun
    const lookSun = max(dot(viewDir.negate(), sunDir), float(0.0));
    const silverLining = pow(lookSun, float(7.0))
      .mul(float(1.0).sub(facing).mul(0.75).add(0.25))
      .mul(0.42);

    const shadowTint = vec3(0.54, 0.63, 0.76);
    const sunlitTint = vec3(0.99, 0.98, 0.96);
    const cloudBody = mix(shadowTint, sunlitTint, smoothstep(float(0.18), float(0.86), lightMix))
      .add(vec3(1.0, 0.94, 0.84).mul(silverLining))
      .mul(this.uDayFactor.mul(0.94).add(0.04));

    // Distance aerial perspective haze so far horizon cumulus dissolve naturally into the sky
    const haze = float(1.0).sub(exp(camDist.mul(-0.000022))).mul(0.72);
    const finalCloudCol = mix(cloudBody, this.uHorizonColor, clamp(haze, float(0.0), float(0.82)));

    // Gentle fade right at camera clip distance so flying directly through a cloud feels silky
    const closeSoftFade = smoothstep(float(180.0), float(1100.0), camDist);
    const farFade = float(1.0).sub(smoothstep(float(120000.0), float(240000.0), camDist));

    mat.colorNode = finalCloudCol;
    mat.opacityNode = clamp(
      softVolume.mul(closeSoftFade).mul(farFade).mul(this.uCloudFade).mul(0.82),
      float(0.0),
      float(0.86)
    );

    // Scatter 46 distinct multi-lobe fair-weather Florida cumulus formations (~280 total lobes)
    const maxLobes = 320;
    const instanced = new THREE.InstancedMesh(lobeGeo, mat, maxLobes);
    instanced.frustumCulled = false;
    instanced.renderOrder = 4;

    let seed = 882731;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const dummy = new THREE.Object3D();
    let idx = 0;
    const cloudCount = 48;

    for (let c = 0; c < cloudCount && idx < maxLobes - 8; c++) {
      // Keep direct zenith over SLC-40 partly open for clear sunlight while surrounding sky & ocean
      const angle = rand() * Math.PI * 2;
      const dist = 3_200 + Math.pow(rand(), 0.72) * 44_000;
      const cx = Math.cos(angle) * dist;
      const cz = Math.sin(angle) * dist;
      const baseAlt = 1_850 + rand() * 2_200 - curvatureDropM(cx, cz);

      const lobesInCloud = 5 + Math.floor(rand() * 4);
      const formationScale = 340 + rand() * 580;

      for (let l = 0; l < lobesInCloud && idx < maxLobes; l++) {
        const isTower = l === 0;
        const offAng = (l / lobesInCloud) * Math.PI * 2 + rand() * 0.6;
        const offRad = isTower ? 0 : formationScale * (0.45 + rand() * 0.72);
        const lx = cx + Math.cos(offAng) * offRad;
        const lz = cz + Math.sin(offAng) * offRad;
        const ly = baseAlt + (isTower ? formationScale * 0.24 : (rand() - 0.25) * formationScale * 0.28);

        const sx = formationScale * (isTower ? 0.92 : 0.52 + rand() * 0.45);
        const sy = formationScale * (isTower ? 0.68 : 0.34 + rand() * 0.32);
        const sz = formationScale * (isTower ? 0.88 : 0.48 + rand() * 0.45);

        dummy.position.set(lx, ly, lz);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        dummy.scale.set(sx, sy, sz);
        dummy.updateMatrix();
        instanced.setMatrixAt(idx++, dummy.matrix);
      }
    }

    instanced.count = idx;
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
    return { group, instanced };
  }

  private createStarField(): { points: THREE.Points; material: THREE.PointsMaterial } {
    const starCount = 5600;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    let seed = 421987;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // Authentic stellar spectral classes (O/B blue-white -> A/F white -> G warm -> K/M amber)
    const starPalette = [
      [0.72, 0.86, 1.0],
      [0.88, 0.94, 1.0],
      [0.98, 0.98, 1.0],
      [1.0, 0.95, 0.84],
      [1.0, 0.82, 0.62],
    ];

    for (let i = 0; i < starCount; i++) {
      // 35% of stars gently concentrated along a tilted Milky Way galactic plane
      const inBand = i < starCount * 0.35;
      const u = inBand ? (rand() + rand() - 1) * 0.22 : rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));

      let x = r * Math.cos(phi);
      let y = u;
      let z = r * Math.sin(phi);

      if (inBand) {
        // Tilt galactic band ~58 degrees
        const c = Math.cos(1.01);
        const s = Math.sin(1.01);
        const ny = y * c - z * s;
        const nz = y * s + z * c;
        y = ny;
        z = nz;
      }

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const mag = Math.pow(rand(), inBand ? 2.7 : 2.2);
      const brightness = (inBand ? 0.16 : 0.24) + 0.76 * mag;
      const tint = starPalette[Math.floor(rand() * starPalette.length)];

      colors[i * 3] = tint[0] * brightness;
      colors[i * 3 + 1] = tint[1] * brightness;
      colors[i * 3 + 2] = tint[2] * brightness;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 1.85,
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
    cameraFar: number,
    dt = 0
  ): void {
    const skyRadius = Math.max(5000, cameraFar * 0.56);
    // This background has depth testing disabled; keep it camera-local rather
    // than expanding its vertices to tens of millions of meters.
    this.skyDome.scale.setScalar(5000);
    this.skyDome.position.set(0, 0, 0);

    const r = Math.hypot(cameraPosECEF.x, cameraPosECEF.y, cameraPosECEF.z) || 1;
    const upX = cameraPosECEF.x / r;
    const upY = cameraPosECEF.y / r;
    const upZ = cameraPosECEF.z / r;

    this.uLocalUp.value.set(upX, upY, upZ);
    this.uSunDir.value.set(sunDirECEF.x, sunDirECEF.y, sunDirECEF.z).normalize();

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
    this.uHorizonColor.value.set(
      this.currentHorizonColor.r,
      this.currentHorizonColor.g,
      this.currentHorizonColor.b
    );

    // Planetary atmospheric limb halo fades in smoothly above 22 km
    this.atmoLimbMesh.position.set(-cameraPosECEF.x, -cameraPosECEF.y, -cameraPosECEF.z);
    // The camera-centered sky already handles scattering inside the atmosphere.
    // Looking at the inside of the planet-sized shell produces visible polygon
    // silhouettes near the camera; use that shell only for the exterior limb.
    this.atmoLimbMesh.visible = alt > 120_000;
    this.uLimbStrength.value = Math.max(0, Math.min(1, (alt - 120_000) / 65_000));

    // Position 3D coastal cumulus field over Cape Canaveral with gentle trade-wind drift
    this.cloudDriftClock += dt;
    const driftEastM = Math.sin(this.cloudDriftClock * 0.002) * 350;
    const capeRel = subVec3(CAPE_FRAME.originECEF, cameraPosECEF);
    this.localCloudDeck.position.set(
      capeRel.x + CAPE_FRAME.east.x * driftEastM,
      capeRel.y + CAPE_FRAME.east.y * driftEastM,
      capeRel.z + CAPE_FRAME.east.z * driftEastM
    );

    const cloudAltFade = 1 - Math.max(0, Math.min(1, (alt - 100_000) / 100_000));
    this.uCloudFade.value = cloudAltFade;
    const distFromCape = Math.hypot(capeRel.x, capeRel.y, capeRel.z);
    this.cloudInstancedMesh.visible = cloudAltFade > 0.01 && distFromCape < 250_000;

    // Stars stay suppressed against bright daytime skies (<= 35 km) and emerge cleanly into space
    this.starField.position.set(0, 0, 0);
    this.starField.scale.setScalar(skyRadius * 0.96);
    this.starField.rotation.y = -earthRotationRad;

    const skyBrightness = rayleighFactor * dayFactor;
    const starT = Math.max(0, Math.min(1, (0.095 - skyBrightness) / 0.082));
    const starVis = starT * starT * (3 - 2 * starT);
    // Sunlit spacecraft and Earth expose like daylight photography: the same
    // exposure cannot also show a bright field of stars. Preserve the night sky.
    this.starMaterial.opacity = starVis * (1 - dayFactor * 0.97);
  }
}
