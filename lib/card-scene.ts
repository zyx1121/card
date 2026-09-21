import type { Draw, Gpu, ShaderSource, Texture } from "vgpu";
import {
  group,
  perspectiveCamera,
  type PerspectiveCamera,
  type SceneNode,
} from "vgpu/scene";

import { cardGeometryOptions } from "@/lib/card-geometry";
import { cardMaterial, type PresetName } from "@/lib/card-presets";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  TEXTURE_HEIGHT,
  TEXTURE_WIDTH,
} from "@/lib/card-spec";
import type { CardSide } from "@/lib/card-texture";
import { uploadDesignTexture } from "@/lib/design-texture";

/**
 * The vgpu factories the scene needs.
 *
 * `vgpu` and `vgpu/node` export the same functions from different entry
 * points, so the caller passes the ones for its environment.
 */
export interface VgpuApi {
  readonly draw: typeof import("vgpu").draw;
  readonly geometry: typeof import("vgpu").geometry;
  readonly sampler: typeof import("vgpu").sampler;
  readonly texture: typeof import("vgpu").texture;
}

/** Vertical field of view in degrees. */
export const CARD_FOV = 30;

/**
 * The hero pose: a shallow three-quarter view from the card's left, which is
 * how a metal card is shot for a product page. Radians.
 */
export const CARD_HERO_YAW = (-22 * Math.PI) / 180;

/** Hero pitch, just above the card's plane. Radians. */
export const CARD_HERO_PITCH = (8 * Math.PI) / 180;

/** Idle spin speed in radians per second: one full turn every 16 seconds. */
const SPIN_SPEED = (2 * Math.PI) / 16;

/** Gap between the card's bottom edge and the invisible floor, in millimetres. */
export const CARD_FLOAT_HEIGHT = 6;

/** The plane the floor reflection is mirrored about, in millimetres. */
export const CARD_FLOOR_Y = -(CARD_HEIGHT / 2 + CARD_FLOAT_HEIGHT);

/** Global gain of the floor reflection. */
const REFLECTION_STRENGTH = 0.35;

/**
 * Distance below the floor line over which the reflection dies, in millimetres.
 *
 * The mirrored card starts {@link CARD_FLOAT_HEIGHT} below the line, so it
 * never gets the full strength; by the bottom of a hero frame it is gone.
 */
const REFLECTION_FADE = 34;

/**
 * How far in front of the card the cursor light hangs, in millimetres.
 *
 * The light lives on a plane perpendicular to the view direction, so it tracks
 * the cursor from any orbit angle.
 */
export const POINTER_PLANE_OFFSET = 120;

/** A point in scene millimetres. */
export type ScenePoint = readonly [number, number, number];

export interface CardSceneOptions {
  readonly shader: string | ShaderSource;
  readonly preset: PresetName;
  readonly designs: Record<CardSide, Uint8Array>;
  readonly aspect: number;
  /** Initial orbit pose, the hero three-quarter view by default. */
  readonly yaw?: number;
  readonly pitch?: number;
}

/**
 * Distance at which the card fills the intended share of the viewport.
 *
 * Wide viewports get about 60% of the width, narrow (phone) viewports about
 * 85%. The height is checked too so a very wide window never crops the card.
 */
