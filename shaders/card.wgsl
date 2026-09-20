// Photorealistic business card.
//
// One shader covers all three faces: the front and back sample their design
// texture (alpha = ink coverage = UV spot varnish mask) while the cut edge gets
// a darker, rougher paper-fibre treatment. Lighting is GGX specular with a
// Burley diffuse term, three softbox lights, and a procedural studio
// environment sampled for reflections.

import { fbmPerlin2d } from "@vgpu/wgsl-std/noise/perlin";

const PI: f32 = 3.14159265359;

const FACE_FRONT: u32 = 0u;
const FACE_BACK: u32 = 1u;

struct Camera {
  viewProjection: mat4x4f,
  position: vec3f,
}

// The card is only ever rotated and translated, so the same rigid matrix
// transforms normals (the translation drops out against a w of 0).
struct Model {
  matrix: mat4x4f,
}

struct Material {
  baseColor: vec3f,
  roughness: f32,
  inkColor: vec3f,
  metallic: f32,
  inkRoughness: f32,
  inkMetallic: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
  sheen: f32,
  spotGloss: f32,
  grain: f32,
  exposure: f32,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> material: Material;
@group(0) @binding(3) var frontDesign: texture_2d<f32>;
@group(0) @binding(4) var backDesign: texture_2d<f32>;
@group(0) @binding(5) var designSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  // `either` is required by WebGPU compatibility mode, which rejects the
  // default `first` sampling for flat vertex outputs.
  @location(3) @interpolate(flat, either) face: u32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) face: f32,
) -> VertexOut {
  let world = model.matrix * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = camera.viewProjection * world;
  out.worldPosition = world.xyz;
  out.normal = normalize((model.matrix * vec4f(normal, 0.0)).xyz);
  out.uv = uv;
  out.face = u32(face + 0.5);
  return out;
}

