/**
 * Headless renderer and visual regression harness.
 *
 * It runs the exact geometry, shaders, textures and material presets the
 * browser uses, through `vgpu/node`, and writes PNGs plus a few pixel
 * assertions so a render can be judged without a GPU or a browser.
 *
 *   bun run scripts/render.ts --preset titanium --out renders/titanium.png
 *   bun run scripts/render.ts --view hero --yaw 70
 *   bun run scripts/render.ts --view hero --pointer 0.62,0.45
 *   bun run scripts/render.ts --all
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts, Path2D } from "@napi-rs/canvas";
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
  CARD_HERO_PITCH,
  CARD_HERO_YAW,
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
  CARD_WIDTH,
  TEXTURE_HEIGHT,
  TEXTURE_WIDTH,
} from "@/lib/card-spec";
import {
  drawCardFace,
  type Canvas2DLike,
  type CardSide,
  type Path2DConstructor,
} from "@/lib/card-texture";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FONT_DIR = `${ROOT}.fonts`;

/**
 * Page background, matching the forced-dark `--background` token.
 *
 * The card writes premultiplied colour with its coverage in alpha, so the
 * composite lays it over this.
 */
const BACKGROUND: readonly [number, number, number] = [0, 0, 0];

/** Clear value of the card target: nothing at all, not even an alpha. */
const TRANSPARENT: readonly [number, number, number, number] = [0, 0, 0, 0];

/** Which frames to shoot. */
type ViewName = "hero" | "edge" | "back";

const VIEW_NAMES: readonly ViewName[] = ["hero", "edge", "back"];

interface Args {
  readonly preset: PresetName;
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly all: boolean;
  readonly views: readonly ViewName[];
  /** True when `--out` was given, which pins the file name for a single view. */
  readonly explicitOut: boolean;
  /**
   * `--pointer x,y` as viewport fractions, `0,0` top-left and `1,1`
   * bottom-right, which is where the cursor would be. It lights the cursor lamp
   * for the hero frame; omitting it leaves the lamp off, so every existing
   * probe is unchanged.
   */
  readonly pointer?: readonly [number, number];
  /** `--yaw <degrees>` overrides the hero yaw, for a steep three-quarter view. */
  readonly yaw?: number;
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
  const view = values.get("view");
  const views =
    view && VIEW_NAMES.includes(view as ViewName)
      ? [view as ViewName]
      : VIEW_NAMES;
  const pointerArg = values.get("pointer");
  const pointer = pointerArg
    ? (pointerArg.split(",").map(Number) as [number, number])
    : undefined;
  if (
    pointer &&
    (!Number.isFinite(pointer[0]) || !Number.isFinite(pointer[1]))
  ) {
    throw new Error(
      `--pointer wants "x,y" as viewport fractions, got "${pointerArg}"`
    );
  }
  const yawArg = values.get("yaw");
  return {
    preset,
    out: values.get("out") ?? `renders/${preset}.png`,
    width: Number(values.get("width") ?? 1600),
    height: Number(values.get("height") ?? 1000),
    all,
    views,
    explicitOut: values.has("out"),
    pointer,
    yaw: yawArg ? (Number(yawArg) * Math.PI) / 180 : undefined,
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
    drawCardFace(context as unknown as Canvas2DLike, side, {
      Path2D: Path2D as unknown as Path2DConstructor,
    });
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

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(sorted.length * fraction))
  );
  return sorted[index];
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

/** Brightest pixel in a box centred on a pixel. */
function peakLuminance(
  pixels: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number
): number {
  let peak = 0;
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      peak = Math.max(peak, luminance(pixels, (y * width + x) * 4));
    }
  }
  return peak;
}

/** Etch mask value of the design at a point on the face, in millimetres. */
function maskAt(
  design: Uint8Array,
  side: CardSide,
  millimetreX: number,
  millimetreY: number
): number {
  // Back UVs are mirrored on X, matching `buildCardMesh`.
  const u =
    side === "front"
      ? (millimetreX + CARD_WIDTH / 2) / CARD_WIDTH
      : (CARD_WIDTH / 2 - millimetreX) / CARD_WIDTH;
  const v = (CARD_HEIGHT / 2 - millimetreY) / CARD_HEIGHT;
  const x = Math.min(
    TEXTURE_WIDTH - 1,
    Math.max(0, Math.round(u * TEXTURE_WIDTH))
  );
  const y = Math.min(
    TEXTURE_HEIGHT - 1,
    Math.max(0, Math.round(v * TEXTURE_HEIGHT))
  );
  return design[(y * TEXTURE_WIDTH + x) * 4 + 3] / 255;
}

interface FaceProbe {
  /** Contrast between the bare coating and the etched floor. */
  readonly etchContrast: number;
  /** p90 minus p10 of the bare coating, i.e. the gradient across the face. */
  readonly faceGradient: number;
  /** Width over height of the brightest patch on the bare coating. */
  readonly highlightRatio: number;
  readonly bare: number;
  readonly etched: number;
  readonly samples: number;
}

