# AGENTS.md

One photorealistic 3D business card, rendered with WebGPU: laser-etched white
titanium, in the spirit of the Apple Card. Next.js 16 App Router, Tailwind v4,
shadcn tokens, vgpu 0.5.0.

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
- `Path2D` exists in both the browser and `@napi-rs/canvas`, so the zyx mark is
  drawn from one SVG path string in both. The constructor is injected rather than
  imported, because `lib/card-texture.ts` is bundled for the browser too.

## How the titanium is built

- The design texture's alpha is the **etch mask**: 1 where the laser removed the
  white coating. The shader reads it four ways: the mark's albedo, its metalness
  and roughness, a hairline wall derived from the mask gradient, and a little
  occlusion at the etch floor. The bevel is deliberately weak, because 0.03 mm
  of recess is a hairline, not a chamfer. Push it and the marks read as embossed
  chrome instead of a burn.
- The coating is brushed along the card's long axis, so the specular lobe is
  **anisotropic GGX** (Burley `at`/`ab`, Filament's stable `D` and height
  correlated `V`) and the environment lookup is compressed along the tangent.
  Anisotropy 0 falls back to the isotropic path, so the printed presets keep
  their old lobe. Their lighting rig did move with this restyle, so they are not
  pixel-identical to the pre-titanium renders.
- Tangents come from the vertex buffer in model space, not from a constant in
  the fragment stage, because the card rotates.

## Verifying a change

`next build` never validates WGSL. Every shader edit must pass:

```sh
bun run check:wgsl                       # vgpu check --require-validation
bun run render                           # headless PNGs + pixel assertions
bun run lint && bunx tsc --noEmit && bun run build
```

`bun run render` needs the fonts from `bun run fonts` (downloads variable TTFs
and instances them with fontTools through `uvx`). It shoots a hero, a back and a
rim macro per preset and prints the silhouette aspect, the etch-versus-coating
contrast, the bare-face luminance gradient, the highlight aspect ratio (the
anisotropy check) and the rim-versus-face step, so a render can be judged
without a GPU. `--view hero|back|edge` shoots one frame.

The titanium preset is held to: `etch_contrast >= 0.35`, `face_gradient` between
0.05 and 0.25, and `highlight_ratio >= 1.8`.

## Layout

- `lib/card-spec.ts` `CARD_DIMENSIONS` in millimetres, which are the scene units.
- `lib/card-content.ts` everything etched into the card, positioned in millimetres.
- `lib/zyx-logo.ts` the zyx mark's SVG path and its tight ink box.
- `lib/card-texture.ts` 2D drawing shared by the browser and the render script.
- `lib/card-geometry.ts` the extruded rounded rectangle.
- `lib/card-presets.ts` the four material presets behind `?preset=`; `titanium` is the default.
  `etch` is the laser recess and `spotGloss` is the UV varnish: two readings of the
  same mask, and no preset uses both.
- `lib/card-scene.ts` geometry, textures, camera and the draw, shared by both entry points.
- `lib/card-runtime.ts` browser-only: surface, orbit controls, idle sway, frame loop.
- `shaders/card.wgsl` PBR shading; `shaders/present.wgsl` the composite pass.