fn srgbToLinear(color: vec3f) -> vec3f {
  let low = color / 12.92;
  let high = pow((color + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(low, high, color > vec3f(0.04045));
}

fn linearToSrgb(color: vec3f) -> vec3f {
  let clamped = clamp(color, vec3f(0.0), vec3f(1.0));
  let low = clamped * 12.92;
  let high = 1.055 * pow(clamped, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(low, high, clamped > vec3f(0.0031308));
}

// Narkowicz ACES filmic approximation.
fn tonemap(color: vec3f) -> vec3f {
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

fn geometrySmith(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  let gv = nDotV / (nDotV * (1.0 - k) + k);
  let gl = nDotL / (nDotL * (1.0 - k) + k);
  return gv * gl;
}

fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
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

// Procedural studio: vertical sky/floor gradient plus two bright softboxes.
fn environment(direction: vec3f, roughness: f32) -> vec3f {
  let y = clamp(direction.y, -1.0, 1.0);
  let sky = mix(
    vec3f(0.26, 0.28, 0.32),
    vec3f(0.64, 0.68, 0.74),
    smoothstep(0.0, 0.9, y),
  );
  let ground = mix(
    vec3f(0.035, 0.035, 0.04),
    vec3f(0.2, 0.2, 0.21),
    smoothstep(-0.9, 0.0, y),
  );
  var color = select(ground, sky, y > 0.0);
  color += softbox(direction, normalize(vec3f(-0.55, 0.8, 0.5)), 0.34, 0.2, roughness) *
    vec3f(6.4, 6.3, 6.0);
  color += softbox(direction, normalize(vec3f(0.75, 0.3, -0.6)), 0.24, 0.14, roughness) *
    vec3f(2.6, 2.9, 3.6);
  // Large front bounce, low and slightly left: this is the box a coated or
  // varnished surface actually reflects back at a three-quarter viewing angle.
  color += softbox(direction, normalize(vec3f(-0.38, -0.22, 0.9)), 0.11, 0.075, roughness) *
    vec3f(11.0, 11.0, 11.2);
  return color;
}

struct Surface {
  albedo: vec3f,
  roughness: f32,
  metallic: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
  sheen: f32,
}

fn shadeLight(
  lightDirection: vec3f,
  radiance: vec3f,
  normal: vec3f,
  view: vec3f,
  clearcoatNormal: vec3f,
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

  let d = distributionGgx(nDotH, surface.roughness);
  let g = geometrySmith(nDotV, nDotL, surface.roughness);
  let f = fresnelSchlick(vDotH, f0);
  let specular = (d * g * f) / max(4.0 * nDotV * nDotL, 1e-4);

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

// Paper fibre: a faint height field turned into a normal perturbation.
fn grainNormal(normal: vec3f, tangent: vec3f, uv: vec2f, strength: f32) -> vec3f {
  if (strength <= 0.0) {
    return normal;
  }
  // About 5.5 fibre cells per millimetre across the 90 mm card.
  let scale = 500.0;
  let step = 1.0;
  let p = uv * scale;
  let h = fbmPerlin2d(p, 3, 2.17, 0.55);
  let hx = fbmPerlin2d(p + vec2f(step, 0.0), 3, 2.17, 0.55);
  let hy = fbmPerlin2d(p + vec2f(0.0, step), 3, 2.17, 0.55);
  let bitangent = normalize(cross(normal, tangent));
  let gradient = vec2f(hx - h, hy - h) * strength * 0.28;
  return normalize(normal + tangent * gradient.x + bitangent * gradient.y);
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  // Sampled outside any branch so the mip derivatives stay uniform.
  let front = textureSample(frontDesign, designSampler, input.uv);
  let back = textureSample(backDesign, designSampler, input.uv);

  var design = vec4f(0.0, 0.0, 0.0, 0.0);
  var tangent = vec3f(1.0, 0.0, 0.0);
  var stockColor = material.baseColor;
  var stockRoughness = material.roughness;

  if (input.face == FACE_FRONT) {
    design = front;
  } else if (input.face == FACE_BACK) {
    design = back;
    tangent = vec3f(-1.0, 0.0, 0.0);
  } else {
    // Cut edge: exposed fibre, darker and much rougher than the printed faces.
    stockColor = material.baseColor * 0.72;
    stockRoughness = clamp(material.roughness * 1.15 + 0.12, 0.0, 1.0);
    tangent = normalize(vec3f(0.0, 0.0, 1.0));
  }

  let coverage = clamp(design.a, 0.0, 1.0);
  let inkTint = select(vec3f(1.0), srgbToLinear(design.rgb), coverage > 0.001);

  var surface: Surface;
  surface.albedo = mix(stockColor, material.inkColor * inkTint, coverage);
  surface.roughness = clamp(mix(stockRoughness, material.inkRoughness, coverage), 0.03, 1.0);
  surface.metallic = mix(material.metallic, material.inkMetallic, coverage);
  surface.clearcoat = material.clearcoat;
  surface.clearcoatRoughness = material.clearcoatRoughness;
  surface.sheen = material.sheen * (1.0 - coverage * 0.6);

  // UV spot varnish: only the printed marks get the extra coat.
  let spot = coverage * material.spotGloss;
  surface.roughness = mix(surface.roughness, 0.07, spot * 0.9);
  surface.clearcoat = max(surface.clearcoat, spot);
  surface.clearcoatRoughness = mix(surface.clearcoatRoughness, 0.04, spot);

  let geometricNormal = normalize(input.normal);
  let grain = material.grain * (1.0 - spot * 0.8);
  let normal = grainNormal(geometricNormal, tangent, input.uv, grain);
  let view = normalize(camera.position - input.worldPosition);
  let f0 = mix(vec3f(0.04), surface.albedo, surface.metallic);

  // Key top-left, rim back-right, soft fill from the front-bottom.
  var color = shadeLight(
    vec3f(-0.55, 0.8, 0.5), vec3f(3.1, 3.05, 2.95),
    normal, view, geometricNormal, surface, f0,
  );
  color += shadeLight(
    vec3f(0.75, 0.3, -0.6), vec3f(1.15, 1.25, 1.6),
    normal, view, geometricNormal, surface, f0,
  );
  color += shadeLight(
    vec3f(0.1, -0.35, 0.95), vec3f(0.5, 0.5, 0.55),
    normal, view, geometricNormal, surface, f0,
  );

  // Image based lighting from the procedural studio.
  let nDotV = max(dot(normal, view), 1e-4);
  let reflection = reflect(-view, normal);
  let irradiance = environment(normal, 1.0);
  let kd = (vec3f(1.0) - fresnelSchlick(nDotV, f0)) * (1.0 - surface.metallic);
  color += kd * surface.albedo * irradiance * 0.32;
  color += environment(reflection, surface.roughness) *
    envBrdfApprox(f0, surface.roughness, nDotV);

  if (surface.clearcoat > 0.0) {
    let ccReflection = reflect(-view, geometricNormal);
    let ccFresnel = fresnelSchlick(nDotV, vec3f(0.04)).x * surface.clearcoat;
    color = color * (1.0 - ccFresnel);
    color += environment(ccReflection, max(surface.clearcoatRoughness, 0.02)) * ccFresnel;
  }

  return vec4f(linearToSrgb(tonemap(color * material.exposure)), 1.0);
}
