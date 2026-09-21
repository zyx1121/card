```
 ██████╗ █████╗ ██████╗ ██████╗
██╔════╝██╔══██╗██╔══██╗██╔══██╗
██║     ███████║██████╔╝██║  ██║
██║     ██╔══██║██╔══██╗██║  ██║
╚██████╗██║  ██║██║  ██║██████╔╝
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝
```

# card

> A laser-etched white titanium business card you can pick up, turn over and hold to the light, drawn over in ink and printed in dots.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

Handing someone a link is easy; handing them something that feels like an object is not. A metal card has weight, a milled rim, a blasted coating that catches the light in a band rather than a point, and none of that survives a flat PNG. This page renders the real thing instead: 90 x 54 x 0.76 mm of titanium under a white ceramic coating, every mark burned through to bare metal, lit in a studio, running on your GPU.

Then it draws over it. A contour of constant screen-space width is inked around the silhouette after the fact, and the shading is printed as halftone dots or resampled as a cloud of gaussian splats, so the object reads as an illustration of itself rather than a photograph.

![The card, white titanium with a laser-etched mark, printed as halftone dots](docs/hero.png)
<sub>The default `titanium` preset under `?fx=stipple`: sandblasted white coating, brushed along the long axis, etched down to bare metal, printed in dots.</sub>

## Features

- **Hold a real card**: true millimetre dimensions, a 3.18 mm ID-1 corner radius and a 0.76 mm milled rim you can rake the light across.
- **Etched, not printed**: the design texture's alpha is an etch mask, so every mark is recessed bare titanium with its own roughness, metalness and hairline wall.
- **Brushed metal, properly**: an anisotropic GGX lobe along the card's long axis, with the studio environment stretched to match, so softboxes smear into horizontal bands.
- **Lit by your cursor**: a fourth light hangs 120 mm in front of the card and follows the pointer, so the coating carries a soft warm pool that glides instead of a fixed highlight.
- **Inked afterwards**: a 3 CSS px contour is dilated in screen space from the card's own silhouette and its face-versus-rim crease, so the line keeps one weight whatever the card's angle, distance or pixel ratio, the way a drawn line would.
- **Printed, or splatted**: `?fx=stipple` prints the shading as a jittered hexagonal halftone whose dots fatten where the card goes dark; `?fx=splat` throws the card away and rebuilds it from 30 000 gaussian splats scattered over the real surface, each one shaded by the same lobe it was sampled from; `?fx=none` leaves the shading alone.
- **Arrives, does not appear**: on load the card swings in from edge-on over 1.6 s while the canvas fades up, then settles into its slow turn. Touch it and the intro gets out of the way.
- **Compare four finishes**: `?preset=titanium` is the default; `?preset=paper`, `?preset=soft-touch` and `?preset=gloss` swap the whole material back to printed stock.
- **Prove the render without a GPU**: a headless script renders every preset to PNG and asserts on the pixels, so a shader change cannot quietly break the look.

## Tech stack

| Layer           | Choice                             |
| --------------- | ---------------------------------- |
| Framework       | Next.js 16 (App Router)            |
| Rendering       | vgpu 0.5.0 (WebGPU)                |
| Styling         | Tailwind CSS v4 + shadcn/ui tokens |
| Package manager | Bun                                |

## Getting started

```bash
git clone https://github.com/zyx1121/card && cd card
bun install
bun dev
```

Open [localhost:3000](http://localhost:3000) in a browser with WebGPU, and drag
the card to orbit it. No environment variables, no backend.

## Editing the card

Everything etched into the card lives in [`lib/card-content.ts`](lib/card-content.ts),
positioned in millimetres on the real 90 x 54 mm face. The blank itself is
[`CARD_DIMENSIONS`](lib/card-spec.ts), the material presets are in
[`lib/card-presets.ts`](lib/card-presets.ts), and the outline's width and colour
and the splat cloud's size and count are in [`lib/card-fx.ts`](lib/card-fx.ts).

## Verifying a render

`next build` never validates WGSL, so shaders have their own gates:

```bash
bun run check:wgsl   # vgpu check --require-validation on every shader
bun run fonts        # one-off: fetch and instance the fonts the renderer needs
bun run render       # headless PNGs into renders/, plus pixel assertions
```

`bun run render` shoots a hero, a back and a rim macro per preset. It prints the
measured silhouette aspect, the etch-versus-coating contrast, the luminance
gradient across the bare face, the aspect ratio of the brightest highlight
(which is how the anisotropy is checked), the rim-versus-face step, the
outline's measured width at four points on the silhouette and the mean luminance
of the band under the card. A single frame is available with
`--view hero|back|edge`.

More flags cover what a single still frame cannot show on its own:

```bash
bun run scripts/render.ts --fx splat --view hero             # the point cloud, 30 000 splats
bun run scripts/render.ts --fx splat --splats 8000           # thinner, for a software adapter
bun run scripts/render.ts --view hero --yaw 70               # steep three-quarter: the outline must not thicken
bun run scripts/render.ts --view hero --dpr 2                # the outline at a 2x pixel ratio
bun run scripts/render.ts --view hero --pointer 0.62,0.45    # cursor light on, at 62% across and 45% down
bun run scripts/render.ts --view hero --probe                # keep the frame the outline probe measures
```

The outline is black and so is the page, so its width cannot be read off the
delivered frame. `--probe` reshoots the same camera with the line in red and
measures it across itself rather than down a screen axis, which is what makes
the reading independent of the edge's orientation.

## Deploy

Push to `main` and Vercel does the rest.

## Contributing

Issues and PRs welcome: start with [CONTRIBUTING.md](https://github.com/zyx1121/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE) · The card weighs nothing and still bills for the titanium.
