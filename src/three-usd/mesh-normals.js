import { Float32BufferAttribute } from 'three';
import { usdPointIndices } from '../split-normals.js';

export function setUSDMeshNormals(geometry, fields, pointIndices, faceCorners) {
  const count = geometry.getAttribute('position').count;
  if (pointIndices?.length === count) usdPointIndices.set(geometry, pointIndices);
  if (fields.orientation === 'leftHanded' && count % 3 === 0) {
    const indices = Array.from({ length: count }, (_, i) => i);
    for (let i = 0; i < count; i += 3) {
      indices[i + 1] = i + 2;
      indices[i + 2] = i + 1;
    }
    geometry.setIndex(indices);
  }

  const name = fields['primvars:normals']?.length ? 'primvars:normals' : 'normals';
  const source = fields[name];
  if (!source?.length) return;
  const lookup = fields[name + ':indices'];
  const sizes = fields.faceVertexCounts ?? [];
  const entries = lookup?.length || source.length / 3;
  const pointCount = fields.points.length / 3;
  const interpolation = fields[name + ':interpolation'] ??
    (entries === 1 ? 'constant' : entries === pointCount ? 'vertex' :
      entries === sizes.length ? 'uniform' : 'faceVarying');

  let faces;
  if (interpolation === 'uniform') {
    faces = new Uint32Array(fields.faceVertexIndices?.length ?? 0);
    let offset = 0;
    for (let face = 0; face < sizes.length; face++) {
      faces.fill(face, offset, offset + sizes[face]);
      offset += sizes[face];
    }
  }
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const corner = faceCorners?.[i] ?? i;
    let entry;
    switch (interpolation) {
      case 'constant': entry = 0; break;
      case 'uniform': entry = faces[corner]; break;
      case 'vertex':
      case 'varying': entry = pointIndices?.[i] ?? i; break;
      case 'faceVarying': entry = corner; break;
      default: return;
    }
    const normal = (lookup?.length ? lookup[entry] : entry) * 3;
    if (normal >= 0 && normal + 2 < source.length) {
      for (let axis = 0; axis < 3; axis++) data[i * 3 + axis] = source[normal + axis];
    }
  }
  geometry.setAttribute('normal', new Float32BufferAttribute(data, 3));
}
