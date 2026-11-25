import * as THREE from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  dot,
  float,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sub,
  time,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { LoadedAssets } from '../assets/assetManager';
import { VisualAssemblyFlags } from '../config/vehicleConfig';
import { SpacecraftEntity } from '../simulation/spacecraftManager';
import { Vec3d, lenVec3, normVec3, subVec3 } from '../math/vec3d';
import { buildSaturnAssembly } from './saturnAssembly';

interface LegPivot {
  pivot: THREE.Group;
  axis: THREE.Vector3;
}

interface FinControl {
  node: THREE.Object3D;
  baseRotation: THREE.Euler;
  axisIndex: number;
}

interface AerospaceMicroMaps {
  fuselageBump: THREE.CanvasTexture;
  fuselageRoughness: THREE.CanvasTexture;
  carbonBump: THREE.CanvasTexture;
}

let cachedMicroMaps: AerospaceMicroMaps | null = null;

function getAerospaceMicroMaps(): AerospaceMicroMaps {
  if (cachedMicroMaps) return cachedMicroMaps;

  const size = 256;
  const makeTex = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d')!);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 8);
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  };

  let seed = 918273;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // Aluminum-lithium welded barrel ring seams + subtle rivet/weld micro-relief
  const fuselageBump = makeTex((ctx) => {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#5a5a5a';
    ctx.lineWidth = 2;
    for (let y = 0; y < size; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#6c6c6c';
    ctx.lineWidth = 1;
    for (let x = 0; x < size; x += 128) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
  });

  // Subtle painted-metal & cryogenic frost/patina roughness variation (eliminates flat plastic sheen)
  const fuselageRoughness = makeTex((ctx) => {
    ctx.fillStyle = '#585858';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 650; i++) {
      const v = 54 + Math.floor(rand() * 58);
      ctx.fillStyle = `rgba(${v},${v},${v},0.22)`;
      ctx.fillRect(rand() * size, rand() * size, 6 + rand() * 24, 3 + rand() * 14);
    }
  });

  // Fine diagonal aerospace carbon-fiber composite weave for interstage & landing legs
  const carbonBump = makeTex((ctx) => {
    ctx.fillStyle = '#707070';
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 8) {
      for (let x = 0; x < size; x += 8) {
        const bright = ((x + y) / 8) % 2 === 0;
        ctx.fillStyle = bright ? '#989898' : '#585858';
        ctx.fillRect(x, y, 4, 4);
      }
    }
  });
  carbonBump.repeat.set(8, 8);

  cachedMicroMaps = { fuselageBump, fuselageRoughness, carbonBump };
  return cachedMicroMaps;
}

/**
 * Modular multistage visual rig for any REENTRY-9 spacecraft configuration:
 * - Full orbital stack (Stage 1 + Stage 2 + Fairings + Starlink Payload)
 * - Standalone Stage 1 Booster (with deployable legs & steerable grid fins)
 * - Standalone Stage 2 Upper Stage (with exposed MVac bell, toggleable fairings & payload)
 * - Standalone Payload Fairing half (A or B)
 * - Standalone REENTRY-Sat-1 Payload (`starlink-v1.glb`)
 *
 * Also renders dynamic atmospheric reentry plasma heating glow and stage separation cold-gas puffs.
 */
export class RocketVisual {
  public readonly group: THREE.Group;
  public readonly engineNozzleAnchor: THREE.Group;

  private readonly assemblyRoot: THREE.Group;
  public get breakupSource(): THREE.Object3D { return this.assemblyRoot; }
  private readonly assets: LoadedAssets;
  private legPivots: LegPivot[] = [];
  private finControls: FinControl[] = [];
  private nozzleThroatMat: THREE.MeshStandardMaterial | null = null;

  // Dynamic reentry plasma bow-shock VFX
  private readonly reentryGroup: THREE.Group;
  private readonly reentryMesh: THREE.Mesh;
  private readonly uReentryHeat = uniform(0.0);

  // Stage / fairing separation cold-gas puff ring
  private readonly sepPuffMesh: THREE.Mesh;
  private readonly uSepPuff = uniform(0.0);

  private currentFlagsKey = '';