export function cardCameraDistance(aspect: number): number {
  const narrow = clamp01((1.4 - aspect) / (1.4 - 0.6));
  const widthFill = 0.6 + narrow * 0.25;
  const halfFov = (CARD_FOV * Math.PI) / 360;
  const byWidth = CARD_WIDTH / widthFill / (2 * Math.tan(halfFov) * aspect);
  const byHeight = CARD_HEIGHT / 0.72 / (2 * Math.tan(halfFov));
  return Math.max(byWidth, byHeight);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface CardScene {
  readonly draw: Draw;
  /** The same card mirrored about the floor plane, for the reflection pass. */
  readonly reflectionDraw: Draw;
  readonly camera: PerspectiveCamera;
  readonly model: SceneNode;
  /** Advances the idle spin; `amount` fades it out while the user is dragging. */
  animate(time: number, amount: number): void;
  /** Uploads camera, model and pointer state for the current frame. */
  sync(): void;
  setAspect(aspect: number): void;
  setPreset(preset: PresetName): void;
  /** Moves the cursor light; `intensity` 0 switches it off entirely. */
  setPointer(position: ScenePoint, intensity: number): void;
  /**
   * Where a camera ray through normalised device coordinates crosses the
   * cursor light's plane, in scene millimetres.
   */
  pointerPlanePoint(ndcX: number, ndcY: number): ScenePoint;
  /** Texture-space v of the floor line, which `present.wgsl` blurs around. */
  floorLine(): number;
  destroy(): void;
}

/**
 * Builds the single draw that renders the card.
 *
 * vgpu 0.5.0 has no scene renderer, so this is the low-level path: a custom
 * geometry with named attributes plus our own vertex and fragment stages, with
 * `perspectiveCamera` only supplying the view-projection matrix.
 */
export function createCardScene(
  api: VgpuApi,
  gpu: Gpu,
  options: CardSceneOptions
): CardScene {
  const geometry = api.geometry(gpu, cardGeometryOptions());

  const designSampler = api.sampler(gpu, {
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    maxAnisotropy: 8,
  });

  let aspect = options.aspect;

  const textures: Texture[] = [];
  const design = (side: CardSide, label: string): Texture => {
    const uploaded = uploadDesignTexture(
      gpu,
      api.texture,
      options.designs[side],
      TEXTURE_WIDTH,
      TEXTURE_HEIGHT,
      label
    );
    textures.push(uploaded);
    return uploaded;
  };

  const camera = perspectiveCamera({
    fov: CARD_FOV,
    aspect: options.aspect,
    near: 1,
    far: 2000,
    position: [0, 0, cardCameraDistance(options.aspect)],
    target: [0, 0, 0],
  });

  const model = group();

  const frontDesign = design("front", "card-front");
  const backDesign = design("back", "card-back");

  const pointer = {
    position: [0, 0, 0] as [number, number, number],
    intensity: 0,
  };

  // The mirror image of `model.worldMatrix`, rebuilt every `sync()`.
  const mirrorMatrix = new Float32Array(16);

  const shared = {
    material: cardMaterial(options.preset),
    frontDesign,
    backDesign,
    designSampler,
  };

  const draw = api.draw(gpu, {
    label: "card",
    shader: options.shader,
    geometry,
    cull: "back",
    depth: { write: true, compare: "less-equal" },
    set: {
      camera: {
        viewProjection: camera.viewProjection,
        position: camera.worldPosition,
      },
      model: { matrix: model.worldMatrix },
      ...shared,
      pointer,
      reflection: {
        floorY: CARD_FLOOR_Y,
        fade: REFLECTION_FADE,
        strength: REFLECTION_STRENGTH,
        isReflection: 0,
      },
    },
  });

  // The floor reflection is the same card under a mirrored model matrix. A
  // mirror flips the winding, so clockwise triangles are the front ones here.
  const reflectionDraw = api.draw(gpu, {
    label: "card-reflection",
    shader: options.shader,
    geometry,
    cull: "back",
    frontFace: "cw",
    depth: { write: true, compare: "less-equal" },
    set: {
      camera: {
        viewProjection: camera.viewProjection,
        position: camera.worldPosition,
      },
      model: { matrix: mirrorMatrix },
      ...shared,
      pointer,
      reflection: {
        floorY: CARD_FLOOR_Y,
        fade: REFLECTION_FADE,
        strength: REFLECTION_STRENGTH,
        isReflection: 1,
      },
    },
  });

  /** Mirrors a rigid model matrix about `y = CARD_FLOOR_Y`, in place. */
  const mirrorAboutFloor = (source: Float32Array): Float32Array => {
    mirrorMatrix.set(source);
    for (let column = 0; column < 4; column += 1) {
      mirrorMatrix[column * 4 + 1] = -source[column * 4 + 1];
    }
    mirrorMatrix[13] += 2 * CARD_FLOOR_Y;
    return mirrorMatrix;
  };

  const placeCamera = (): void => {
    const distance = cardCameraDistance(aspect);
    const yaw = options.yaw ?? CARD_HERO_YAW;
    const pitch = options.pitch ?? CARD_HERO_PITCH;
    camera.set({
      aspect,
      position: [
        Math.sin(yaw) * Math.cos(pitch) * distance,
        Math.sin(pitch) * distance,
        Math.cos(yaw) * Math.cos(pitch) * distance,
      ],
    });
    camera.lookAt([0, 0, 0]);
  };

  placeCamera();

  let spinYaw = 0;
  let lastTime: number | undefined;

  return {
    draw,
    reflectionDraw,
    camera,
    model,
    animate(time: number, amount: number): void {
      const delta = lastTime === undefined ? 0 : Math.max(0, time - lastTime);
      lastTime = time;
      spinYaw = (spinYaw + delta * SPIN_SPEED * amount) % (2 * Math.PI);
      model.set({ rotation: [0, spinYaw, 0] });
    },
    sync(): void {
      const view = {
        camera: {
          viewProjection: camera.viewProjection,
          position: camera.worldPosition,
        },
        pointer,
      };
      draw.set({ ...view, model: { matrix: model.worldMatrix } });
      reflectionDraw.set({
        ...view,
        model: { matrix: mirrorAboutFloor(model.worldMatrix as Float32Array) },
      });
    },
    setAspect(next: number): void {
      aspect = next;
      camera.set({ aspect: next });
    },
    setPreset(preset: PresetName): void {
      const material = cardMaterial(preset);
      draw.set({ material });
      reflectionDraw.set({ material });
    },
    setPointer(position: ScenePoint, intensity: number): void {
      pointer.position[0] = position[0];
      pointer.position[1] = position[1];
      pointer.position[2] = position[2];
      pointer.intensity = intensity;
    },
    pointerPlanePoint(ndcX: number, ndcY: number): ScenePoint {
      // The view matrix maps world to camera space, so its rows are the camera
      // basis in world space: right, up and the direction behind the camera.
      const view = camera.view;
      const eye = camera.worldPosition;
      // The camera always looks at the origin, where the card is.
      const toCard = Math.hypot(eye[0], eye[1], eye[2]);
      const depth = Math.max(1, toCard - POINTER_PLANE_OFFSET);
      // The lamp hangs on the plane POINTER_PLANE_OFFSET in front of the card,
      // directly ahead of the point the cursor is over. Intersecting the cursor
      // ray with that plane instead would barely move the lamp at all: at hero
      // framing the plane is only about a third of the way out from the eye, so
      // the whole viewport maps to a couple of centimetres and the pool sits
      // still.
      const extent = Math.tan((CARD_FOV * Math.PI) / 360) * toCard;
      const x = ndcX * extent * aspect;
      const y = ndcY * extent;
      return [
        eye[0] - view[2] * depth + view[0] * x + view[1] * y,
        eye[1] - view[6] * depth + view[4] * x + view[5] * y,
        eye[2] - view[10] * depth + view[8] * x + view[9] * y,
      ];
    },
    floorLine(): number {
      const m = camera.viewProjection;
      const clipY = m[5] * CARD_FLOOR_Y + m[13];
      const clipW = m[7] * CARD_FLOOR_Y + m[15];
      if (clipW === 0) return 1;
      return 1 - ((clipY / clipW) * 0.5 + 0.5);
    },
    destroy(): void {
      geometry.destroy();
      for (const item of textures) item.destroy();
    },
  };
}
