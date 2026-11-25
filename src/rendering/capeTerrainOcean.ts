import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  cos,
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
  sin,
  smoothstep,
  sub,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { LoadedAssets } from '../assets/assetManager';
import { Vec3d } from '../math/vec3d';
import { getCapeTerrainElevationM } from '../simulation/terrainHeight';

/**
 * Real-world Cape Canaveral satellite terrain (3 nested public-domain USGS National Map
 * orthoimagery layers blended radially with zero rectangular seams) + non-repetitive
 * distance-attenuated TSL Atlantic Ocean with Fresnel sky reflection and aerial haze.
 *
 * Smoothly dissolves between 24 km and 62 km altitude so high-altitude & spaceflight views
 * reveal Earth's continuous 8K spherical globe, continents, and curved atmospheric limb cleanly.
 */
export class CapeTerrainOcean {
  public readonly group: THREE.Group;
  private readonly terrainMesh: THREE.Mesh;
  private readonly oceanMesh: THREE.Mesh;

  private readonly uSunDir = uniform(new THREE.Vector3(0.7, 0.5, 0.3));
  private readonly uHorizonColor = uniform(new THREE.Vector3(0.58, 0.75, 0.92));
  private readonly uZenithColor = uniform(new THREE.Vector3(0.08, 0.24, 0.56));
  private readonly uAtmoHazeStrength = uniform(1.0);
  private readonly uRegionalFade = uniform(1.0);

  private readonly detailConcreteTex: THREE.CanvasTexture;
  private readonly detailGrassTex: THREE.CanvasTexture;
  private readonly detailSandTex: THREE.CanvasTexture;

  constructor(assets: LoadedAssets) {
    this.group = new THREE.Group();
    this.group.name = 'CapeTerrainAndOcean';

    this.detailConcreteTex = this.createDetailMap('concrete');
    this.detailGrassTex = this.createDetailMap('grass');
    this.detailSandTex = this.createDetailMap('sand');

    this.oceanMesh = this.buildOceanDisk();
    this.group.add(this.oceanMesh);

    this.terrainMesh = this.buildSatelliteTerrainDisk(assets);
    this.group.add(this.terrainMesh);
  }

  private createDetailMap(kind: 'concrete' | 'grass' | 'sand'): THREE.CanvasTexture {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    let seed = kind === 'concrete' ? 4011 : kind === 'grass' ? 5021 : 6031;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);

