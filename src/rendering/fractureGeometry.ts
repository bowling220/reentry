import * as THREE from 'three/webgpu';
import { sliceStageGeometry } from './saturnAssembly';

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

