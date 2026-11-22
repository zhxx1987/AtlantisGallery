import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute } from '../src/three/build/three.core.js';
import { splitGeometryNormals, usdPointIndices } from '../src/split-normals.js';
import { prepareNativeGalleryNormals } from '../src/native-normals.js';

const smoothPositions = [0,0,0, 1,0,0, 0,1,0, 1,0,0, 0,0,0, 0,-1,0.268];
const tilt = 0.3 * Math.PI / 180;
const firstNormal = [0, 0, 1];
const secondNormal = [0, Math.sin(tilt), Math.cos(tilt)];
const authored = [...firstNormal, ...firstNormal, ...firstNormal, ...secondNormal, ...secondNormal, ...secondNormal];
const attribute = (array, size) => new Float32BufferAttribute(array, size);
const near = (a, b) => {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `${a[i]} vs ${b[i]}`);
};

function smoothGeometry(normals, useUsdTopology) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', attribute(smoothPositions, 3));
  geometry.setAttribute('uv', attribute([0,0, 1,0, 0,1, 0,0, 1,0, 0,1], 2));
  if (normals) geometry.setAttribute('normal', attribute(normals, 3));
  if (useUsdTopology) usdPointIndices.set(geometry, [0, 1, 2, 1, 0, 3]);
  const result = splitGeometryNormals(geometry);
  assert.equal(result, geometry);
  const resultNormals = result.getAttribute('normal').array;
  near(resultNormals.slice(0, 3), resultNormals.slice(12, 15));
  near(resultNormals.slice(3, 6), resultNormals.slice(9, 12));
  assert.ok(resultNormals[1] > 0.1);
  return resultNormals;
}
const expected = smoothGeometry(null, false);
near(smoothGeometry(authored, false), expected);
near(smoothGeometry(authored, true), expected);

const crease = new BufferGeometry();
const creasePositions = [0,0,0, 1,0,0, 0,1,0, 0,0,1];
crease.setAttribute('position', attribute(creasePositions, 3));
crease.setAttribute('normal', attribute([...firstNormal, ...firstNormal, ...firstNormal, ...firstNormal], 3));
crease.setIndex([0, 1, 2, 1, 0, 3]);
crease.addGroup(0, 3, 0);
crease.addGroup(3, 3, 1);
const split = splitGeometryNormals(crease);
assert.equal(split.getIndex(), null);
assert.deepEqual(split.groups, crease.groups);
near(split.getAttribute('normal').array.slice(0, 3), firstNormal);
near(split.getAttribute('normal').array.slice(9, 12), [0, 1, 0]);

const stream = (values, itemSize, componentType = 5126) => ({
  array: componentType === 5126 ? Float32Array.from(values) : Uint8Array.from(values),
  itemSize,
  componentType,
  normalized: false,
});
const native = {
  mode: 5,
  indices: Uint16Array.of(2, 0, 1, 3),
  material: 7,
  attributes: {
    POSITION: stream(creasePositions, 3),
    NORMAL: stream(crease.getAttribute('normal').array, 3),
    TANGENT: stream(new Float32Array(16), 4),
    JOINTS_0: stream([1,0,0,0, 2,0,0,0, 3,0,0,0, 4,0,0,0], 4, 5121),
  },
  targets: [{ POSITION: stream(creasePositions, 3) }],
};
prepareNativeGalleryNormals([[native]]);
assert.equal(native.mode, 4);
assert.equal(native.indices, null);
assert.equal(native.material, 7);
assert.equal(native.attributes.TANGENT, undefined);
assert.deepEqual(Array.from(native.attributes.JOINTS_0.array).filter((_, i) => i % 4 === 0), [3, 1, 2, 2, 1, 4]);
near(native.targets[0].POSITION.array, native.attributes.POSITION.array);
near(native.attributes.NORMAL.array.slice(0, 3), firstNormal);
near(native.attributes.NORMAL.array.slice(9, 12), [0, 1, 0]);
const nativeSmooth = { mode: 4, indices: null, attributes: {
  POSITION: stream(smoothPositions, 3), NORMAL: stream(authored, 3),
}, targets: [] };
prepareNativeGalleryNormals([[nativeSmooth]]);
near(nativeSmooth.attributes.NORMAL.array, expected);
console.log('Geometry-only import normals passed for GLB, USD topology, and native GLB streams.');
