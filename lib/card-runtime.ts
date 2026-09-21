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
  CARD_ROLL_EASE,
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

/**
 * Render budget in device pixels for the full-viewport canvas.
 *
 * The card shader is heavy (anisotropic GGX, four lights, relief and sparkle
 * per pixel) and the target is multisampled, so a phone at DPR 3 would draw
 * three to four million samples per frame. The DPR is clamped so the canvas
 * never exceeds the budget; a touch device gets a smaller one than a desktop.
 */
const PIXEL_BUDGET_TOUCH = 1.4e6;
const PIXEL_BUDGET_DESKTOP = 3.6e6;

/** Largest DPR that keeps `canvas` inside the pixel budget, at least 1. */
function budgetDpr(canvas: HTMLCanvasElement): number {
  const isTouch = navigator.maxTouchPoints > 0;
  const budget = isTouch ? PIXEL_BUDGET_TOUCH : PIXEL_BUDGET_DESKTOP;
  const cssPixels = Math.max(1, canvas.clientWidth * canvas.clientHeight);
  const fit = Math.sqrt(budget / cssPixels);
  return Math.max(1, Math.min(window.devicePixelRatio || 1, fit));
}

/** Length of the one-shot intro move, in seconds. */
const INTRO_DURATION = 1.6;

/** Where the intro starts: edge-on, above the card and further out. */
const INTRO_YAW = (-110 * Math.PI) / 180;
const INTRO_PITCH = (20 * Math.PI) / 180;
const INTRO_DISTANCE_SCALE = 1.8;

/** Easing time constant of the cursor light, in seconds. */
const POINTER_EASE = 0.08;

/** Seconds without a pointer before the cursor light fades out. */
const POINTER_TIMEOUT = 1.5;

/** Cubic ease-out, the intro's only curve. */
function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

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
  /** Fires once the first frame has been submitted, so the canvas can fade in. */
  readonly onReady?: () => void;
}

