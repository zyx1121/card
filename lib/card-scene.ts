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
  destroy(): void;
}

/**
 * Builds the draws that render the card.
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

  const shared = {
    material: cardMaterial(options.preset),
    frontDesign,
    backDesign,
    designSampler,
  };

  const cameraValue = () => ({
    viewProjection: camera.viewProjection,
    position: camera.worldPosition,
  });

  const draw = api.draw(gpu, {
    label: "card",
    shader: options.shader,
    geometry,
    cull: "back",
    depth: { write: true, compare: "less-equal" },
    set: {
      camera: cameraValue(),
      model: { matrix: model.worldMatrix },
      ...shared,
      pointer,
    },
  });

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
    camera,
    model,
    animate(time: number, amount: number): void {
      const delta = lastTime === undefined ? 0 : Math.max(0, time - lastTime);
      lastTime = time;
      spinYaw = (spinYaw + delta * SPIN_SPEED * amount) % (2 * Math.PI);
      model.set({ rotation: [0, spinYaw, 0] });
    },
    sync(): void {
      draw.set({
        camera: cameraValue(),
        model: { matrix: model.worldMatrix },
        pointer,
      });
    },
    setAspect(next: number): void {
      aspect = next;
      camera.set({ aspect: next });
    },
    setPreset(preset: PresetName): void {
      draw.set({ material: cardMaterial(preset) });
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
    destroy(): void {
      geometry.destroy();
      for (const item of textures) item.destroy();
    },
  };
}
