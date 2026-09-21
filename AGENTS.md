# AGENTS.md

One photorealistic 3D business card, rendered with WebGPU: white titanium with
embossed marks, in the spirit of the Apple Card. Next.js 16 App Router,
Tailwind v4, shadcn tokens, vgpu 0.5.0.

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
- 3D needs a depth attachment and a canvas surface has none, so the card is
  drawn into an offscreen `target(gpu, { size, colors, depth: true, msaa: true })`
  and a full-screen composite lays it onto the surface.
- There is no mip generation and no texture upload helper. `lib/design-texture.ts`
  builds the mip chain on the CPU and writes every level through
  `gpu.gpu.queue.writeTexture`.
- Imported `.wgsl` modules are pure: they cannot declare `@group`/`@binding`
  resources. `shaders/pbr.wgsl` therefore exports the structs and the maths and
  `shaders/card.wgsl` owns every binding.
- WebGPU compatibility mode, which the `vgpu/node` adapter runs in, is stricter
  than core WebGPU in two ways this project runs into. It rejects the default
  `first` sampling for flat vertex outputs, so the `face` varying is declared
  `@interpolate(flat, either)`. And it refuses to multisample `rgba16float`, so
  the scene attachment is `rgba8unorm`.
- `Path2D` exists in both the browser and `@napi-rs/canvas`, so the zyx mark is
  drawn from one SVG path string in both. The constructor is injected rather than
  imported, because `lib/card-texture.ts` is bundled for the browser too.

## The two passes and their uniforms

| Pass    | Target                                     | Draw             | What it does                           |
| ------- | ------------------------------------------ | ---------------- | -------------------------------------- |
| card    | `scene`, one attachment, MSAA 4x, depth    | `card.draw`      | The lit card, premultiplied            |
| present | the canvas surface, or an offscreen target | `present` effect | Lays the card over the page background |

`scene` is multisampled because the card's silhouette is a hard edge against the
page. It is `rgba8unorm`: WebGPU compatibility mode, which the `vgpu/node`
adapter runs in, refuses to multisample `rgba16float`.

The attachment is **premultiplied** colour with the card's coverage in alpha.
The target clears to `[0, 0, 0, 0]` and the composite does
`scene.rgb + background * (1 - scene.a)`. Premultiplied is not a stylistic
choice here: it is what makes an MSAA resolve of a half covered pixel correct.

`card.wgsl`'s uniforms:

- `pointer: { position: vec3f, intensity: f32 }` is the cursor light, a fourth
  light hanging `POINTER_PLANE_OFFSET` (120 mm) in front of the card, on a plane
  perpendicular to the view direction. `intensity` 0 removes it entirely, which
  is the default and what every existing probe sees. Intersecting the cursor ray
  with that plane, as a literal reading would, barely moves the lamp: at hero
  framing the plane is only a third of the way out from the eye, so the whole
  viewport maps to a couple of centimetres. `pointerPlanePoint()` therefore
  hangs the lamp on that plane directly in front of the point the cursor is
  over. The lamp is shaded by `POINTER_MARK_SHADE` where the mark mask covers
  the surface: the ACES curve is nearly flat at the coating's luminance and
  steep at the mark's, so a light that hits both equally flattens the marks.

`present.wgsl`'s uniform is `composite: { background }`, and the target size
comes from `textureDimensions(scene)` rather than from a uniform.

## How the titanium is built

- The design texture's alpha is the **mark mask**: 1 where the white coating
  gives way to bare titanium. The shader reads it four ways: the mark's albedo,
  its metalness and roughness, a lip derived from the mask gradient, and the
  relief's ambient term.
- **`reliefDepth` is signed**, in millimetres: negative is a laser cut into the
  coating, positive is a mark raised proud of it. Its sign flips the bevel
  (into the surface for a cut, out of it for a relief), moves the wall's weight
  from the inside of the mark to its outer foot, and swaps the ambient term
  from a darkened floor to a lifted top with a contact shadow in the crook
  outside it (`RELIEF_LIFT` in `card.wgsl`). `titanium` is `+0.06`; dial it
  negative and the same marks are etched again. Either way it stays a lip and
  not a chamfer: pushed harder the marks read as machined chrome.
- The sandblast is two layers. `grain` is the smooth fbm height field, shared
  with the printed stocks. `sparkle` is the grit itself: one round pit per cell
  on a 320 x 192 grid over the blank, which is 3.6 cells per millimetre, about
  3 px per cell at hero framing. Each pit tilts the normal and nudges the
  roughness, which is what breaks the anisotropic highlight into a band of
  glints. It fades out past about one cell per pixel, where it would only
  alias, but it is meant to be visible well before that: a blast that resolves
  to a flat grey reads as white paint.
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

`check:wgsl` covers `card.wgsl` and `present.wgsl`; `pbr.wgsl` has no entry
point of its own and is validated through `card.wgsl`, which imports it. It
stays a module rather than being inlined: it is 440 lines of material maths and
`card.wgsl` reads better without them.

