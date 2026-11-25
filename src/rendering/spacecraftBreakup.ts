import * as THREE from 'three/webgpu';
import { sliceStageGeometry } from './saturnAssembly';
import { Vec3d } from '../math/vec3d';
import { PLANET_CONFIG } from '../config/planetConfig';
import { getSurfaceElevationAtECEF } from '../simulation/terrainHeight';

interface Fragment {
  mesh: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  halfSize: THREE.Vector3;
  settled: boolean;
}

/** Cut the actual painted hardware into barrel sections and shell panels. */
export function fractureAssembly(source: THREE.Object3D, root: THREE.Object3D): THREE.Group[] {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  const meshes: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[] = [];
  source.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    const geometry = mesh.geometry.clone();
    // Expand quantized GLTF positions before transforming: integer attributes
    // would clamp meter-scale coordinates and collapse the fuselage to [-1, 1].
    for (const name of ['position', 'normal']) {
      const attribute = geometry.getAttribute(name);
      if (attribute) geometry.setAttribute(name, new THREE.Float32BufferAttribute(
        Array.from({ length: attribute.count * attribute.itemSize }, (_, i) =>
          attribute.getComponent(Math.floor(i / attribute.itemSize), i % attribute.itemSize)), attribute.itemSize));
    }
    geometry.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox!);
    if (Array.isArray(mesh.material) && geometry.groups.length) {
      for (const group of geometry.groups) {
        const part = geometry.clone();
        part.setIndex(Array.from({ length: group.count }, (_, i) => geometry.index ? geometry.index.getX(group.start + i) : group.start + i));
        part.clearGroups();
        meshes.push({ mesh: new THREE.Mesh(part, mesh.material[group.materialIndex ?? 0]), geometry: part });
      }
      geometry.dispose();
    } else meshes.push({ mesh, geometry });
  });
  if (bounds.isEmpty()) return [];
  const bands = 7, pieces = Array.from({ length: bands * 4 }, () => new THREE.Group());
  const height = Math.max(0.1, bounds.max.y - bounds.min.y);
  for (const { mesh, geometry } of meshes) {
    for (let band = 0; band < bands; band++) {
      const min = bounds.min.y + height * band / bands, max = bounds.min.y + height * (band + 1) / bands;
      if (geometry.boundingBox!.max.y < min || geometry.boundingBox!.min.y > max) continue;
      const slice = sliceStageGeometry(geometry, min, max);
      const position = slice.getAttribute('position');
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const buckets = new Map<string, number[]>();
      for (let i = 0; i < position.count; i += 3) {
        const x = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
        const z = (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3;
        const quadrant = (x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0);
        const key = String(quadrant);
        let indices = buckets.get(key);
        if (!indices) { indices = []; buckets.set(key, indices); }
        indices.push(i, i + 1, i + 2);
      }
      for (const [key, indices] of buckets) {
        const part = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(slice.attributes)) {
          const values = indices.flatMap(index => Array.from({ length: attribute.itemSize }, (_, c) => attribute.getComponent(index, c)));
          part.setAttribute(name, new THREE.Float32BufferAttribute(values, attribute.itemSize));
        }
        const panel = new THREE.Mesh(part, materials[0]);
        panel.castShadow = true; panel.receiveShadow = true;
        pieces[band * 4 + Number(key)].add(panel);
      }
      slice.dispose();
    }
    geometry.dispose();
  }
  return pieces.filter(piece => piece.children.length > 0);
}

export class SpacecraftBreakup {
  readonly group = new THREE.Group();
  private fragments: Fragment[] = [];
  private materials = new Map<THREE.Material, THREE.Material>();

  constructor(source: THREE.Object3D, root: THREE.Object3D, position: Vec3d, orientation: THREE.Quaternion, velocity: Vec3d) {
    this.group.name = 'CrashDebris';
    const up = new THREE.Vector3(position.x, position.y, position.z).normalize();
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    const north = up.clone().cross(east);
    const inherited = new THREE.Vector3(velocity.x, velocity.y, velocity.z).clampLength(0, 100).multiplyScalar(0.25);
    for (const [i, mesh] of fractureAssembly(source, root).entries()) {
      const bounds = new THREE.Box3().setFromObject(mesh);
      const center = bounds.getCenter(new THREE.Vector3());
      const halfSize = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      mesh.traverse(object => {
        if (!(object as THREE.Mesh).isMesh) return;
        const panel = object as THREE.Mesh;
        panel.geometry.translate(-center.x, -center.y, -center.z);
        const original = panel.material as THREE.Material;
        let scorched = this.materials.get(original);
        if (!scorched) {
          scorched = original.clone();
          scorched.side = THREE.DoubleSide;
          const standard = scorched as THREE.MeshStandardMaterial;
          if (standard.color) standard.color.multiplyScalar(0.72);
          if (standard.roughness !== undefined) standard.roughness = 0.92;
          if (standard.emissive) standard.emissive.setHex(0x000000);
          this.materials.set(original, scorched);
        }
        panel.material = scorched;
      });
      mesh.quaternion.copy(orientation);
      const offset = center.clone().applyQuaternion(orientation);
      const angle = i * 2.399963;
      const scatter = east.clone().multiplyScalar(Math.cos(angle)).addScaledVector(north, Math.sin(angle));
      const speed = 7 + (i % 5) * 2;
      const fragment: Fragment = {
        mesh, position: new THREE.Vector3(position.x, position.y, position.z).add(offset),
        velocity: inherited.clone().addScaledVector(scatter, speed).addScaledVector(up, 6 + i % 7),
        spin: new THREE.Vector3(Math.sin(i + 1), Math.cos(i * 3), Math.sin(i * 2 + 2)).multiplyScalar(1.5),
        halfSize, settled: false,
      };
      this.fragments.push(fragment); this.group.add(mesh);
    }
  }

  update(camera: Vec3d, dt: number): void {
    const steps = Math.ceil(Math.min(dt, 0.25) / (1 / 60));
    const step = steps ? Math.min(dt, 0.25) / steps : 0;
    for (const fragment of this.fragments) {
      const { mesh, position, velocity, spin, halfSize } = fragment;
      for (let i = 0; i < steps && !fragment.settled; i++) {
        const up = position.clone().normalize();
        velocity.addScaledVector(up, -9.81 * step).multiplyScalar(Math.exp(-0.08 * step));
        position.addScaledVector(velocity, step);
        const speed = spin.length();
        if (speed > 0) mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(spin.clone().normalize(), speed * step));
        const localUp = up.clone().applyQuaternion(mesh.quaternion.clone().invert());
        const support = Math.abs(localUp.x) * halfSize.x + Math.abs(localUp.y) * halfSize.y + Math.abs(localUp.z) * halfSize.z;
        const groundRadius = PLANET_CONFIG.meanRadiusM + getSurfaceElevationAtECEF(position) + support;
        if (position.length() < groundRadius) {
          position.copy(up).multiplyScalar(groundRadius + 0.02);
          const vertical = velocity.dot(up);
          if (vertical < 0) velocity.addScaledVector(up, -vertical * 1.18);
          velocity.multiplyScalar(0.55); spin.multiplyScalar(0.45);
          if (velocity.length() < 1.2 && spin.length() < 0.2) fragment.settled = true;
        }
      }
      mesh.position.set(position.x - camera.x, position.y - camera.y, position.z - camera.z);
    }
  }

  dispose(): void {
    this.group.traverse(object => { if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).geometry.dispose(); });
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear(); this.fragments = []; this.group.clear();
  }
}
