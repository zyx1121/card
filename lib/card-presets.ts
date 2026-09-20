/**
 * Material presets. Pick one with the `?preset=` search param.
 */

export type PresetName = "paper" | "soft-touch" | "gloss";

export const PRESET_NAMES: readonly PresetName[] = [
  "paper",
  "soft-touch",
  "gloss",
];

export const DEFAULT_PRESET: PresetName = "paper";

export interface CardMaterial {
  /** Stock albedo, linear RGB. */
  readonly baseColor: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  /** Retroreflective fibre sheen of the stock. */
  readonly sheen: number;
  /** Printed ink albedo, linear RGB. */
  readonly inkColor: readonly [number, number, number];
  readonly inkRoughness: number;
  readonly inkMetallic: number;
  /** Strength of the UV spot varnish applied over the ink. */
  readonly spotGloss: number;
  /** Paper fibre normal perturbation. */
  readonly grain: number;
  readonly exposure: number;
}

const PRESETS: Record<PresetName, CardMaterial> = {
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