`bun run render` needs the fonts from `bun run fonts` (downloads variable TTFs
and instances them with fontTools through `uvx`). It shoots a hero, a back and a
rim macro per preset and prints the silhouette aspect and width, the
mark-versus-coating contrast, the bare-face luminance gradient, the speckle
(the RMS of each pixel against its local mean, which is the grain with the
lighting filtered out), the highlight aspect ratio (the anisotropy check), the
rim-versus-face step and the mean luminance of the band under the card, so a
render can be judged without a GPU. `--view hero|back|edge|macro` shoots one
frame; `macro` is the name at about four times hero scale, the only framing
where the relief lip is more than a pixel wide, and it is the frame that
carries the relief probes.

The relief probes are `relief_edge` (the lip just inside the mark's upper-left
boundary), `relief_opposite` (the same lip on the lower-right) and
`relief_interior`. `relief_facing`, the first minus the second, is the one that
settles which way the marks stand: both lips sit the same distance into the
same mask edge and carry the same blend with the bright coating, so only the
bevel tells them apart. It is about `-0.09` when the marks are etched and
`+0.23` when they are embossed.

Render at a portrait size (`--width 900 --height 1600`) to check the roll: the
probes go through the model matrix, so `silhouette_aspect` becomes 54/90 and
`silhouette_width` about 0.85.

The flags:

- `--yaw <degrees>` overrides the hero yaw. `--yaw 70` is a steep three-quarter
  view, the only frame where the milled rim is wide enough to read on its own.
- `--pointer x,y` lights the cursor lamp, `x` and `y` being viewport fractions
  from the top-left, so `0.62,0.45` is right of centre and a little high. It
  adds `pointer_lit`, `pointer_unlit`, `pointer_delta` and `pointer_peak`,
  measured on a 49 x 49 patch at that pixel against the same frame with the lamp
  off. Without the flag the lamp stays dark, so the existing probes are
  untouched.

### The gates

The titanium preset is held to, at the landscape hero framing:
`mark_contrast >= 0.35`, `face_gradient` between 0.05 and 0.25,
`face_speckle >= 0.015`, `highlight_ratio >= 1.8`, `under_card < 0.01`
(nothing renders below the card since the floor reflection was removed), and
`pointer_delta >= 0.08` with `pointer_peak` at most 0.95. The portrait framing
holds the card closer, so its `mark_contrast` runs about 0.03 lower and its
`highlight_ratio` is below 1 by design: the brushing runs up the screen once
the card is rolled.

The render script's background is black with an alpha of 0, matching the site's
forced-dark theme, and the card writes premultiplied colour over it.

## Layout

- `lib/card-spec.ts` `CARD_DIMENSIONS` in millimetres, which are the scene units.
- `lib/card-content.ts` everything marked into the card, positioned in millimetres.
- `lib/zyx-logo.ts` the zyx mark's SVG path and its tight ink box.
- `lib/card-texture.ts` 2D drawing shared by the browser and the render script.
- `lib/card-geometry.ts` the extruded rounded rectangle.
- `lib/card-presets.ts` the four material presets behind `?preset=`; `titanium` is the default.
  `relief` (with its signed `reliefDepth`) is the worked metal and `spotGloss`
  is the UV varnish: two readings of the same mask, and no preset uses both.
- `lib/card-scene.ts` geometry, textures, camera and the card draw, shared by
  both entry points. A canvas taller than it is wide rolls the card a quarter
  turn clockwise (`CARD_PORTRAIT_ROLL`) and frames it to 85% of the width on
  its short side. The roll is the Z of an intrinsic XYZ Euler, so the matrix is
  `Rx(tilt) * Ry(spin) * Rz(roll)`: the card turns in its own frame first and
  the idle spin stays about the screen-vertical axis, which keeps the flip
  reading as a horizontal turn rather than a somersault. It eases over
  `CARD_ROLL_EASE` (0.4 s) instead of snapping.
- `lib/card-runtime.ts` browser-only: surface, the offscreen target, orbit
  controls, the cursor light's easing and idle timeout, the one-shot intro and
  the frame loop. The intro runs for 1.6 s on a cubic ease-out from
  `distance x 1.8`, yaw -110 deg and pitch 20 deg to the hero pose, driven
  through `controls.set()` (which jumps state and goal), with the spin held; a
  `pointerdown` skips it. A resize that changes the framing eases the camera
  distance over the same 0.4 s, through the same `controls.set()`, so the
  visitor's own zoom is overridden for the length of the ease and then handed
  back. `onReady` fires after the first submitted frame so
  `components/card-canvas.tsx` can fade the canvas in over 0.5 s.
- `shaders/pbr.wgsl` the material model, imported by `card.wgsl`.
- `shaders/card.wgsl` the card itself; `shaders/present.wgsl` the composite.

## Decisions

- Illustrated outline/grain shipped 2026-09-21 and removed the same day on
  Loki's call.
- The marks went from etched to embossed on 2026-09-21, on Loki's call, along
  with a heavier blast and the portrait roll. `reliefDepth` keeps the etch one
  sign flip away.
