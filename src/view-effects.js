import { GPU } from '../atlantis-renderer/vendor/tidewater/src/engine/gpu/GPU.js';
import { Texture } from '../atlantis-renderer/vendor/tidewater/src/engine/gpu/Texture.js';
import { ShaderModule, UniformBlock } from '../atlantis-renderer/vendor/tidewater/src/engine/gpu/Shader.js';
import { FullscreenPass } from '../atlantis-renderer/vendor/tidewater/src/engine/render/FullscreenPass.js';

const ssrCode = /* wgsl */ `
fn galleryProject(p: vec3f) -> vec2f {
  let clip = frame.proj * vec4f(p, 1.0);
  return clip.xy / clip.w * vec2f(.5, -.5) + .5;
}

fn fragment(in: FSIn) -> vec4f {
  let px = vec2i(in.pos.xy);
  let base = textureLoad(galleryHdr, px, 0);
  let depth = textureLoad(galleryDepth, px, 0);
  let surface = textureLoad(gallerySurface, px, 0);
  let len = length(surface.xyz);
  if (isSky(depth) || len < .99 || len > 1.84) { return base; }
  let roughness = clamp(len - 1.0, .04, 1.0);
  let N = surface.xyz / len;
  let P = viewFromDepth(in.uv, depth);
  let V = normalize(-P);
  let R = reflect(-V, N);
  let bias = max(gallerySSR.scale * .002, -P.z * .0015);
  let origin = P + N * bias;
  let maxLength = gallerySSR.scale * 4.0;
  let size = vec2f(textureDimensions(galleryDepth));
  var previous = 0.0;
  for (var i = 1; i <= 28; i++) {
    let f = f32(i) / 28.0;
    let stride = bias * 2.0 + maxLength * f * f;
    let Q = origin + R * stride;
    if (Q.z >= -.0001) { break; }
    let uv = galleryProject(Q);
    if (any(uv < vec2f(.001)) || any(uv > vec2f(.999))) { break; }
    let hitPx = vec2i(uv * size);
    let d = textureLoad(galleryDepth, hitPx, 0);
    if (isSky(d) || distance(vec2f(hitPx), vec2f(px)) < 2.0) { previous = stride; continue; }
    let sceneZ = viewFromDepth(uv, d).z;
    if (sceneZ <= Q.z) { previous = stride; continue; }

    var lo = previous;
    var hi = stride;
    for (var j = 0; j < 5; j++) {
      let mid = (hi + lo) * .5;
      let query = origin + R * mid;
      let queryUv = galleryProject(query);
      let queryPx = clamp(vec2i(queryUv * size), vec2i(0), vec2i(size) - 1);
      let queryDepth = textureLoad(galleryDepth, queryPx, 0);
      let gap = viewFromDepth(queryUv, queryDepth).z - query.z;
      if (!isSky(queryDepth) && gap > 0.0) { hi = mid; } else { lo = mid; }
    }
    let point = origin + R * hi;
    let hitUv = galleryProject(point);
    let refinedPx = clamp(vec2i(hitUv * size), vec2i(0), vec2i(size) - 1);
    let hitDepth = textureLoad(galleryDepth, refinedPx, 0);
    let gap = viewFromDepth(hitUv, hitDepth).z - point.z;
    if (!isSky(hitDepth) && distance(vec2f(refinedPx), vec2f(px)) > 2.0 &&
        gap >= 0.0 && gap < max(gallerySSR.scale * .022, -point.z * .002)) {
      let border = min(hitUv, 1.0 - hitUv);
      let fade = smoothstep(0.0, .12, min(border.x, border.y)) * (1.0 - smoothstep(.55, 1.0, f));
      let fresnel = mix(surface.w, 1.0, pow(clamp(1.0 - dot(V, N), 0.0, 1.0), 5.0));
      let energy = fade * fresnel * pow(1.0 - roughness, 1.7);
      let reflection = textureSampleLevel(galleryHdr, smpLinearClamp, hitUv, 0.0).rgb;
      return vec4f(base.rgb + reflection * energy * .7, base.a);
    }
    previous = stride;
  }
  return base;
}
`;

export async function installGalleryEffects(viewer) {
  const scene = viewer.sceneRenderer;
  const camera = viewer.renderPipeline;
  const reflections = new Texture({ label: 'Gallery SSR HDR', format: 'rgba16float', usage: ['render', 'copySrc'] });
  const settings = new UniformBlock('GalleryReflectionSettings', { scale: ['f32', 1] });
  const ssr = new FullscreenPass({
    label: 'Gallery screen-space reflections',
    modules: [new ShaderModule({ name: 'gallerySSR', uniforms: settings, uniformName: 'gallerySSR' })],
    bindings: {
      galleryHdr: { texture: () => scene.sceneRT.texture },
      galleryDepth: { texture: () => scene.sceneRT.depthTexture },
      gallerySurface: { texture: () => scene.velocityTexture },
    },
    code: ssrCode,
  });
  const opaqueHook = scene.onAfterOpaque;
  scene.onAfterOpaque = () => {
    opaqueHook?.();
    if (camera.diagnosticMode || !viewer.root) return;
    const { width, height } = scene;
    reflections.resize(width, height);
    ssr.render({ colorViews: [reflections] });
    GPU.getEncoder().copyTextureToTexture(
      { texture: reflections.getGPU() },
      { texture: scene.sceneRT.texture.getGPU() },
      [width, height, 1],
    );
  };
  return { setScale: scale => { settings.fields.scale.value = scale; } };
}
