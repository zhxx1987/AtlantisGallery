import { ShaderModule, UniformBlock } from '../gpu/Shader.js';
import { Texture } from '../gpu/Texture.js';

const code = /* wgsl */ `
fn bevelPoint(pixel: vec2i, size: vec2i) -> vec4f {
	if (any(pixel < vec2i(0)) || any(pixel >= size)) { return vec4f(0.0); }
	let depth = textureLoad(bevelDepth, pixel, 0);
	if (depth <= 0.0) { return vec4f(0.0); }
	return vec4f(worldFromDepth((vec2f(pixel) + 0.5) / vec2f(size), depth), 1.0);
}

fn bevelNormal(pixel: vec2f, position: vec3f, normal: vec3f) -> vec3f {
	let size = vec2i(textureDimensions(bevelDepth));
	let origin = vec2i(pixel);
	let radius = bevelSettings.radius;
	let viewDepth = -(frame.view * vec4f(position, 1.0)).z;
	let projected = 0.5 * f32(size.y) * frame.proj[1][1] * radius /
		max(viewDepth, frame.near);
	if (projected < 0.5) { return vec3f(0.0); }
	let steps = i32(clamp(round(projected), 1.0, 5.0));
	let axes = array<vec2i, 4>(vec2i(1, 0), vec2i(0, 1), vec2i(-1, 0), vec2i(0, -1));
	var adjustment = vec3f(0.0);
	var best = 0.0;
	for (var i = 0; i < 4; i++) {
		let axis = axes[i];
		let neighbor = origin + steps * axis;
		let a = bevelPoint(neighbor, size);
		let b = bevelPoint(neighbor + axis, size);
		let c = bevelPoint(neighbor + axes[(i + 1) % 4], size);
		if (min(min(a.w, b.w), c.w) == 0.0) { continue; }
		let normalVector = cross(b.xyz - a.xyz, c.xyz - a.xyz);
		let area = length(normalVector);
		if (area < 1e-10) { continue; }
		var otherNormal = normalVector / area;
		otherNormal *= select(-1.0, 1.0, dot(otherNormal, frame.cameraPos - a.xyz) >= 0.0);
		let alignment = dot(normal, otherNormal);
		if (alignment < -0.25 || alignment > 0.88 || distance(a.xyz, position) > radius * 2.5) { continue; }
		// Reject occluders whose nearby plane cannot meet the current surface.
		let planeOffset = abs(dot(normal, a.xyz - position));
		let edgeDistance = abs(dot(otherNormal, position - a.xyz)) /
			sqrt(max(1.0 - alignment * alignment, 0.01));
		if (planeOffset > radius * 1.25 || edgeDistance > radius) { continue; }
		let weight = (1.0 - smoothstep(0.0, radius, edgeDistance)) *
			smoothstep(0.5, 1.5, projected);
		if (weight > best) {
			best = weight;
			adjustment = normalize(normal + otherNormal) - normal;
		}
	}
	return adjustment * best * bevelSettings.strength;
}
`;

export class ShaderBevel {
	constructor(depthFormat) {
		this.depth = new Texture({
			label: 'shader bevel depth', format: depthFormat, usage: ['render', 'sample'],
		});
		this.params = new UniformBlock('BevelSettings', { radius: ['f32', 0.004], strength: ['f32', 0.65] });
		this.module = new ShaderModule({
			name: 'shaderBevel', uniforms: this.params, uniformName: 'bevelSettings',
			bindings: { bevelDepth: { texture: this.depth } }, code,
		});
	}

	prepare(renderer, scene, { camera, layerMask, depthFormat }, width, height, { radius, strength }) {
		this.params.fields.radius.value = radius;
		this.params.fields.strength.value = strength;
		this.depth.resize(width, height);
		renderer.render(scene, {
			label: 'shader bevel depth', kind: 'depth', camera, layerMask,
			colorViews: [], colorFormats: [], depthView: this.depth.view(), depthFormat,
			clearDepth: 0, apsVegetationSeed: true,
		});
		return this.module;
	}

	dispose() {
		this.depth.destroy();
		this.params.buffer?.destroy();
	}
}
