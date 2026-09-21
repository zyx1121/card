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
- 3D needs a depth attachment and a canvas surface has none, so the card is
  drawn into an offscreen `target(gpu, { size, colors, depth: true, msaa: true })`
  and a full-screen composite lays it onto the surface.
- There is no mip generation and no texture upload helper. `lib/design-texture.ts`
  builds the mip chain on the CPU and writes every level through
  `gpu.gpu.queue.writeTexture`.
- Imported `.wgsl` modules are pure: they cannot declare `@group`/`@binding`
  resources. `shaders/pbr.wgsl` therefore exports the structs and the maths and
  the entry modules own every binding.
- WebGPU compatibility mode, which the `vgpu/node` adapter runs in, is stricter
  than core WebGPU in three ways this project runs into. It rejects the default
  `first` sampling for flat vertex outputs, so the `face` varying is declared
  `@interpolate(flat, either)`. It refuses to multisample `rgba16float`, so both
  colour attachments are `rgba8unorm` and the normal is packed into the unit
  range. And it requires every colour target of one draw to share a blend state
  and a write mask, so a per-attachment `writeMask: []` is not available: the
  splat pass leaves the geometry buffer alone by writing a transparent black to
  it under premultiplied blending instead.
- `Path2D` exists in both the browser and `@napi-rs/canvas`, so the zyx mark is
  drawn from one SVG path string in both. The constructor is injected rather than
  imported, because `lib/card-texture.ts` is bundled for the browser too.

## The three passes and their uniforms

`shaders/card.wgsl` and `shaders/splat.wgsl` both import the material model from
`shaders/pbr.wgsl`, so a splat is lit by exactly the lobe the surface under it
would have been. A WGSL module cannot declare `@group`/`@binding` resources, so
`pbr.wgsl` holds only the data shapes and the maths and the two entry modules own
the bindings.

| Pass    | Target                                     | Draw             | What it does                                                                        |
| ------- | ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------- |
| card    | `scene`, two attachments, MSAA 4x, depth   | `card.draw`      | The picture in attachment 0, the outline's geometry buffer in attachment 1          |
| splat   | the same target, in the same pass          | `card.splatDraw` | Only when `?fx=splat`: 30 000 instanced gaussian quads, premultiplied over the card |
| present | the canvas surface, or an offscreen target | `present` effect | Lays the card over the page background, prints the grain and draws the outline      |

The card and splat draws share **one** render pass. An MSAA target discards its
multisample attachments at the end of a pass, so a second pass with
`clear: false` would lose both the card and the depth the splats test against.

`scene` is multisampled because a three pixel line dilated from a jagged
silhouette is a jagged line. Both attachments are `rgba8unorm`: WebGPU
compatibility mode, which the `vgpu/node` adapter runs in, refuses to
multisample `rgba16float`.

- Attachment 0 is **premultiplied** colour with the card's coverage in alpha.
  The target clears to `[0, 0, 0, 0]` and the composite does
  `scene.rgb + background * (1 - scene.a)`. Premultiplied is not a stylistic
  choice here: it is what makes an MSAA resolve of a half covered pixel correct.
- Attachment 1 is the world normal packed into the unit range (`n * 0.5 + 0.5`)
  in xyz, and the solid card's silhouette mask in w. The mask lives here rather
  than in attachment 0's alpha because the splat pass blends over that one and
  would smear the silhouette the outline has to follow. Only the card pass ever
  writes attachment 1.

`card.wgsl`'s uniforms:

- `pointer: { position: vec3f, intensity: f32 }` is the cursor light, a fourth
  light hanging `POINTER_PLANE_OFFSET` (120 mm) in front of the card, on a plane
  perpendicular to the view direction. `intensity` 0 removes it entirely, which
  is the default and what every existing probe sees. Intersecting the cursor ray
  with that plane, as a literal reading would, barely moves the lamp: at hero
  framing the plane is only a third of the way out from the eye, so the whole
  viewport maps to a couple of centimetres. `pointerPlanePoint()` therefore
  hangs the lamp on that plane directly in front of the point the cursor is
  over. The lamp is shaded by `POINTER_ETCH_SHADE` where the etch mask covers
  the surface: the ACES curve is nearly flat at the coating's luminance and
  steep at the etch floor, so a light that hits both equally flattens the marks.
- `style: { solidMix: f32 }` is how much of its own shading the solid card
  keeps. `?fx=splat` drops it to 0.45, which desaturates and dims the card so
  the cloud drawn over it carries the look; every other mode leaves it at 1.

