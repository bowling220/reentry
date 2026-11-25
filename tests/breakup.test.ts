import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { fractureAssembly, SpacecraftBreakup } from '../src/rendering/spacecraftBreakup';
import { CAPE_FRAME } from '../src/simulation/terrainHeight';

test('quantized GLTF fuselage retains its full meter-scale dimensions when fractured', () => {
  const root = new THREE.Group(), source = new THREE.Group(); root.add(source);
  const geometry = new THREE.CylinderGeometry(2, 2, 70, 16);
  const position = geometry.getAttribute('position');
  geometry.setAttribute('position', new THREE.Int16BufferAttribute(
    Array.from(position.array, value => Math.round(value / 35 * 32767)), 3, true));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.scale.setScalar(35); source.add(mesh);
  const pieces = fractureAssembly(source, root), debris = new THREE.Group();
  pieces.forEach(piece => debris.add(piece));
  const size = new THREE.Box3().setFromObject(debris).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.y - 70) < 0.01);
  assert.ok(Math.abs(size.x - 4) < 0.01);
  assert.equal(pieces.length, 28);
  assert.equal(geometry.getAttribute('position').normalized, true, 'original quantized asset remains unchanged');
});
import { localPointToECEF } from '../src/math/coordinates';
import { prepareFracture } from '../src/rendering/fracture.worker';
import { snapshotAttribute } from '../src/rendering/breakupPreparation';

test('worker snapshots deinterleave and decode normalized GLTF attributes without detaching assets', () => {
  const buffer = new THREE.InterleavedBuffer(new Int16Array([32767, 0, -32767, 123, 0, 16384, 0, 456]), 4);
  const attribute = new THREE.InterleavedBufferAttribute(buffer, 3, 0, true);
  const snapshot = snapshotAttribute(attribute);
  assert.equal(snapshot.array.byteLength, 6 * 4);
  const values = Array.from(snapshot.array as Float32Array);
  assert.deepEqual(values.slice(0, 3), [1, 0, -1]);
  assert.ok(Math.abs(values[4] - 0.5) < 0.001);
  assert.equal(snapshot.normalized, false);
  assert.equal(buffer.array.length, 8);
});

test('worker fracture preserves quantized geometry and batches matching shell materials', () => {
  const geometry = new THREE.CylinderGeometry(2, 2, 70, 32);
  const p = geometry.getAttribute('position');
  const quantized = new Int16Array(Array.from(p.array, value => Math.round(value / 35 * 32767)));
  const attributes = {
    position: { array: quantized, itemSize: 3, normalized: true },
    normal: { array: geometry.getAttribute('normal').array, itemSize: 3, normalized: false },
    uv: { array: geometry.getAttribute('uv').array, itemSize: 2, normalized: false },
  };
  const packet = { attributes, index: Array.from(geometry.index!.array), groups: [],
    matrix: new THREE.Matrix4().makeScale(35, 35, 35).toArray(), materials: [0] };
  const before = Array.from(quantized);
  const pieces = prepareFracture([packet, packet, packet, packet]);
  assert.equal(pieces.length, 28);
  assert.equal(pieces.reduce((count, panels) => count + panels.length, 0), 28, 'four identical materials merge into one draw per fragment');
  const ys = pieces.flatMap(panels => panels.flatMap(panel => {
    const positions = panel.attributes.position.array as Float32Array;
    return Array.from({ length: positions.length / 3 }, (_, i) => positions[i * 3 + 1]);
  }));
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 70) < 0.01);
  assert.deepEqual(Array.from(quantized), before);
});

function surfaceArea(root: THREE.Object3D): number {
  let area = 0;
  root.traverse(object => {
    if (!(object as THREE.Mesh).isMesh) return;
    const geometry = (object as THREE.Mesh).geometry;
    const p = geometry.getAttribute('position'), index = geometry.index;
    for (let i = 0; i < (index?.count ?? p.count); i += 3) {
      const vertices = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(p, index ? index.getX(i + j) : i + j));
      area += vertices[1].sub(vertices[0]).cross(vertices[2].sub(vertices[0])).length() / 2;
    }
  });
  return area;
}

