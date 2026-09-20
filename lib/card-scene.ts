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

/** Idle yaw sway amplitude in radians (12 degrees). */
const SWAY_YAW = (12 * Math.PI) / 180;

/** Idle float amplitude in millimetres. */
const SWAY_FLOAT = 1.1;

export interface CardSceneOptions {
  readonly shader: string | ShaderSource;
  readonly preset: PresetName;
  readonly designs: Record<CardSide, Uint8Array>;
  readonly aspect: number;
  /** Initial orbit pose, a three-quarter view by default. */
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
  /** Applies the idle sway; `amount` fades it out while the user is dragging. */
  animate(time: number, amount: number): void;
  /** Uploads camera and model matrices for the current frame. */
  sync(): void;
  setAspect(aspect: number): void;
  setPreset(preset: PresetName): void;
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
      material: cardMaterial(options.preset),
      frontDesign: design("front", "card-front"),
      backDesign: design("back", "card-back"),
      designSampler,
    },
  });

  const placeCamera = (aspect: number): void => {
    const distance = cardCameraDistance(aspect);
    const yaw = options.yaw ?? 0.42;
    const pitch = options.pitch ?? 0.3;
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

  placeCamera(options.aspect);

  return {
    draw,
    camera,
    model,
    animate(time: number, amount: number): void {
      model.set({
        rotation: [0, Math.sin(time * 0.33) * SWAY_YAW * amount, 0],
        position: [0, Math.sin(time * 0.52) * SWAY_FLOAT * amount, 0],
      });
    },
    sync(): void {
      draw.set({
        camera: {
          viewProjection: camera.viewProjection,
          position: camera.worldPosition,
        },
        model: { matrix: model.worldMatrix },
      });
    },
    setAspect(aspect: number): void {
      camera.set({ aspect });
    },
    setPreset(preset: PresetName): void {
      draw.set({ material: cardMaterial(preset) });
    },
    destroy(): void {
      geometry.destroy();
      for (const item of textures) item.destroy();
    },
  };
}