/**
 * Starts the card renderer on `canvas` and returns its teardown function.
 *
 * 3D needs a depth attachment and a canvas surface has none, so the card is
 * drawn into an offscreen target and composited in a second pass. That target
 * holds the premultiplied picture with the card's coverage in alpha, and it is
 * multisampled, because the card's silhouette is a hard edge against the page.
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
        dpr: [1, budgetDpr(canvas)],
        clearColor: background,
      });
      const [initialWidth, initialHeight] = canvasSurface.size;
      // The card writes premultiplied colour with its coverage in alpha, so the
      // target clears to nothing at all and the composite lays the result over
      // the page background. That is also what makes the MSAA resolve correct.
      // `rgba8unorm`, because WebGPU compatibility mode refuses to multisample
      // a float format.
      const scene = target(gpu, {
        size: [initialWidth, initialHeight],
        colors: [{ format: "rgba8unorm" }],
        depth: true,
        msaa: true,
        clearColor: [0, 0, 0, 0],
        label: "card-scene",
      });

      const api: VgpuApi = { draw, geometry, sampler, texture };
      const card = createCardScene(api, gpu, {
        shader: cardShader,
        preset: options.preset,
        designs: await renderCardFacesInBrowser(),
        aspect: initialWidth / initialHeight,
      });

      const compositeValue = () => ({
        background: [background[0], background[1], background[2]] as [
          number,
          number,
          number,
        ],
      });

      const present = effect(gpu, presentShader, {
        label: "present",
        set: {
          scene: scene.colors[0],
          composite: compositeValue(),
        },
      });

      // Portrait and landscape frame the card differently, so the distance is
      // refit whenever the canvas changes shape. It is a `let` because the
      // intro and the pitch return both read the current framing.
      let distance = cardCameraDistance(initialWidth / initialHeight);
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
      const homeYaw = controls.yaw;
      const homePitch = controls.pitch;
      let pointerDown = false;
      let sinceRelease = RESUME_DELAY;

      // The intro runs once per load and is skipped the moment the visitor
      // touches the canvas.
      let introElapsed = 0;
      let introDone = false;
      const endIntro = () => {
        introDone = true;
        controls.set({ yaw: homeYaw, pitch: homePitch, distance });
      };

      // Cursor light: the last pointer position in NDC, an idle timer and the
      // eased intensity the shader actually sees.
      let pointerNdc: [number, number] | undefined;
      let sincePointer = POINTER_TIMEOUT;
      let pointerIntensity = 0;

      const trackPointer = (event: PointerEvent): void => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        pointerNdc = [
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          1 - ((event.clientY - rect.top) / rect.height) * 2,
        ];
        sincePointer = 0;
      };

      const onPointerDown = (event: PointerEvent) => {
        pointerDown = true;
        if (!introDone) endIntro();
        trackPointer(event);
      };
      const onPointerUp = (event: PointerEvent) => {
        pointerDown = false;
        sinceRelease = 0;
        // A touch has no hover, so the light fades as soon as the finger lifts.
        if (event.pointerType !== "mouse") sincePointer = POINTER_TIMEOUT;
      };
      const onWheel = () => {
        sinceRelease = 0;
      };
      const onPointerLeave = () => {
        sincePointer = POINTER_TIMEOUT;
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", trackPointer);
      canvas.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: true });

      // A refit in flight: where the camera distance is coming from, where it
      // is going and how far through the ease it is.
      let refit: { from: number; to: number; elapsed: number } | undefined;

      const unsubscribeResize = canvasSurface.onResize((event) => {
        scene.resize([event.width, event.height]);
        // Binding a specific attachment does not follow a resize, so it is
        // rebound against the new generation.
        present.set({ scene: scene.colors[0] });
        card.setAspect(event.width / event.height);
        const next = cardCameraDistance(event.width / event.height);
        // Sub-millimetre refits are the browser rounding the canvas, not a new
        // framing, and are not worth an ease.
        if (Math.abs(next - distance) > 0.5) {
          refit = { from: controls.distance, to: next, elapsed: 0 };
          distance = next;
        }
      });

      const applyTheme = () => {
        const color = readCssColor(document.body, "--background");
        canvasSurface.clearColor = color;
        background[0] = color[0];
        background[1] = color[1];
        background[2] = color[2];
      };
      const observer = new MutationObserver(applyTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      stopThemeWatch = () => observer.disconnect();

      const time = clock(gpu);
      let ready = false;
      loop = frameLoop(gpu, (frame) => {
        const delta = time.deltaTime;

        if (!introDone) {
          introElapsed += delta;
          const eased = easeOutCubic(introElapsed / INTRO_DURATION);
          const from = distance * INTRO_DISTANCE_SCALE;
          controls.set({
            yaw: INTRO_YAW + (homeYaw - INTRO_YAW) * eased,
            pitch: INTRO_PITCH + (homePitch - INTRO_PITCH) * eased,
            distance: from + (distance - from) * eased,
          });
          if (introElapsed >= INTRO_DURATION) introDone = true;
          // The intro already flies to the current framing, so a refit that
          // lands mid-intro needs nothing of its own.
          refit = undefined;
        } else if (!pointerDown) {
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
        if (refit) {
          refit.elapsed += delta;
          const eased = easeOutCubic(refit.elapsed / CARD_ROLL_EASE);
          // `set()` moves state and goal together, so the visitor's own zoom is
          // overridden for the length of the ease and then handed back.
          controls.set({
            distance: refit.from + (refit.to - refit.from) * eased,
          });
          if (refit.elapsed >= CARD_ROLL_EASE) refit = undefined;
        }
        controls.update(delta);

        // The cursor light glides rather than snaps, and dies out once the
        // pointer has been gone for POINTER_TIMEOUT.
        sincePointer += delta;
        const wanted = pointerNdc && sincePointer < POINTER_TIMEOUT ? 1 : 0;
        pointerIntensity +=
          (wanted - pointerIntensity) * (1 - Math.exp(-delta / POINTER_EASE));
        if (pointerNdc && pointerIntensity > 0.001) {
          card.setPointer(
            card.pointerPlanePoint(pointerNdc[0], pointerNdc[1]),
            pointerIntensity
          );
        } else {
          card.setPointer([0, 0, 0], 0);
        }

        const spinning =
          introDone && !pointerDown && sinceRelease >= RESUME_DELAY;
        card.animate(time.time, spinning ? 1 : 0);
        card.sync();
        // The background token can change under the theme watcher, so the
        // composite's clear colour is uploaded every frame.
        present.set({ composite: compositeValue() });

        frame.pass({ target: scene, clear: true, clearDepth: 1 }, (pass) => {
          pass.draw(card.draw);
        });
        frame.pass(canvasSurface, present);

        if (!ready) {
          ready = true;
          options.onReady?.();
        }
      });

      const teardown = () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", trackPointer);
        canvas.removeEventListener("pointerleave", onPointerLeave);
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
