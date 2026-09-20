// Second pass: copy the offscreen scene (the only target with a depth buffer)
// onto the canvas surface.

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(scene, sceneSampler, uv, 0.0);
}
