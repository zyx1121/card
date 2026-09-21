// Laser-etched white titanium card, the solid pass.
//
// One shader covers all three faces. The front and back sample their design
// texture, whose alpha is the etch mask: 1 where the laser has burned the white
// ceramic coating away and left bare titanium, 0 where the coating is intact.
// The milled rim is shaded from its own albedo, metalness and roughness. The
// material model itself lives in `pbr.wgsl`, which `splat.wgsl` imports too.
//
// A fourth light follows the cursor: a soft point light on a plane between the
// camera and the card. It is off (`pointer.intensity` 0) unless the page or the
// render script supplies a pointer.
//
// The pass writes two colour attachments. Attachment 0 is the premultiplied
// shaded colour, so its alpha is the card's coverage and an MSAA resolve stays
// linear. Attachment 1 is the geometry buffer the composite's outline reads:
// the world normal packed into the unit range in xyz, and the card's own
// silhouette mask in w. The mask lives here rather than in attachment 0's alpha
// because the splat pass blends over that one and would smear the silhouette
// the line has to follow; nothing but this pass ever writes attachment 1.

import {
  Material,
  Pointer,
  Surface,
  grainNormal,
  shadeSurface,
  sparkleNormal,
  srgbToLinear,
} from "./pbr.wgsl";

const FACE_FRONT: u32 = 0u;
const FACE_BACK: u32 = 1u;

struct Camera {
  viewProjection: mat4x4f,
  position: vec3f,
}

// The card is only ever rotated and translated, so the same rigid matrix
// transforms normals and tangents (the translation drops out against a w of 0).
struct Model {
  matrix: mat4x4f,
}

// How much of its own shading the solid card keeps. `fx=splat` drops it to
// `CARD_SOLID_MIX` so the point cloud drawn over it carries the look; every
// other mode leaves it at 1.
struct Style {
  solidMix: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> material: Material;
@group(0) @binding(3) var frontDesign: texture_2d<f32>;
@group(0) @binding(4) var backDesign: texture_2d<f32>;
@group(0) @binding(5) var designSampler: sampler;
@group(0) @binding(6) var<uniform> pointer: Pointer;
@group(0) @binding(7) var<uniform> style: Style;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  // `either` is required by WebGPU compatibility mode, which rejects the
  // default `first` sampling for flat vertex outputs.
  @location(3) @interpolate(flat, either) face: u32,
  @location(4) tangent: vec3f,
}

