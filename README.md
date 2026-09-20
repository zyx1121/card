```
 ██████╗ █████╗ ██████╗ ██████╗
██╔════╝██╔══██╗██╔══██╗██╔══██╗
██║     ███████║██████╔╝██║  ██║
██║     ██╔══██║██╔══██╗██║  ██║
╚██████╗██║  ██║██║  ██║██████╔╝
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝
```

# card

> A business card you can pick up, turn over and hold to the light, without printing one.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

Handing someone a link is easy; handing them something that feels like an object is not. Printed stock has weight, a cut edge, a grain you can see when the light rakes across it, and none of that survives a flat PNG. This page renders the real thing instead: 90 x 54 x 0.35 mm of paper, lit in a studio, running on your GPU.

![The card, uncoated 300 gsm stock](docs/hero.png)
<sub>The default `paper` preset: warm white uncoated stock, matte ink, visible fibre.</sub>

## Features

- **Hold a real card**: true millimetre dimensions, 2 mm die-cut corners and a 0.35 mm edge you can rake the light across.
- **Compare three stocks**: `?preset=paper`, `?preset=soft-touch` and `?preset=gloss` swap the whole material, down to the UV spot varnish on the ink.
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

Everything printed on the card lives in [`lib/card-content.ts`](lib/card-content.ts),
positioned in millimetres on the real 90 x 54 mm face. The material presets are
in [`lib/card-presets.ts`](lib/card-presets.ts).

## Verifying a render

`next build` never validates WGSL, so shaders have their own gates:

```bash
bun run check:wgsl   # vgpu check --require-validation on every shader
bun run fonts        # one-off: fetch and instance the fonts the renderer needs
bun run render       # headless PNGs into renders/, plus pixel assertions
```

`bun run render` prints the measured silhouette aspect, the luminance step
between the cut edge and the printed face, and the ink contrast for each preset.

## Deploy

Push to `main` and Vercel does the rest.

## Contributing

Issues and PRs welcome: start with [CONTRIBUTING.md](https://github.com/zyx1121/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE) · The card weighs nothing and still costs 300 gsm.
