// `fx=splat`: the card resampled as a cloud of gaussian splats.
//
// `lib/card-splats.ts` scatters N points over the real surface (front, back and
// the milled rim) from a deterministic hash, and hands each one its local
// position, normal, uv, face and seed in an instance stream. This shader draws
// every point as a camera-facing quad with a gaussian alpha falloff.
//
// A splat is one shaded sample of the surface, so the whole material evaluation
// happens in the vertex stage: four invocations per splat instead of a few
// hundred fragments, and the same `shadeSurface` the solid pass uses, so the
// cloud is lit by exactly the lobe it was sampled from.
//
// The quads are premultiplied-blended over the solid card, which `card.wgsl`
// has already dimmed and desaturated, and depth-tested against it without
// writing depth. The card is only 0.76 mm thick, so a quad centred on the back
// face still pokes through the front: the depth test alone cannot hide it, and
// the real cull is the sign of `dot(normal, view)`, which is exact on a slab.

import {
  Material,
  Pointer,
  Surface,
  grainNormal,
  hash21,
  shadeSurface,
  srgbToLinear,
} from "./pbr.wgsl";

const FACE_FRONT: u32 = 0u;
const FACE_BACK: u32 = 1u;

/// Mip level the splat reads the design texture at. The splat is about a
/// millimetre across, but the etched marks are finer than that, so the lookup
/// deliberately stays sharper than the footprint: at the full footprint the
/// name would average away into the coating.
const DESIGN_LOD: f32 = 2.0;

/// Gaussian exponent over the quad, whose corners sit at radius 1.
const FALLOFF: f32 = 4.0;

// The splat pass needs the camera basis in world space to face its quads, so
// its camera block carries more than `card.wgsl`'s.
struct SplatCamera {
  viewProjection: mat4x4f,
  position: vec3f,
  right: vec3f,
  up: vec3f,
}

struct Model {
  matrix: mat4x4f,
}

struct SplatParams {
  /// Base splat diameter in millimetres.
  size: f32,
  /// Frame index divided into quarter seconds, which the twinkle hashes against.
  tick: f32,
  /// How far each quad is pulled towards the camera, in millimetres, so a splat
  /// centred on the surface is not half-buried in it.
  lift: f32,
}

@group(0) @binding(0) var<uniform> camera: SplatCamera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> material: Material;
@group(0) @binding(3) var frontDesign: texture_2d<f32>;
@group(0) @binding(4) var backDesign: texture_2d<f32>;
@group(0) @binding(5) var designSampler: sampler;
@group(0) @binding(6) var<uniform> pointer: Pointer;
@group(0) @binding(7) var<uniform> splat: SplatParams;

struct SplatOut {
  @builtin(position) position: vec4f,
  /// Quad-local coordinates, -1..1 across the gaussian.
  @location(0) local: vec2f,
  @location(1) color: vec3f,
}

struct SplatFragment {
  @location(0) color: vec4f,
  /// Always a transparent black. The outline reads the solid card's geometry,
  /// never the cloud's, and compatibility mode will not let one attachment of
  /// an MRT draw carry its own write mask, so premultiplied blending is what
  /// leaves this one untouched: a source alpha of 0 keeps the destination.
  @location(1) normalMask: vec4f,
}