// Attachment 0 is the picture, attachment 1 the outline's geometry buffer.
struct CardOut {
  @location(0) color: vec4f,
  @location(1) normalMask: vec4f,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) tangent: vec3f,
  @location(3) uv: vec2f,
  @location(4) face: f32,
) -> VertexOut {
  let world = model.matrix * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = camera.viewProjection * world;
  out.worldPosition = world.xyz;
  out.normal = normalize((model.matrix * vec4f(normal, 0.0)).xyz);
  out.tangent = normalize((model.matrix * vec4f(tangent, 0.0)).xyz);
  out.uv = uv;
  out.face = u32(face + 0.5);
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> CardOut {
  // The etch mask is read at the centre and one step to each side so its
  // gradient can drive the bevel. Every sample sits outside any branch so the
  // mip derivatives stay uniform across the quad.
  let texel = 1.0 / vec2f(textureDimensions(frontDesign, 0));
  let footprint = max(abs(dpdx(input.uv)), abs(dpdy(input.uv)));
  // A bevel one screen pixel wide, but never finer than the texture itself.
  // `tap`, not `step`, because `step` is a WGSL builtin.
  let tap = max(texel * 1.5, footprint);

  let front = textureSample(frontDesign, designSampler, input.uv);
  let frontL = textureSample(frontDesign, designSampler, input.uv - vec2f(tap.x, 0.0));
  let frontR = textureSample(frontDesign, designSampler, input.uv + vec2f(tap.x, 0.0));
  let frontUp = textureSample(frontDesign, designSampler, input.uv - vec2f(0.0, tap.y));
  let frontDown = textureSample(frontDesign, designSampler, input.uv + vec2f(0.0, tap.y));
  let back = textureSample(backDesign, designSampler, input.uv);
  let backL = textureSample(backDesign, designSampler, input.uv - vec2f(tap.x, 0.0));
  let backR = textureSample(backDesign, designSampler, input.uv + vec2f(tap.x, 0.0));
  let backUp = textureSample(backDesign, designSampler, input.uv - vec2f(0.0, tap.y));
  let backDown = textureSample(backDesign, designSampler, input.uv + vec2f(0.0, tap.y));

  var design = vec4f(0.0, 0.0, 0.0, 0.0);
  var maskGradient = vec2f(0.0, 0.0);
  var stockColor = material.baseColor;
  var stockRoughness = material.roughness;
  var stockMetallic = material.metallic;
  var anisotropy = material.anisotropy;

  if (input.face == FACE_FRONT) {
    design = front;
    maskGradient = vec2f(frontR.a - frontL.a, frontDown.a - frontUp.a) * 0.5;
  } else if (input.face == FACE_BACK) {
    design = back;
    maskGradient = vec2f(backR.a - backL.a, backDown.a - backUp.a) * 0.5;
  } else {
    // Milled rim: its own metal, brushed around the perimeter rather than
    // along the card.
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

  // UV spot varnish: only the printed marks get the extra coat. Unused by the
  // etched presets, where the mask means a cut rather than a coating.
  let spot = coverage * material.spotGloss;
  surface.roughness = mix(surface.roughness, 0.07, spot * 0.9);
  surface.clearcoat = max(surface.clearcoat, spot);
  surface.clearcoatRoughness = mix(surface.clearcoatRoughness, 0.04, spot);

  let geometricNormal = normalize(input.normal);
  // The texture's v axis runs down the card, so the texture-space bitangent is
  // the negated geometric one.
  let tangent = normalize(input.tangent - geometricNormal * dot(geometricNormal, input.tangent));
  let bitangent = -normalize(cross(geometricNormal, tangent));

  let grain = material.grain * (1.0 - spot * 0.8);
  var normal = grainNormal(geometricNormal, tangent, bitangent, input.uv, grain);
  normal = sparkleNormal(
    normal, tangent, bitangent, input.uv,
    max(footprint.x, footprint.y),
    material.sparkle * (1.0 - coverage),
  );

  // Laser recess: the coating is cut away, so the mask edge is a short wall
  // down to the etch floor. The wall is faked from the mask gradient, scaled by
  // the physical depth, and the floor picks up a little occlusion.
  if (material.etch > 0.0) {
    // The cut is only 0.03 mm deep, so this is a hairline wall, not a chamfer:
    // pushed any harder the marks read as embossed chrome instead of a burn.
    // The wall belongs to the cut, so it is weighted towards the inside.
    let slope =
      material.bevel * material.etch *
      clamp(material.etchDepth * 40.0, 0.0, 2.0) *
      (0.3 + 0.7 * coverage);
    normal = normalize(
      normal + (tangent * maskGradient.x + bitangent * maskGradient.y) * slope * 1.1
    );
  }
  let etchAo = 1.0 - material.etchAo * material.etch * coverage;

  let shaded = shadeSurface(
    surface, normal, geometricNormal, tangent, bitangent,
    input.worldPosition, camera.position, pointer,
    coverage, etchAo, material.exposure,
  );

  // `fx=splat` sends the solid card backwards: desaturated and dimmed, so the
  // point cloud over it reads as the card rather than as a texture on one.
  let luma = dot(shaded, vec3f(0.2126, 0.7152, 0.0722));
  let receded = mix(vec3f(luma), shaded, 0.4) * 0.8;
  let body = mix(receded, shaded, clamp(style.solidMix, 0.0, 1.0));

  var out: CardOut;
  // Premultiplied, with the coverage in alpha: the composite lays this over the
  // page background and an MSAA resolve of it stays correct.
  out.color = vec4f(body, 1.0);
  // Packed into the unit range because compatibility mode refuses to
  // multisample a float format, and 8 bits of normal is about half a degree,
  // which is nothing against a crease the line is looking for.
  out.normalMask = vec4f(geometricNormal * 0.5 + vec3f(0.5), 1.0);
  return out;
}
