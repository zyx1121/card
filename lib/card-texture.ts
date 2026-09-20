import {
  CARD_FONTS,
  cardContent,
  type CardFaceContent,
  type CardTextItem,
} from "@/lib/card-content";
import {
  TEXTURE_HEIGHT,
  TEXTURE_PX_PER_MM,
  TEXTURE_WIDTH,
} from "@/lib/card-spec";

/**
 * The subset of the 2D canvas API the design needs.
 *
 * Declared structurally so the same drawing code runs against the browser's
 * `CanvasRenderingContext2D` and against `@napi-rs/canvas` in the headless
 * render script.
 */
export interface Canvas2DLike {
  font: string;
  fillStyle: string;
  globalAlpha: number;
  textBaseline: string;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** Which side of the card to draw. */
export type CardSide = "front" | "back";

/** Font family per stack. The browser overrides these with next/font names. */
export type CardFontFamilies = Record<keyof typeof CARD_FONTS, string>;

function fontString(item: CardTextItem, families: CardFontFamilies): string {
  const weight = item.weight ?? 400;
  const size = item.size * TEXTURE_PX_PER_MM;
  return `${weight} ${size.toFixed(2)}px ${families[item.font]}`;
}

/**
 * Draws one text run, advancing character by character so letter tracking
 * behaves identically in every 2D canvas implementation.
 */
function drawTracked(
  context: Canvas2DLike,
  item: CardTextItem,
  x: number,
  y: number
): void {
  const tracking = (item.tracking ?? 0) * TEXTURE_PX_PER_MM;
  if (tracking === 0) {
    context.fillText(item.text, x, y);
    return;
  }
  let cursor = x;
  for (const character of item.text) {
    context.fillText(character, cursor, y);
    cursor += context.measureText(character).width + tracking;
  }
}

/**
 * Paints one face of the design.
 *
 * The result is an ink coverage mask: paper stays fully transparent and ink is
 * opaque white. The renderer reads alpha as both ink coverage and the spot
 * varnish mask, and RGB as an optional per-design tint.
 */
export function drawCardFace(
  context: Canvas2DLike,
  side: CardSide,
  families: CardFontFamilies = CARD_FONTS
): void {
  const face: CardFaceContent = cardContent[side];
  context.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  context.textBaseline = "alphabetic";
  context.fillStyle = "#ffffff";
  for (const item of face.items) {
    context.globalAlpha = item.opacity ?? 1;
    context.font = fontString(item, families);
    drawTracked(
      context,
      item,
      item.x * TEXTURE_PX_PER_MM,
      item.y * TEXTURE_PX_PER_MM
    );
  }
  context.globalAlpha = 1;
}

/**
 * Resolves the families `next/font` generated, which carry hashed names and are
 * only reachable through the CSS variables the layout sets.
 */
function browserFontFamilies(): CardFontFamilies {
  const styles = getComputedStyle(document.documentElement);
  const read = (variable: string, fallback: string): string => {
    const value = styles.getPropertyValue(variable).trim();
    return value.length > 0 ? `${value}, ${fallback}` : fallback;
  };
  return {
    han: read("--font-noto-sans-tc", CARD_FONTS.han),
    sans: read("--font-geist-sans", CARD_FONTS.sans),
    mono: read("--font-geist-mono", CARD_FONTS.mono),
  };
}

/** Draws both faces into browser canvases and returns their RGBA bytes. */
export async function renderCardFacesInBrowser(): Promise<
  Record<CardSide, Uint8Array>
> {
  const families = browserFontFamilies();

  // Web fonts load lazily, and a face drawn before its font arrives would be
  // baked into the texture with a fallback typeface.
  await Promise.all(
    (["front", "back"] as CardSide[]).flatMap((side) =>
      cardContent[side].items.map((item) =>
        document.fonts.load(fontString(item, families), item.text)
      )
    )
  );
  await document.fonts.ready;

  const result = {} as Record<CardSide, Uint8Array>;
  for (const side of ["front", "back"] as CardSide[]) {
    const canvas = document.createElement("canvas");
    canvas.width = TEXTURE_WIDTH;
    canvas.height = TEXTURE_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas context unavailable");
    drawCardFace(context as unknown as Canvas2DLike, side, families);
    const image = context.getImageData(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    result[side] = new Uint8Array(image.data.buffer.slice(0));
  }
  return result;
}