`splat.wgsl`'s uniforms: the same `material`, `pointer` and design textures, a
`camera` block that also carries the world-space `right` and `up` the quads face
along, and `splat: { size, tick, lift }`. `size` is the base diameter in
millimetres (1.1), `tick` is the frame counter divided by `FX_TICK_FRAMES` and
drives the twinkle, and `lift` (0.12 mm) pulls each quad towards the camera so a
splat centred on the surface is not half buried in it.

`present.wgsl`'s uniform is
`composite: { background, outlineWidth, outlineColor, dpr, size, tick, mode }`.

## The outline

Screen space, and deliberately so: the width is fixed in CSS pixels, so it never
changes with the card's angle, its distance or the device pixel ratio. That is
the "drawn on afterwards" look rather than a modelled bevel.

`outlineAt()` walks a disc of integer pixel offsets and keeps the distance to the
nearest offset a geometric edge is found at, then thresholds that distance at
half the wanted width. Because the answer is a **distance** rather than a
dilation, the width is the same whatever the edge's orientation, and one
`smoothstep` over a pixel antialiases it. Half a pixel comes off each tap radius:
an edge found at a tap lies between the two pixels, not at the tap, and without
that correction the nearest tap is never closer than 1 and the line comes out a
pixel thin whatever the width asks for.

`edgeBetween()` has two terms, not three. The mask step catches the silhouette
and the angle between the two normals catches the crease where the face meets the
milled rim; on a 0.76 mm slab those are every geometric edge there is. There is
no depth term: a fold that keeps its normal cannot happen on this geometry, and
the 8 bit attachment compatibility mode forces on us is too coarse for a
relative depth threshold anyway. The etched marks are not in attachment 1 at all,
so the line follows geometry only and never traces the text.

`OUTLINE_PX` is 3 and `OUTLINE_COLOR` is black. **Note**: the page background is
`oklch(0 0 0)`, so the half of the silhouette line that falls outside the card is
black on black. What reads on the live page is the half that bites into the card
and, at a steep yaw, the face-versus-rim crease. `outlineColor` is one uniform if
that should change.

## The grain, under `?fx=`

`?fx=stipple` is the default, `?fx=splat` the other variant and `?fx=none`
switches the grain off. `?preset=` still works alongside it.

- **stipple** is a post effect in the composite, over the card pixels only. A
  jittered hexagonal grid of soft gaussian dots, `STIPPLE_PITCH` (3.2 CSS px)
  apart, with both the dot size and the grid's density following the shaded
  luminance: darker shading gets more and fatter dots, which is what a stippler
  does. The coating between the dots is lifted and a dot is the same colour
  burned down, and `STIPPLE_SHADING` (0.35) of the smooth shading is kept
  underneath so the titanium gradient still reads across the face.
- **splat** resamples the card as 30 000 gaussian splats. `lib/card-splats.ts`
  scatters them over the real geometry (both faces of the rounded rectangle and
  the milled rim) in proportion to area, from a seeded PRNG rather than
  `Math.random`, so the cloud is identical between frames, between the browser
  and the render script, and between runs. Each splat carries its local position,
  normal, uv, face, seed and size scale in an instance stream, and is drawn as a
  camera-facing quad with a gaussian alpha that reaches exactly zero at the
  quad's rim.

  The whole material evaluation happens in the **vertex** stage: a splat is one
  shaded sample of the surface, so four invocations per splat instead of a few
  hundred fragments. The design texture is a vertex-stage lookup, which needs an
  explicit level; `DESIGN_LOD` is 2 rather than the splat's full footprint,
  because at the footprint the etched name would average away into the coating.

  Two things the cloud must not do. It must not disturb attachment 1, and
  compatibility mode will not let one attachment of an MRT draw carry its own
  write mask, so the shader writes a transparent black there and premultiplied
  blending leaves the destination as it found it. And it must not show the far
  side of the card: the real cull is the sign of `dot(normal, view)`, which is
  exact on a slab, because a quad centred on the back face still pokes through
  the front of a 0.76 mm card and the depth test alone cannot hide it.

  The browser always asks for 30 000. The render script takes `--splats <n>` for
  a slower adapter.

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

`check:wgsl` covers `card.wgsl`, `splat.wgsl` and `present.wgsl`; `pbr.wgsl` has
no entry point of its own and is validated through the two that import it.

`bun run render` needs the fonts from `bun run fonts` (downloads variable TTFs
and instances them with fontTools through `uvx`). It shoots a hero, a back and a
rim macro per preset and prints the silhouette aspect, the etch-versus-coating
contrast, the bare-face luminance gradient, the highlight aspect ratio (the
anisotropy check), the rim-versus-face step, the outline's measured width and
the mean luminance of the band under the card, so a render can be judged without
a GPU. `--view hero|back|edge` shoots one frame.

