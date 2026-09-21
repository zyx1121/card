// Second pass: composite the offscreen scene onto the canvas surface, print the
// grain over the card and draw the outline on top of everything.
//
// The card pass is the only one with a depth buffer, so it renders offscreen
// into two attachments. `scene` is premultiplied colour with the card's
// coverage in alpha, which is what lets it be laid over the page background and
// resolved from MSAA without going wrong. `normalMask` is the geometry buffer:
// the world normal packed into the unit range in xyz and the solid card's
// silhouette mask in w. Only the solid pass writes it, so the outline follows
// the card's own geometry even when the splat cloud is blurring its edge.
//
// The outline is screen-space on purpose. It is measured in CSS pixels and
// dilated to that width here, so its thickness never changes with the card's
// angle, its distance or the device pixel ratio: the line reads as drawn on
// afterwards rather than modelled.

/// Grain modes, matching `CardFx` in `lib/card-fx.ts`.
const FX_NONE: u32 = 0u;
const FX_STIPPLE: u32 = 1u;
const FX_SPLAT: u32 = 2u;

/// Half-width of the tap box the outline's distance search walks, in pixels.
/// It has to cover `outlineWidth / 2 + 1`, which is 4 at the 3 CSS px default
/// on a device pixel ratio of 2.
const OUTLINE_TAPS: i32 = 4;

/// Centre-to-centre spacing of the stipple grid, in CSS pixels.
const STIPPLE_PITCH: f32 = 3.2;

/// How much of the smooth shading survives under the printed dots.
const STIPPLE_SHADING: f32 = 0.35;

