// The card's material model, shared by the solid pass and the splat pass.
//
// A WGSL module cannot declare `@group`/`@binding` resources, so this file
// holds only the data shapes and the maths; `card.wgsl` and `splat.wgsl` own
// the bindings and hand the values in. That is what lets a splat be lit by
// exactly the same lobe as the surface it was sampled from.
//
// Lighting is a GGX specular lobe with a Burley diffuse term, three softbox
// lights and a procedural studio environment sampled for reflections. The
// coating is sandblasted and micro-brushed along the card's long axis, so the
// specular lobe is anisotropic and the environment lookup is stretched along
// the tangent to match.

import { fbmPerlin2d } from "@vgpu/wgsl-std/noise/perlin";

export const PI: f32 = 3.14159265359;

/// Falloff scale of the cursor light, in millimetres.
const POINTER_RADIUS: f32 = 60.0;

/// Warm-neutral white, a touch below daylight so the pool reads as a lamp.
const POINTER_COLOR: vec3f = vec3f(1.0, 0.94, 0.86);

/// Peak radiance of the cursor light at `intensity` 1, before falloff.
const POINTER_GAIN: f32 = 42.0;

/// How much of the cursor light the etch floor loses. The lamp is near-field
/// and nearly head-on, so the recess walls cut it far harder than they cut the
/// distant softboxes; without that the marks wash out under the pool.
const POINTER_ETCH_SHADE: f32 = 0.8;

export struct Material {
  baseColor: vec3f,
  roughness: f32,
  inkColor: vec3f,
  metallic: f32,
  edgeColor: vec3f,
  edgeMetallic: f32,
  inkRoughness: f32,
  inkMetallic: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
  sheen: f32,
  spotGloss: f32,
  grain: f32,
  exposure: f32,
  anisotropy: f32,
  sparkle: f32,
  etch: f32,
  etchDepth: f32,
  bevel: f32,
  etchAo: f32,
  edgeRoughness: f32,
}

// The cursor light. `position` is in scene millimetres; `intensity` is eased on
// the CPU and is 0 whenever no pointer is over the canvas.
export struct Pointer {
  position: vec3f,
  intensity: f32,
}

export struct Surface {
  albedo: vec3f,
  roughness: f32,
  metallic: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
  sheen: f32,
  anisotropy: f32,
}

export fn srgbToLinear(color: vec3f) -> vec3f {
  let low = color / 12.92;
  let high = pow((color + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(low, high, color > vec3f(0.04045));
}

export fn linearToSrgb(color: vec3f) -> vec3f {
  let clamped = clamp(color, vec3f(0.0), vec3f(1.0));
  let low = clamped * 12.92;
  let high = 1.055 * pow(clamped, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(low, high, clamped > vec3f(0.0031308));
}

// Narkowicz ACES filmic approximation.
export fn tonemap(color: vec3f) -> vec3f {
  let x = max(color, vec3f(0.0));
  let a = x * (2.51 * x + vec3f(0.03));
  let b = x * (2.43 * x + vec3f(0.59)) + vec3f(0.14);
  return clamp(a / b, vec3f(0.0), vec3f(1.0));
}

fn distributionGgx(nDotH: f32, roughness: f32) -> f32 {
  let a = max(roughness * roughness, 1e-3);
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-6);
}

// Burley's anisotropic GGX, in the numerically stable form Filament uses.
// `at` and `ab` are the roughness along and across the brushing direction.
fn distributionGgxAniso(
  nDotH: f32,
  tDotH: f32,
  bDotH: f32,
  at: f32,
  ab: f32,
) -> f32 {
  let a2 = at * ab;
  let v = vec3f(ab * tDotH, at * bDotH, a2 * nDotH);
  let v2 = max(dot(v, v), 1e-8);
  let w2 = a2 / v2;
  return a2 * w2 * w2 / PI;
}

fn geometrySmith(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  let gv = nDotV / (nDotV * (1.0 - k) + k);
  let gl = nDotL / (nDotL * (1.0 - k) + k);
  return gv * gl;
}

// Height-correlated Smith visibility for the anisotropic lobe. This already
// carries the 1 / (4 nDotV nDotL) denominator.
fn visibilityGgxAniso(
  at: f32,
  ab: f32,
  tDotV: f32,
  bDotV: f32,
  tDotL: f32,
  bDotL: f32,
  nDotV: f32,
  nDotL: f32,
) -> f32 {
  let lambdaV = nDotL * length(vec3f(at * tDotV, ab * bDotV, nDotV));
  let lambdaL = nDotV * length(vec3f(at * tDotL, ab * bDotL, nDotL));
  return 0.5 / max(lambdaV + lambdaL, 1e-6);
}

export fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Burley (Disney) diffuse: keeps grazing angles on uncoated stock from going flat.
fn diffuseBurley(nDotV: f32, nDotL: f32, vDotH: f32, roughness: f32) -> f32 {
  let fd90 = 0.5 + 2.0 * vDotH * vDotH * roughness;
  let lightScatter = 1.0 + (fd90 - 1.0) * pow(1.0 - nDotL, 5.0);
  let viewScatter = 1.0 + (fd90 - 1.0) * pow(1.0 - nDotV, 5.0);
  return lightScatter * viewScatter / PI;
}

// Retroreflective fibre sheen of uncoated paper and soft-touch laminate.
fn sheenTerm(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  let inverseAlpha = 1.0 / max(roughness * roughness, 1e-3);
  let rim = pow(1.0 - nDotV, 4.0) * pow(1.0 - nDotL, 1.5);
  return rim * inverseAlpha * 0.02;
}

// Karis' analytic split-sum environment BRDF.
fn envBrdfApprox(f0: vec3f, roughness: f32, nDotV: f32) -> vec3f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = vec4f(roughness, roughness, roughness, roughness) * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * nDotV)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + vec3f(ab.y);
}