  constructor(assets: LoadedAssets, craft: SpacecraftEntity) {
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = `SpacecraftVisual_${craft.id}`;

    this.assemblyRoot = new THREE.Group();
    this.group.add(this.assemblyRoot);

    this.engineNozzleAnchor = new THREE.Group();
    this.group.add(this.engineNozzleAnchor);

    // Build atmospheric reentry plasma heating bow-shock shell
    this.reentryGroup = new THREE.Group();
    const reentryGeo = new THREE.SphereGeometry(4.4, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.72);
    this.reentryMesh = new THREE.Mesh(reentryGeo, this.createReentryPlasmaMaterial());
    this.reentryMesh.frustumCulled = false;
    this.reentryMesh.renderOrder = 23;
    this.reentryGroup.add(this.reentryMesh);
    this.reentryGroup.visible = false;
    this.group.add(this.reentryGroup);

    // Build pneumatic stage-separation cold-gas burst cloud ring
    const sepGeo = new THREE.TorusGeometry(2.6, 1.35, 12, 24);
    sepGeo.rotateX(Math.PI / 2);
    this.sepPuffMesh = new THREE.Mesh(sepGeo, this.createSepPuffMaterial());
    this.sepPuffMesh.frustumCulled = false;
    this.sepPuffMesh.renderOrder = 24;
    this.sepPuffMesh.visible = false;
    this.group.add(this.sepPuffMesh);

    this.rebuildAssemblyIfNeeded(craft);
  }

  private createReentryPlasmaMaterial(): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.blending = THREE.AdditiveBlending;

    const coords = uv();
    const nWorld = normalize(normalWorld);
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const rim = pow(clamp(float(1.0).sub(abs(dot(nWorld, viewDir))), float(0.001), float(1.0)), float(1.6));

    // Leading stagnation point at coords.y = 1.0 (white-hot) streaming back to trailing amber plasma
    const lead = smoothstep(float(0.05), float(0.95), coords.y);
    const streak = sin(coords.x.mul(36.0).add(coords.y.mul(18.0)).sub(time.mul(24.0))).mul(0.5).add(0.5);

    const plasmaColor = mix(
      vec3(0.95, 0.24, 0.04),
      vec3(1.0, 0.88, 0.62),
      lead.mul(0.75).add(streak.mul(0.25))
    );

    const alpha = lead
      .mul(rim.mul(0.75).add(0.25))
      .mul(streak.mul(0.35).add(0.65))
      .mul(this.uReentryHeat);

