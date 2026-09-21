// Second pass: composite the offscreen scene (the only target with a depth
// buffer) and the half-resolution floor reflection onto the canvas surface.
//
// The scene target is cleared with an alpha of 0, so its alpha is the card's
// coverage and the reflection can be shown only where the card is not. The
// reflection target holds premultiplied colour, so a plain weighted sum is a
// correct blur; the radius grows with the distance below the floor line, which
// is what a real floor does to a reflection.

struct Composite {
  /// Texture-space v of the floor line, where the reflection starts.
  floorLine: f32,
  /// Blur radius in texture-space units at the bottom of the frame.
  blur: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var reflection: texture_2d<f32>;
@group(0) @binding(3) var<uniform> composite: Composite;

/// Nine taps in a cross: the centre plus two pairs along each axis. vgpu 0.5.0
/// generates no mips, so this fixed kernel at half resolution is the blur.
fn blurReflection(uv: vec2f, radius: f32) -> vec4f {
  var sum = textureSampleLevel(reflection, sceneSampler, uv, 0.0) * 0.2;
  let inner = radius;
  let outer = radius * 2.3;
  sum += textureSampleLevel(reflection, sceneSampler, uv + vec2f(inner, 0.0), 0.0) * 0.13;
  sum += textureSampleLevel(reflection, sceneSampler, uv - vec2f(inner, 0.0), 0.0) * 0.13;
  sum += textureSampleLevel(reflection, sceneSampler, uv + vec2f(0.0, inner), 0.0) * 0.13;
  sum += textureSampleLevel(reflection, sceneSampler, uv - vec2f(0.0, inner), 0.0) * 0.13;
  sum += textureSampleLevel(reflection, sceneSampler, uv + vec2f(outer, 0.0), 0.0) * 0.07;
  sum += textureSampleLevel(reflection, sceneSampler, uv - vec2f(outer, 0.0), 0.0) * 0.07;
  sum += textureSampleLevel(reflection, sceneSampler, uv + vec2f(0.0, outer), 0.0) * 0.07;
  sum += textureSampleLevel(reflection, sceneSampler, uv - vec2f(0.0, outer), 0.0) * 0.07;
  return sum;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scenePixel = textureSampleLevel(scene, sceneSampler, uv, 0.0);

  // v grows downward, so this is how far below the floor line the pixel sits.
  let depth = clamp(
    (uv.y - composite.floorLine) / max(1.0 - composite.floorLine, 1e-3),
    0.0,
    1.0,
  );
  let mirrored = blurReflection(uv, composite.blur * (0.25 + 0.75 * depth));

  // The reflection sits on the cleared background, and the card sits on both.
  let floorPixel = scenePixel.rgb * (1.0 - mirrored.a) + mirrored.rgb;
  return vec4f(mix(floorPixel, scenePixel.rgb, scenePixel.a), 1.0);
}
