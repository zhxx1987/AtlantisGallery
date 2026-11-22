export const FXAA_WGSL = /* wgsl */ `
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(.299,.587,.114)); }
fn sampleColor(uv: vec2f) -> vec3f {
  return textureSampleLevel(fxaaInput, smpLinearClamp, uv, 0.0).rgb;
}
fn hasForeground(uv: vec2f) -> bool {
  let size = vec2i(textureDimensions(fxaaDepth));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
  return textureLoad(fxaaDepth, pixel, 0) > 0.0 || textureLoad(fxaaMotion, pixel, 0).z > 0.001;
}
fn fragment(in: FSIn) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(fxaaInput));
  let rgba = textureSampleLevel(fxaaInput, smpLinearClamp, in.uv, 0.0);
  if (!hasForeground(in.uv)) {
    var edge = false;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        edge = edge || hasForeground(in.uv + vec2f(f32(x), f32(y)) * px);
      }
    }
    if (!edge) { return rgba; }
  }
  let center = rgba.rgb;
  let m = luma(center);
  let nw = luma(sampleColor(in.uv + vec2f(-1.0, -1.0) * px));
  let ne = luma(sampleColor(in.uv + vec2f(1.0, -1.0) * px));
  let sw = luma(sampleColor(in.uv + vec2f(-1.0, 1.0) * px));
  let se = luma(sampleColor(in.uv + vec2f(1.0, 1.0) * px));
  let darkest = min(m, min(min(nw, ne), min(sw, se)));
  let brightest = max(m, max(max(nw, ne), max(sw, se)));
  if (brightest - darkest < max(.0312, brightest * .125)) { return rgba; }
  let dir = vec2f(sw + se - nw - ne, nw + sw - ne - se);
  let reduce = max((nw + ne + sw + se) * .03125, .0078125);
  let axis = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), vec2f(-8.0), vec2f(8.0)) * px;
  let inner = .5 * (sampleColor(in.uv - axis / 6.0) + sampleColor(in.uv + axis / 6.0));
  let outer = .5 * inner + .25 * (sampleColor(in.uv - axis * .5) + sampleColor(in.uv + axis * .5));
  let luminance = luma(outer);
  return vec4f(select(outer, inner, luminance < darkest || luminance > brightest), rgba.a);
}
`;