/**
 * Walks a grid across the visible face in card space, projects every point and
 * reads the rendered pixel under it.
 *
 * Sampling in card space rather than in screen space means the etched marks and
 * the bare coating can be told apart from the design texture itself, instead of
 * by guessing at a threshold, and it keeps the rim out of the statistics.
 */
function probeFace(
  pixels: Uint8Array,
  width: number,
  height: number,
  viewProjection: Float32Array,
  design: Uint8Array,
  side: CardSide
): FaceProbe {
  const z = (side === "front" ? 1 : -1) * (CARD_THICKNESS / 2);
  const inset = 1.5;
  const steps = 260;
  const bare: number[] = [];
  const etched: number[] = [];
  const bright: { x: number; y: number; value: number }[] = [];

  for (let iy = 0; iy <= steps; iy += 1) {
    const my =
      -CARD_HEIGHT / 2 + inset + ((CARD_HEIGHT - 2 * inset) * iy) / steps;
    for (let ix = 0; ix <= steps; ix += 1) {
      const mx =
        -CARD_WIDTH / 2 + inset + ((CARD_WIDTH - 2 * inset) * ix) / steps;
      const centre = maskAt(design, side, mx, my);
      // Only interior samples count, so half-covered edge pixels never land in
      // either bucket.
      const neighbours = [
        maskAt(design, side, mx + 0.2, my),
        maskAt(design, side, mx - 0.2, my),
        maskAt(design, side, mx, my + 0.2),
        maskAt(design, side, mx, my - 0.2),
      ];
      const isEtched = centre > 0.9 && neighbours.every((value) => value > 0.9);
      const isBare = centre < 0.02 && neighbours.every((value) => value < 0.02);
      if (!isEtched && !isBare) continue;

      const point = project(viewProjection, [mx, my, z], width, height);
      const px = Math.round(point.x);
      const py = Math.round(point.y);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const value = luminance(pixels, (py * width + px) * 4);
      if (isEtched) {
        etched.push(value);
      } else {
        bare.push(value);
        bright.push({ x: px, y: py, value });
      }
    }
  }

  bare.sort((a, b) => a - b);
  etched.sort((a, b) => a - b);
  const bareMedian = percentile(bare, 0.5);
  // The darkest decile of the etch, which is its floor rather than its bevel.
  const etchedFloor = percentile(etched, 0.1);

  const threshold = percentile(bare, 0.95);
  const box: Bounds = { minX: width, maxX: -1, minY: height, maxY: -1 };
  for (const sample of bright) {
    if (sample.value < threshold) continue;
    box.minX = Math.min(box.minX, sample.x);
    box.maxX = Math.max(box.maxX, sample.x);
    box.minY = Math.min(box.minY, sample.y);
    box.maxY = Math.max(box.maxY, sample.y);
  }
  const boxWidth = box.maxX - box.minX + 1;
  const boxHeight = box.maxY - box.minY + 1;

  return {
    etchContrast: Math.abs(bareMedian - etchedFloor),
    faceGradient: percentile(bare, 0.9) - percentile(bare, 0.1),
    highlightRatio: boxHeight > 0 ? boxWidth / boxHeight : 0,
    bare: bareMedian,
    etched: etchedFloor,
    samples: bare.length + etched.length,
  };
}

/**
 * Mean luminance of the band under the card, where the floor reflection used to
 * be drawn. Nothing renders there now, so it must read as background.
 */
