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

/** Seconds after the pointer is released before the spin resumes. */
const RESUME_DELAY = 3;

/** Easing rate (per second) for the camera pitch returning to its home value. */
const PITCH_RETURN_RATE = 2.5;

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

      // The spin stops while the pointer is down and resumes RESUME_DELAY
      // seconds after release; the camera pitch eases back to its home value.
      const homePitch = controls.pitch;
      let pointerDown = false;
      let sinceRelease = RESUME_DELAY;
      const onPointerDown = () => {
        pointerDown = true;
      };
      const onPointerUp = () => {
        pointerDown = false;
        sinceRelease = 0;
      };
      const onWheel = () => {
        sinceRelease = 0;
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: true });

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
        if (!pointerDown) {
          sinceRelease += delta;
          const pitchError = homePitch - controls.pitch;
          if (Math.abs(pitchError) > 1e-4) {
            controls.set({
              pitch:
                controls.pitch +
                pitchError * Math.min(1, delta * PITCH_RETURN_RATE),
            });
          }
        }
        controls.update(delta);

        const spinning = !pointerDown && sinceRelease >= RESUME_DELAY;
        card.animate(time.time, spinning ? 1 : 0);
        card.sync();

        frame.pass({ target: scene, clear: true, clearDepth: 1 }, (pass) => {
          pass.draw(card.draw);
        });
        frame.pass(canvasSurface, present);
      });

      const teardown = () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("wheel", onWheel);
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
