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

interface LegPivot {
  pivot: THREE.Group;
  axis: THREE.Vector3;
}

interface FinControl {
  node: THREE.Object3D;
  baseRotation: THREE.Euler;
  axisIndex: number;
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
  private readonly assets: LoadedAssets;
  private legPivots: LegPivot[] = [];
  private finControls: FinControl[] = [];

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
    const key = this.flagsKey(craft.visuals);
    if (key === this.currentFlagsKey) return;
    this.currentFlagsKey = key;

    // Clear existing assembly children
    while (this.assemblyRoot.children.length > 0) {
      this.assemblyRoot.remove(this.assemblyRoot.children[0]);
    }
    this.legPivots = [];
    this.finControls = [];

    const f = craft.visuals;
    const comOffset = craft.dynamics.comHeightFromBase;
    this.engineNozzleAnchor.position.set(0, -comOffset, 0);

    const stackGroup = new THREE.Group();
    stackGroup.position.set(0, -comOffset, 0);
    this.assemblyRoot.add(stackGroup);

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
      roughness: 0.36,
      metalness: 0.84,
    });
    const throatMat = new THREE.MeshStandardMaterial({
      color: 0x101216,
      roughness: 0.65,
      metalness: 0.7,
    });

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
    root.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals();
      }

      const mat = mesh.material;
      if (mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        const std = (mat as THREE.MeshStandardMaterial).clone();
        const lum = std.color.r * 0.3 + std.color.g * 0.59 + std.color.b * 0.11;
        if (lum > 0.55) {
          std.color.setRGB(0.91, 0.92, 0.935);
          std.roughness = 0.3;
          std.metalness = 0.14;
          std.envMapIntensity = 1.15;
        } else if (lum < 0.08) {
          std.color.setRGB(0.08, 0.088, 0.1);
          std.roughness = 0.44;
          std.metalness = 0.36;
          std.envMapIntensity = 1.1;
        } else {
          std.roughness = 0.34;
          std.metalness = 0.72;
          std.envMapIntensity = 1.35;
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
