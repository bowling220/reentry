import * as THREE from 'three/webgpu';

export interface GeometryPacket {
  attributes: Record<string, { array: ArrayBufferView; itemSize: number; normalized: boolean }>;
  index: number[] | null;
  groups: { start: number; count: number; materialIndex?: number }[];
  matrix: number[];
  materials: number[];
}
export interface PanelPacket { attributes: GeometryPacket['attributes']; material: number }
export type PiecesPacket = PanelPacket[][];

export function snapshotAttribute(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): GeometryPacket['attributes'][string] {
  const array = new Float32Array(attribute.count * attribute.itemSize);
  for (let i = 0; i < attribute.count; i++) for (let c = 0; c < attribute.itemSize; c++) {
    array[i * attribute.itemSize + c] = attribute.getComponent(i, c);
  }
  return { array, itemSize: attribute.itemSize, normalized: false };
}

export function disposePreparedPieces(pieces: THREE.Group[]): void {
  for (const piece of pieces) piece.traverse(object => {
    if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).geometry.dispose();
  });
}

/** A persistent worker prepares each assembly during flight, never on impact. */
export class BreakupPreparation {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: PiecesPacket) => void; reject: (reason: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./fracture.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = event => {
      const { id, pieces, error } = event.data;
      const task = this.pending.get(id);
      if (!task) return;
      this.pending.delete(id);
      if (error) task.reject(new Error(error)); else task.resolve(pieces);
    };
    this.worker.onerror = () => {
      for (const task of this.pending.values()) task.reject(new Error('Debris preparation worker failed'));
      this.pending.clear();
    };
  }

  async prepare(source: THREE.Object3D, root: THREE.Object3D): Promise<THREE.Group[]> {
    root.updateWorldMatrix(true, true);
    const inverse = root.matrixWorld.clone().invert();
    const materials: THREE.Material[] = [], packets: GeometryPacket[] = [];
    // Canonicalize equivalent GLTF materials so hundreds of shell submeshes
    // become a few draws per fragment instead of one draw per original mesh.
    const materialKeys = new Map<string, number>();
    const materialId = (material: THREE.Material): number => {
      const m = material as THREE.MeshStandardMaterial;
      const key = m.isMeshStandardMaterial ? JSON.stringify([m.type, m.color.getHex(), m.emissive.getHex(),
        m.roughness, m.metalness, m.map?.uuid, m.normalMap?.uuid, m.bumpMap?.uuid, m.roughnessMap?.uuid,
        m.metalnessMap?.uuid, m.alphaMap?.uuid, m.alphaTest, m.opacity, m.transparent, m.side, m.vertexColors,
        m.bumpScale, m.normalScale.toArray()]) : material.uuid;
      let id = materialKeys.get(key);
      if (id === undefined) { id = materials.length; materials.push(material); materialKeys.set(key, id); }
      return id;
    };
    source.traverseVisible(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const attributes: GeometryPacket['attributes'] = {};
      for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
        // Copy only, never transfer/detach live shared asset buffers.
        attributes[name] = snapshotAttribute(attribute);
      }
      packets.push({ attributes, index: mesh.geometry.index ? Array.from(mesh.geometry.index.array) : null,
        groups: mesh.geometry.groups.map(group => ({ ...group })),
        matrix: inverse.clone().multiply(mesh.matrixWorld).toArray(),
        materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(materialId) });
    });
    const id = ++this.nextId;
    if (import.meta.env.DEV) console.debug('[Breakup] input meshes', packets.length);
    const result = new Promise<PiecesPacket>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const transfers = packets.flatMap(packet => Object.values(packet.attributes).map(a => a.array.buffer as ArrayBuffer));
    this.worker.postMessage({ id, packets }, transfers);
    const pieces = await result;
    return pieces.map(panels => {
      const group = new THREE.Group();
      for (const panel of panels) {
        const geometry = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(panel.attributes)) geometry.setAttribute(name,
          new THREE.BufferAttribute(attr.array as Float32Array, attr.itemSize, attr.normalized));
        const mesh = new THREE.Mesh(geometry, materials[panel.material]);
        mesh.castShadow = true; mesh.receiveShadow = true;
        group.add(mesh);
      }
      return group;
    });
  }
}