@vertex
fn vs_main(
  @location(0) corner: vec2f,
  @location(1) splatPosition: vec3f,
  @location(2) splatNormal: vec3f,
  @location(3) splatUv: vec2f,
  @location(4) splatMeta: vec3f,
) -> SplatOut {
  let seed = splatMeta.x;
  let sizeScale = splatMeta.y;
  let face = u32(splatMeta.z + 0.5);

  let world = (model.matrix * vec4f(splatPosition, 1.0)).xyz;
  let normal = normalize((model.matrix * vec4f(splatNormal, 0.0)).xyz);
  let view = normalize(camera.position - world);

  var out: SplatOut;
  out.local = corner;

  // A slab is convex enough that the sign of dot(normal, view) is an exact
  // visibility test, which the 0.76 mm depth range cannot give. Hidden splats
  // collapse to a degenerate quad outside the clip volume.
  if (dot(normal, view) <= 0.04) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    out.color = vec3f(0.0);
    return out;
  }

  // Slight twinkle: the size is re-hashed every quarter second, which keeps the
  // cloud alive without letting any splat wander off its sample point.
  let twinkle = 1.0 + (hash21(vec2f(seed, splat.tick)) - 0.5) * 0.2;
  let radius = splat.size * 0.5 * sizeScale * twinkle;

  let center = world + view * splat.lift;
  let offset = camera.right * (corner.x * radius) + camera.up * (corner.y * radius);
  out.position = camera.viewProjection * vec4f(center + offset, 1.0);

  // One shaded sample of the surface under the splat. The design texture is a
  // vertex-stage lookup, which needs an explicit level.
  var design = vec4f(0.0);
  var stockColor = material.baseColor;
  var stockRoughness = material.roughness;
  var stockMetallic = material.metallic;
  var anisotropy = material.anisotropy;
  if (face == FACE_FRONT) {
    design = textureSampleLevel(frontDesign, designSampler, splatUv, DESIGN_LOD);
  } else if (face == FACE_BACK) {
    design = textureSampleLevel(backDesign, designSampler, splatUv, DESIGN_LOD);
  } else {
    stockColor = material.edgeColor;
    stockRoughness = clamp(material.edgeRoughness, 0.03, 1.0);
    stockMetallic = material.edgeMetallic;
    anisotropy = material.anisotropy * 0.5;
  }

  let coverage = clamp(design.a, 0.0, 1.0);
  let inkTint = select(vec3f(1.0), srgbToLinear(design.rgb), coverage > 0.001);

  var surface: Surface;
  surface.albedo = mix(stockColor, material.inkColor * inkTint, coverage);
  surface.roughness = clamp(mix(stockRoughness, material.inkRoughness, coverage), 0.03, 1.0);
  surface.metallic = mix(stockMetallic, material.inkMetallic, coverage);
  surface.clearcoat = material.clearcoat;
  surface.clearcoatRoughness = material.clearcoatRoughness;
  surface.sheen = material.sheen * (1.0 - coverage * 0.6);
  surface.anisotropy = anisotropy;

  let spot = coverage * material.spotGloss;
  surface.roughness = mix(surface.roughness, 0.07, spot * 0.9);
  surface.clearcoat = max(surface.clearcoat, spot);
  surface.clearcoatRoughness = mix(surface.clearcoatRoughness, 0.04, spot);

  // The rim is brushed around the perimeter, the faces along the long axis,
  // which is exactly how `card-geometry.ts` lays its tangents out.
  var localTangent = vec3f(1.0, 0.0, 0.0);
  if (face == FACE_BACK) {
    localTangent = vec3f(-1.0, 0.0, 0.0);
  } else if (face != FACE_FRONT) {
    localTangent = vec3f(-splatNormal.y, splatNormal.x, 0.0);
  }
  let worldTangent = normalize((model.matrix * vec4f(localTangent, 0.0)).xyz);
  let tangent = normalize(worldTangent - normal * dot(normal, worldTangent));
  let bitangent = -normalize(cross(normal, tangent));

  let shadingNormal = grainNormal(
    normal, tangent, bitangent, splatUv,
    material.grain * (1.0 - spot * 0.8),
  );
  let etchAo = 1.0 - material.etchAo * material.etch * coverage;

  out.color = shadeSurface(
    surface, shadingNormal, normal, tangent, bitangent,
    world, camera.position, pointer,
    coverage, etchAo, material.exposure,
  );
  return out;
}

@fragment
fn fs_main(input: SplatOut) -> SplatFragment {
  let r2 = dot(input.local, input.local);
  if (r2 > 1.0) {
    discard;
  }
  // A gaussian rebased so it reaches exactly zero at the quad's rim, which is
  // what keeps the cloud's outer edge soft instead of showing the quads.
  let floorValue = exp(-FALLOFF);
  let alpha = clamp(
    (exp(-FALLOFF * r2) - floorValue) / (1.0 - floorValue),
    0.0,
    1.0,
  );

  var out: SplatFragment;
  out.color = vec4f(input.color * alpha, alpha);
  out.normalMask = vec4f(0.0);
  return out;
}
