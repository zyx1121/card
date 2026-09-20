import {
  clock,
  draw,
  effect,
  frameLoop,
  geometry,
  init,
  sampler,
  surface,
  target,
  texture,
  type FrameLoopHandle,
  type Gpu,
} from "vgpu";
import { orbitControls } from "vgpu/scene";

import cardShader from "@/shaders/card.wgsl";
import presentShader from "@/shaders/present.wgsl";

import {
  cardCameraDistance,
  createCardScene,
  type VgpuApi,
} from "@/lib/card-scene";
import type { PresetName } from "@/lib/card-presets";
import { renderCardFacesInBrowser } from "@/lib/card-texture";

/** Seconds of stillness before the idle sway fades back in. */
const RESUME_DELAY = 2;

const MAX_PITCH = (80 * Math.PI) / 180;

/** Reads a CSS colour token as sRGB components in 0..1. */
function readCssColor(
  element: HTMLElement,
  property: string
): [number, number, number, number] {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;background-color:var(${property})`;
  element.appendChild(probe);
  const computed = getComputedStyle(probe).backgroundColor;
  probe.remove();

  // The browser may report oklch(), color() or rgb(); a 2D canvas resolves all
  // of them to plain sRGB bytes.
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [1, 1, 1, 1];
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}

export interface CardRuntimeOptions {
  readonly preset: PresetName;
  /** Reports fatal startup problems, typically missing WebGPU support. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Starts the card renderer on `canvas` and returns its teardown function.
 *
 * 3D needs a depth attachment and a canvas surface has none, so the card is
 * drawn into an offscreen target and composited in a second pass.
 */
export function startCard(
  canvas: HTMLCanvasElement,
  options: CardRuntimeOptions
): () => void {
  let disposed = false;
  let cleanup: (() => void) | undefined;
  let loop: FrameLoopHandle | undefined;
  let gpu: Gpu | undefined;
  let stopThemeWatch: (() => void) | undefined;

  void (async () => {
    try {
      gpu = await init();
      if (disposed) {
        gpu.dispose();
        return;
      }

      const background = readCssColor(document.body, "--background");
      const canvasSurface = surface(gpu, canvas, {
        dpr: [1, 2],
        clearColor: background,
      });
      const [initialWidth, initialHeight] = canvasSurface.size;
      const scene = target(gpu, {
        size: [initialWidth, initialHeight],
        depth: true,
        clearColor: background,
        label: "card-scene",
      });

      const api: VgpuApi = { draw, geometry, sampler, texture };
      const card = createCardScene(api, gpu, {
        shader: cardShader,
        preset: options.preset,
        designs: await renderCardFacesInBrowser(),
        aspect: initialWidth / initialHeight,
      });

      const present = effect(gpu, presentShader, {
        label: "present",
        set: {
          scene,
          sceneSampler: sampler(gpu, {
            minFilter: "linear",
            magFilter: "linear",
          }),
        },
      });

      const distance = cardCameraDistance(initialWidth / initialHeight);
      const controls = orbitControls(card.camera, {
        element: canvas,
        damping: 0.12,
        pitch: { min: -MAX_PITCH, max: MAX_PITCH },
        // Close enough to inspect the stock, never inside the card itself.
        distance: { min: 70, max: 520 },
      });
      controls.set({ distance });

      // The idle sway pauses while the card is being dragged, then eases back.
      let idleSince = 0;
      let swayAmount = 1;
      const markInteraction = () => {
        idleSince = 0;
      };
      canvas.addEventListener("pointerdown", markInteraction);
      canvas.addEventListener("pointermove", markInteraction);
      canvas.addEventListener("wheel", markInteraction, { passive: true });

      const unsubscribeResize = canvasSurface.onResize((event) => {
        scene.resize([event.width, event.height]);
        present.set({ scene });
        card.setAspect(event.width / event.height);
      });

      const applyTheme = () => {
        const color = readCssColor(document.body, "--background");
        canvasSurface.clearColor = color;
        scene.clearColor = color;
      };
      const observer = new MutationObserver(applyTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      stopThemeWatch = () => observer.disconnect();

      const time = clock(gpu);
      loop = frameLoop(gpu, (frame) => {
        const delta = time.deltaTime;
        const moved = controls.update(delta);
        if (moved) idleSince = 0;
        idleSince += delta;

        const targetAmount = idleSince > RESUME_DELAY ? 1 : 0;
        swayAmount += (targetAmount - swayAmount) * Math.min(1, delta * 1.5);

        card.animate(time.time, swayAmount);
        card.sync();

        frame.pass({ target: scene, clear: true, clearDepth: 1 }, (pass) => {
          pass.draw(card.draw);
        });
        frame.pass(canvasSurface, present);
      });

      const teardown = () => {
        canvas.removeEventListener("pointerdown", markInteraction);
        canvas.removeEventListener("pointermove", markInteraction);
        canvas.removeEventListener("wheel", markInteraction);
        unsubscribeResize();
        controls.dispose();
        card.destroy();
      };
      cleanup = teardown;
    } catch (error) {
      options.onError?.(error);
      gpu?.dispose();
    }
  })();

  return () => {
    disposed = true;
    loop?.stop();
    cleanup?.();
    stopThemeWatch?.();
    gpu?.dispose();
  };
}
