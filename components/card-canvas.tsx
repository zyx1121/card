"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { startCard } from "@/lib/card-runtime";
import type { PresetName } from "@/lib/card-presets";

export function CardCanvas({ preset }: { preset: PresetName }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  // `init()` rejects when the browser has no WebGPU, so the fallback is driven
  // from this callback rather than from a check inside the effect body.
  const handleError = useCallback(() => setFailed(true), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startCard(canvas, { preset, onError: handleError });
  }, [preset, handleError]);

  if (failed) {
    return <p className="text-muted-foreground text-sm">WebGPU required</p>;
  }

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      aria-label="Business card"
    />
  );
}
