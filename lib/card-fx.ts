/**
 * The illustrated pass: a constant-width outline, and the grain under `?fx=`.
 *
 * The outline is always on. The grain has two variants so they can be compared
 * side by side: `stipple` prints the shaded card as halftone dots in the
 * composite, and `splat` rebuilds the card as a cloud of gaussian splats.
 */

export type CardFx = "none" | "stipple" | "splat";

export const FX_NAMES: readonly CardFx[] = ["none", "stipple", "splat"];

export const DEFAULT_FX: CardFx = "stipple";

/** The `mode` value `present.wgsl` branches on. Keep both lists in step. */
const FX_MODE: Record<CardFx, number> = { none: 0, stipple: 1, splat: 2 };

export function fxMode(fx: CardFx): number {
  return FX_MODE[fx];
}

/** Reads the `?fx=` search param, falling back to {@link DEFAULT_FX}. */
export function resolveFx(value: string | string[] | undefined): CardFx {
  const name = Array.isArray(value) ? value[0] : value;
  return FX_NAMES.includes(name as CardFx) ? (name as CardFx) : DEFAULT_FX;
}

/**
 * Outline thickness in CSS pixels.
 *
 * The composite multiplies it by the device pixel ratio, so the line is the
 * same apparent weight on a 1x display and a 2x one, and because it is dilated
 * in screen space it does not thin out as the card turns edge-on.
 */
export const OUTLINE_PX = 3;

/**
 * Default outline colour, sRGB 0..1. White: the page background is black, so
 * a black line would vanish into it. `?outline=<hex>` overrides it.
 */
export const OUTLINE_COLOR: readonly [number, number, number] = [1, 1, 1];

/** Parses `rgb` / `rrggbb` (optional leading `#`) into sRGB 0..1. */
export function parseHexColor(
  value: string | undefined
): [number, number, number] | undefined {
  if (!value) return undefined;
  const hex = value.replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return undefined;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Reads `?outline=<hex>`, falling back to {@link OUTLINE_COLOR}. */
export function resolveOutline(
  value: string | string[] | undefined
): [number, number, number] {
  const raw = Array.isArray(value) ? value[0] : value;
  return parseHexColor(raw) ?? [...OUTLINE_COLOR];
}

/** Reads `?bg=<hex>` as a CSS colour string, or undefined to keep the theme. */
export function resolveBackground(
  value: string | string[] | undefined
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = parseHexColor(raw);
  if (!parsed) return undefined;
  const hex = parsed
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
  return `#${hex}`;
}

/**
 * How much of its own shading the solid card keeps.
 *
 * `splat` sends it backwards so the point cloud over it carries the look;
 * everything else leaves the card alone.
 */
export function solidMix(fx: CardFx): number {
  return fx === "splat" ? 0.45 : 1;
}

/** Splats in the browser. The render script can ask for fewer with `--splats`. */
export const SPLAT_COUNT = 30_000;

/** Splat diameter in millimetres, before the per-splat scale and the twinkle. */
export const SPLAT_SIZE = 1.1;

/**
 * How far a splat is pulled towards the camera, in millimetres.
 *
 * A camera-facing quad centred on the surface is half buried in it, and the
 * card is only 0.76 mm thick, so the lift has to stay well under half that or
 * the back of the card would start to show through the front.
 */
export const SPLAT_LIFT = 0.12;

/** Frames between one splat twinkle and the next, and one stipple jitter. */
export const FX_TICK_FRAMES = 6;