    if (kind === 'concrete') {
      // Crisp gravel, aggregate & subtle slab seams for close-up SLC-40 ground
      for (let i = 0; i < 4200; i++) {
        const v = 90 + Math.floor(rand() * 80);
        ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
        ctx.fillRect(rand() * size, rand() * size, 2 + rand() * 2, 2 + rand() * 2);
      }
      ctx.strokeStyle = 'rgba(72,72,72,0.32)';
      ctx.lineWidth = 1.5;
      for (let k = 0; k < size; k += 64) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k, size);
        ctx.moveTo(0, k);
        ctx.lineTo(size, k);
        ctx.stroke();
      }
    } else if (kind === 'grass') {
      // Organic Florida coastal grass / scrub micro-texture
      for (let i = 0; i < 3600; i++) {
        const g = 88 + Math.floor(rand() * 88);
        ctx.fillStyle = `rgba(${Math.floor(g * 0.92)},${g},${Math.floor(g * 0.84)},0.32)`;
        ctx.fillRect(rand() * size, rand() * size, 2, 4 + rand() * 4);
      }
    } else {
      // Fine Atlantic coastal beach sand ripples & grain
      for (let y = 0; y < size; y += 6) {
        ctx.fillStyle = y % 12 === 0 ? 'rgba(155,150,140,0.22)' : 'rgba(108,104,96,0.2)';
        ctx.fillRect(0, y, size, 3);
      }
      for (let i = 0; i < 3200; i++) {
        const v = 100 + Math.floor(rand() * 70);
        ctx.fillStyle = `rgba(${v},${v - 2},${v - 6},0.28)`;
        ctx.fillRect(rand() * size, rand() * size, 2, 2);
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  private buildCurvedRadialDiskGeometry(
    maxRadiusM: number,
    rings: number,
    sectors: number,
    withTerrainElevation: boolean,
    yOffsetM: number
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const centerElev = withTerrainElevation ? getCapeTerrainElevationM(0, 0) : 0;
    positions.push(0, centerElev + yOffsetM, 0);
    uvs.push(0.5, 0.5);

    for (let r = 1; r <= rings; r++) {
      const t = r / rings;
      const rad = Math.pow(t, 2.75) * maxRadiusM;
      const drop = (rad * rad) / (2 * 6_371_000);

      for (let s = 0; s < sectors; s++) {
        const theta = (s / sectors) * Math.PI * 2;
        const x = Math.cos(theta) * rad;
        const z = Math.sin(theta) * rad;

        const elev = withTerrainElevation ? getCapeTerrainElevationM(x, z) : 0;
        positions.push(x, elev - drop + yOffsetM, z);
        uvs.push(0.5 + x / (maxRadiusM * 2), 0.5 - z / (maxRadiusM * 2));
      }
    }

    for (let s = 0; s < sectors; s++) {
      const next = (s + 1) % sectors;
      indices.push(0, 1 + next, 1 + s);
    }

    for (let r = 1; r < rings; r++) {
      const ringStart = 1 + (r - 1) * sectors;
      const nextRingStart = 1 + r * sectors;
      for (let s = 0; s < sectors; s++) {
        const next = (s + 1) % sectors;
        const a = ringStart + s;
        const b = ringStart + next;
        const c = nextRingStart + s;
        const d = nextRingStart + next;
        indices.push(a, b, d);
        indices.push(a, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  private buildSatelliteTerrainDisk(assets: LoadedAssets): THREE.Mesh {
    const maxRadius = 88_000;
    const geo = this.buildCurvedRadialDiskGeometry(maxRadius, 128, 128, true, 0.25);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = true;

    const pLocal = positionLocal;
    const pWorld = positionWorld;
    const nWorld = normalize(normalWorld);
    const sunDir = normalize(this.uSunDir);

    const uvLocal = vec2(
      pLocal.x.div(4400.0).add(0.5),
      pLocal.z.negate().div(4400.0).add(0.5)
    );
    const uvMid = vec2(
      pLocal.x.div(36000.0).add(0.5),
      pLocal.z.negate().div(36000.0).add(0.5)
    );
    const uvWide = vec2(
      pLocal.x.div(180000.0).add(0.5),
      pLocal.z.negate().div(180000.0).add(0.5)
    );

    const satLocal = assets.capeSatLocal
      ? texture(assets.capeSatLocal, clamp(uvLocal, vec2(0.002), vec2(0.998)))
      : vec4(0.24, 0.3, 0.2, 1.0);
    const satMid = assets.capeSatMid
      ? texture(assets.capeSatMid, clamp(uvMid, vec2(0.002), vec2(0.998)))
      : vec4(0.22, 0.28, 0.19, 1.0);
    const satWide = assets.capeSatWide
      ? texture(assets.capeSatWide, clamp(uvWide, vec2(0.002), vec2(0.998)))
      : vec4(0.2, 0.26, 0.18, 1.0);

    const radialDist = length(vec2(pLocal.x, pLocal.z));
    const localToMid = smoothstep(float(1450.0), float(2050.0), radialDist);
    const midToWide = smoothstep(float(12500.0), float(17000.0), radialDist);

    const blend1Rgb = mix(satLocal.rgb, satMid.rgb, localToMid);
    const blend1A = mix(satLocal.a, satMid.a, localToMid);

    const satRgb = mix(blend1Rgb, satWide.rgb, midToWide);
    const satAlpha = mix(blend1A, satWide.a, midToWide);

    // Close-range layered PBR detail materials blended naturally with USGS satellite imagery
    // (concrete/gravel on bright neutral areas, grass/scrub on green areas, sand on warm beach tones)
    const camDist = length(sub(cameraPosition, pWorld));
    const detailFade = float(1.0).sub(smoothstep(float(90.0), float(950.0), camDist));
    const uvDetailNear = vec2(pLocal.x.div(22.0), pLocal.z.div(22.0));
    const uvDetailFar = vec2(pLocal.x.div(85.0), pLocal.z.div(85.0));

    const dConc = texture(this.detailConcreteTex, uvDetailNear).rgb.mul(0.65).add(
      texture(this.detailConcreteTex, uvDetailFar).rgb.mul(0.35)
    );
    const dGrass = texture(this.detailGrassTex, uvDetailNear).rgb.mul(0.65).add(
      texture(this.detailGrassTex, uvDetailFar).rgb.mul(0.35)
    );
    const dSand = texture(this.detailSandTex, uvDetailNear).rgb;

    const greenScore = clamp(satRgb.g.sub(satRgb.r).mul(6.5), float(0.0), float(1.0));
    const sandScore = clamp(satRgb.r.sub(satRgb.b).mul(4.0).mul(float(1.0).sub(greenScore)), float(0.0), float(1.0));
    const blendedDetail = mix(mix(dConc, dSand, sandScore), dGrass, greenScore);
    // Center around 1.0 multiplicative micro-albedo modulation so satellite color accuracy stays intact
    const detailMod = vec3(1.0).add(blendedDetail.sub(vec3(0.5)).mul(0.68).mul(detailFade));

    const ndotl = max(dot(nWorld, sunDir), float(0.0));
    const sunMod = ndotl.mul(0.92).add(0.24);
    const litTerrain = satRgb.mul(detailMod).mul(sunMod);

    const hazeFactor = float(1.0)
      .sub(exp(camDist.mul(-0.000018)))
      .mul(this.uAtmoHazeStrength)
      .mul(0.75);
    const finalColor = mix(litTerrain, this.uHorizonColor, clamp(hazeFactor, float(0.0), float(0.84)));

    const outerCircleFade = float(1.0).sub(smoothstep(float(54000.0), float(84000.0), radialDist));
    const waterAlphaFeather = smoothstep(float(0.15), float(0.95), satAlpha);

    mat.colorNode = finalColor;
    mat.opacityNode = waterAlphaFeather.mul(outerCircleFade).mul(this.uRegionalFade);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  private buildOceanDisk(): THREE.Mesh {
    const maxRadius = 112_000;
    const geo = this.buildCurvedRadialDiskGeometry(maxRadius, 96, 128, false, -0.35);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = true;

    const pLocal = positionLocal;
    const pWorld = positionWorld;
    const nBase = normalize(normalWorld);
    const sunDir = normalize(this.uSunDir);
    const viewDir = normalize(sub(cameraPosition, pWorld));
    const camDist = length(sub(cameraPosition, pWorld));

    const nearDetail = float(1.0).div(float(1.0).add(camDist.mul(0.00065)));
    const midDetail = float(1.0).div(float(1.0).add(camDist.mul(0.00009)));
    const t = time.mul(0.72);

    const w1 = sin(pLocal.x.mul(0.061).add(pLocal.z.mul(0.023)).add(t.mul(1.1))).mul(0.028).mul(nearDetail);
    const w2 = cos(pLocal.x.mul(-0.043).add(pLocal.z.mul(0.079)).sub(t.mul(1.47))).mul(0.022).mul(nearDetail);
    const w3 = sin(pLocal.x.mul(0.137).sub(pLocal.z.mul(0.113)).add(t.mul(2.13))).mul(0.014).mul(nearDetail);
    const w4 = cos(pLocal.x.mul(0.0117).add(pLocal.z.mul(0.0089)).add(t.mul(0.45))).mul(0.018).mul(midDetail);
    const w5 = sin(pLocal.x.mul(-0.0063).add(pLocal.z.mul(0.0141)).sub(t.mul(0.37))).mul(0.014).mul(midDetail);

    const nx = w1.add(w3).add(w4);
    const nz = w2.sub(w3.mul(0.7)).add(w5);
    const nWave = normalize(nBase.add(vec3(nx, float(0.0), nz)));

    const ndotl = max(dot(nWave, sunDir), float(0.0));
    const ndotv = clamp(dot(nWave, viewDir), float(0.0), float(1.0));
    const fresnel = pow(float(1.0).sub(ndotv), float(4.5)).mul(0.85).add(0.04);

    const offshoreT = smoothstep(float(400.0), float(14000.0), pLocal.x);
    const coastalTeal = vec3(0.055, 0.22, 0.28);
    const deepAtlantic = vec3(0.014, 0.058, 0.135);
    const waterBody = mix(coastalTeal, deepAtlantic, offshoreT).mul(ndotl.mul(0.95).add(0.16));

    const skyRefl = mix(this.uZenithColor, this.uHorizonColor, pow(float(1.0).sub(ndotv), float(1.6)));

    const halfVec = normalize(sunDir.add(viewDir));
    const nh = max(dot(nWave, halfVec), float(0.0));
    const specTight = pow(nh, float(260.0)).mul(1.85).mul(nearDetail.mul(0.7).add(0.3));
    const specBroad = pow(nh, float(28.0)).mul(0.22);
    const sunGlint = vec3(1.0, 0.95, 0.85).mul(specTight.add(specBroad));

    const waterLit = mix(waterBody, skyRefl.mul(ndotl.mul(0.75).add(0.25)), fresnel).add(sunGlint);

    const hazeFactor = float(1.0)
      .sub(exp(camDist.mul(-0.000018)))
      .mul(this.uAtmoHazeStrength)
      .mul(0.78);
    const finalWater = mix(waterLit, this.uHorizonColor, clamp(hazeFactor, float(0.0), float(0.88)));

    const radialDist = length(vec2(pLocal.x, pLocal.z));
    const outerFade = float(1.0).sub(smoothstep(float(70000.0), float(108000.0), radialDist));

    mat.colorNode = finalWater;
    mat.opacityNode = outerFade.mul(this.uRegionalFade);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return mesh;
  }

  public update(
    sunDirECEF: Vec3d,
    horizonColor: THREE.Color,
    zenithColor: THREE.Color,
    cameraAltitudeM: number,
    distFromCapeM: number
  ): void {
    this.uSunDir.value.set(sunDirECEF.x, sunDirECEF.y, sunDirECEF.z).normalize();
    this.uHorizonColor.value.set(horizonColor.r, horizonColor.g, horizonColor.b);
    this.uZenithColor.value.set(zenithColor.r, zenithColor.g, zenithColor.b);

    // Aerial haze matches true atmospheric scale height (~9 km)
    const haze = Math.exp(-Math.max(0, cameraAltitudeM) / 9_500);
    this.uAtmoHazeStrength.value = haze;

    // Dissolve regional Cape Canaveral patch smoothly between 24 km and 62 km so Earth's
    // continuous 8K spherical globe & glowing blue limb dominate upper atmosphere & space views
    const altFade = 1 - Math.max(0, Math.min(1, (cameraAltitudeM - 24_000) / 38_000));
    const visible = altFade > 0.01 && distFromCapeM < 260_000;
    this.uRegionalFade.value = altFade;
    this.terrainMesh.visible = visible;
    this.oceanMesh.visible = visible;
  }
}
