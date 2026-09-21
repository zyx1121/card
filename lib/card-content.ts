/**
 * Everything etched into the card.
 *
 * Positions and sizes are in millimetres on the real 90 x 54 mm blank, so this
 * file can be edited without touching the renderer. `lib/card-texture.ts`
 * converts them to texture pixels.
 *
 * The layout follows the white titanium Apple Card: a mark in the top-left
 * corner, the holder's name along the bottom-left, and nothing else. Both sides
 * are mostly bare metal, which is the whole point.
 */

/** Font stacks. Names must match the fonts registered by the renderer. */
export const CARD_FONTS = {
  han: '"Noto Sans TC", sans-serif',
  sans: '"Geist", sans-serif',
  mono: '"Geist Mono", monospace',
} as const;

/** Margin from the card edge to the etched block, in millimetres. */
export const CARD_MARGIN = 6.5;

export interface CardTextItem {
  readonly kind?: "text";
  readonly text: string;
  /**
   * Horizontal anchor in millimetres: distance from the left edge for a
   * left-aligned run, from the right edge for a right-aligned one.
   */
  readonly x: number;
  /** Baseline in millimetres from the card's top side. */
  readonly baseline: number;
  /**
   * Height of the etched glyphs above the baseline, in millimetres.
   *
   * Specifying cap height rather than font size keeps the etch the requested
   * physical size no matter which typeface or fallback the canvas resolves.
   */
  readonly capHeight: number;
  readonly font: keyof typeof CARD_FONTS;
  readonly weight?: number;
  /** Extra letter spacing in millimetres. */
  readonly tracking?: number;
  readonly align?: "left" | "right";
  /** Etch depth mask value, 1 for a full-depth cut. */
  readonly opacity?: number;
}

export interface CardLogoItem {
  readonly kind: "logo";
  /** Left edge of the mark in millimetres from the card's left side. */
  readonly x: number;
  /** Top edge of the mark in millimetres from the card's top side. */
  readonly y: number;
  /** Height of the mark in millimetres; the width follows the artwork. */
  readonly height: number;
  readonly opacity?: number;
}

export type CardItem = CardTextItem | CardLogoItem;

export interface CardFaceContent {
  readonly items: readonly CardItem[];
}

/** Baseline of the bottom row, in millimetres from the card's top side. */
const BOTTOM_BASELINE = 54 - 8;

/** Baseline of the bottom row on the back, which sits closer to the edge. */
const BACK_BASELINE = 54 - CARD_MARGIN;

export const cardContent: {
  readonly front: CardFaceContent;
  readonly back: CardFaceContent;
} = {
  front: {
    items: [
      {
        kind: "logo",
        x: CARD_MARGIN,
        y: CARD_MARGIN,
        height: 7,
      },
      {
        text: "詹詠翔",
        x: CARD_MARGIN,
        baseline: BOTTOM_BASELINE,
        capHeight: 4.2,
        font: "han",
        weight: 500,
      },
    ],
  },
  back: {
    items: [
      {
        text: "github.com/zyx1121",
        x: CARD_MARGIN,
        baseline: BACK_BASELINE - 3.6,
        capHeight: 2.2,
        font: "mono",
        weight: 400,
      },
      {
        text: "mail@zyx.tw",
        x: CARD_MARGIN,
        baseline: BACK_BASELINE,
        capHeight: 2.2,
        font: "mono",
        weight: 400,
      },
      {
        text: "zyx.tw",
        x: CARD_MARGIN,
        baseline: BACK_BASELINE,
        capHeight: 2.2,
        font: "mono",
        weight: 400,
        align: "right",
      },
    ],
  },
};
