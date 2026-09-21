"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { startCard } from "@/lib/card-runtime";
import type { CardFx } from "@/lib/card-fx";
import type { PresetName } from "@/lib/card-presets";

export function CardCanvas({
  preset,
  fx,
  outline,
  background,
}: {
  preset: PresetName;
  fx: CardFx;
  outline: [number, number, number];
  background?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  // `init()` rejects when the browser has no WebGPU, so the fallback is driven
  // from this callback rather than from a check inside the effect body.
  const handleError = useCallback(() => setFailed(true), []);
  // The first WebGPU frame lands well after paint, so the canvas fades in
  // instead of popping from an empty surface to a lit card.
  const handleReady = useCallback(() => setReady(true), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // If the first frame never arrives the canvas must not stay invisible, so
    // it fades in regardless after three seconds.
    const fallback = window.setTimeout(handleReady, 3000);
    // `?bg=` overrides the theme token; the runtime watches the style attribute
    // and re-reads the clear colour.
    const root = document.documentElement;
    const previousBackground = root.style.getPropertyValue("--background");
    if (background) root.style.setProperty("--background", background);
    const stop = startCard(canvas, {
      preset,
      fx,
      outlineColor: outline,
      onError: handleError,
      onReady: handleReady,
    });
    return () => {
      window.clearTimeout(fallback);
      stop();
      if (background) {
        if (previousBackground) {
          root.style.setProperty("--background", previousBackground);
        } else {
          root.style.removeProperty("--background");
        }
      }
    };
  }, [preset, fx, outline, background, handleError, handleReady]);

  if (failed) {
    return <p className="text-muted-foreground text-sm">WebGPU required</p>;
  }

  return (
    <canvas
      ref={canvasRef}
      className={`h-full w-full touch-none transition-opacity duration-500 ${
        ready ? "opacity-100" : "opacity-0"
      }`}
      aria-label="Business card"
    />
  );
}
