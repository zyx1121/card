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
 * Quarter turn the card is rolled by on a portrait viewport, in radians.
 *
 * Negative is clockwise on screen, so the card's top edge swings to the right:
 * the mark ends up in the top-right corner and the name runs down the left
 * side, which is how a card is held to be read on a phone.
 */
export const CARD_PORTRAIT_ROLL = -Math.PI / 2;

/**
 * Seconds the portrait roll and the matching refit take.
 *
 * A resize or an orientation change is a real event, not a layout glitch, so
 * the card turns into its new framing instead of snapping.
 */
export const CARD_ROLL_EASE = 0.4;

/**
 * Easing rate of the roll, per second.
 *
 * It is a time constant, so the roll covers about 95% of the turn within
 * {@link CARD_ROLL_EASE}.
 */
const ROLL_RATE = 3 / CARD_ROLL_EASE;

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

/** True when the canvas is taller than it is wide, where the card is rolled. */
export function isPortrait(aspect: number): boolean {
  return aspect < 1;
}

/**
 * Distance at which the card fills the intended share of the viewport.
 *
 * Wide viewports get about 60% of the width, narrowing to about 85% as the
 * window squares up. A portrait viewport is a different framing altogether:
 * the card is rolled upright, so it is the 54 mm side that has to fit the
 * width, and it is given 85% of it. Either way the other axis is checked too,
 * so no window shape ever crops the card.
 */
export function cardCameraDistance(aspect: number): number {
  const span = 2 * Math.tan((CARD_FOV * Math.PI) / 360);
  if (isPortrait(aspect)) {
    return Math.max(
      CARD_HEIGHT / 0.85 / (span * aspect),
      CARD_WIDTH / 0.82 / span
    );
  }
  const narrow = clamp01((1.4 - aspect) / (1.4 - 0.6));
  const widthFill = 0.6 + narrow * 0.25;
  return Math.max(
    CARD_WIDTH / widthFill / (span * aspect),
    CARD_HEIGHT / 0.72 / span
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface CardScene {
  readonly draw: Draw;
  readonly camera: PerspectiveCamera;
  readonly model: SceneNode;
  /**
   * Advances the idle spin and the portrait roll; `amount` fades the spin out
   * while the user is dragging, the roll always eases.
   */
  animate(time: number, amount: number): void;
  /** Uploads camera, model and pointer state for the current frame. */
  sync(): void;
  /** Reframes for a new canvas aspect, which may also start the portrait roll. */
  setAspect(aspect: number): void;
  /** Tilts the card about its own X axis, for the rim macro. Radians. */
  setTilt(tilt: number): void;
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
  let tilt = 0;
  let roll = isPortrait(aspect) ? CARD_PORTRAIT_ROLL : 0;
  let rollGoal = roll;
  let lastTime: number | undefined;

  // `rotation` is intrinsic XYZ Euler, so this is Rx(tilt) * Ry(spin) *
  // Rz(roll): the portrait roll turns the card in its own frame first, and the
  // spin stays about the world (screen-vertical) axis on top of it. Rolling
  // last instead would tip the spin axis over with the card and the flip would
  // read as a somersault rather than a turn.
  const placeCard = (): void => {
    model.set({ rotation: [tilt, spinYaw, roll] });
  };

  placeCard();

  return {
    draw,
    camera,
    model,
    animate(time: number, amount: number): void {
      const delta = lastTime === undefined ? 0 : Math.max(0, time - lastTime);
      lastTime = time;
      spinYaw = (spinYaw + delta * SPIN_SPEED * amount) % (2 * Math.PI);
      if (Math.abs(rollGoal - roll) > 1e-4) {
        roll += (rollGoal - roll) * (1 - Math.exp(-delta * ROLL_RATE));
      } else {
        roll = rollGoal;
      }
      placeCard();
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
      rollGoal = isPortrait(next) ? CARD_PORTRAIT_ROLL : 0;
    },
    setTilt(next: number): void {
      tilt = next;
      placeCard();
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