// One rectangular softbox evaluated in a reflection direction.
fn softbox(
  direction: vec3f,
  center: vec3f,
  halfWidth: f32,
  halfHeight: f32,
  roughness: f32,
) -> f32 {
  let facing = dot(direction, center);
  if (facing <= 0.02) {
    return 0.0;
  }
  let reference = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(center.y) > 0.95);
  let right = normalize(cross(reference, center));
  let top = cross(center, right);
  let projected = direction / facing;
  let u = abs(dot(projected, right));
  let v = abs(dot(projected, top));
  let blur = 0.02 + roughness * roughness * 1.1;
  // The falloff starts well inside the box, which is what a diffused softbox
  // looks like: a soft-cornered rectangle rather than a hard-edged plate.
  let mask =
    (1.0 - smoothstep(halfWidth * 0.25, halfWidth + blur, u)) *
    (1.0 - smoothstep(halfHeight * 0.25, halfHeight + blur, v));
  // Spreading the box over a wider solid angle has to dim its peak.
  let energy =
    (halfWidth * halfHeight) /
    ((halfWidth + blur * 0.5) * (halfHeight + blur * 0.5));
  return mask * energy;
}

// Procedural studio: vertical sky/floor gradient, a big key box upper-left, a
// broad fill on the right and a thin cool strip behind the card.
export fn studio(direction: vec3f, roughness: f32) -> vec3f {
  let y = clamp(direction.y, -1.0, 1.0);
  let sky = mix(
    vec3f(0.28, 0.29, 0.31),
    vec3f(0.68, 0.70, 0.73),
    smoothstep(0.0, 0.9, y),
  );
  let ground = mix(
    vec3f(0.035, 0.035, 0.04),
    vec3f(0.2, 0.2, 0.21),
    smoothstep(-0.9, 0.0, y),
  );
  var color = select(ground, sky, y > 0.0);
  // Large soft key, high and to the left.
  color += softbox(direction, normalize(vec3f(-0.6, 0.75, 0.45)), 0.52, 0.18, roughness) *
    vec3f(6.4, 6.3, 6.0);
  // Broad fill on the right, almost level with the card.
  color += softbox(direction, normalize(vec3f(0.85, 0.12, 0.5)), 0.4, 0.3, roughness) *
    vec3f(2.4, 2.45, 2.55);
  // Thin cool strip behind and to the right, which is what makes the milled rim
  // read as a bright line.
  color += softbox(direction, normalize(vec3f(0.7, 0.3, -0.7)), 0.3, 0.06, roughness) *
    vec3f(3.3, 3.45, 3.9);
  // Low front bounce, slightly left: the box a coated surface actually reflects
  // back at a three-quarter viewing angle.
  color += softbox(direction, normalize(vec3f(-0.38, -0.22, 0.9)), 0.12, 0.08, roughness) *
    vec3f(9.0, 9.0, 9.2);
  return color;
}

