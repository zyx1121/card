import {
  CARD_FONTS,
  cardContent,
  type CardFaceContent,
  type CardItem,
  type CardTextItem,
} from "@/lib/card-content";
import {
  CARD_WIDTH,
  TEXTURE_HEIGHT,
  TEXTURE_PX_PER_MM,
  TEXTURE_WIDTH,
} from "@/lib/card-spec";
import { ZYX_LOGO_INK_BOX, ZYX_LOGO_PATH } from "@/lib/zyx-logo";

/** The measurements the painter reads back from a laid-out run. */
export interface TextMetricsLike {
  readonly width: number;
  /** Ink height above the baseline. Absent on very old canvas implementations. */
  readonly actualBoundingBoxAscent?: number;
}

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
  measureText(text: string): TextMetricsLike;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  fill(path: Path2DLike): void;
}

/** The `Path2D` shape the logo needs; both runtimes provide the real thing. */
export type Path2DLike = object;

/** Constructs a `Path2D` from SVG path data. */
export type Path2DConstructor = new (data: string) => Path2DLike;

/** Which side of the card to draw. */
export type CardSide = "front" | "back";

/** Font family per stack. The browser overrides these with next/font names. */
export type CardFontFamilies = Record<keyof typeof CARD_FONTS, string>;

/** Everything the painter needs that differs between the two runtimes. */
export interface CardPainterEnvironment {
  readonly families?: CardFontFamilies;
  readonly Path2D?: Path2DConstructor;
}

/** Reference size used to measure a typeface before solving for cap height. */
const MEASURE_SIZE = 200;

/**
 * Fallback cap-height ratios, used only if a canvas reports no ink bounds.
 *
 * Latin faces sit near 0.73 em; a Han face fills closer to 0.86 em because the
 * ideographic square is taller than a capital.
 */
const CAP_HEIGHT_RATIO: Record<keyof typeof CARD_FONTS, number> = {
  han: 0.86,
  sans: 0.73,
  mono: 0.73,
};

function fontString(
  item: CardTextItem,
  families: CardFontFamilies,
  size: number
): string {
  const weight = item.weight ?? 400;
  return `${weight} ${size.toFixed(2)}px ${families[item.font]}`;
}

/**
 * Solves for the font size whose ink stands exactly `capHeight` mm above the
 * baseline, by measuring the real run once at a reference size.
 */
function solveFontSize(
  context: Canvas2DLike,
  item: CardTextItem,
  families: CardFontFamilies
): number {
  const target = item.capHeight * TEXTURE_PX_PER_MM;
  context.font = fontString(item, families, MEASURE_SIZE);
  const ascent = context.measureText(item.text).actualBoundingBoxAscent;
  const ratio =
    typeof ascent === "number" && ascent > 1
      ? ascent / MEASURE_SIZE
      : CAP_HEIGHT_RATIO[item.font];
  return target / ratio;
}

/** Total advance of a run, including the extra tracking between characters. */
function runWidth(context: Canvas2DLike, text: string, tracking: number): number {
  if (tracking === 0) return context.measureText(text).width;
  let total = 0;
  for (const character of text) {
    total += context.measureText(character).width + tracking;
  }
  return total - tracking;
}

/**
 * Draws one text run, advancing character by character so letter tracking
 * behaves identically in every 2D canvas implementation.
 */
function drawTracked(
  context: Canvas2DLike,
  text: string,
  tracking: number,
  x: number,
  y: number
): void {
  if (tracking === 0) {
    context.fillText(text, x, y);
    return;
  }
  let cursor = x;
  for (const character of text) {
    context.fillText(character, cursor, y);
    cursor += context.measureText(character).width + tracking;
  }
}

function drawText(
  context: Canvas2DLike,
  item: CardTextItem,
  families: CardFontFamilies
): void {
  const size = solveFontSize(context, item, families);
  context.font = fontString(item, families, size);
  const tracking = (item.tracking ?? 0) * TEXTURE_PX_PER_MM;
  const x =
    item.align === "right"
      ? (CARD_WIDTH - item.x) * TEXTURE_PX_PER_MM -
        runWidth(context, item.text, tracking)
      : item.x * TEXTURE_PX_PER_MM;
  drawTracked(
    context,
    item.text,
    tracking,
    x,
    item.baseline * TEXTURE_PX_PER_MM
  );
}

/**
 * Stamps the zyx mark by replaying its SVG path through `Path2D`.
 *
 * The transform is anchored on the ink rather than on the viewBox, so the
 * requested position is the mark's own top-left corner and the requested height
 * is the height of the mark itself. The aspect ratio is preserved.
 */
function drawLogo(
  context: Canvas2DLike,
  x: number,
  y: number,
  height: number,
  Path2DCtor: Path2DConstructor | undefined
): void {
  const constructor = Path2DCtor ?? (globalThis as { Path2D?: Path2DConstructor }).Path2D;
  if (!constructor) {
    throw new Error("Path2D is unavailable; cannot paint the zyx mark");
  }
  const scale = (height * TEXTURE_PX_PER_MM) / ZYX_LOGO_INK_BOX.height;
  context.save();
  context.translate(x * TEXTURE_PX_PER_MM, y * TEXTURE_PX_PER_MM);
  context.scale(scale, scale);
  context.translate(-ZYX_LOGO_INK_BOX.x, -ZYX_LOGO_INK_BOX.y);
  context.fill(new constructor(ZYX_LOGO_PATH));
  context.restore();
}

/**
 * Paints one face of the design.
 *
 * The result is an etch mask: bare coating stays fully transparent and every
 * laser-removed area is opaque white. The renderer reads alpha as the etch
 * mask, both for the material swap and for the recessed bevel, and RGB as an
 * optional per-design tint.
 */
export function drawCardFace(
  context: Canvas2DLike,
  side: CardSide,
  environment: CardPainterEnvironment = {}
): void {
  const families = environment.families ?? CARD_FONTS;
  const face: CardFaceContent = cardContent[side];
  context.clearRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  context.textBaseline = "alphabetic";
  context.fillStyle = "#ffffff";
  for (const item of face.items) {
    context.globalAlpha = item.opacity ?? 1;
    if (isLogo(item)) {
      drawLogo(context, item.x, item.y, item.height, environment.Path2D);
    } else {
      drawText(context, item, families);
    }
  }
  context.globalAlpha = 1;
}

function isLogo(item: CardItem): item is Extract<CardItem, { kind: "logo" }> {
  return item.kind === "logo";
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
  // measured and baked into the texture with a fallback typeface.
  await Promise.all(
    (["front", "back"] as CardSide[]).flatMap((side) =>
      cardContent[side].items
        .filter((item): item is CardTextItem => !isLogo(item))
        .map((item) =>
          document.fonts.load(
            fontString(item, families, MEASURE_SIZE),
            item.text
          )
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
    drawCardFace(context as unknown as Canvas2DLike, side, { families });
    const image = context.getImageData(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    result[side] = new Uint8Array(image.data.buffer.slice(0));
  }
  return result;
}
