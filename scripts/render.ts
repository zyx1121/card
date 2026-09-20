/**
 * Headless renderer and visual regression harness.
 *
 * It runs the exact geometry, shader, textures and material presets the browser
 * uses, through `vgpu/node`, and writes PNGs plus a few pixel assertions so a
 * render can be judged without a GPU or a browser.
 *
 *   bun run scripts/render.ts --preset paper --out renders/paper.png
 *   bun run scripts/render.ts --all
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { PNG } from "pngjs";
import { resolveShader } from "@vgpu/wgsl/runtime";
import {
  draw,
  effect,
  frame,
  geometry,
  init,
  sampler,
  target,
  texture,
} from "vgpu/node";

import {
  cardCameraDistance,
  createCardScene,
  type VgpuApi,
} from "@/lib/card-scene";
import {
  PRESET_NAMES,
  resolvePreset,
  type PresetName,
} from "@/lib/card-presets";
import {
  CARD_HEIGHT,
  CARD_THICKNESS,
  TEXTURE_HEIGHT,
  TEXTURE_WIDTH,
} from "@/lib/card-spec";
import {
  drawCardFace,
  type Canvas2DLike,
  type CardSide,
} from "@/lib/card-texture";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FONT_DIR = `${ROOT}.fonts`;

/** Page background, matching the light `--background` token. */
const BACKGROUND: readonly [number, number, number, number] = [
  0.988, 0.988, 0.988, 1,
];

interface Args {
  readonly preset: PresetName;
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly all: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let all = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--all") {
      all = true;
    } else if (token.startsWith("--")) {
      values.set(token.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  const preset = resolvePreset(values.get("preset"));
  return {
    preset,
    out: values.get("out") ?? `renders/${preset}.png`,
    width: Number(values.get("width") ?? 1600),
    height: Number(values.get("height") ?? 1000),
    all,
  };
}

function registerFonts(): void {
  const files: readonly [string, string][] = [
    ["NotoSansTC-Medium.ttf", "Noto Sans TC"],
    ["Geist-Regular.ttf", "Geist"],
    ["GeistMono-Regular.ttf", "Geist Mono"],
  ];
  for (const [file, family] of files) {
    const path = `${FONT_DIR}/${file}`;
    if (!existsSync(path)) {
      throw new Error(`missing ${path}; run \`bun run fonts\` first`);
    }
    GlobalFonts.registerFromPath(path, family);
  }
}

function renderDesigns(): Record<CardSide, Uint8Array> {
  const sides: CardSide[] = ["front", "back"];
  const result = {} as Record<CardSide, Uint8Array>;
  for (const side of sides) {
    const canvas = createCanvas(TEXTURE_WIDTH, TEXTURE_HEIGHT);
    const context = canvas.getContext("2d");
    drawCardFace(context as unknown as Canvas2DLike, side);
    const image = context.getImageData(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    result[side] = new Uint8Array(image.data.buffer.slice(0));
  }
  return result;
}

function writePng(
  path: string,
  pixels: Uint8Array,
  width: number,
  height: number
): void {
  mkdirSync(dirname(path), { recursive: true });
  const png = new PNG({ width, height });
  png.data.set(pixels);
  writeFileSync(path, PNG.sync.write(png));
}

function luminance(pixels: Uint8Array, index: number): number {
  return (
    (0.2126 * pixels[index] +
      0.7152 * pixels[index + 1] +
      0.0722 * pixels[index + 2]) /
    255
  );
}

const BACKGROUND_LUMINANCE =
  0.2126 * BACKGROUND[0] + 0.7152 * BACKGROUND[1] + 0.0722 * BACKGROUND[2];

function isCard(pixels: Uint8Array, index: number): boolean {
  return Math.abs(luminance(pixels, index) - BACKGROUND_LUMINANCE) > 0.02;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function silhouette(pixels: Uint8Array, width: number, height: number): Bounds {
  const bounds: Bounds = {
    minX: width,
    maxX: -1,
    minY: height,
    maxY: -1,
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isCard(pixels, (y * width + x) * 4)) continue;
      if (x < bounds.minX) bounds.minX = x;
      if (x > bounds.maxX) bounds.maxX = x;
      if (y < bounds.minY) bounds.minY = y;
      if (y > bounds.maxY) bounds.maxY = y;
    }
  }
  return bounds;
}

function percentileLuminance(
  pixels: Uint8Array,
  width: number,
  height: number,
  percentile: number
): number {
  const values: number[] = [];
  for (let i = 0; i < width * height; i += 1) {
    const index = i * 4;
    if (isCard(pixels, index)) values.push(luminance(pixels, index));
  }
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[
    Math.min(values.length - 1, Math.floor(values.length * percentile))
  ];
}

/** Projects a scene-space point to pixel coordinates. */
function project(
  viewProjection: Float32Array,
  point: readonly [number, number, number],
  width: number,
  height: number
): { x: number; y: number } {
  const m = viewProjection;
  const [x, y, z] = point;
  const clipX = m[0] * x + m[4] * y + m[8] * z + m[12];
  const clipY = m[1] * x + m[5] * y + m[9] * z + m[13];
  const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
  return {
    x: ((clipX / clipW) * 0.5 + 0.5) * width,
    y: (1 - ((clipY / clipW) * 0.5 + 0.5)) * height,
  };
}

/**
 * Luminance of the printed ink inside a rectangle.
 *
 * Returns the pixel that departs furthest from the bare stock, so it works for
 * dark ink on white and for pale gold on black alike.
 */
function inkLuminanceInRect(
  pixels: Uint8Array,
  width: number,
  height: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  stock: number
): number {
  let best = stock;
  for (
    let y = Math.round(Math.min(a.y, b.y));
    y <= Math.max(a.y, b.y);
    y += 1
  ) {
    for (
      let x = Math.round(Math.min(a.x, b.x));
      x <= Math.max(a.x, b.x);
      x += 1
    ) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const value = luminance(pixels, (y * width + x) * 4);
      if (Math.abs(value - stock) > Math.abs(best - stock)) best = value;
    }
  }
  return best;
}

