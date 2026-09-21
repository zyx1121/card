/**
 * Physical specification of the card.
 *
 * Scene units are millimetres, so every number below is a real dimension.
 */

/**
 * The card blank, in millimetres.
 *
 * The outline is Loki's business-card format, 90 x 54 mm, but the corner radius
 * and the gauge are ISO/IEC 7810 ID-1, which is what gives the Apple Card its
 * silhouette and its heft. Switching to a true ID-1 blank is a one-line change:
 * set `width: 85.6` and `height: 53.98`.
 */
export const CARD_DIMENSIONS = {
  /** Card width. */
  width: 90,
  /** Card height. */
  height: 54,
  /** Card thickness. ID-1 gauge, which is what a metal card is milled to. */
  thickness: 0.76,
  /** Corner radius. ID-1 radius. */
  cornerRadius: 3.18,
} as const;

/** Card width in millimetres. */
export const CARD_WIDTH = CARD_DIMENSIONS.width;

/** Card height in millimetres. */
export const CARD_HEIGHT = CARD_DIMENSIONS.height;

/** Card thickness in millimetres. */
export const CARD_THICKNESS = CARD_DIMENSIONS.thickness;

/** Milled corner radius in millimetres. */
export const CARD_CORNER_RADIUS = CARD_DIMENSIONS.cornerRadius;

/** Tessellation of a single rounded corner arc. */
export const CARD_CORNER_SEGMENTS = 10;

/** Aspect ratio of the etched face. */
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
export const TEXTURE_HEIGHT = Math.round(TEXTURE_WIDTH / CARD_ASPECT);

/** Pixels per millimetre of the design texture. */
export const TEXTURE_PX_PER_MM = TEXTURE_WIDTH / CARD_WIDTH;
