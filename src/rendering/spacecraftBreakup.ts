import * as THREE from 'three/webgpu';
export { fractureAssembly } from './fractureGeometry';
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
  center: THREE.Vector3;
}

export class SpacecraftBreakup {
  readonly group = new THREE.Group();
  private fragments: Fragment[] = [];
  private materials = new Map<THREE.Material, THREE.Material>();
  private readonly up = new THREE.Vector3();
  private readonly localUp = new THREE.Vector3();
  private readonly spinAxis = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly inverseRotation = new THREE.Quaternion();

  constructor(pieces: THREE.Group[], position: Vec3d, orientation: THREE.Quaternion, velocity: Vec3d) {
    this.group.name = 'CrashDebris';
    for (const mesh of pieces) {
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
        panel.frustumCulled = false;
      });
      const fragment: Fragment = { mesh, position: new THREE.Vector3(), velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(), halfSize, center, settled: false };
      this.fragments.push(fragment); this.group.add(mesh);
    }
    this.activate(position, orientation, velocity);
  }

  activate(position: Vec3d, orientation: THREE.Quaternion, velocity: Vec3d): void {
    const up = new THREE.Vector3(position.x, position.y, position.z).normalize();
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize(), north = up.clone().cross(east);
    const inherited = new THREE.Vector3(velocity.x, velocity.y, velocity.z).clampLength(0, 100).multiplyScalar(0.25);
    this.fragments.forEach((fragment, i) => {
      fragment.mesh.quaternion.copy(orientation);
      fragment.position.set(position.x, position.y, position.z).add(fragment.center.clone().applyQuaternion(orientation));
      const angle = i * 2.399963, speed = 7 + (i % 5) * 2;
      fragment.velocity.copy(inherited).addScaledVector(east, Math.cos(angle) * speed)
        .addScaledVector(north, Math.sin(angle) * speed).addScaledVector(up, 6 + i % 7);
      fragment.spin.set(Math.sin(i + 1), Math.cos(i * 3), Math.sin(i * 2 + 2)).multiplyScalar(1.5);
      fragment.settled = false;
    });
  }

  update(camera: Vec3d, dt: number): void {
    const steps = Math.ceil(Math.min(dt, 0.25) / (1 / 60));
    const step = steps ? Math.min(dt, 0.25) / steps : 0;
    for (const fragment of this.fragments) {
      const { mesh, position, velocity, spin, halfSize } = fragment;
      for (let i = 0; i < steps && !fragment.settled; i++) {
        const up = this.up.copy(position).normalize();
        velocity.addScaledVector(up, -9.81 * step).multiplyScalar(Math.exp(-0.08 * step));
        position.addScaledVector(velocity, step);
        const speed = spin.length();
        if (speed > 0) mesh.quaternion.premultiply(this.rotation.setFromAxisAngle(this.spinAxis.copy(spin).normalize(), speed * step));
        const localUp = this.localUp.copy(up).applyQuaternion(this.inverseRotation.copy(mesh.quaternion).invert());
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