/// Compresses the lookup along the brushing direction so every reflected
/// feature smears into a horizontal band, which is what a micro-brushed
/// surface does to a softbox.
fn stretchAlongTangent(direction: vec3f, tangent: vec3f, anisotropy: f32) -> vec3f {
  if (anisotropy <= 0.0) {
    return direction;
  }
  // The visible smear needs a stronger compression than the specular lobe's
  // own anisotropy, so the two are scaled apart.
  let along = dot(direction, tangent);
  return normalize(direction - tangent * along * clamp(anisotropy * 1.9, 0.0, 0.92));
}

fn environment(
  direction: vec3f,
  roughness: f32,
  tangent: vec3f,
  anisotropy: f32,
) -> vec3f {
  return studio(stretchAlongTangent(direction, tangent, anisotropy), roughness);
}

fn shadeLight(
  lightDirection: vec3f,
  radiance: vec3f,
  normal: vec3f,
  view: vec3f,
  clearcoatNormal: vec3f,
  tangent: vec3f,
  bitangent: vec3f,
  surface: Surface,
  f0: vec3f,
) -> vec3f {
  let l = normalize(lightDirection);
  let h = normalize(l + view);
  let nDotL = max(dot(normal, l), 0.0);
  if (nDotL <= 0.0) {
    return vec3f(0.0);
  }
  let nDotV = max(dot(normal, view), 1e-4);
  let nDotH = max(dot(normal, h), 0.0);
  let vDotH = max(dot(view, h), 0.0);

  let f = fresnelSchlick(vDotH, f0);

  var specular: vec3f;
  if (surface.anisotropy > 0.0) {
    // at along the brushing direction, ab across it.
    let a = max(surface.roughness * surface.roughness, 1e-3);
    let at = max(a * (1.0 + surface.anisotropy), 1e-4);
    let ab = max(a * (1.0 - surface.anisotropy), 1e-4);
    let d = distributionGgxAniso(nDotH, dot(tangent, h), dot(bitangent, h), at, ab);
    let v = visibilityGgxAniso(
      at, ab,
      dot(tangent, view), dot(bitangent, view),
      dot(tangent, l), dot(bitangent, l),
      nDotV, nDotL,
    );
    specular = d * v * f;
  } else {
    let d = distributionGgx(nDotH, surface.roughness);
    let g = geometrySmith(nDotV, nDotL, surface.roughness);
    specular = (d * g * f) / max(4.0 * nDotV * nDotL, 1e-4);
  }

  let kd = (vec3f(1.0) - f) * (1.0 - surface.metallic);
  let diffuse = kd * surface.albedo * diffuseBurley(nDotV, nDotL, vDotH, surface.roughness);

  let sheen = surface.albedo * surface.sheen * sheenTerm(nDotV, nDotL, surface.roughness);

  var color = (diffuse + specular + sheen) * radiance * nDotL;

  if (surface.clearcoat > 0.0) {
    let ccNDotL = max(dot(clearcoatNormal, l), 0.0);
    let ccNDotH = max(dot(clearcoatNormal, h), 0.0);
    let ccNDotV = max(dot(clearcoatNormal, view), 1e-4);
    let ccD = distributionGgx(ccNDotH, max(surface.clearcoatRoughness, 0.02));
    let ccG = geometrySmith(ccNDotV, ccNDotL, max(surface.clearcoatRoughness, 0.02));
    let ccF = fresnelSchlick(vDotH, vec3f(0.04)).x * surface.clearcoat;
    let ccSpecular = (ccD * ccG * ccF) / max(4.0 * ccNDotV * ccNDotL, 1e-4);
    color = color * (1.0 - ccF) + ccSpecular * radiance * ccNDotL;
  }

  return color;
}

// Paper fibre, or the coating's blasted texture: a faint height field turned
// into a normal perturbation.
export fn grainNormal(
  normal: vec3f,
  tangent: vec3f,
  bitangent: vec3f,
  uv: vec2f,
  strength: f32,
) -> vec3f {
  if (strength <= 0.0) {
    return normal;
  }
  // About 5.5 cells per millimetre across the 90 mm card.
  let scale = 500.0;
  let step = 1.0;
  let p = uv * scale;
  let h = fbmPerlin2d(p, 3, 2.17, 0.55);
  let hx = fbmPerlin2d(p + vec2f(step, 0.0), 3, 2.17, 0.55);
  let hy = fbmPerlin2d(p + vec2f(0.0, step), 3, 2.17, 0.55);
  let gradient = vec2f(hx - h, hy - h) * strength * 0.28;
  return normalize(normal + tangent * gradient.x + bitangent * gradient.y);
}