test('breakup cuts long tank triangles, preserves material groups and original geometry', () => {
  const root = new THREE.Group(), assembly = new THREE.Group(); root.add(assembly);
  root.position.set(10000, -2000, 7000);
  root.rotation.set(0.2, 0.5, 0.8);
  const materials = [0xffffff, 0x111111, 0x888888].map(color => new THREE.MeshStandardMaterial({ color }));
  const original = new THREE.CylinderGeometry(2, 2, 70, 32, 1);
  assembly.add(new THREE.Mesh(original, materials));
  const positions = Array.from(original.getAttribute('position').array);
  const pieces = fractureAssembly(assembly, root);
  assert.equal(pieces.length, 28);
  const debris = new THREE.Group(); pieces.forEach(piece => debris.add(piece));
  assert.ok(Math.abs(surfaceArea(debris) - surfaceArea(assembly)) < 0.01, 'preserves the actual shell surface rather than duplicating intact rockets');
  const used = new Set<THREE.Material>();
  debris.traverse(object => { if ((object as THREE.Mesh).isMesh) used.add((object as THREE.Mesh).material as THREE.Material); });
  assert.equal(used.size, 3, 'retains barrel and end-cap materials');
  for (const piece of pieces) assert.ok(new THREE.Box3().setFromObject(piece).getSize(new THREE.Vector3()).y <= 10.001);
  assert.deepEqual(Array.from(original.getAttribute('position').array), positions, 'shared live assets are not modified');
});

test('debris separates, pauses, settles, survives camera shifts and disposes its own resources', () => {
  const root = new THREE.Group(), assembly = new THREE.Group(); root.add(assembly);
  const originalMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
  assembly.add(new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 40, 16), originalMaterial));
  const origin = localPointToECEF({ x: -320, y: 25, z: 520 }, CAPE_FRAME);
  const breakup = new SpacecraftBreakup(fractureAssembly(assembly, root), origin,
    new THREE.Quaternion(CAPE_FRAME.localToECEF.x, CAPE_FRAME.localToECEF.y, CAPE_FRAME.localToECEF.z, CAPE_FRAME.localToECEF.w), { x: 0, y: 0, z: 0 });
  breakup.update(origin, 0);
  const initial = breakup.group.children.map(piece => piece.position.clone());
  breakup.update(origin, 0);
  assert.deepEqual(breakup.group.children.map(piece => piece.position.toArray()), initial.map(p => p.toArray()));
  for (let i = 0; i < 600; i++) breakup.update(origin, 1 / 60);
  assert.ok(breakup.group.children.every((piece, i) => piece.position.distanceTo(initial[i]) > 2), 'sections visibly scatter');
  const settled = breakup.group.children.map(piece => piece.position.clone());
  for (let i = 0; i < 600; i++) breakup.update(origin, 1 / 60);
  assert.ok(breakup.group.children.every((piece, i) => piece.position.distanceTo(settled[i]) < 0.1), 'wreckage remains settled');
  const before = breakup.group.children[0].position.clone();
  breakup.update({ x: origin.x + 100, y: origin.y, z: origin.z }, 0);
  assert.ok(Math.abs(breakup.group.children[0].position.x - before.x + 100) < 1e-6);
  let originalDisposed = false, debrisDisposed = false;
  originalMaterial.addEventListener('dispose', () => { originalDisposed = true; });
  (breakup.group.children[0].children[0] as THREE.Mesh).geometry.addEventListener('dispose', () => { debrisDisposed = true; });
  breakup.dispose();
  assert.equal(breakup.group.children.length, 0);
  assert.equal(debrisDisposed, true);
  assert.equal(originalDisposed, false, 'reset never disposes shared vehicle assets');
});