/** Mean luminance of a small box centred on a pixel. */
function patchLuminance(
  pixels: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number
): number {
  let total = 0;
  let count = 0;
  for (
    let y = Math.round(centerY - halfHeight);
    y <= centerY + halfHeight;
    y += 1
  ) {
    for (
      let x = Math.round(centerX - halfWidth);
      x <= centerX + halfWidth;
      x += 1
    ) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      total += luminance(pixels, (y * width + x) * 4);
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

interface ShotOptions {
  readonly yaw: number;
  readonly pitch: number;
  /** Absolute camera distance in millimetres. */
  readonly distance: number;
  readonly sway: number;
  /** Tilt of the card itself about X, in radians. */
  readonly tilt?: number;
}

/** Applies a column-major 4x4 matrix to a point. */
function transformPoint(
  matrix: Float32Array,
  point: readonly [number, number, number]
): [number, number, number] {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  registerFonts();

  const cardShader = await resolveShader({
    entry: `${ROOT}shaders/card.wgsl`,
  });
  const presentShader = await resolveShader({
    entry: `${ROOT}shaders/present.wgsl`,
  });

  const designs = renderDesigns();
  const gpu = await init();
  const api: VgpuApi = { draw, geometry, sampler, texture };

  const { width, height } = args;
  const aspect = width / height;
  const scene = target(gpu, { size: [width, height], depth: true });
  const output = target(gpu, { size: [width, height] });
  const present = effect(gpu, presentShader.wgsl, {
    set: {
      scene,
      sceneSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
    },
  });

  const presets = args.all ? PRESET_NAMES : [args.preset];

  const shoot = (
    card: ReturnType<typeof createCardScene>,
    shot: ShotOptions
  ): Promise<Uint8Array> => {
    const distance = shot.distance;
    card.camera.set({
      aspect,
      position: [
        Math.sin(shot.yaw) * Math.cos(shot.pitch) * distance,
        Math.sin(shot.pitch) * distance,
        Math.cos(shot.yaw) * Math.cos(shot.pitch) * distance,
      ],
    });
    card.camera.lookAt([0, 0, 0]);
    card.animate(0, shot.sway);
    card.model.set({ rotation: [shot.tilt ?? 0, 0, 0] });
    card.sync();
    frame(gpu, (current) => {
      current.pass(
        { target: scene, clear: BACKGROUND, clearDepth: 1 },
        (pass) => {
          pass.draw(card.draw);
        }
      );
      current.pass(output, present);
    });
    return output.color
      .read({ mipLevel: 0, region: "all" })
      .then((buffer) => new Uint8Array(buffer));
  };

  for (const preset of presets) {
    const card = createCardScene(api, gpu, {
      shader: cardShader.wgsl,
      preset,
      designs,
      aspect,
    });

    const heroPath = args.all ? `renders/${preset}.png` : args.out;
    const edgePath = heroPath.replace(/\.png$/, "-edge.png");

    const hero = await shoot(card, {
      yaw: 0.46,
      pitch: 0.3,
      distance: cardCameraDistance(aspect),
      sway: 0,
    });
    writePng(heroPath, hero, width, height);

    // Macro of the cut edge: the card is tipped almost edge-on and the camera
    // moves in until the 0.35 mm wall is more than ten pixels tall.
    const EDGE_TILT = (78 * Math.PI) / 180;
    const edge = await shoot(card, {
      yaw: 0.16,
      pitch: 0.1,
      distance: 52,
      sway: 0,
      tilt: EDGE_TILT,
    });
    const edgeViewProjection = new Float32Array(card.camera.viewProjection);
    const edgeModel = new Float32Array(card.model.worldMatrix);
    writePng(edgePath, edge, width, height);

    const flat = await shoot(card, {
      yaw: 0,
      pitch: 0,
      distance: cardCameraDistance(aspect),
      sway: 0,
    });

    const flatBounds = silhouette(flat, width, height);
    const flatAspect =
      (flatBounds.maxX - flatBounds.minX + 1) /
      (flatBounds.maxY - flatBounds.minY + 1);

    // The 0.35 mm cut edge and the printed face 3 mm below it, located by
    // projecting known scene points instead of guessing at the silhouette.
    const edgePixel = project(
      edgeViewProjection,
      transformPoint(edgeModel, [0, CARD_HEIGHT / 2, 0]),
      width,
      height
    );
    const facePixel = project(
      edgeViewProjection,
      transformPoint(edgeModel, [0, CARD_HEIGHT / 2 - 3, CARD_THICKNESS / 2]),
      width,
      height
    );
    const edgeLuminance = patchLuminance(
      edge,
      width,
      height,
      edgePixel.x,
      edgePixel.y,
      40,
      1
    );
    const faceLuminance = patchLuminance(
      edge,
      width,
      height,
      facePixel.x,
      facePixel.y,
      40,
      1
    );

    // Ink versus bare stock, read off the hero frame at known card positions.
    const heroViewProjection = new Float32Array(card.camera.viewProjection);
    const nameTopLeft = project(
      heroViewProjection,
      [-35, 11, CARD_THICKNESS / 2],
      width,
      height
    );
    const nameBottomRight = project(
      heroViewProjection,
      [-19, 1, CARD_THICKNESS / 2],
      width,
      height
    );
    const stockPixel = project(
      heroViewProjection,
      [26, -18, CARD_THICKNESS / 2],
      width,
      height
    );
    const stockLuminance = patchLuminance(
      hero,
      width,
      height,
      stockPixel.x,
      stockPixel.y,
      25,
      25
    );
    const inkLuminance = inkLuminanceInRect(
      hero,
      width,
      height,
      nameTopLeft,
      nameBottomRight,
      stockLuminance
    );

    const highlight = percentileLuminance(hero, width, height, 0.999);
    const median = percentileLuminance(hero, width, height, 0.5);

    console.log(
      [
        `preset=${preset}`,
        `silhouette_aspect=${flatAspect.toFixed(4)}/1.6667`,
        `edge_luma=${edgeLuminance.toFixed(4)}`,
        `face_luma=${faceLuminance.toFixed(4)}`,
        `edge_delta=${Math.abs(edgeLuminance - faceLuminance).toFixed(4)}`,
        `ink=${inkLuminance.toFixed(4)}`,
        `stock=${stockLuminance.toFixed(4)}`,
        `ink_contrast=${Math.abs(stockLuminance - inkLuminance).toFixed(4)}`,
        `highlight_p999=${highlight.toFixed(4)}`,
        `median=${median.toFixed(4)}`,
        `contrast=${(highlight - median).toFixed(4)}`,
        `-> ${heroPath} ${edgePath}`,
      ].join(" ")
    );

    card.destroy();
  }

  gpu.dispose();
}

await main();