export fn hash21(p: vec2f) -> f32 {
  var h = fract(p * vec2f(443.8975, 397.2973));
  h += dot(h, h.yx + vec2f(19.19));
  return fract((h.x + h.y) * h.x);
}

// Sandblast glitter: individual pits catching the key light. It is deliberately
// near the resolution limit, so it is faded out once a screen pixel covers more
// than about one pit, otherwise it would only produce aliasing.
export fn sparkleNormal(
  normal: vec3f,
  tangent: vec3f,
  bitangent: vec3f,
  uv: vec2f,
  footprint: f32,
  strength: f32,
) -> vec3f {
  if (strength <= 0.0) {
    return normal;
  }
  let cells = 700.0;
  let fade = 1.0 - smoothstep(0.35, 1.1, footprint * cells);
  if (fade <= 0.0) {
    return normal;
  }
  let cell = floor(uv * cells);
  let dx = hash21(cell) - 0.5;
  let dy = hash21(cell + vec2f(7.31, 3.17)) - 0.5;
  let amount = strength * fade * 0.09;
  return normalize(normal + tangent * dx * amount + bitangent * dy * amount);
}

/// The whole lighting rig applied to one shaded point, returned in sRGB.
///
/// `coverage` is the etch mask under the point, which shades the cursor lamp;
/// `etchAo` is the occlusion at the etch floor. Both the solid card pass and
/// the splat pass call this, so a splat is lit exactly like the surface it was
/// sampled from.
export fn shadeSurface(
  surface: Surface,
  normal: vec3f,
  geometricNormal: vec3f,
  tangent: vec3f,
  bitangent: vec3f,
  worldPosition: vec3f,
  cameraPosition: vec3f,
  pointer: Pointer,
  coverage: f32,
  etchAo: f32,
  exposure: f32,
) -> vec3f {
  let view = normalize(cameraPosition - worldPosition);
  let f0 = mix(vec3f(0.04), surface.albedo, surface.metallic);

  // Key upper-left, broad fill on the right, thin cool rim from behind-right.
  var color = shadeLight(
    vec3f(-0.6, 0.75, 0.45), vec3f(3.1, 3.05, 2.95),
    normal, view, geometricNormal, tangent, bitangent, surface, f0,
  );
  color += shadeLight(
    vec3f(0.85, 0.12, 0.5), vec3f(0.95, 0.97, 1.02),
    normal, view, geometricNormal, tangent, bitangent, surface, f0,
  );
  color += shadeLight(
    vec3f(0.7, 0.3, -0.7), vec3f(1.3, 1.34, 1.48),
    normal, view, geometricNormal, tangent, bitangent, surface, f0,
  );

  // Cursor light: a soft lamp hanging between the camera and the card. The
  // falloff is squared so the pool has a readable centre instead of lifting the
  // whole face, and the whole term collapses to zero when no pointer is over
  // the canvas.
  if (pointer.intensity > 0.0) {
    let toPointer = pointer.position - worldPosition;
    let pointerDistance = max(length(toPointer), 1e-3);
    let ratio = pointerDistance / POINTER_RADIUS;
    let falloff = 1.0 / (1.0 + ratio * ratio);
    color += shadeLight(
      toPointer,
      POINTER_COLOR * POINTER_GAIN * pointer.intensity * falloff * falloff *
        (1.0 - coverage * POINTER_ETCH_SHADE),
      normal, view, geometricNormal, tangent, bitangent, surface, f0,
    );
  }

  // Image based lighting from the procedural studio.
  let nDotV = max(dot(normal, view), 1e-4);
  let reflectionDirection = reflect(-view, normal);
  let irradiance = studio(normal, 1.0);
  let kd = (vec3f(1.0) - fresnelSchlick(nDotV, f0)) * (1.0 - surface.metallic);
  color += kd * surface.albedo * irradiance * 0.32 * etchAo;
  color += environment(reflectionDirection, surface.roughness, tangent, surface.anisotropy) *
    envBrdfApprox(f0, surface.roughness, nDotV) * etchAo;

  if (surface.clearcoat > 0.0) {
    let ccReflection = reflect(-view, geometricNormal);
    let ccFresnel = fresnelSchlick(nDotV, vec3f(0.04)).x * surface.clearcoat;
    color = color * (1.0 - ccFresnel);
    color += studio(ccReflection, max(surface.clearcoatRoughness, 0.02)) * ccFresnel;
  }

  return linearToSrgb(tonemap(color * exposure));
}
