// White titanium card with embossed marks, the solid pass.
//
// One shader covers all three faces. The front and back sample their design
// texture, whose alpha is the mark mask: 1 where the white ceramic coating
// gives way to bare titanium, 0 where the coating is intact. `reliefDepth`
// says which way that mark stands: negative is a laser cut into the coating,
// positive is a raised relief proud of it.
// The milled rim is shaded from its own albedo, metalness and roughness. The
// material model itself lives in `pbr.wgsl`.
//
// A fourth light follows the cursor: a soft point light on a plane between the
// camera and the card. It is off (`pointer.intensity` 0) unless the page or the
// render script supplies a pointer.
//
// The pass writes premultiplied shaded colour, so its alpha is the card's
// coverage and an MSAA resolve of a half covered pixel stays linear.

import {
  Material,
  Pointer,
  Surface,
  grainNormal,
  shadeSurface,
  sparkle,
  srgbToLinear,
} from "./pbr.wgsl";

const FACE_FRONT: u32 = 0u;
const FACE_BACK: u32 = 1u;

// How much extra ambient a raised mark's top face collects. A relief stands
// above the coating instead of hiding in it, so it gathers a little more of the
// room than the surface around it rather than less.
const RELIEF_LIFT: f32 = 0.12;

struct Camera {
  viewProjection: mat4x4f,
  position: vec3f,
}

// The card is only ever rotated and translated, so the same rigid matrix
// transforms normals and tangents (the translation drops out against a w of 0).
struct Model {
  matrix: mat4x4f,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> material: Material;
@group(0) @binding(3) var frontDesign: texture_2d<f32>;
@group(0) @binding(4) var backDesign: texture_2d<f32>;
@group(0) @binding(5) var designSampler: sampler;
@group(0) @binding(6) var<uniform> pointer: Pointer;

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
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  // The mark mask is read at the centre and one step to each side so its
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
  // relief presets, where the mask means bare metal rather than a coating.
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
  let grit = sparkle(
    normal, tangent, bitangent, input.uv,
    max(footprint.x, footprint.y),
    material.sparkle * (1.0 - coverage),
  );
  normal = grit.normal;
  surface.roughness = clamp(surface.roughness + grit.roughness, 0.03, 1.0);

  // Relief: the mask edge is a short wall, faked from the mask gradient and
  // scaled by the physical depth. Which way that wall faces is the sign of
  // `reliefDepth`: into the surface for a laser cut, out of it for a raised
  // mark. Either is a fraction of a tenth of a millimetre, so it is a lip and
  // not a chamfer; pushed harder the marks read as machined chrome.
  let raised = step(0.0, material.reliefDepth);
  var foot = 0.0;
  if (material.relief > 0.0) {
    // A cut carries its wall on the inside, where the floor is; a relief
    // carries it on the outside, at the foot where it meets the coating.
    let wall = mix(0.3 + 0.7 * coverage, 1.0 - 0.7 * coverage, raised);
    let slope =
      material.bevel * material.relief *
      clamp(abs(material.reliefDepth) * 40.0, 0.0, 2.0) * wall;
    // The mask gradient points into the mark, which is down the wall of a cut
    // and up the wall of a relief.
    let facing = mix(1.0, -1.0, raised);
    normal = normalize(
      normal +
        (tangent * maskGradient.x + bitangent * maskGradient.y) *
        slope * facing * 1.1
    );
    // The contact shadow of a raised mark, gathered in the crook just outside
    // its foot. The gradient is the only thing that knows where that is.
    foot = clamp(length(maskGradient) * 3.0, 0.0, 1.0) * (1.0 - coverage);
  }
  // A cut loses ambient on its floor; a relief loses it at its foot and gains a
  // little on the top face it holds up to the room.
  let occlusion =
    1.0 -
    material.reliefAo * material.relief * mix(coverage, foot, raised) +
    RELIEF_LIFT * material.relief * raised * coverage;

  let shaded = shadeSurface(
    surface, normal, geometricNormal, tangent, bitangent,
    input.worldPosition, camera.position, pointer,
    coverage, occlusion, material.exposure,
  );

  // Premultiplied, with the coverage in alpha: the composite lays this over the
  // page background and an MSAA resolve of it stays correct.
  return vec4f(shaded, 1.0);
}
