import { Float32BufferAttribute, Vector3 } from './three/build/three.core.js';

// USD point indices preserve the original topology after the loader expands faces.
export const usdPointIndices = new WeakMap();

const nextCorner = corner => corner % 3 === 2 ? corner - 2 : corner + 1;

function coincidentPoints(position) {
  const ids = new Uint32Array(position.count);
  const points = new Map();
  for (let i = 0; i < position.count; i++) {
    const key = [position.getX(i), position.getY(i), position.getZ(i)].join(',');
    if (!points.has(key)) points.set(key, points.size);
    ids[i] = points.get(key);
  }
  return ids;
}

export function splitGeometryNormals(geometry, creaseDegrees = 45) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index?.count ?? position?.count;
  if (!position || !count || count % 3 !== 0) return geometry;

  const pointIDs = usdPointIndices.get(geometry) ?? coincidentPoints(position);
  const vertices = new Uint32Array(count);
  const parents = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    vertices[i] = index ? index.getX(i) : i;
    parents[i] = i;
  }
  function find(corner) {
    while (parents[corner] !== corner) {
      parents[corner] = parents[parents[corner]];
      corner = parents[corner];
    }
    return corner;
  }

  const directions = new Float64Array(count);
  const angles = new Float32Array(count);
  const edges = new Map();
  const points = [new Vector3(), new Vector3(), new Vector3()];
  const a = new Vector3(), b = new Vector3(), normal = new Vector3();
  for (let start = 0; start < count; start += 3) {
    for (let i = 0; i < 3; i++) points[i].fromBufferAttribute(position, vertices[start + i]);
    a.subVectors(points[1], points[0]);
    b.subVectors(points[2], points[0]);
    normal.crossVectors(a, b);
    const length = normal.length();
    if (!Number.isFinite(length) || length === 0) continue;
    normal.divideScalar(length).toArray(directions, start);
    for (let i = 0; i < 3; i++) {
      const corner = start + i;
      a.subVectors(points[(i + 1) % 3], points[i]);
      b.subVectors(points[(i + 2) % 3], points[i]);
      angles[corner] = Math.atan2(normal.crossVectors(a, b).length(), a.dot(b));
      const from = pointIDs[vertices[corner]], to = pointIDs[vertices[nextCorner(corner)]];
      const key = from < to ? from + ':' + to : to + ':' + from;
      const edge = edges.get(key);
      if (!edge) edges.set(key, { corner, from, other: -1 });
      else if (edge.other === -1 && edge.from === to) edge.other = corner;
      else edge.other = -2; // Non-manifold or inconsistent winding.
    }
  }

  const limit = Math.cos(creaseDegrees * Math.PI / 180);
  // Smoothing groups come from shared edges and triangle geometry alone.
  for (const { corner, other } of edges.values()) {
    if (other < 0) continue;
    a.fromArray(directions, corner - corner % 3);
    b.fromArray(directions, other - other % 3);
    if (a.dot(b) < limit - 1e-6) continue;
    parents[find(nextCorner(other))] = find(corner);
    parents[find(other)] = find(nextCorner(corner));
  }

  const weighted = new Float64Array(count * 3);
  for (let corner = 0; corner < count; corner++) {
    const group = find(corner);
    const dest = group * 3, face = corner - corner % 3;
    for (let axis = 0; axis < 3; axis++) weighted[dest + axis] += directions[face + axis] * angles[corner];
  }

  const perVertex = new Float32Array(position.count * 3);
  const perCorner = index ? new Float32Array(count * 3) : perVertex;
  const firstGroup = new Uint32Array(position.count);
  let needsSplit = false;
  for (let corner = 0; corner < count; corner++) {
    const vertex = vertices[corner], group = find(corner);
    normal.fromArray(weighted, group * 3).normalize();
    if (normal.lengthSq() === 0) {
      normal.fromArray(directions, corner - corner % 3);
      if (normal.lengthSq() === 0) normal.set(0, 1, 0);
    }
    normal.toArray(perCorner, corner * 3);
    if (firstGroup[vertex]) {
      if (firstGroup[vertex] !== group + 1) needsSplit = true;
    } else {
      firstGroup[vertex] = group + 1;
      normal.toArray(perVertex, vertex * 3);
    }
  }
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (!firstGroup[vertex]) perVertex[vertex * 3 + 1] = 1;
  }

  const result = needsSplit ? geometry.toNonIndexed() : geometry;
  if (needsSplit) {
    result.name = geometry.name;
    result.userData = geometry.userData;
    result.setDrawRange(geometry.drawRange.start, geometry.drawRange.count);
  }
  result.setAttribute('normal', new Float32BufferAttribute(needsSplit ? perCorner : perVertex, 3));
  // The native material can rebuild the tangent frame from the UV derivatives.
  result.deleteAttribute('tangent');
  return result;
}

export function prepareModelNormals(root, creaseDegrees) {
  const limit = Number.isFinite(creaseDegrees) ? Math.min(180, Math.max(0, creaseDegrees)) : 45;
  const converted = new Map();
  root.traverse(node => {
    if (!node.isMesh || !node.geometry) return;
    const source = node.geometry;
    if (!converted.has(source)) converted.set(source, splitGeometryNormals(source, limit));
    node.geometry = converted.get(source);
  });
  for (const [source, result] of converted) {
    if (source !== result) source.dispose();
    usdPointIndices.delete(source);
  }
}
