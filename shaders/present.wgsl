// Second pass: composite the offscreen scene onto the canvas surface.
//
// The card pass is the only one with a depth buffer, so it renders offscreen
// into `scene`: premultiplied colour with the card's coverage in alpha, which
// is what lets it be laid over the page background and resolved from MSAA
// without going wrong.

struct Composite {
  /// Page background, which the premultiplied card is laid over.
  background: vec3f,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<uniform> composite: Composite;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // The scene target is the size of the surface, so the composite is a plain
  // texel-for-texel read rather than a filtered sample.
  let size = vec2f(textureDimensions(scene, 0));
  let pixel = vec2i(uv * size);

  let scenePixel = textureLoad(scene, pixel, 0);
  let coverage = clamp(scenePixel.a, 0.0, 1.0);
  let color = scenePixel.rgb + composite.background * (1.0 - coverage);

  return vec4f(color, 1.0);
}
