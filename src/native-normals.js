import { BufferGeometry, BufferAttribute } from './three/build/three.core.js';
import { floatAttribute } from '../atlantis-renderer/frontend/webgpu/mesh_gltf.js';
import { splitGeometryNormals } from './split-normals.js';

function remapAttributes(attributes, indices) {
  return Object.fromEntries(Object.entries(attributes).map(([name, attribute]) => {
    const { array, itemSize } = attribute;
    const expanded = new array.constructor(indices.length * itemSize);
    for (let i = 0; i < indices.length; i++) {
      const offset = indices[i] * itemSize;
      for (let j = 0; j < itemSize; j++) expanded[i * itemSize + j] = array[offset + j];
    }
    return [name, { ...attribute, array: expanded }];
  }));
}

export function prepareNativeGalleryNormals(meshes, creaseDegrees) {
  const limit = Number.isFinite(creaseDegrees) ? Math.min(180, Math.max(0, creaseDegrees)) : 45;
  for (const primitives of meshes) {
    for (const primitive of primitives) {
      if (primitive.mode < 4) continue;
      const position = primitive.attributes.POSITION;
      if (position.itemSize !== 3 || position.array.length % 3) throw Error('Invalid POSITION shape');
      const count = position.array.length / 3;
      let indices = primitive.indices;
      if (indices && (!(indices instanceof Uint8Array || indices instanceof Uint16Array || indices instanceof Uint32Array)
          || indices.some(i => i >= count))) throw Error('Invalid glTF indices');
      if (primitive.mode > 4) {
        const sequence = indices ?? Uint32Array.from({ length: count }, (_, i) => i);
        if (sequence.length < 3) continue;
        indices = new Uint32Array((sequence.length - 2) * 3);
        for (let i = 2; i < sequence.length; i++) {
          const offset = (i - 2) * 3;
          if (primitive.mode === 6) {
            indices[offset] = sequence[0];
            indices[offset + 1] = sequence[i - 1];
          } else {
            indices[offset] = sequence[i - (i % 2 ? 1 : 2)];
            indices[offset + 1] = sequence[i - (i % 2 ? 2 : 1)];
          }
          indices[offset + 2] = sequence[i];
        }
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(floatAttribute(position), 3));
      if (indices) geometry.setIndex(new BufferAttribute(indices, 1));
      const result = splitGeometryNormals(geometry, limit);
      const normal = result.getAttribute('normal');
      if (!normal) continue;
      if (result !== geometry) {
        primitive.attributes = remapAttributes(primitive.attributes, indices);
        primitive.targets = primitive.targets.map(target => remapAttributes(target, indices));
      }
      primitive.indices = result === geometry ? indices : null;
      primitive.mode = 4;
      primitive.attributes.NORMAL = { array: normal.array, itemSize: 3, componentType: 5126, normalized: false };
      delete primitive.attributes.TANGENT;
    }
  }
}
