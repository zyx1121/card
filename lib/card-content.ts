/**
 * Everything printed on the card.
 *
 * Positions and sizes are in millimetres on the real 90 x 54 mm card, so this
 * file can be edited without touching the renderer. `lib/card-texture.ts`
 * converts them to texture pixels.
 */

/** Font stacks. Names must match the fonts registered by the renderer. */
export const CARD_FONTS = {
  han: '"Noto Sans TC", sans-serif',
  sans: '"Geist", sans-serif',
  mono: '"Geist Mono", monospace',
} as const;

export interface CardTextItem {
  readonly text: string;
  /** Left edge in millimetres from the card's left side. */
  readonly x: number;
  /** Baseline in millimetres from the card's top side. */
  readonly y: number;
  /** Font size in millimetres. */
  readonly size: number;
  readonly font: keyof typeof CARD_FONTS;
  readonly weight?: number;
  /** Extra letter spacing in millimetres. */
  readonly tracking?: number;
  /** Ink coverage, also the spot-gloss mask value. */
  readonly opacity?: number;
}

export interface CardFaceContent {
  readonly items: readonly CardTextItem[];
}

export const cardContent: {
  readonly front: CardFaceContent;
  readonly back: CardFaceContent;
} = {
  front: {
    items: [
      {
        text: "詹詠翔",
        x: 10,
        y: 26,
        size: 10,
        font: "han",
        weight: 500,
      },
      {
        text: "Loki Zhan",
        x: 10.4,
        y: 33.5,
        size: 4,
        font: "sans",
        weight: 400,
        tracking: 0.7,
      },
      {
        text: "WinLab · NYCU CS",
        x: 10.4,
        y: 46,
        size: 2.8,
        font: "sans",
        weight: 400,
        tracking: 0.16,
        opacity: 0.82,
      },
    ],
  },
  back: {
    items: [
      {
        text: "zyx1121",
        x: 10,
        y: 21,
        size: 5,
        font: "mono",
        weight: 400,
        tracking: 0.12,
      },
      {
        text: "github.com/zyx1121",
        x: 10,
        y: 32,
        size: 2.9,
        font: "mono",
        weight: 400,
        opacity: 0.9,
      },
      {
        text: "yongxiang.zhan@outlook.com",
        x: 10,
        y: 37.5,
        size: 2.9,
        font: "mono",
        weight: 400,
        opacity: 0.9,
      },
      {
        text: "www.zyx.tw",
        x: 10,
        y: 43,
        size: 2.9,
        font: "mono",
        weight: 400,
        opacity: 0.9,
      },
    ],
  },
};
