import { GPU } from '../gpu/GPU.js';
import { Texture } from '../gpu/Texture.js';
import { FullscreenPass } from './FullscreenPass.js';

const HARDWARE_SAMPLES = 4;

const visibilityResolve = /* wgsl */`
@fragment fn fs(in: FSIn) -> @builtin(frag_depth) f32 {
	var farthest = 1.0;
	let pixel = vec2i(in.pos.xy);
	for (var sample = 0; sample < 4; sample++) {
		farthest = min(farthest, textureLoad(coverageDepth, pixel, sample));
	}
	return farthest;
}
`;

const sceneResolve = /* wgsl */`
struct ResolvedScene {
	@location(0) color: vec4f,
	@location(1) surface: vec4f,
	@location(2) mask: vec4f,
	@builtin(frag_depth) depth: f32,
}
@fragment fn fs(in: FSIn) -> ResolvedScene {
	let pixel = vec2i(in.pos.xy);
	var color = vec4f(0.0);
	var covered = 0;
	var closest = 0.0;
	var closestSample = 0;
	for (var sample = 0; sample < 4; sample++) {
		let depth = textureLoad(coverageDepth, pixel, sample);
		if (depth > 0.0) {
			color += textureLoad(coverageColor, pixel, sample);
			covered++;
		}
		if (depth > closest) {
			closest = depth;
			closestSample = sample;
		}
	}
	if (covered == 0) { discard; }
	if (covered < 4) {
		color += textureLoad(backgroundColor, pixel, 0) * f32(4 - covered);
	}
	return ResolvedScene(color * 0.25,
		textureLoad(coverageSurface, pixel, closestSample),
		textureLoad(coverageMask, pixel, closestSample), closest);
}
`;

// Average linear color and retain nearest reversed-Z surface data
// for post effects. Conservative visibility instead requires full coverage.
export class OpaqueAntialiasing {
	constructor(formats, depthFormat) {
		const attachment = (format, label) => new Texture({
			format, label, sampleCount: HARDWARE_SAMPLES, usage: ['sample', 'render'],
		});
		this.colors = formats.map((format, i) => attachment(format, `opaque MSAA color ${i}`));
		this.depth = attachment(depthFormat, 'opaque MSAA depth');
		this.backgroundColor = new Texture({
			format: formats[0], label: 'single-sample background color', usage: ['copyDst', 'sample'],
		});
		const coverageDepth = { texture: this.depth, wgslType: 'texture_depth_multisampled_2d' };
		const binding = texture => ({
			texture, sampleType: 'unfilterable-float', wgslType: 'texture_multisampled_2d<f32>',
		});
		this.scenePass = new FullscreenPass({
			label: 'opaque MSAA resolve', colorFormats: formats, depthFormat, depthWrite: true,
			bindings: { coverageDepth, backgroundColor: { texture: this.backgroundColor },
				coverageColor: binding(this.colors[0]),
				coverageSurface: binding(this.colors[1]), coverageMask: binding(this.colors[2]) },
			code: sceneResolve,
		});
		this.visibilityPass = new FullscreenPass({
			label: 'opaque MSAA visibility depth', colorFormats: [], depthFormat, depthWrite: true,
			bindings: { coverageDepth }, code: visibilityResolve,
		});
	}

	opaquePass(scenePass, resolved) {
		for (const texture of [...this.colors, this.depth]) texture.resize(resolved.width, resolved.height);
		return {
			...scenePass,
			sampleCount: HARDWARE_SAMPLES,
			colorViews: this.colors.map(texture => texture.view()),
			depthView: this.depth.view(),
			depthTexture: this.depth,
			resolveVisibilityDepth: () => {
				this.resolve(this.visibilityPass, [], resolved.depthTexture);
				return resolved.depthTexture;
			},
		};
	}

	resolveScene(resolved, background, clearColors) {
		const encoder = GPU.getEncoder();
		const depth = resolved.depthTexture;
		const rp = encoder.beginRenderPass({
			label: 'single-sample background',
			colorAttachments: resolved.textures.map((texture, i) => ({
				view: texture.view(), loadOp: 'clear', clearValue: clearColors[i], storeOp: 'store',
			})),
			depthStencilAttachment: {
				view: depth.view(), depthLoadOp: 'clear', depthClearValue: 0, depthStoreOp: 'store',
			},
		});
		try { background?.(rp); } finally { rp.end(); }
		this.backgroundColor.resize(resolved.width, resolved.height);
		encoder.copyTextureToTexture(
			{ texture: resolved.texture.getGPU() }, { texture: this.backgroundColor.getGPU() },
			{ width: resolved.width, height: resolved.height },
		);
		this.resolve(this.scenePass, resolved.textures, depth, 'load');
	}

	resolve(pass, colors, depth, loadOp = 'clear') {
		const rp = GPU.getEncoder().beginRenderPass({
			label: pass.label,
			colorAttachments: colors.map(texture => ({
				view: texture.view(), loadOp, clearValue: [0, 0, 0, 0], storeOp: 'store',
			})),
			depthStencilAttachment: {
				view: depth.view(), depthLoadOp: loadOp, depthClearValue: 0, depthStoreOp: 'store',
			},
		});
		try { pass.draw(rp); } finally { rp.end(); }
	}

	dispose() {
		for (const texture of [...this.colors, this.depth, this.backgroundColor]) texture.destroy();
	}
}