struct Composite {
  /// Page background, which the premultiplied card is laid over.
  background: vec3f,
  /// Outline thickness in physical pixels: CSS pixels times the pixel ratio.
  outlineWidth: f32,
  outlineColor: vec3f,
  /// Device pixel ratio, so the stipple grid keeps one apparent size.
  dpr: f32,
  /// Target size in physical pixels.
  size: vec2f,
  /// Slow animation counter: the frame index divided down, so the stipple
  /// jitter breathes instead of boiling.
  tick: f32,
  mode: u32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var normalMask: texture_2d<f32>;
@group(0) @binding(2) var<uniform> composite: Composite;

fn hash21(p: vec2f) -> f32 {
  var h = fract(p * vec2f(443.8975, 397.2973));
  h += dot(h, h.yx + vec2f(19.19));
  return fract((h.x + h.y) * h.x);
}

fn luminance(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

/// How strongly a geometric edge lies between two pixels, 0..1.
///
/// Two readings: the mask step catches the silhouette, and the angle between
/// the two normals catches the crease where the face meets the milled rim. On a
/// 0.76 mm slab those are every geometric edge there is, which is why there is
/// no depth term here. Both come from the multisampled resolve, so a half
/// covered pixel reports half a mask and the step is found to within a fraction
/// of a pixel rather than on the pixel grid.
fn edgeBetween(center: vec4f, sample: vec4f) -> f32 {
  let silhouette = smoothstep(0.15, 0.5, abs(sample.w - center.w));

  // Off the card the whole texel is zero, which unpacks to a meaningless
  // direction, so the crease term is weighted by both masks.
  let both = center.w * sample.w;
  let a = normalize(center.xyz * 2.0 - vec3f(1.0) + vec3f(1e-6, 0.0, 0.0));
  let b = normalize(sample.xyz * 2.0 - vec3f(1.0) + vec3f(1e-6, 0.0, 0.0));
  let crease = smoothstep(0.10, 0.30, 1.0 - dot(a, b)) * both;

  return max(silhouette, crease);
}

/// The outline coverage at one pixel.
///
/// It walks a disc of integer offsets, keeps the distance to the nearest
/// offset a geometric edge is found at, and thresholds that distance at half
/// the wanted width. Because the answer is a distance rather than a dilation,
/// the width is exactly `outlineWidth` whatever the edge's orientation, and one
/// smoothstep over a pixel antialiases it.
fn outlineAt(pixel: vec2i) -> f32 {
  let halfWidth = composite.outlineWidth * 0.5;
  let reach = halfWidth + 1.0;

  let center = textureLoad(normalMask, pixel, 0);

  var nearest = 1e6;
  for (var dy = -OUTLINE_TAPS; dy <= OUTLINE_TAPS; dy++) {
    for (var dx = -OUTLINE_TAPS; dx <= OUTLINE_TAPS; dx++) {
      let offset = vec2f(f32(dx), f32(dy));
      // A tap that disagrees with the centre puts the edge somewhere between
      // the two, not at the tap, so half a pixel comes off the radius. Without
      // it the nearest tap is never closer than 1 and the line comes out a
      // pixel thin whatever the width asks for.
      let radius = max(length(offset) - 0.5, 0.0);
      if (radius > reach || radius >= nearest) {
        continue;
      }
      let edge = edgeBetween(center, textureLoad(normalMask, pixel + vec2i(dx, dy), 0));
      // A tap that only half disagrees is pushed away rather than counted, so
      // the distance field stays smooth instead of snapping between rings.
      nearest = min(nearest, mix(1e6, radius, edge));
    }
  }

  return 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, nearest);
}

/// The printed-dot layer: a jittered hexagonal grid of soft gaussian dots whose
/// size and density follow the shaded luminance, so the card reads as a poster
/// halftone rather than as film grain.
fn stipple(pixel: vec2f, tone: f32) -> f32 {
  let pitch = STIPPLE_PITCH * composite.dpr;
  let rowHeight = pitch * 0.866025;

  // Denser and fatter where the shading is dark, which is what a stippler does.
  let density = clamp(0.12 + tone * 1.65, 0.0, 1.0);
  let sigma = pitch * mix(0.17, 0.34, tone);
  let falloff = 1.0 / (2.0 * sigma * sigma);

  let row = floor(pixel.y / rowHeight);
  var ink = 0.0;
  for (var dr = -1; dr <= 1; dr++) {
    let r = row + f32(dr);
    // Every other row is offset by half a pitch, which is what makes it a
    // hexagonal packing instead of a square one.
    let stagger = select(0.0, pitch * 0.5, fract(r * 0.5) > 0.25);
    let column = floor((pixel.x - stagger) / pitch);
    for (var dc = -1; dc <= 1; dc++) {
      let c = column + f32(dc);
      let cell = vec2f(c, r);
      if (hash21(cell + vec2f(composite.tick * 0.017, 0.0)) > density) {
        continue;
      }
      let jitter = vec2f(
        hash21(cell + vec2f(11.3, composite.tick)) - 0.5,
        hash21(cell + vec2f(composite.tick, 7.7)) - 0.5,
      ) * pitch * 0.34;
      let center = vec2f(
        stagger + (c + 0.5) * pitch,
        (r + 0.5) * rowHeight,
      ) + jitter;
      let delta = pixel - center;
      ink = max(ink, exp(-dot(delta, delta) * falloff));
    }
  }
  return ink;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixelf = uv * composite.size;
  let pixel = vec2i(pixelf);

  let scenePixel = textureLoad(scene, pixel, 0);
  let coverage = clamp(scenePixel.a, 0.0, 1.0);
  var premultiplied = scenePixel.rgb;

  if (composite.mode == FX_STIPPLE && coverage > 0.004) {
    let shaded = scenePixel.rgb / coverage;
    let tone = clamp(1.0 - luminance(shaded), 0.0, 1.0);
    let ink = stipple(pixelf, tone);
    // The coating between the dots is the paper; a dot is the same colour
    // burned down. Some of the smooth shading is kept underneath so the
    // titanium gradient still reads across the face.
    let paper = shaded * 1.12 + vec3f(0.015);
    let burn = shaded * 0.42;
    let printed = mix(paper, burn, ink);
    premultiplied = mix(printed, shaded, STIPPLE_SHADING) * coverage;
  }

  var color = premultiplied + composite.background * (1.0 - coverage);

  // Last, and over everything: the line is drawn on the picture, not in it.
  if (composite.outlineWidth > 0.0) {
    color = mix(color, composite.outlineColor, outlineAt(pixel));
  }

  return vec4f(color, 1.0);
}
