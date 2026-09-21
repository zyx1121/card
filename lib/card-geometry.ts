import type { GeometryOptions } from "vgpu";

import {
  CARD_CORNER_RADIUS,
  CARD_CORNER_SEGMENTS,
  CARD_FACE,
  CARD_HEIGHT,
  CARD_THICKNESS,
  CARD_WIDTH,
} from "@/lib/card-spec";

/** Floats per vertex: position(3) + normal(3) + tangent(3) + uv(2) + face(1). */
export const CARD_VERTEX_STRIDE_FLOATS = 12;

/** Bytes per vertex of the interleaved vertex buffer. */
export const CARD_VERTEX_STRIDE = CARD_VERTEX_STRIDE_FLOATS * 4;

export interface CardMesh {
  /** Interleaved position/normal/tangent/uv/face vertex data. */
  readonly vertices: Float32Array<ArrayBuffer>;
  /** Triangle list indices. */
  readonly indices: Uint16Array<ArrayBuffer>;
  readonly vertexCount: number;
  readonly indexCount: number;
}

interface RingPoint {
  readonly x: number;
  readonly y: number;
  /** Outward normal in the XY plane. */
  readonly nx: number;
  readonly ny: number;
  /** Normalised arc length along the perimeter, 0..1. */
  readonly s: number;
}

/**
 * Samples the rounded rectangle outline counter-clockwise as seen from +Z,
 * starting at the top-right corner arc.
 */
function buildRing(): RingPoint[] {
  const halfWidth = CARD_WIDTH / 2 - CARD_CORNER_RADIUS;
  const halfHeight = CARD_HEIGHT / 2 - CARD_CORNER_RADIUS;
  const centers: readonly (readonly [number, number])[] = [
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
  ];

  const points: { x: number; y: number; nx: number; ny: number }[] = [];
  for (let corner = 0; corner < 4; corner += 1) {
    const [cx, cy] = centers[corner];
    const start = (corner * Math.PI) / 2;
    for (let step = 0; step <= CARD_CORNER_SEGMENTS; step += 1) {
      const angle = start + (Math.PI / 2) * (step / CARD_CORNER_SEGMENTS);
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      points.push({
        x: cx + nx * CARD_CORNER_RADIUS,
        y: cy + ny * CARD_CORNER_RADIUS,
        nx,
        ny,
      });
    }
  }

  const lengths: number[] = [0];
  let perimeter = 0;
  for (let i = 1; i <= points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i % points.length];
    perimeter += Math.hypot(current.x - previous.x, current.y - previous.y);
    lengths.push(perimeter);
  }

  return points.map((point, index) => ({
    ...point,
    s: lengths[index] / perimeter,
  }));
}

/**
 * Builds an extruded rounded rectangle: front face, back face and a side wall.
 *
 * Front UVs map the whole 90x54 mm face to 0..1. Back UVs are mirrored on X so
 * the etched text reads correctly once the card is flipped about its vertical
 * axis. The edge wall runs uv.x along the perimeter and uv.y across the
 * thickness.
 *
 * Every vertex also carries a tangent, which the shader needs for the brushed
 * anisotropic lobe and which must be in model space so the card can rotate.
 */
export function buildCardMesh(): CardMesh {
  const ring = buildRing();
  const ringCount = ring.length;
  const halfThickness = CARD_THICKNESS / 2;

  const vertices: number[] = [];
  const indices: number[] = [];
  let vertexCount = 0;

  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    tx: number,
    ty: number,
    tz: number,
    u: number,
    v: number,
    face: number
  ): number => {
    vertices.push(x, y, z, nx, ny, nz, tx, ty, tz, u, v, face);
    vertexCount += 1;
    return vertexCount - 1;
  };

  // Front face: triangle fan from the centre, counter-clockwise from +Z.
  const frontCenter = push(
    0,
    0,
    halfThickness,
    0,
    0,
    1,
    1,
    0,
    0,
    0.5,
    0.5,
    CARD_FACE.front
  );
  const frontStart = vertexCount;
  for (const point of ring) {
    push(
      point.x,
      point.y,
      halfThickness,
      0,
      0,
      1,
      1,
      0,
      0,
      (point.x + CARD_WIDTH / 2) / CARD_WIDTH,
      (CARD_HEIGHT / 2 - point.y) / CARD_HEIGHT,
      CARD_FACE.front
    );
  }
  for (let i = 0; i < ringCount; i += 1) {
    indices.push(
      frontCenter,
      frontStart + i,
      frontStart + ((i + 1) % ringCount)
    );
  }

  // Back face: same fan wound the other way so it faces -Z.
  const backCenter = push(
    0,
    0,
    -halfThickness,
    0,
    0,
    -1,
    -1,
    0,
    0,
    0.5,
    0.5,
    CARD_FACE.back
  );
  const backStart = vertexCount;
  for (const point of ring) {
    push(
      point.x,
      point.y,
      -halfThickness,
      0,
      0,
      -1,
      -1,
      0,
      0,
      (CARD_WIDTH / 2 - point.x) / CARD_WIDTH,
      (CARD_HEIGHT / 2 - point.y) / CARD_HEIGHT,
      CARD_FACE.back
    );
  }
  for (let i = 0; i < ringCount; i += 1) {
    indices.push(backCenter, backStart + ((i + 1) % ringCount), backStart + i);
  }

  // Side wall: one quad per ring segment, outward normals from the outline.
  const edgeStart = vertexCount;
  for (const point of ring) {
    // The rim is milled around the perimeter, so its brushing runs along the
    // outline rather than along the card's long axis.
    push(
      point.x,
      point.y,
      halfThickness,
      point.nx,
      point.ny,
      0,
      -point.ny,
      point.nx,
      0,
      point.s,
      1,
      CARD_FACE.edge
    );
    push(
      point.x,
      point.y,
      -halfThickness,
      point.nx,
      point.ny,
      0,
      -point.ny,
      point.nx,
      0,
      point.s,
      0,
      CARD_FACE.edge
    );
  }
  for (let i = 0; i < ringCount; i += 1) {
    const next = (i + 1) % ringCount;
    const topA = edgeStart + i * 2;
    const bottomA = topA + 1;
    const topB = edgeStart + next * 2;
    const bottomB = topB + 1;
    indices.push(topA, bottomA, bottomB);
    indices.push(topA, bottomB, topB);
  }

  return {
    vertices: new Float32Array(vertices),
    indices: new Uint16Array(indices),
    vertexCount,
    indexCount: indices.length,
  };
}

/** Geometry descriptor accepted by `geometry(gpu, options)`. */
export function cardGeometryOptions(): GeometryOptions {
  const mesh = buildCardMesh();
  return {
    label: "card",
    buffers: [
      {
        attributes: {
          position: "float32x3",
          normal: "float32x3",
          tangent: "float32x3",
          uv: "float32x2",
          face: "float32",
        } as const,
        data: mesh.vertices,
        stride: CARD_VERTEX_STRIDE,
      },
    ],
    indices: mesh.indices,
  };
}