function underCardLuminance(
  pixels: Uint8Array,
  width: number,
  height: number
): number {
  const bounds = silhouette(pixels, width, height);
  const y0 = Math.min(height - 1, bounds.maxY + 6);
  if (bounds.maxX <= bounds.minX || y0 >= height - 1) return 0;
  let total = 0;
  let count = 0;
  for (let y = y0; y < height; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
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
  /** Cursor position as a viewport fraction; omitted leaves the lamp off. */
  readonly pointer?: readonly [number, number];
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
  // The premultiplied picture, multisampled because the card's silhouette is a
  // hard edge against the page, and `rgba8unorm` because compatibility mode
  // will not multisample a float format.
  const scene = target(gpu, {
    size: [width, height],
    colors: [{ format: "rgba8unorm" }],
    depth: true,
    msaa: true,
  });
  const output = target(gpu, { size: [width, height] });

  const composite = {
    background: [...BACKGROUND] as [number, number, number],
  };

  const present = effect(gpu, presentShader.wgsl, {
    set: {
      scene: scene.colors[0],
      composite,
    },
  });

  const presets = args.all ? PRESET_NAMES : [args.preset];

  /** Milliseconds the last `shoot()` spent inside the frame. */
  let lastFrameMs = 0;

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
    card.setPointer(
      shot.pointer
        ? card.pointerPlanePoint(
            shot.pointer[0] * 2 - 1,
            1 - shot.pointer[1] * 2
          )
        : [0, 0, 0],
      shot.pointer ? 1 : 0
    );
    card.sync();
    const started = performance.now();
    frame(gpu, (current) => {
      current.pass(
        { target: scene, clear: TRANSPARENT, clearDepth: 1 },
        (pass) => {
          pass.draw(card.draw);
        }
      );
      current.pass(output, present);
    });
    return output.color.read({ mipLevel: 0, region: "all" }).then((buffer) => {
      lastFrameMs = performance.now() - started;
      return new Uint8Array(buffer);
    });
  };

  for (const preset of presets) {
    const card = createCardScene(api, gpu, {
      shader: cardShader.wgsl,
      preset,
      designs,
      aspect,
    });

    const base = (args.all ? `renders/${preset}.png` : args.out).replace(
      /\.png$/,
      ""
    );
    const report: string[] = [`preset=${preset}`];
    const wanted = new Set(args.views);
    // A single view only takes the bare `--out` path when the caller named one,
    // so `--view edge` on its own can never overwrite the hero frame.
    const single = args.views.length === 1 && args.explicitOut;

    if (wanted.has("hero")) {
      const path = `${base}.png`;
      const heroShot: ShotOptions = {
        yaw: args.yaw ?? CARD_HERO_YAW,
        pitch: CARD_HERO_PITCH,
        distance: cardCameraDistance(aspect),
        sway: 0,
      };
      const hero = await shoot(card, { ...heroShot, pointer: args.pointer });
      const heroViewProjection = new Float32Array(card.camera.viewProjection);
      writePng(path, hero, width, height);
      report.push(`frame_ms=${lastFrameMs.toFixed(1)}`);

      const probe = probeFace(
        hero,
        width,
        height,
        heroViewProjection,
        designs.front,
        "front"
      );
      report.push(
        `face=${probe.bare.toFixed(4)}`,
        `etch=${probe.etched.toFixed(4)}`,
        `etch_contrast=${probe.etchContrast.toFixed(4)}`,
        `face_gradient=${probe.faceGradient.toFixed(4)}`,
        `highlight_ratio=${probe.highlightRatio.toFixed(2)}`,
        `probe_samples=${probe.samples}`
      );

      report.push(
        `under_card=${underCardLuminance(hero, width, height).toFixed(5)}`
      );

      // The cursor light is compared against the same frame without it, at the
      // pixel the cursor sits on.
      if (args.pointer) {
        const dark = await shoot(card, heroShot);
        const px = (args.pointer[0] * width) | 0;
        const py = (args.pointer[1] * height) | 0;
        const lit = patchLuminance(hero, width, height, px, py, 24, 24);
        const unlit = patchLuminance(dark, width, height, px, py, 24, 24);
        report.push(
          `pointer_px=${px},${py}`,
          `pointer_lit=${lit.toFixed(4)}`,
          `pointer_unlit=${unlit.toFixed(4)}`,
          `pointer_delta=${(lit - unlit).toFixed(4)}`,
          `pointer_peak=${peakLuminance(hero, width, height, px, py, 24).toFixed(4)}`
        );
      }

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
      report.push(`silhouette_aspect=${flatAspect.toFixed(4)}/1.6667`);
      report.push(`-> ${path}`);
    }

    if (wanted.has("back")) {
      const path = single ? `${base}.png` : `${base}-back.png`;
      const back = await shoot(card, {
        yaw: Math.PI + CARD_HERO_YAW,
        pitch: CARD_HERO_PITCH,
        distance: cardCameraDistance(aspect),
        sway: 0,
      });
      const backViewProjection = new Float32Array(card.camera.viewProjection);
      writePng(path, back, width, height);
      const probe = probeFace(
        back,
        width,
        height,
        backViewProjection,
        designs.back,
        "back"
      );
      report.push(
        `back_etch_contrast=${probe.etchContrast.toFixed(4)}`,
        `back_face_gradient=${probe.faceGradient.toFixed(4)}`,
        `-> ${path}`
      );
    }

    if (wanted.has("edge")) {
      const path = single ? `${base}.png` : `${base}-edge.png`;
      // Macro of the milled rim: the card is tipped almost edge-on and the
      // camera climbs above it, so the frame holds the lit back face and, along
      // its top, the 0.76 mm wall catching the key.
      const EDGE_TILT = (72 * Math.PI) / 180;
      const edgeShot: ShotOptions = {
        yaw: 0.16,
        pitch: 0.38,
        distance: 66,
        sway: 0,
        tilt: EDGE_TILT,
      };
      const edge = await shoot(card, edgeShot);
      const edgeViewProjection = new Float32Array(card.camera.viewProjection);
      const edgeModel = new Float32Array(card.model.worldMatrix);
      writePng(path, edge, width, height);

      const edgePixel = project(
        edgeViewProjection,
        transformPoint(edgeModel, [0, CARD_HEIGHT / 2, 0]),
        width,
        height
      );
      const facePixel = project(
        edgeViewProjection,
        transformPoint(edgeModel, [
          0,
          CARD_HEIGHT / 2 - 3,
          -CARD_THICKNESS / 2,
        ]),
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
      report.push(
        `edge_luma=${edgeLuminance.toFixed(4)}`,
        `rim_face_luma=${faceLuminance.toFixed(4)}`,
        `edge_delta=${Math.abs(edgeLuminance - faceLuminance).toFixed(4)}`,
        `-> ${path}`
      );
    }

    console.log(report.join(" "));
    card.destroy();
  }

  gpu.dispose();
}

await main();