    mat.colorNode = plasmaColor.mul(2.8).mul(this.uReentryHeat);
    mat.opacityNode = clamp(alpha.mul(0.85), float(0.0), float(0.95));
    return mat;
  }

  private createSepPuffMaterial(): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;

    const coords = uv();
    const wisp = sin(coords.x.mul(24.0).add(time.mul(8.0))).mul(0.3).add(0.7);
    mat.colorNode = vec3(0.84, 0.91, 1.0).mul(1.25);
    mat.opacityNode = clamp(this.uSepPuff.mul(wisp).mul(0.65), float(0.0), float(0.7));
    return mat;
  }

  private flagsKey(f: VisualAssemblyFlags): string {
    return `${+f.hasStage1}${+f.hasStage2}${+f.hasFairingA}${+f.hasFairingB}${+f.hasPayload}`;
  }

  public rebuildAssemblyIfNeeded(craft: SpacecraftEntity): void {
    const key = this.flagsKey(craft.visuals) + (craft.saturn ? `saturn:${craft.saturn.stageIndex}:${craft.saturn.detached}` : '');
    if (key === this.currentFlagsKey) return;
    this.currentFlagsKey = key;

    // Clear existing assembly children
    while (this.assemblyRoot.children.length > 0) {
      this.assemblyRoot.remove(this.assemblyRoot.children[0]);
    }
    this.legPivots = [];
    this.finControls = [];
    this.nozzleThroatMat = null;

    const f = craft.visuals;
    const comOffset = craft.dynamics.comHeightFromBase;
    this.engineNozzleAnchor.position.set(0, -comOffset, 0);

    const stackGroup = new THREE.Group();
    stackGroup.position.set(0, -comOffset, 0);
    this.assemblyRoot.add(stackGroup);

    if (craft.saturn) {
      stackGroup.add(buildSaturnAssembly(this.assets.saturnModel, craft.saturn));
      return;
    }

    const scaleS1 = 1.028; // Matches 68.1m raw stack -> 70.0m full vehicle consistently across stages

    // CASE A: Has Stage 1 (Full Stack OR Standalone S1 Booster)
    if (f.hasStage1 && this.assets.stage1Model) {
      const s1 = this.assets.stage1Model.clone(true);
      s1.updateMatrixWorld(true);
      const s1Box = new THREE.Box3().setFromObject(s1);
      const s1Height = Math.max(1, s1Box.max.y - s1Box.min.y); // 45.65m

      s1.position.y -= s1Box.min.y;
      this.enhanceMaterials(s1);
      stackGroup.add(s1);
      this.addOctawebDetail(stackGroup);
      this.bindStage1Mechanisms(s1);

      if (f.hasStage2 && this.assets.upperStageModel) {
        this.attachUpperStage(stackGroup, s1Height - 4.02, f, true);
      }

      stackGroup.scale.setScalar(scaleS1);
      return;
    }

    // CASE B: Standalone Stage 2 Upper Stage (+ optional Fairings + optional Payload)
    if (f.hasStage2 && this.assets.upperStageModel) {
      this.attachUpperStage(stackGroup, 0, f, false);
      stackGroup.scale.setScalar(scaleS1);
      return;
    }

    // CASE C: Standalone Detached Fairing Half (A or B)
    if ((f.hasFairingA || f.hasFairingB) && this.assets.upperStageModel) {
      const upper = this.assets.upperStageModel.clone(true);
      const targetName = f.hasFairingA ? 'fairing-a' : 'fairing-b';
      const fairing = upper.getObjectByName(targetName);
      if (fairing) {
        const clone = fairing.clone(true);
        clone.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(clone);
        const center = new THREE.Vector3();
        box.getCenter(center);
        clone.position.set(-center.x, -box.min.y, -center.z);
        this.enhanceMaterials(clone);
        stackGroup.add(clone);
        stackGroup.scale.setScalar(scaleS1);
        return;
      }
    }

    // CASE D: Standalone Demonstration Payload (`starlink-v1.glb`)
    if (f.hasPayload) {
      this.attachPayload(stackGroup, 0.3, true);
      return;
    }

    // Defensive minimal fallback
    const fallback = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, craft.dynamics.config.heightM, 20),
      new THREE.MeshStandardMaterial({ color: 0xe6eaee, roughness: 0.35, metalness: 0.2 })
    );
    fallback.position.y = craft.dynamics.config.heightM * 0.5;
    stackGroup.add(fallback);
  }

  private attachUpperStage(
    stackGroup: THREE.Group,
    yBase: number,
    f: VisualAssemblyFlags,
    withInterstageCollar: boolean
  ): void {
    const upper = this.assets.upperStageModel!.clone(true);

    const fairingA = upper.getObjectByName('fairing-a');
    const fairingB = upper.getObjectByName('fairing-b');
    if (fairingA) {
      fairingA.position.y -= 0.78;
      fairingA.visible = f.hasFairingA;
    }
    if (fairingB) {
      fairingB.position.y -= 0.78;
      fairingB.visible = f.hasFairingB;
    }

    upper.position.y = yBase;
    this.enhanceMaterials(upper);
    stackGroup.add(upper);
    this.addUpperStageHardware(stackGroup, yBase);

    const carbonMat = new THREE.MeshStandardMaterial({
      color: 0x181b20,
      roughness: 0.44,
      metalness: 0.36,
    });
    const whiteMat = new THREE.MeshStandardMaterial({
      color: 0xe6e9ec,
      roughness: 0.3,
      metalness: 0.14,
    });

    if (withInterstageCollar) {
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.945, 1.955, 0.55, 40), carbonMat);
      collar.position.y = yBase + 3.92;
      collar.castShadow = true;
      stackGroup.add(collar);
    }

    const fairingAdapterY = yBase + 12.65;
    if (f.hasFairingA || f.hasFairingB) {
      const fCollar = new THREE.Mesh(new THREE.CylinderGeometry(1.915, 1.935, 0.92, 40), whiteMat);
      fCollar.position.y = fairingAdapterY;
      fCollar.castShadow = true;
      stackGroup.add(fCollar);

      const fBand = new THREE.Mesh(new THREE.CylinderGeometry(1.945, 1.945, 0.16, 40), carbonMat);
      fBand.position.y = fairingAdapterY + 0.36;
      stackGroup.add(fBand);
    }

    // Payload Attach Fitting (PAF) cone & demonstration Starlink satellite visible once fairings jettison!
    if (f.hasPayload) {
      const paf = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.65, 1.1, 24), carbonMat);
      paf.position.y = fairingAdapterY + 0.4;
      stackGroup.add(paf);
      this.attachPayload(stackGroup, fairingAdapterY + 1.0, false);
    }
  }

  private addUpperStageHardware(parent: THREE.Group, baseY: number): void {
    const titanium = new THREE.MeshStandardMaterial({ color: 0x8c9297, roughness: 0.5, metalness: 0.78 });
    const painted = new THREE.MeshStandardMaterial({ color: 0xc9cdd0, roughness: 0.68, metalness: 0.12 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x25292d, roughness: 0.72, metalness: 0.35 });
    const hardware = new THREE.Group();
    hardware.position.y = baseY;
    hardware.name = 'UpperStageServiceHardware';
    for (const y of [2.0, 4.7, 7.4, 10.6]) {
      const weld = new THREE.Mesh(new THREE.TorusGeometry(1.858, 0.012, 5, 64), titanium);
      weld.rotation.x = Math.PI / 2;
      weld.position.y = y;
      hardware.add(weld);
    }
    // External cable raceway, access covers and pipe clamps give the cylindrical
    // stage readable scale and relief without changing collision or flight data.
    const raceway = new THREE.Mesh(new THREE.BoxGeometry(0.15, 8.4, 0.085), painted);
    raceway.position.set(0, 6.1, 1.873);
    hardware.add(raceway);
    for (const y of [2.8, 5.4, 8.1, 9.8]) {
      const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.055, 0.1), titanium);
      clamp.position.set(0, y, 1.895);
      hardware.add(clamp);
    }
    for (const y of [3.5, 8.8]) {
      const cover = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.025, 20), dark);
      cover.rotation.x = Math.PI / 2;
      cover.position.set(0.7, y, 1.725);
      cover.rotation.y = 0.38;
      hardware.add(cover);
    }
    const bellBands = new THREE.InstancedMesh(new THREE.TorusGeometry(0.9, 0.016, 4, 48), titanium, 12);
    const transform = new THREE.Object3D();
    for (let i = 0; i < 12; i++) {
      transform.position.set(0, 0.16 + i * 0.115, 0);
      transform.rotation.x = Math.PI / 2;
      transform.scale.setScalar(1.25 - i * 0.052);
      transform.updateMatrix();
      bellBands.setMatrixAt(i, transform.matrix);
    }
    hardware.add(bellBands);
    hardware.traverse(object => { if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).castShadow = true; });
    parent.add(hardware);
  }

  private attachPayload(stackGroup: THREE.Group, yBase: number, standalone: boolean): void {
    if (this.assets.payloadModel) {
      const sat = this.assets.payloadModel.clone(true);
      sat.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(sat);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const maxDim = Math.max(size.x, size.y, size.z, 0.1);
      // Scale to fit comfortably inside the 5.2m fairing when attached, or crisp 4.2m unfolded span in orbit
      const targetSpan = standalone ? 4.4 : 3.2;
      const sc = targetSpan / maxDim;

      const wrap = new THREE.Group();
      sat.position.set(-center.x, -box.min.y, -center.z);
      this.enhanceMaterials(sat);
      wrap.add(sat);
      wrap.scale.setScalar(sc);
      wrap.position.y = yBase;
      stackGroup.add(wrap);
      return;
    }

    // Fallback satellite bus + solar panels
    const bus = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.8, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xd9a84e, roughness: 0.3, metalness: 0.85 })
    );
    bus.position.y = yBase + 0.9;
    stackGroup.add(bus);
  }

  private bindStage1Mechanisms(s1: THREE.Object3D): void {
    const legNames = ['leg-a', 'leg-b', 'leg-c', 'leg-d'];
    for (const name of legNames) {
      const legNode = s1.getObjectByName(name);
      if (!legNode || !legNode.parent) continue;

      legNode.updateMatrixWorld(true);
      const legBox = new THREE.Box3().setFromObject(legNode);
      const legCenter = new THREE.Vector3();
      legBox.getCenter(legCenter);

      const radialDir = new THREE.Vector3(legCenter.x, 0, legCenter.z).normalize();
      const hingePos = new THREE.Vector3(radialDir.x * 1.88, 2.08, radialDir.z * 1.88);
      const hingeAxis = new THREE.Vector3(0, 1, 0).cross(radialDir).normalize();

      const pivot = new THREE.Group();
      pivot.position.copy(hingePos);
      legNode.parent.add(pivot);

      legNode.position.sub(hingePos);
      pivot.add(legNode);

      this.legPivots.push({ pivot, axis: hingeAxis });
    }

    const finNames = ['fin-a', 'fin-b', 'fin-c', 'fin-d'];
    finNames.forEach((name, idx) => {
      const finNode = s1.getObjectByName(name);
      if (finNode) {
        this.finControls.push({
          node: finNode,
          baseRotation: finNode.rotation.clone(),
          axisIndex: idx,
        });
      }
    });
  }

  private addOctawebDetail(stackGroup: THREE.Group): void {
    const inconelMat = new THREE.MeshStandardMaterial({
      color: 0x262a31,
      roughness: 0.32,
      metalness: 0.88,
      envMapIntensity: 1.45,
    });
    const throatMat = new THREE.MeshStandardMaterial({
      color: 0x101216,
      emissive: new THREE.Color(0xff6b1a),
      emissiveIntensity: 0.0,
      roughness: 0.58,
      metalness: 0.72,
    });
    this.nozzleThroatMat = throatMat;

    const bellGeo = new THREE.CylinderGeometry(0.24, 0.44, 0.92, 18, 1, true);
    const addBell = (x: number, z: number) => {
      const bell = new THREE.Mesh(bellGeo, inconelMat);
      bell.position.set(x, 0.48, z);
      bell.castShadow = true;
      stackGroup.add(bell);

      const cap = new THREE.Mesh(new THREE.CircleGeometry(0.42, 14), throatMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(x, 0.12, z);
      stackGroup.add(cap);
    };

    addBell(0, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      addBell(Math.cos(a) * 1.15, Math.sin(a) * 1.15);
    }
  }

  private enhanceMaterials(root: THREE.Object3D): void {
    const micro = getAerospaceMicroMaps();
    root.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals();
      }
      if (mesh.geometry && !mesh.geometry.hasAttribute('uv')) {
        // Some model parts omit UVs. Give the barrel detail maps cylindrical
        // coordinates rather than sampling every vertex at the same texel.
        mesh.geometry = mesh.geometry.clone();
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox!;
        const positions = mesh.geometry.getAttribute('position');
        const coords = new Float32Array(positions.count * 2);
        for (let i = 0; i < positions.count; i++) {
          coords[i * 2] = 0.5 + Math.atan2(positions.getZ(i), positions.getX(i)) / (2 * Math.PI);
          coords[i * 2 + 1] = (positions.getY(i) - box.min.y) / Math.max(0.001, box.max.y - box.min.y);
        }
        mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(coords, 2));
      }

      const mat = mesh.material;
      if (mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        const hasUv = mesh.geometry.hasAttribute('uv');
        const std = (mat as THREE.MeshStandardMaterial).clone();
        const lum = std.color.r * 0.3 + std.color.g * 0.59 + std.color.b * 0.11;
        if (lum > 0.55) {
          std.color.setRGB(0.92, 0.93, 0.945);
          std.roughness = 0.34;
          std.metalness = 0.18;
          std.roughnessMap = hasUv ? micro.fuselageRoughness : null;
          if (hasUv && !std.bumpMap) {
            std.bumpMap = micro.fuselageBump;
            std.bumpScale = 0.028;
          }
          std.envMapIntensity = 1.25;
        } else if (lum < 0.08) {
          std.color.setRGB(0.085, 0.092, 0.108);
          std.roughness = 0.42;
          std.metalness = 0.38;
          if (hasUv && !std.bumpMap) {
            std.bumpMap = micro.carbonBump;
            std.bumpScale = 0.022;
          }
          std.envMapIntensity = 1.2;
        } else {
          std.roughness = 0.3;
          std.metalness = 0.82;
          std.envMapIntensity = 1.45;
        }
        std.needsUpdate = true;
        mesh.material = std;
      }
    });
  }

  public update(craft: SpacecraftEntity, cameraPosECEF: Vec3d): void {
    this.rebuildAssemblyIfNeeded(craft);

    const rocket = craft.dynamics;
    const rel = subVec3(rocket.posECEF, cameraPosECEF);
    this.group.position.set(rel.x, rel.y, rel.z);
    this.group.quaternion.set(
      rocket.quatECEF.x,
      rocket.quatECEF.y,
      rocket.quatECEF.z,
      rocket.quatECEF.w
    );

    // Animate incandescent Merlin nozzle glow proportionally to live throttle
    if (this.nozzleThroatMat) {
      const thr = rocket.actualThrottle;
      this.nozzleThroatMat.emissiveIntensity = thr > 0.01 ? 0.8 + thr * 4.5 : 0.0;
    }

    // Animate deployable landing legs
    const t = rocket.gearDeployProgress;
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const deployAngleRad = ease * ((116 * Math.PI) / 180);
    for (const leg of this.legPivots) {
      leg.pivot.quaternion.setFromAxisAngle(leg.axis, deployAngleRad);
    }

    // Animate steering grid fins
    for (const fin of this.finControls) {
      const pitchDeflect = rocket.gimbalPitchRad * 1.65;
      const yawDeflect = rocket.gimbalYawRad * 1.65;
      fin.node.rotation.copy(fin.baseRotation);
      if (fin.axisIndex % 2 === 0) {
        fin.node.rotation.z += pitchDeflect;
      } else {
        fin.node.rotation.x += yawDeflect;
      }
    }

    // Atmospheric reentry plasma bow-shock VFX oriented directly into incoming velocity vector!
    const heat = rocket.reentryHeatIntensity;
    this.uReentryHeat.value = heat;
    if (heat > 0.02 && lenVec3(rocket.velECEF) > 50) {
      this.reentryGroup.visible = true;
      const velDir = normVec3(rocket.velECEF);
      // Orient bow shock in rocket's local space toward incoming airflow
      const invQ = new THREE.Quaternion(
        -rocket.quatECEF.x,
        -rocket.quatECEF.y,
        -rocket.quatECEF.z,
        rocket.quatECEF.w
      );
      const localVel = new THREE.Vector3(velDir.x, velDir.y, velDir.z).applyQuaternion(invQ).normalize();
      this.reentryGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), localVel);
      const leadScale = Math.max(0.8, rocket.config.diameterM / 3.7);
      const trailLen = Math.max(1.2, rocket.config.heightM * 0.14);
      this.reentryMesh.scale.set(leadScale * 1.15, trailLen, leadScale * 1.15);
      // Place bow shock slightly ahead along leading edge (nose or aft heatshield)
      const leadOffset = localVel.y < 0 ? -rocket.comHeightFromBase * 0.9 : (rocket.config.heightM - rocket.comHeightFromBase) * 0.8;
      this.reentryGroup.position.set(0, leadOffset, 0);
    } else {
      this.reentryGroup.visible = false;
    }

    // Stage / Fairing separation pneumatic cold-gas burst VFX
    if (craft.separationFxTimer > 0.01) {
      this.sepPuffMesh.visible = true;
      const progress = 1 - Math.min(1, craft.separationFxTimer / 1.8);
      this.uSepPuff.value = Math.sin(Math.min(1, progress * 3.5) * (Math.PI / 2)) * (1 - progress);
      this.sepPuffMesh.position.y = craft.separationFxLocalY;
      const expand = 0.7 + progress * 4.2;
      this.sepPuffMesh.scale.set(expand, 0.8 + progress * 1.8, expand);
    } else {
      this.sepPuffMesh.visible = false;
    }
  }
}
