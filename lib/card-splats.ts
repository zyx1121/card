import type { GeometryOptions } from "vgpu";

import {
  CARD_CORNER_RADIUS,
  CARD_FACE,
  CARD_HEIGHT,
  CARD_THICKNESS,
  CARD_WIDTH,
} from "@/lib/card-spec";

/**
 * Resamples the card's surface as a cloud of gaussian splats.
 *
 * `shaders/splat.wgsl` draws one camera-facing quad per point, so the cloud is
 * an instance stream: the quad's four corners in buffer 0 and one record per
 * splat in buffer 1. Points are scattered over the real geometry (both faces of
 * the rounded rectangle and the milled rim) in proportion to area, so the
 * density is even everywhere rather than piling up on the small rim.
 *
 * The scatter is driven by a seeded PRNG rather than by `Math.random`, so the
 * same count always produces the same cloud: identical between frames, between
 * the browser and the render script, and between runs.
 */

/** Floats per splat: position(3) + normal(3) + uv(2) + meta(3). */
export const SPLAT_STRIDE_FLOATS = 11;

/** Bytes per splat of the instance stream. */
export const SPLAT_STRIDE = SPLAT_STRIDE_FLOATS * 4;

/** Per-splat size multiplier, which spreads the cloud over 0.9 to 1.4 mm. */
const SIZE_SCALE_MIN = 0.82;
const SIZE_SCALE_MAX = 1.27;

/** Mulberry32: small, fast and good enough to scatter points evenly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when a point on the face is inside the rounded rectangle. */
function insideRoundedRect(x: number, y: number): boolean {
  const inner = CARD_WIDTH / 2 - CARD_CORNER_RADIUS;
  const innerY = CARD_HEIGHT / 2 - CARD_CORNER_RADIUS;
  const dx = Math.abs(x) - inner;
  const dy = Math.abs(y) - innerY;
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= CARD_CORNER_RADIUS * CARD_CORNER_RADIUS;
}

interface PerimeterPoint {
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
}

const STRAIGHT_X = CARD_WIDTH / 2 - CARD_CORNER_RADIUS;
const STRAIGHT_Y = CARD_HEIGHT / 2 - CARD_CORNER_RADIUS;
const ARC_LENGTH = (Math.PI * CARD_CORNER_RADIUS) / 2;

/**
 * The outline as eight pieces, walked counter-clockwise from the middle of the
 * right edge: four straights and four quarter arcs, with their lengths so a
 * uniform sample of arc length lands uniformly on the perimeter.
 */
const PERIMETER: readonly {
  readonly length: number;
  readonly at: (t: number) => PerimeterPoint;
}[] = [
  {
    length: 2 * STRAIGHT_Y,
    at: (t) => ({
      x: CARD_WIDTH / 2,
      y: -STRAIGHT_Y + 2 * STRAIGHT_Y * t,
      nx: 1,
      ny: 0,
    }),
  },
  { length: ARC_LENGTH, at: (t) => arc(STRAIGHT_X, STRAIGHT_Y, 0, t) },
  {
    length: 2 * STRAIGHT_X,
    at: (t) => ({
      x: STRAIGHT_X - 2 * STRAIGHT_X * t,
      y: CARD_HEIGHT / 2,
      nx: 0,
      ny: 1,
    }),
  },
  { length: ARC_LENGTH, at: (t) => arc(-STRAIGHT_X, STRAIGHT_Y, 1, t) },
  {
    length: 2 * STRAIGHT_Y,
    at: (t) => ({
      x: -CARD_WIDTH / 2,
      y: STRAIGHT_Y - 2 * STRAIGHT_Y * t,
      nx: -1,
      ny: 0,
    }),
  },
  { length: ARC_LENGTH, at: (t) => arc(-STRAIGHT_X, -STRAIGHT_Y, 2, t) },
  {
    length: 2 * STRAIGHT_X,
    at: (t) => ({
      x: -STRAIGHT_X + 2 * STRAIGHT_X * t,
      y: -CARD_HEIGHT / 2,
      nx: 0,
      ny: -1,
    }),
  },
  { length: ARC_LENGTH, at: (t) => arc(STRAIGHT_X, -STRAIGHT_Y, 3, t) },
];

/** One point on the `quadrant`-th corner arc, `t` of the way around it. */
function arc(
  centerX: number,
  centerY: number,
  quadrant: number,
  t: number
): PerimeterPoint {
  const angle = (quadrant * Math.PI) / 2 + (Math.PI / 2) * t;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  return {
    x: centerX + nx * CARD_CORNER_RADIUS,
    y: centerY + ny * CARD_CORNER_RADIUS,
    nx,
    ny,
  };
}

