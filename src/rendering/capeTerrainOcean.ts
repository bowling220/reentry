import * as THREE from 'three/webgpu';
import {
  abs,
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
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { LANDING_PAD_OFFSET_LOCAL } from '../config/planetConfig';
import { LoadedAssets } from '../assets/assetManager';
import { Vec3d } from '../math/vec3d';
import { getCapeTerrainElevationM } from '../simulation/terrainHeight';

/**
 * Fully procedural PBR Cape Canaveral barrier-island terrain + realistic Atlantic Ocean:
 * - Zero flat pasted satellite image decals!
 * - True shadow-receiving MeshStandardNodeMaterial so the rocket, tower, strongback,
 *   hangars, tanks, and 3D palms cast crisp grounded shadows across the coastal landscape.
 * - Multi-scale organic procedural biomes matching Cape Canaveral's true geography:
 *   crushed limestone industrial gravel around SLC-40/LZ-1, golden foredune sand & damp
 *   tidal swash zone, Florida coastal palmetto/scrub barrier island, inland marshlands,
 *   and western Banana River estuary shoreline.
 * - Multi-octave directional Atlantic Ocean with animated shoreline breaking surf,
 *   open-water whitecap foam, emerald coastal shallows, Fresnel sky reflection & sun glint.
 * - Dissolves seamlessly into the real-scale 3D spherical Earth between 18 km and 54 km.
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

  constructor(_assets: LoadedAssets) {
    this.group = new THREE.Group();
    this.group.name = 'CapeTerrainAndOcean';

    this.oceanMesh = this.buildOceanDisk();
    this.group.add(this.oceanMesh);

    this.terrainMesh = this.buildProceduralTerrainDisk();
    this.group.add(this.terrainMesh);
  }

  /**
   * Non-repeating 4-octave directional organic noise in TSL (zero grid tiling artifacts!).
   */
  private proceduralFbm(px: any, pz: any, baseScale: number): any {
    const x1 = px.mul(baseScale);
    const z1 = pz.mul(baseScale);
    const n1 = sin(x1.mul(1.0).add(z1.mul(0.73))).mul(cos(z1.mul(1.17).sub(x1.mul(0.41))));

    const x2 = px.mul(baseScale * 2.13).add(17.3);
    const z2 = pz.mul(baseScale * 2.13).sub(9.7);
    const n2 = sin(x2.mul(1.31).sub(z2.mul(0.89))).mul(cos(z2.mul(0.97).add(x2.mul(0.67))));

    const x3 = px.mul(baseScale * 4.71).sub(31.1);
    const z3 = pz.mul(baseScale * 4.71).add(23.4);
    const n3 = sin(x3.mul(0.83).add(z3.mul(1.41))).mul(cos(z3.mul(1.23).sub(x3.mul(0.79))));

    const x4 = px.mul(baseScale * 10.37).add(5.1);
    const z4 = pz.mul(baseScale * 10.37).sub(14.9);
    const n4 = sin(x4.mul(1.47).sub(z4.mul(0.63))).mul(cos(z4.mul(1.11).add(x4.mul(1.09))));

    // Normalize roughly to [0, 1]
    return n1
      .mul(0.5)
      .add(n2.mul(0.28))
      .add(n3.mul(0.14))
      .add(n4.mul(0.08))
      .mul(0.5)
      .add(0.5);
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

  private buildProceduralTerrainDisk(): THREE.Mesh {
    const maxRadius = 82_000;
    const geo = this.buildCurvedRadialDiskGeometry(maxRadius, 144, 144, true, 0.08);

    // True PBR MeshStandardNodeMaterial so real sun shadows from rocket/towers/palms fall onto terrain!
    const mat = new THREE.MeshStandardNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = true;
    mat.metalness = 0.0;

    const pLocal = positionLocal;
    const pWorld = positionWorld;
    const camDist = length(sub(cameraPosition, pWorld));
    const radialDist = length(vec2(pLocal.x, pLocal.z));

    // Exact Cape Canaveral Atlantic shoreline curve matching terrainHeight.ts
    const coastX = float(490.0)
      .add(pLocal.z.mul(0.21))
      .add(sin(pLocal.z.mul(0.00055)).mul(38.0));
    const distInland = coastX.sub(pLocal.x);

    // Multi-scale organic procedural variation (macro biome -> meso scrub -> micro gravel/sand grain)
    const macroN = this.proceduralFbm(pLocal.x, pLocal.z, 0.0016);
    const mesoN = this.proceduralFbm(pLocal.x, pLocal.z, 0.014);
    const microN = this.proceduralFbm(pLocal.x, pLocal.z, 0.14);
    const fineGrain = this.proceduralFbm(pLocal.x, pLocal.z, 0.72);
    const nearFade = float(1.0).sub(smoothstep(float(60.0), float(750.0), camDist));
    const microMod = mix(float(1.0), fineGrain.mul(0.32).add(0.84), nearFade);

    // 1. Coastal Atlantic Beach Sand (wet swash zone -> warm bright dune sand)
    const wetSandCol = vec3(0.42, 0.37, 0.29);
    const drySandCol = vec3(0.76, 0.7, 0.57);
    const duneSandCol = vec3(0.68, 0.62, 0.49);
    const wetFactor = smoothstep(float(2.0), float(26.0), distInland);
    const beachSand = mix(wetSandCol, mix(drySandCol, duneSandCol, mesoN), wetFactor);

    // 2. Florida Barrier-Island Coastal Scrub & Saw Palmetto Grasslands
    const scrubDark = vec3(0.11, 0.18, 0.09);
    const scrubOlive = vec3(0.19, 0.27, 0.13);
    const dryGrass = vec3(0.36, 0.37, 0.21);
    const sandyPatch = vec3(0.56, 0.51, 0.39);
    const marshDark = vec3(0.08, 0.13, 0.08);

    const scrubBase = mix(scrubDark, scrubOlive, mesoN);
    const scrubWithGrass = mix(scrubBase, dryGrass, smoothstep(float(0.45), float(0.82), macroN));
    const scrubWithSand = mix(
      scrubWithGrass,
      sandyPatch,
      smoothstep(float(0.64), float(0.92), microN.mul(0.65).add(macroN.mul(0.35))).mul(0.55)
    );

    // Coastal transition: beach sand (0..58m) -> dune sea-oats -> dense inland scrub -> marshlands
    const sandToScrub = smoothstep(float(36.0), float(108.0), distInland.add(mesoN.sub(0.5).mul(26.0)));
    const marshMask = smoothstep(float(920.0), float(1550.0), distInland.add(macroN.mul(180.0)));
    const naturalLand = mix(mix(beachSand, scrubWithSand, sandToScrub), marshDark, marshMask.mul(0.58));

    // 3. Graded Industrial Crushed-Limestone / Concrete Gravel around SLC-40 & LZ-1
    const padDist = length(vec2(pLocal.x, pLocal.z));
    const lzDist = length(
      vec2(
        pLocal.x.sub(LANDING_PAD_OFFSET_LOCAL.eastM),
        pLocal.z.sub(LANDING_PAD_OFFSET_LOCAL.southM)
      )
    );
    const hifDist = length(vec2(pLocal.x.add(38.0), pLocal.z.sub(215.0)));

    const slcApronMask = float(1.0).sub(
      smoothstep(float(105.0), float(185.0), padDist.add(mesoN.sub(0.5).mul(28.0)))
    );
    const lzApronMask = float(1.0).sub(
      smoothstep(float(55.0), float(105.0), lzDist.add(mesoN.sub(0.5).mul(16.0)))
    );
    const hifApronMask = float(1.0).sub(
      smoothstep(float(65.0), float(115.0), hifDist.add(mesoN.sub(0.5).mul(18.0)))
    );
    const industrialMask = clamp(slcApronMask.add(lzApronMask).add(hifApronMask), float(0.0), float(1.0));

    const gravelLight = vec3(0.55, 0.54, 0.5);
    const gravelDark = vec3(0.36, 0.36, 0.34);
    const gravelDirt = vec3(0.46, 0.43, 0.37);
    const industrialGravel = mix(
      mix(gravelDark, gravelLight, microN),
      gravelDirt,
      smoothstep(float(0.45), float(0.85), mesoN).mul(0.45)
    );

    const surfaceAlbedo = mix(naturalLand, industrialGravel, industrialMask).mul(microMod);

    // Distance-attenuated atmospheric aerial perspective haze
    const hazeFactor = float(1.0)
      .sub(exp(camDist.mul(-0.000017)))
      .mul(this.uAtmoHazeStrength)
      .mul(0.76);
    const finalAlbedo = mix(surfaceAlbedo, this.uHorizonColor, clamp(hazeFactor, float(0.0), float(0.85)));

    // Wet sand near waterline is glossier; scrub & crushed gravel are matte
    const wetSpecRough = mix(float(0.38), float(0.88), wetFactor);
    const finalRoughness = mix(wetSpecRough, float(0.93), max(sandToScrub, industrialMask));

    // Cleanly feather terrain alpha at the Atlantic ocean waterline AND western Banana River lagoon
    const atlanticLandMask = smoothstep(float(-4.0), float(14.0), distInland);
    // Western Banana River waterway (~1.8 km to 4.2 km west of pad) creates authentic barrier island!
    const lagoonCenter = float(-2850.0).add(sin(pLocal.z.mul(0.00032)).mul(420.0));
    const distFromLagoon = abs(pLocal.x.sub(lagoonCenter));
    const lagoonCutout = smoothstep(float(820.0), float(1180.0), distFromLagoon);
    const outerCircleFade = float(1.0).sub(smoothstep(float(48000.0), float(78000.0), radialDist));

    mat.colorNode = finalAlbedo;
    mat.roughnessNode = finalRoughness;
    mat.opacityNode = atlanticLandMask.mul(lagoonCutout).mul(outerCircleFade).mul(this.uRegionalFade);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  private buildOceanDisk(): THREE.Mesh {
    const maxRadius = 115_000;
    const geo = this.buildCurvedRadialDiskGeometry(maxRadius, 112, 144, false, -0.22);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = true;

    const pLocal = positionLocal;
    const pWorld = positionWorld;
    const nBase = normalize(normalWorld);
    const sunDir = normalize(this.uSunDir);
    const viewDir = normalize(sub(cameraPosition, pWorld));
    const camDist = length(sub(cameraPosition, pWorld));

    const nearDetail = float(1.0).div(float(1.0).add(camDist.mul(0.00055)));
    const midDetail = float(1.0).div(float(1.0).add(camDist.mul(0.000075)));
    const t = time.mul(0.82);

    // 7-octave multi-directional Atlantic swells + wind chop + capillary ripples
    const w1 = sin(pLocal.x.mul(0.058).add(pLocal.z.mul(0.021)).add(t.mul(1.25))).mul(0.032).mul(nearDetail);
    const w2 = cos(pLocal.x.mul(-0.041).add(pLocal.z.mul(0.074)).sub(t.mul(1.52))).mul(0.024).mul(nearDetail);
    const w3 = sin(pLocal.x.mul(0.145).sub(pLocal.z.mul(0.118)).add(t.mul(2.35))).mul(0.017).mul(nearDetail);
    const w4 = cos(pLocal.x.mul(0.285).add(pLocal.z.mul(0.193)).sub(t.mul(3.15))).mul(0.011).mul(nearDetail);
    const w5 = cos(pLocal.x.mul(0.0124).add(pLocal.z.mul(0.0082)).add(t.mul(0.52))).mul(0.022).mul(midDetail);
    const w6 = sin(pLocal.x.mul(-0.0067).add(pLocal.z.mul(0.0138)).sub(t.mul(0.41))).mul(0.016).mul(midDetail);
    const w7 = sin(pLocal.x.mul(0.0029).add(pLocal.z.mul(-0.0034)).add(t.mul(0.21))).mul(0.012);

    const nx = w1.add(w3).add(w4).add(w5).add(w7);
    const nz = w2.sub(w3.mul(0.75)).add(w4.mul(0.6)).add(w6);
    const nWave = normalize(nBase.add(vec3(nx, float(0.0), nz)));

    const ndotl = max(dot(nWave, sunDir), float(0.0));
    const ndotv = clamp(dot(nWave, viewDir), float(0.0), float(1.0));
    const fresnel = pow(float(1.0).sub(ndotv), float(4.8)).mul(0.88).add(0.035);

    // Distance offshore from the real Atlantic shoreline
    const coastX = float(490.0)
      .add(pLocal.z.mul(0.21))
      .add(sin(pLocal.z.mul(0.00055)).mul(38.0));
    const offshoreM = pLocal.x.sub(coastX);

    // Shallow turquoise-emerald coastal water -> rich mid-shelf teal -> deep Atlantic indigo
    const shallowT = smoothstep(float(0.0), float(420.0), offshoreM);
    const deepT = smoothstep(float(250.0), float(9500.0), offshoreM);
    const surfTeal = vec3(0.08, 0.34, 0.36);
    const shelfBlue = vec3(0.032, 0.155, 0.24);
    const deepAtlantic = vec3(0.011, 0.048, 0.125);
    const waterColor = mix(mix(surfTeal, shelfBlue, shallowT), deepAtlantic, deepT);

    // Subtle sunlit subsurface scattering glow through wave crests
    const crestHeight = clamp(w1.add(w2).add(w5).mul(14.0), float(0.0), float(1.0));
    const sssGlow = vec3(0.06, 0.28, 0.3).mul(crestHeight).mul(ndotl).mul(0.45);
    const waterBody = waterColor.mul(ndotl.mul(0.95).add(0.14)).add(sssGlow);

    // Sky reflection & multi-lobe crisp solar sparkle
    const skyRefl = mix(this.uZenithColor, this.uHorizonColor, pow(float(1.0).sub(ndotv), float(1.55)));
    const halfVec = normalize(sunDir.add(viewDir));
    const nh = max(dot(nWave, halfVec), float(0.0));
    const specGlitter = pow(nh, float(420.0)).mul(2.6).mul(nearDetail.mul(0.75).add(0.25));
    const specTight = pow(nh, float(95.0)).mul(0.65);
    const specBroad = pow(nh, float(20.0)).mul(0.14);
    const sunGlint = vec3(1.0, 0.96, 0.86).mul(specGlitter.add(specTight).add(specBroad));

    // Animated rolling Atlantic surf breakers & shoreline foam along Cape Canaveral beach!
    const surfNoise = this.proceduralFbm(pLocal.x, pLocal.z, 0.045);
    const surfZone = smoothstep(float(-12.0), float(10.0), offshoreM)
      .mul(float(1.0).sub(smoothstep(float(22.0), float(135.0), offshoreM)));
    const breakerWave = sin(offshoreM.mul(0.17).add(t.mul(1.85)).add(surfNoise.mul(4.5)));
    const surfFoam = smoothstep(float(0.42), float(0.88), breakerWave)
      .mul(surfZone)
      .mul(0.78)
      .add(
        smoothstep(float(-8.0), float(6.0), offshoreM)
          .mul(float(1.0).sub(smoothstep(float(8.0), float(28.0), offshoreM)))
          .mul(surfNoise.mul(0.55).add(0.35))
      );

    // Subtle open-ocean whitecap foam flecks on choppy crests
    const whitecap = smoothstep(float(0.74), float(0.95), crestHeight.mul(surfNoise.mul(0.7).add(0.5)))
      .mul(nearDetail)
      .mul(0.35);

    const totalFoam = clamp(surfFoam.add(whitecap), float(0.0), float(0.92));
    const foamColor = vec3(0.92, 0.95, 0.97).mul(ndotl.mul(0.82).add(0.22));

    const waterLit = mix(
      mix(waterBody, skyRefl.mul(ndotl.mul(0.78).add(0.22)), fresnel).add(sunGlint),
      foamColor,
      totalFoam
    );

    const hazeFactor = float(1.0)
      .sub(exp(camDist.mul(-0.000017)))
      .mul(this.uAtmoHazeStrength)
      .mul(0.8);
    const finalWater = mix(waterLit, this.uHorizonColor, clamp(hazeFactor, float(0.0), float(0.88)));

    const radialDist = length(vec2(pLocal.x, pLocal.z));
    const outerFade = float(1.0).sub(smoothstep(float(68000.0), float(110000.0), radialDist));

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

    const haze = Math.exp(-Math.max(0, cameraAltitudeM) / 9_500);
    this.uAtmoHazeStrength.value = haze;

    // Dissolve regional procedural Cape Canaveral patch smoothly between 20 km and 56 km
    // so Earth's continuous 8K spherical globe & glowing limb dominate upper atmosphere & space
    const altFade = 1 - Math.max(0, Math.min(1, (cameraAltitudeM - 20_000) / 36_000));
    const visible = altFade > 0.01 && distFromCapeM < 250_000;
    this.uRegionalFade.value = altFade;
    this.terrainMesh.visible = visible;
    this.oceanMesh.visible = visible;
  }
}
