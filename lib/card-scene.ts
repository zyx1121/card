import type { Draw, Geometry, Gpu, ShaderSource, Texture } from "vgpu";
import {
  group,
  perspectiveCamera,
  type PerspectiveCamera,
  type SceneNode,
} from "vgpu/scene";

import {
  SPLAT_COUNT,
  SPLAT_LIFT,
  SPLAT_SIZE,
  solidMix,
  type CardFx,
} from "@/lib/card-fx";
import { cardGeometryOptions } from "@/lib/card-geometry";
import { cardMaterial, type PresetName } from "@/lib/card-presets";
import { splatGeometryOptions } from "@/lib/card-splats";
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
  /** `shaders/splat.wgsl`, for the `fx=splat` point cloud. */
  readonly splatShader: string | ShaderSource;
  readonly preset: PresetName;
  readonly fx: CardFx;
  readonly designs: Record<CardSide, Uint8Array>;
  readonly aspect: number;
  /** Splats in the cloud; the render script lowers it on slow adapters. */
  readonly splatCount?: number;
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
  /** The point cloud, drawn over the solid card when `fx=splat`. */
  readonly splatDraw: Draw;
  readonly splatCount: number;
  readonly camera: PerspectiveCamera;
  readonly model: SceneNode;
  /** Advances the idle spin; `amount` fades it out while the user is dragging. */
  animate(time: number, amount: number): void;
  /** Uploads camera, model, pointer and splat state for the current frame. */
  sync(): void;
  setAspect(aspect: number): void;
  setPreset(preset: PresetName): void;
  /** Switches the grain variant, which is what dims the solid card. */
  setFx(fx: CardFx): void;
  /** Advances the splat twinkle. One tick every few frames, not every frame. */
  setTick(tick: number): void;
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
 * `perspectiveCamera` only supplying the view-projection matrix. The card pass
 * writes two colour attachments, the picture and the outline's geometry buffer,
 * and the splat pass blends over it without touching the second one.
 */
export function createCardScene(
  api: VgpuApi,
  gpu: Gpu,
  options: CardSceneOptions
): CardScene {
  const geometry = api.geometry(gpu, cardGeometryOptions());
  const splatCount = options.splatCount ?? SPLAT_COUNT;
  const splatGeometry: Geometry = api.geometry(
    gpu,
    splatGeometryOptions(splatCount)
  );

  const designSampler = api.sampler(gpu, {
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    maxAnisotropy: 8,
  });

  let aspect = options.aspect;
  let fx = options.fx;

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

  const splat = { size: SPLAT_SIZE, tick: 0, lift: SPLAT_LIFT };

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

  /**
   * The camera basis in world space, which the splat pass needs to face its
   * quads at the viewer. The view matrix maps world to camera space, so the
   * rows of its rotation block are exactly that basis.
   */
  const splatCameraValue = () => {
    const view = camera.view;
    return {
      ...cameraValue(),
      right: [view[0], view[4], view[8]] as [number, number, number],
      up: [view[1], view[5], view[9]] as [number, number, number],
    };
  };

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
      style: { solidMix: solidMix(fx) },
    },
  });

  // The cloud is premultiplied over the solid card and never writes depth: the
  // quads overlap each other, and sorting a hundred thousand of them per frame
  // is not what this is for.
  //
  // It also has to leave the outline's geometry buffer alone, so the line keeps
  // reading the solid card's own silhouette and crease. A per-attachment write
  // mask would be the obvious way to say that, but WebGPU compatibility mode
  // requires every colour target to share one blend state and one write mask.
  // Instead the shader writes a fully transparent black to that attachment, and
  // premultiplied blending leaves the destination exactly as it found it.
  const splatDraw = api.draw(gpu, {
    label: "card-splats",
    shader: options.splatShader,
    geometry: splatGeometry,
    cull: "none",
    blend: "premultiplied",
    depth: { write: false, compare: "less-equal" },
    set: {
      camera: splatCameraValue(),
      model: { matrix: model.worldMatrix },
      ...shared,
      pointer,
      splat,
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
    splatDraw,
    splatCount,
    camera,
    model,
    animate(time: number, amount: number): void {
      const delta = lastTime === undefined ? 0 : Math.max(0, time - lastTime);
      lastTime = time;
      spinYaw = (spinYaw + delta * SPIN_SPEED * amount) % (2 * Math.PI);
      model.set({ rotation: [0, spinYaw, 0] });
    },
    sync(): void {
      const matrix = { matrix: model.worldMatrix };
      draw.set({ camera: cameraValue(), model: matrix, pointer });
      splatDraw.set({
        camera: splatCameraValue(),
        model: matrix,
        pointer,
        splat,
      });
    },
    setAspect(next: number): void {
      aspect = next;
      camera.set({ aspect: next });
    },
    setPreset(preset: PresetName): void {
      const material = cardMaterial(preset);
      draw.set({ material });
      splatDraw.set({ material });
    },
    setFx(next: CardFx): void {
      fx = next;
      draw.set({ style: { solidMix: solidMix(fx) } });
    },
    setTick(tick: number): void {
      splat.tick = tick;
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
      splatGeometry.destroy();
      for (const item of textures) item.destroy();
    },
  };
}
