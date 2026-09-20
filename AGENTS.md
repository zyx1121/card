# AGENTS.md

One photorealistic 3D business card, rendered with WebGPU. Next.js 16 App
Router, Tailwind v4, shadcn tokens, vgpu 0.5.0.

## Both key dependencies are newer than your training data

Do not write Next.js or vgpu code from memory. Read the versions installed in
this repository first.

- **Next.js 16**: the docs ship with the package at `node_modules/next/dist/docs/`.
- **vgpu 0.5.0**: the docs ship with the package and are served by its CLI.
  Always use the project-local binary, never bare `npx vgpu`:

  ```sh
  ./node_modules/.bin/vgpu docs ls
  ./node_modules/.bin/vgpu docs cat getting-started.md
  ./node_modules/.bin/vgpu docs cat two-pass-rendering.md
  ./node_modules/.bin/vgpu docs find "<symbol or error code>"
  ```

If the installed docs do not contain an API, it does not exist in this version.
Report the mismatch instead of inventing one.

## What vgpu 0.5.0 does and does not have

- There is **no scene renderer**. `vgpu/scene` exports geometry descriptors,
  cameras, lights, orbit controls and a scene tree, but nothing draws the tree.
  The card uses the low-level path: `geometry(gpu, { buffers, indices })` with
  named attributes, `draw(gpu, { shader, geometry })`, and our own vertex and
  fragment stages in `shaders/card.wgsl`.
- 3D needs a depth attachment and a canvas surface has none, so rendering is two
  passes: an offscreen `target(gpu, { size, depth: true })`, then a full-screen
  composite onto the surface.
- There is no mip generation and no texture upload helper. `lib/design-texture.ts`
  builds the mip chain on the CPU and writes every level through
  `gpu.gpu.queue.writeTexture`.
- WebGPU compatibility mode rejects the default `first` sampling for flat vertex
  outputs, so the `face` varying is declared `@interpolate(flat, either)`.

## Verifying a change

`next build` never validates WGSL. Every shader edit must pass:

```sh
bun run check:wgsl                       # vgpu check --require-validation
bun run render                           # headless PNGs + pixel assertions
bun run lint && bunx tsc --noEmit && bun run build
```

`bun run render` needs the fonts from `bun run fonts` (downloads variable TTFs
and instances them with fontTools through `uvx`). It prints the silhouette
aspect, the edge-versus-face luminance and the ink contrast for each preset, so
a render can be judged without a GPU.

## Layout

- `lib/card-spec.ts` physical dimensions in millimetres, which are the scene units.
- `lib/card-content.ts` everything printed on the card, positioned in millimetres.
- `lib/card-texture.ts` 2D drawing shared by the browser and the render script.
- `lib/card-geometry.ts` the extruded rounded rectangle.
- `lib/card-presets.ts` the three material presets behind `?preset=`.
- `lib/card-scene.ts` geometry, textures, camera and the draw, shared by both entry points.
- `lib/card-runtime.ts` browser-only: surface, orbit controls, idle sway, frame loop.
- `shaders/card.wgsl` PBR shading; `shaders/present.wgsl` the composite pass.
