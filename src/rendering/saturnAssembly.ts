import * as THREE from 'three/webgpu';
import { SATURN_HEIGHT_M, SATURN_STAGES, SaturnAssembly } from '../config/launchVehicles';

/** Cut triangles at stage boundaries while interpolating UVs and normals. The
 * NASA asset is one assembly, so filtering whole meshes would remove its body. */
export function sliceStageGeometry(source: THREE.BufferGeometry, minY: number, maxY: number): THREE.BufferGeometry {
  const names = Object.keys(source.attributes);
  const attributes = names.map(name => source.getAttribute(name));
  const sizes = attributes.map(a => a.itemSize);
  const offsets = sizes.map((_, i) => sizes.slice(0, i).reduce((sum, size) => sum + size, 0));
  const yOffset = offsets[names.indexOf('position')] + 1;
  const output: number[][] = names.map(() => []);
  const vertex = (index: number): number[] => attributes.flatMap((a, i) =>
    Array.from({ length: sizes[i] }, (_, c) => a.getComponent(index, c)));
  const clip = (polygon: number[][], boundary: number, above: boolean): number[][] => {
    const result: number[][] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = above ? a[yOffset] >= boundary : a[yOffset] <= boundary;
      const insideB = above ? b[yOffset] >= boundary : b[yOffset] <= boundary;
      if (insideA) result.push(a);
      if (insideA !== insideB) {
        const t = (boundary - a[yOffset]) / (b[yOffset] - a[yOffset]);
        result.push(a.map((v, c) => v + (b[c] - v) * t));
      }
    }
    return result;
  };
  const count = source.index?.count ?? source.getAttribute('position').count;
  const emit = (v: number[]) => names.forEach((_, a) => output[a].push(...v.slice(offsets[a], offsets[a] + sizes[a])));
  for (let i = 0; i < count; i += 3) {
    let polygon = [0, 1, 2].map(j => vertex(source.index ? source.index.getX(i + j) : i + j));
    polygon = clip(clip(polygon, minY, true), maxY, false);
    for (let j = 1; j + 1 < polygon.length; j++) {
      emit(polygon[0]); emit(polygon[j]); emit(polygon[j + 1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  names.forEach((name, i) => geometry.setAttribute(name, new THREE.Float32BufferAttribute(output[i], sizes[i])));
  if (geometry.hasAttribute('normal')) geometry.normalizeNormals();
  return geometry;
}

const cache = new WeakMap<THREE.Object3D, Map<string, THREE.Group>>();

export function buildSaturnAssembly(model: THREE.Object3D | null, state: SaturnAssembly): THREE.Group {
  const group = new THREE.Group();
  const stage = SATURN_STAGES[state.stageIndex];
  const topM = state.detached ? stage.baseM + stage.heightM : SATURN_HEIGHT_M;
  if (model) {
    let variants = cache.get(model);
    if (!variants) { variants = new Map(); cache.set(model, variants); }
    const key = `${state.stageIndex}:${state.detached}`;
    const cached = variants.get(key);
    if (cached) return cached.clone(true);
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const scale = SATURN_HEIGHT_M / (bounds.max.y - bounds.min.y);
    const center = bounds.getCenter(new THREE.Vector3());
    const normalize = new THREE.Matrix4().makeScale(scale, scale, scale)
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
    model.traverse(object => {
      if (!(object as THREE.Mesh).isMesh) return;
      const mesh = object as THREE.Mesh;
      const geometry = mesh.geometry.clone().applyMatrix4(normalize.clone().multiply(mesh.matrixWorld));
      const sliced = sliceStageGeometry(geometry, stage.baseM, topM);
      geometry.dispose();
      if (!sliced.getAttribute('position').count) { sliced.dispose(); return; }
      sliced.translate(0, -stage.baseM, 0);
      const part = new THREE.Mesh(sliced, mesh.material);
      part.castShadow = true;
      part.receiveShadow = true;
      group.add(part);
    });
    // The original full-stack asset has only the five first-stage engines.
    if (state.stageIndex > 0) {
      const metal = new THREE.MeshStandardMaterial({ color: 0x33343a, metalness: 0.7, roughness: 0.5 });
      const bell = new THREE.CylinderGeometry(0.7, 1.3, 2, 24, 1, true);
      const count = state.stageIndex === 1 ? 5 : 1;
      for (let i = 0; i < count; i++) {
        const engine = new THREE.Mesh(bell, metal);
        const radius = i === 0 ? 0 : 2.5;
        engine.position.set(Math.cos(i * Math.PI / 2) * radius, 1, Math.sin(i * Math.PI / 2) * radius);
        group.add(engine);
      }
    }
    variants.set(key, group);
  } else {
    const fallback = new THREE.Mesh(new THREE.CylinderGeometry(stage.diameterM / 2,
      stage.diameterM / 2, topM - stage.baseM, 32), new THREE.MeshStandardMaterial({ color: 0xeeeeeb }));
    fallback.position.y = (topM - stage.baseM) / 2;
    group.add(fallback);
  }
  return group.clone(true);
}