const PERIMETER_LENGTH = PERIMETER.reduce(
  (total, piece) => total + piece.length,
  0
);

/** Area of one face, the rectangle less the four corner bites. */
const FACE_AREA =
  CARD_WIDTH * CARD_HEIGHT -
  (4 - Math.PI) * CARD_CORNER_RADIUS * CARD_CORNER_RADIUS;

/** Area of the milled rim. */
const EDGE_AREA = PERIMETER_LENGTH * CARD_THICKNESS;

export interface SplatCloud {
  /** The instance stream, {@link SPLAT_STRIDE_FLOATS} floats per splat. */
  readonly splats: Float32Array<ArrayBuffer>;
  readonly count: number;
}

/** Scatters `count` splats over the card, in proportion to surface area. */
export function buildSplatCloud(count: number): SplatCloud {
  const random = seededRandom(0x5a797831);
  const splats = new Float32Array(count * SPLAT_STRIDE_FLOATS);
  const halfThickness = CARD_THICKNESS / 2;

  const total = 2 * FACE_AREA + EDGE_AREA;
  const frontShare = FACE_AREA / total;
  const backShare = (2 * FACE_AREA) / total;

  let cursor = 0;
  const write = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    face: number
  ): void => {
    splats[cursor] = x;
    splats[cursor + 1] = y;
    splats[cursor + 2] = z;
    splats[cursor + 3] = nx;
    splats[cursor + 4] = ny;
    splats[cursor + 5] = nz;
    splats[cursor + 6] = u;
    splats[cursor + 7] = v;
    // The seed only ever feeds the twinkle hash, so it is spread wide enough
    // that neighbouring splats do not pulse together.
    splats[cursor + 8] = random() * 128;
    splats[cursor + 9] =
      SIZE_SCALE_MIN + random() * (SIZE_SCALE_MAX - SIZE_SCALE_MIN);
    splats[cursor + 10] = face;
    cursor += SPLAT_STRIDE_FLOATS;
  };

  for (let i = 0; i < count; i += 1) {
    const pick = random();
    if (pick < backShare) {
      const front = pick < frontShare;
      // Rejection sampling: the corner bites are 0.2% of the rectangle, so
      // this almost never loops.
      let x = 0;
      let y = 0;
      do {
        x = (random() - 0.5) * CARD_WIDTH;
        y = (random() - 0.5) * CARD_HEIGHT;
      } while (!insideRoundedRect(x, y));
      // Back UVs are mirrored on X, matching `buildCardMesh`.
      const u = front
        ? (x + CARD_WIDTH / 2) / CARD_WIDTH
        : (CARD_WIDTH / 2 - x) / CARD_WIDTH;
      const v = (CARD_HEIGHT / 2 - y) / CARD_HEIGHT;
      write(
        x,
        y,
        front ? halfThickness : -halfThickness,
        0,
        0,
        front ? 1 : -1,
        u,
        v,
        front ? CARD_FACE.front : CARD_FACE.back
      );
      continue;
    }

    // The rim: uniform in arc length, then uniform across the thickness.
    const walk = random() * PERIMETER_LENGTH;
    let consumed = 0;
    let piece = PERIMETER[PERIMETER.length - 1];
    let t = 1;
    for (const candidate of PERIMETER) {
      if (walk - consumed < candidate.length) {
        piece = candidate;
        t = (walk - consumed) / candidate.length;
        break;
      }
      consumed += candidate.length;
    }
    const point = piece.at(t);
    const z = (random() - 0.5) * CARD_THICKNESS;
    write(
      point.x,
      point.y,
      z,
      point.nx,
      point.ny,
      0,
      // The rim's u runs along the outline and its v across the thickness, as
      // in `buildCardMesh`; only the surface grain reads them.
      walk / PERIMETER_LENGTH,
      (z + halfThickness) / CARD_THICKNESS,
      CARD_FACE.edge
    );
  }

  return { splats, count };
}

/**
 * Geometry descriptor for the splat pass: a four-corner strip drawn once per
 * splat, with the cloud as an instance stream.
 */
export function splatGeometryOptions(count: number): GeometryOptions {
  const cloud = buildSplatCloud(count);
  return {
    label: "card-splats",
    topology: "triangle-strip",
    buffers: [
      {
        attributes: { corner: "float32x2" } as const,
        data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      },
      {
        stepMode: "instance",
        attributes: {
          splatPosition: "float32x3",
          splatNormal: "float32x3",
          splatUv: "float32x2",
          splatMeta: "float32x3",
        } as const,
        data: cloud.splats,
        stride: SPLAT_STRIDE,
      },
    ],
    instanceCount: cloud.count,
  };
}
