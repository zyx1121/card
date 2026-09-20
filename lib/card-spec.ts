/**
 * Physical specification of the card.
 *
 * Scene units are millimetres, so every number below is the real dimension of
 * a Taiwan standard business card printed on ~300 gsm stock.
 */

/** Card width in millimetres. */
export const CARD_WIDTH = 90;

/** Card height in millimetres. */
export const CARD_HEIGHT = 54;

/** Card thickness in millimetres (~300 gsm uncoated stock). */
export const CARD_THICKNESS = 0.35;

/** Die-cut corner radius in millimetres. */
export const CARD_CORNER_RADIUS = 2;

/** Tessellation of a single rounded corner arc. */
export const CARD_CORNER_SEGMENTS = 8;

/** Aspect ratio of the printed face, 5:3. */
export const CARD_ASPECT = CARD_WIDTH / CARD_HEIGHT;

/** Face identifiers handed to the shader through the `face` vertex attribute. */
export const CARD_FACE = {
  front: 0,
  back: 1,
  edge: 2,
} as const;

/** Design texture resolution, about 22.7 px/mm. */
export const TEXTURE_WIDTH = 2048;

/** Design texture height, matching {@link CARD_ASPECT}. */
export const TEXTURE_HEIGHT = 1229;

/** Pixels per millimetre of the design texture. */
export const TEXTURE_PX_PER_MM = TEXTURE_WIDTH / CARD_WIDTH;
