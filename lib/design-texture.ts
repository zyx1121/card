import type { Gpu, Texture } from "vgpu";

export interface MipLevel {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Box-filters an RGBA8 image down to 1x1.
 *
 * Filtering happens in premultiplied alpha so the ink coverage mask does not
 * bleed white fringes into the paper, then the result is un-premultiplied
 * again because that is how the shader reads it.
 */
export function buildMipChain(
  data: Uint8Array,
  width: number,
  height: number
): MipLevel[] {
  const levels: MipLevel[] = [{ width, height, data }];
  let source = data;
  let sourceWidth = width;
  let sourceHeight = height;

  while (sourceWidth > 1 || sourceHeight > 1) {
    const nextWidth = Math.max(1, sourceWidth >> 1);
    const nextHeight = Math.max(1, sourceHeight >> 1);
    const next = new Uint8Array(nextWidth * nextHeight * 4);

    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let samples = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          const sy = Math.min(sourceHeight - 1, y * 2 + dy);
          for (let dx = 0; dx < 2; dx += 1) {
            const sx = Math.min(sourceWidth - 1, x * 2 + dx);
            const offset = (sy * sourceWidth + sx) * 4;
            const alpha = source[offset + 3] / 255;
            r += source[offset] * alpha;
            g += source[offset + 1] * alpha;
            b += source[offset + 2] * alpha;
            a += source[offset + 3];
            samples += 1;
          }
        }
        const alpha = a / samples;
        const unpremultiply = a > 0 ? 255 / a : 0;
        const target = (y * nextWidth + x) * 4;
        next[target] = Math.round(Math.min(255, r * unpremultiply));
        next[target + 1] = Math.round(Math.min(255, g * unpremultiply));
        next[target + 2] = Math.round(Math.min(255, b * unpremultiply));
        next[target + 3] = Math.round(alpha);
      }
    }

    levels.push({ width: nextWidth, height: nextHeight, data: next });
    source = next;
    sourceWidth = nextWidth;
    sourceHeight = nextHeight;
  }

  return levels;
}

/**
 * Creates a mipmapped design texture and uploads every level.
 *
 * vgpu does not generate mips (see `vgpu docs cat /vgpu/texture.docs.md`), and
 * the printed text is minified heavily at card scale, so the chain is built on
 * the CPU and written through the device queue that `Gpu` exposes for interop.
 */
export function uploadDesignTexture(
  gpu: Gpu,
  createTexture: typeof import("vgpu").texture,
  pixels: Uint8Array,
  width: number,
  height: number,
  label: string
): Texture {
  const levels = buildMipChain(pixels, width, height);
  const design = createTexture(gpu, {
    kind: "2d",
    size: [width, height],
    format: "rgba8unorm",
    usage: ["texture_binding", "copy_dst"],
    mipLevelCount: levels.length,
    label,
  });

  levels.forEach((level, mipLevel) => {
    gpu.gpu.queue.writeTexture(
      { texture: design.gpu, mipLevel },
      level.data,
      { bytesPerRow: level.width * 4, rowsPerImage: level.height },
      { width: level.width, height: level.height, depthOrArrayLayers: 1 }
    );
  });

  return design;
}
