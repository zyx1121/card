/**
 * Downloads the fonts the headless renderer needs.
 *
 * The browser gets its fonts from `next/font/google`, but `@napi-rs/canvas`
 * needs real files, and Skia ignores variable-font weight axes. So each family
 * is downloaded as a variable TTF and instanced to a static weight with
 * fontTools (run through `uvx`, so nothing is installed globally).
 *
 * Run it with `bun run fonts`. The output lives in `.fonts/`, which is ignored
 * by git.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FONT_DIR = ".fonts";

interface FontSpec {
  readonly url: string;
  readonly variable: string;
  readonly instance: string;
  readonly weight: number;
}

const FONTS: readonly FontSpec[] = [
  {
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf",
    variable: "NotoSansTC.ttf",
    instance: "NotoSansTC-Medium.ttf",
    weight: 500,
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/geist/Geist%5Bwght%5D.ttf",
    variable: "Geist.ttf",
    instance: "Geist-Regular.ttf",
    weight: 400,
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/geistmono/GeistMono%5Bwght%5D.ttf",
    variable: "GeistMono.ttf",
    instance: "GeistMono-Regular.ttf",
    weight: 400,
  },
];

async function main(): Promise<void> {
  mkdirSync(FONT_DIR, { recursive: true });

  for (const font of FONTS) {
    const instancePath = `${FONT_DIR}/${font.instance}`;
    if (existsSync(instancePath)) {
      console.log(`skip ${font.instance}`);
      continue;
    }

    const variablePath = `${FONT_DIR}/${font.variable}`;
    if (!existsSync(variablePath)) {
      console.log(`download ${font.variable}`);
      const response = await fetch(font.url);
      if (!response.ok) {
        throw new Error(`${font.url} -> HTTP ${response.status}`);
      }
      writeFileSync(variablePath, new Uint8Array(await response.arrayBuffer()));
    }

    console.log(`instance ${font.instance} at wght=${font.weight}`);
    const result = spawnSync(
      "uvx",
      [
        "--from",
        "fonttools",
        "fonttools",
        "varLib.instancer",
        variablePath,
        `wght=${font.weight}`,
        "-o",
        instancePath,
      ],
      { stdio: "inherit" }
    );
    if (result.status !== 0) {
      throw new Error(
        "fontTools failed. Install uv (https://docs.astral.sh/uv/) and retry."
      );
    }
  }

  console.log("fonts ready");
}

await main();
