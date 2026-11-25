import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fractureAssembly } from './fractureGeometry';
import type { GeometryPacket, PanelPacket, PiecesPacket } from './breakupPreparation';

export function prepareFracture(packets: GeometryPacket[]): PiecesPacket {
  const root = new THREE.Group();
  const materials = new Map<number, THREE.MeshBasicMaterial>();
  for (const packet of packets) {
    const geometry = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(packet.attributes)) geometry.setAttribute(name,
      new THREE.BufferAttribute(attr.array as Float32Array, attr.itemSize, attr.normalized));
    if (packet.index) geometry.setIndex(packet.index);
    for (const group of packet.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    const localMaterials = packet.materials.map(id => {
      let material = materials.get(id);
      if (!material) { material = new THREE.MeshBasicMaterial(); material.userData.id = id; materials.set(id, material); }
      return material;
    });
    const mesh = new THREE.Mesh(geometry, localMaterials.length === 1 ? localMaterials[0] : localMaterials);
    mesh.matrix.fromArray(packet.matrix); mesh.matrixAutoUpdate = false; root.add(mesh);
  }
  const result = fractureAssembly(root, root).map(piece => {
    const buckets = new Map<string, THREE.Mesh[]>();
    for (const object of piece.children) {
      const mesh = object as THREE.Mesh;
      const key = JSON.stringify([(mesh.material as THREE.Material).userData.id,
        Object.entries(mesh.geometry.attributes).map(([name, a]) => [name, a.itemSize]).sort()]);
      const bucket = buckets.get(key) ?? []; bucket.push(mesh); buckets.set(key, bucket);
    }
    const panels: PanelPacket[] = [];
    for (const meshes of buckets.values()) {
      const merged = mergeGeometries(meshes.map(mesh => mesh.geometry), false)!;
      const attributes: PanelPacket['attributes'] = {};
      for (const [name, attr] of Object.entries(merged.attributes)) attributes[name] = {
        array: attr.array, itemSize: attr.itemSize, normalized: attr.normalized,
      };
      panels.push({ attributes, material: (meshes[0].material as THREE.Material).userData.id });
      for (const mesh of meshes) mesh.geometry.dispose();
      merged.dispose();
    }
    return panels;
  });
  root.traverse(object => { if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).geometry.dispose(); });
  for (const material of materials.values()) material.dispose();
  return result;
}

if (typeof self !== 'undefined' && typeof document === 'undefined') self.onmessage = event => {
  const { id, packets } = event.data;
  try {
    const pieces = prepareFracture(packets);
    const transfers = pieces.flatMap(panels => panels.flatMap(panel => Object.values(panel.attributes).map(a => a.array.buffer as ArrayBuffer)));
    self.postMessage({ id, pieces }, { transfer: transfers });
  } catch (error) { self.postMessage({ id, error: String(error) }); }
};
