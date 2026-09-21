/**
 * Material presets. Pick one with the `?preset=` search param.
 *
 * `titanium` is the card as designed: a sandblasted white ceramic coating over
 * titanium, with every mark laser-etched down to bare metal. The other three
 * are the printed-stock studies that came before it and are kept reachable for
 * comparison.
 */

export type PresetName = "titanium" | "paper" | "soft-touch" | "gloss";

export const PRESET_NAMES: readonly PresetName[] = [
  "titanium",
  "paper",
  "soft-touch",
  "gloss",
];

export const DEFAULT_PRESET: PresetName = "titanium";

export interface CardMaterial {
  /** Body albedo, linear RGB. */
  readonly baseColor: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  /** Retroreflective fibre sheen of a printed stock. */
  readonly sheen: number;
  /** Mark albedo, linear RGB: printed ink, or bare metal under an etch. */
  readonly inkColor: readonly [number, number, number];
  readonly inkRoughness: number;
  readonly inkMetallic: number;
  /** Strength of a UV spot varnish over the marks, for the printed presets. */
  readonly spotGloss: number;
  /** Surface grain: paper fibre, or the coating's sandblast texture. */
  readonly grain: number;
  readonly exposure: number;
  /** Brushing anisotropy along the card's long axis, 0 for an isotropic lobe. */
  readonly anisotropy: number;
  /** High-frequency glitter from the sandblast. */
  readonly sparkle: number;
  /** How much the mark mask reads as a laser etch rather than printed ink. */
  readonly etch: number;
  /** Depth of the etch in millimetres, used to scale the edge bevel. */
  readonly etchDepth: number;
  /** Strength of the bevel rolled into the mask edge. */
  readonly bevel: number;
  /** Ambient occlusion at the etch floor. */
  readonly etchAo: number;
  /** Rim albedo, linear RGB. */
  readonly edgeColor: readonly [number, number, number];
  readonly edgeMetallic: number;
  readonly edgeRoughness: number;
}

const PRESETS: Record<PresetName, CardMaterial> = {
  titanium: {
    // A fine warm-white ceramic coating, not paper white.
    baseColor: [0.9, 0.89, 0.87],
    roughness: 0.6,
    // Coated metal: mostly a dielectric response, with a metallic grey tint in
    // the Fresnel that stops the white reading as plastic.
    metallic: 0.6,
    clearcoat: 0,
    clearcoatRoughness: 0.3,
    sheen: 0,
    // Bare titanium exposed by the laser.
    inkColor: [0.32, 0.33, 0.35],
    inkRoughness: 0.45,
    inkMetallic: 1,
    spotGloss: 0,
    grain: 0.22,
    exposure: 1.46,
    anisotropy: 0.4,
    sparkle: 0.4,
    etch: 1,
    etchDepth: 0.03,
    bevel: 1,
    etchAo: 0.22,
    // The milled rim keeps its polish, so it catches the rim light.
    edgeColor: [0.6, 0.61, 0.63],
    edgeMetallic: 1,
    edgeRoughness: 0.35,
  },
  paper: {
    baseColor: [0.93, 0.91, 0.87],
    roughness: 0.85,
    metallic: 0,
    clearcoat: 0,
    clearcoatRoughness: 0.3,
    sheen: 0.3,
    inkColor: [0.035, 0.035, 0.04],
    inkRoughness: 0.78,
    inkMetallic: 0,
    spotGloss: 0,
    grain: 1,
    exposure: 0.95,
    anisotropy: 0,
    sparkle: 0,
    etch: 0,
    etchDepth: 0,
    bevel: 0,
    etchAo: 0,
    edgeColor: [0.6696, 0.6552, 0.6264],
    edgeMetallic: 0,
    edgeRoughness: 1,
  },
  "soft-touch": {
    baseColor: [0.022, 0.022, 0.026],
    roughness: 0.6,
    metallic: 0,
    clearcoat: 0,
    clearcoatRoughness: 0.4,
    sheen: 0.5,
    inkColor: [0.83, 0.68, 0.36],
    inkRoughness: 0.3,
    inkMetallic: 1,
    spotGloss: 1,
    grain: 0.45,
    exposure: 1.1,
    anisotropy: 0,
    sparkle: 0,
    etch: 0,
    etchDepth: 0,
    bevel: 0,
    etchAo: 0,
    edgeColor: [0.01584, 0.01584, 0.01872],
    edgeMetallic: 0,
    edgeRoughness: 0.81,
  },
  gloss: {
    baseColor: [0.95, 0.95, 0.95],
    roughness: 0.35,
    metallic: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    sheen: 0.05,
    inkColor: [0.045, 0.045, 0.05],
    inkRoughness: 0.18,
    inkMetallic: 0,
    spotGloss: 1,
    grain: 0.25,
    exposure: 0.78,
    anisotropy: 0,
    sparkle: 0,
    etch: 0,
    etchDepth: 0,
    bevel: 0,
    etchAo: 0,
    edgeColor: [0.684, 0.684, 0.684],
    edgeMetallic: 0,
    edgeRoughness: 0.5225,
  },
};

export function isPresetName(value: unknown): value is PresetName {
  return (
    typeof value === "string" && PRESET_NAMES.includes(value as PresetName)
  );
}

export function resolvePreset(value: unknown): PresetName {
  return isPresetName(value) ? value : DEFAULT_PRESET;
}

export function cardMaterial(preset: PresetName): CardMaterial {
  return PRESETS[preset];
}