The flags:

- `--fx none|stipple|splat` picks the grain, `stipple` by default, as on the
  page. `--splats <n>` thins the cloud for a slow adapter; the browser is always
  at 30 000.
- `--dpr <n>` scales the outline as a 2x display would, so the CSS-pixel width
  can be checked at both ratios without a browser.
- `--yaw <degrees>` overrides the hero yaw. `--yaw 70` is a steep three-quarter
  view, which is the frame that proves the outline's width does not follow the
  card's angle and the only one where the milled rim is wide enough to show the
  face-versus-rim crease line as a separate stroke.
- `--pointer x,y` lights the cursor lamp, `x` and `y` being viewport fractions
  from the top-left, so `0.62,0.45` is right of centre and a little high. It
  adds `pointer_lit`, `pointer_unlit`, `pointer_delta` and `pointer_peak`,
  measured on a 49 x 49 patch at that pixel against the same frame with the lamp
  off. Without the flag the lamp stays dark, so the existing probes are
  untouched.
- `--probe` keeps the frame the outline probe measures on, as
  `<out>-probe.png`.

### Measuring a black line on a black page

`outline_widths` cannot be read off the delivered frame: the line and the page
background are both black. The probe therefore reshoots the same camera with the
line in pure red. The card is near-neutral, so `red - green` is the line's own
coverage at every pixel, on the card and off it, and summing that across a
silhouette crossing gives a sub-pixel width.

The walk is **across the line**, not down a screen axis: the outline's screen
direction comes from projecting a second point a little way along the same side
and the integration follows the perpendicular. A scan down a column would read a
slanted edge as `width / cos(angle)`, which would make a constant-width line
look as though it changed with the card's angle, which is the one thing the
probe exists to rule out. The band is also found in the pixels rather than
assumed to sit on the projected point, because a mid-thickness sample point is a
pixel or two off the silhouette the rasteriser drew: the silhouette is formed by
whichever face of the 0.76 mm slab is turned towards the camera.

### The gates

The material probes are read on `--fx none`. The printed-dot layer lifts the
coating between its dots, which pushes `face_gradient` and `pointer_peak` up by
design, and the cloud softens the etch, so neither is the frame to judge the
material from.

The titanium preset is held to: `etch_contrast >= 0.35` on `--fx none` and
`>= 0.30` on `stipple` and `splat`, `face_gradient` between 0.05 and 0.25,
`highlight_ratio >= 1.8`, `under_card < 0.01` (nothing renders below the card
since the floor reflection was removed), `pointer_delta >= 0.08` with
`pointer_peak` at most 0.95, and every `outline_widths` entry within a pixel of
`OUTLINE_PX * dpr`.

The render script's background is black with an alpha of 0, matching the site's
forced-dark theme, and the card writes premultiplied colour over it.

## Layout

- `lib/card-spec.ts` `CARD_DIMENSIONS` in millimetres, which are the scene units.
- `lib/card-content.ts` everything etched into the card, positioned in millimetres.
- `lib/zyx-logo.ts` the zyx mark's SVG path and its tight ink box.
- `lib/card-texture.ts` 2D drawing shared by the browser and the render script.
- `lib/card-geometry.ts` the extruded rounded rectangle.
- `lib/card-presets.ts` the four material presets behind `?preset=`; `titanium` is the default.
  `etch` is the laser recess and `spotGloss` is the UV varnish: two readings of the
  same mask, and no preset uses both.
- `lib/card-fx.ts` the `?fx=` variants, the outline's width and colour and the
  splat cloud's size, count and lift.
- `lib/card-splats.ts` the seeded scatter of splats over the card's surface, and
  the instanced geometry descriptor for them.
- `lib/card-scene.ts` geometry, textures, camera and both draws, shared by both
  entry points.
- `lib/card-runtime.ts` browser-only: surface, the offscreen target, orbit
  controls, the cursor light's easing and idle timeout, the one-shot intro and
  the frame loop. The intro runs for 1.6 s on a cubic ease-out from
  `distance x 1.8`, yaw -110 deg and pitch 20 deg to the hero pose, driven
  through `controls.set()` (which jumps state and goal), with the spin held; a
  `pointerdown` skips it. `onReady` fires after the first submitted frame so
  `components/card-canvas.tsx` can fade the canvas in over 0.5 s.
- `shaders/pbr.wgsl` the material model, imported by both draws.
- `shaders/card.wgsl` the solid card; `shaders/splat.wgsl` the point cloud;
  `shaders/present.wgsl` the composite, the grain and the outline.
