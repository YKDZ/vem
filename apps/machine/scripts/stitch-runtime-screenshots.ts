#!/usr/bin/env tsx
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";

const DEFAULT_ARTIFACT_DIR = resolve(
  process.cwd(),
  "runtime-screenshot-artifacts",
);
const SCREENSHOT_TILE_WIDTH = 810;
const SCREENSHOT_TILE_HEIGHT = 1440;
const LABEL_HEIGHT = 84;
const TILE_WIDTH = SCREENSHOT_TILE_WIDTH;
const TILE_HEIGHT = LABEL_HEIGHT + SCREENSHOT_TILE_HEIGHT;
const GAP = 36;
const PADDING = 40;
const COLUMNS = 3;
const MAX_TILES_PER_OVERVIEW = 9;
const BACKGROUND = { r: 16, g: 19, b: 24, a: 255 };
const BORDER = { r: 228, g: 232, b: 238, a: 255 };
const LABEL_BACKGROUND = { r: 35, g: 41, b: 52, a: 255 };
const LABEL_TEXT = { r: 247, g: 250, b: 252, a: 255 };
const FONT_SCALE = 7;
const FONT_WIDTH = 5;
const FONT_HEIGHT = 7;
const FONT_GAP = 1;

const FONT: Record<string, readonly string[]> = {
  "-": ["00000", "00000", "00000", "11110", "00000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  a: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  b: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  c: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  d: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  e: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  f: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  g: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  h: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  i: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  j: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  k: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  l: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  m: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  n: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  o: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  p: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  r: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  s: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  t: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  u: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  v: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  w: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  x: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

type CliOptions = {
  artifactDir?: string;
  manifest?: string;
  outputDir?: string;
};

type ScreenshotManifest = {
  viewport: {
    width: number;
    height: number;
  };
  scenarios: {
    id: string;
    name: string;
    category: string;
    targetRoute: string;
    screenshot: string;
  }[];
};

type Color = {
  r: number;
  g: number;
  b: number;
  a: number;
};

type ScenarioScreenshot = ScreenshotManifest["scenarios"][number] & {
  screenshotPng: PNG;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifactDir = resolve(options.artifactDir ?? DEFAULT_ARTIFACT_DIR);
  const manifestPath = resolve(
    options.manifest ?? join(artifactDir, "manifest.json"),
  );
  const outputDir = resolve(options.outputDir ?? join(artifactDir, "overview"));

  const parsedManifest: unknown = JSON.parse(
    await readFile(manifestPath, "utf8"),
  );
  assertManifest(parsedManifest);
  if (parsedManifest.scenarios.length === 0) {
    throw new Error("Screenshot manifest does not contain any scenarios.");
  }

  await mkdir(outputDir, { recursive: true });
  const scenarios = await Promise.all(
    parsedManifest.scenarios.map(async (scenario) => {
      const screenshotPath = resolve(
        dirname(manifestPath),
        scenario.screenshot,
      );
      const screenshotPng = await readPngScreenshot(
        screenshotPath,
        parsedManifest.viewport,
      );
      return { ...scenario, screenshotPng };
    }),
  );

  await Promise.all(
    chunk(scenarios, MAX_TILES_PER_OVERVIEW).map(
      async (scenarioChunk, index) => {
        const overview = stitchOverview(scenarioChunk);
        const outputPath = join(
          outputDir,
          `runtime-screenshot-overview-${index + 1}.png`,
        );
        await writeFile(outputPath, PNG.sync.write(overview));
        await assertFileExists(outputPath);
      },
    ),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--artifact-dir" && next) {
      options.artifactDir = next;
      index += 1;
    } else if (arg === "--manifest" && next) {
      options.manifest = next;
      index += 1;
    } else if (arg === "--output-dir" && next) {
      options.outputDir = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

function assertManifest(
  manifest: unknown,
): asserts manifest is ScreenshotManifest {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("viewport" in manifest) ||
    !("scenarios" in manifest)
  ) {
    throw new Error("Invalid Machine Runtime Console screenshot manifest.");
  }

  const viewport = manifest.viewport;
  if (
    typeof viewport !== "object" ||
    viewport === null ||
    !("width" in viewport) ||
    !("height" in viewport) ||
    typeof viewport.width !== "number" ||
    typeof viewport.height !== "number" ||
    !Array.isArray(manifest.scenarios)
  ) {
    throw new Error("Invalid Machine Runtime Console screenshot manifest.");
  }
}

async function readPngScreenshot(
  path: string,
  viewport: ScreenshotManifest["viewport"],
): Promise<PNG> {
  await assertFileExists(path);
  const buffer = await readFile(path);
  const screenshot = PNG.sync.read(buffer);
  if (
    screenshot.width !== viewport.width ||
    screenshot.height !== viewport.height
  ) {
    throw new Error(
      `${path} is ${screenshot.width}x${screenshot.height}; expected ${viewport.width}x${viewport.height}.`,
    );
  }
  return screenshot;
}

async function assertFileExists(path: string): Promise<void> {
  const result = await stat(path).catch(() => null);
  if (result === null || !result.isFile() || result.size === 0) {
    throw new Error(`Expected artifact file does not exist: ${path}`);
  }
}

function stitchOverview(scenarios: ScenarioScreenshot[]): PNG {
  const rows = Math.ceil(scenarios.length / COLUMNS);
  const width = PADDING * 2 + COLUMNS * TILE_WIDTH + (COLUMNS - 1) * GAP;
  const height = PADDING * 2 + rows * TILE_HEIGHT + (rows - 1) * GAP;
  const overview = new PNG({ width, height });
  fill(overview, BACKGROUND);

  scenarios.forEach((scenario, index) => {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const x = PADDING + column * (TILE_WIDTH + GAP);
    const y = PADDING + row * (TILE_HEIGHT + GAP);
    drawBorder(overview, x, y, TILE_WIDTH, TILE_HEIGHT);
    fillRect(overview, x, y, TILE_WIDTH, LABEL_HEIGHT, LABEL_BACKGROUND);
    drawText(overview, overviewLabel(scenario), x + 18, y + 16, LABEL_TEXT);
    drawScaledImage(
      overview,
      scenario.screenshotPng,
      x,
      y + LABEL_HEIGHT,
      SCREENSHOT_TILE_WIDTH,
      SCREENSHOT_TILE_HEIGHT,
    );
  });

  return overview;
}

function fill(image: PNG, color: Color): void {
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color.r;
    image.data[offset + 1] = color.g;
    image.data[offset + 2] = color.b;
    image.data[offset + 3] = color.a;
  }
}

function fillRect(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Color,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(image, column, row, color);
    }
  }
}

function drawBorder(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  for (let column = x - 1; column <= x + width; column += 1) {
    setPixel(image, column, y - 1, BORDER);
    setPixel(image, column, y + height, BORDER);
  }
  for (let row = y - 1; row <= y + height; row += 1) {
    setPixel(image, x - 1, row, BORDER);
    setPixel(image, x + width, row, BORDER);
  }
}

function drawScaledImage(
  target: PNG,
  source: PNG,
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number,
): void {
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.floor((y * source.height) / targetHeight);
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.floor((x * source.width) / targetWidth);
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = ((targetY + y) * target.width + targetX + x) * 4;
      target.data[targetOffset] = source.data[sourceOffset];
      target.data[targetOffset + 1] = source.data[sourceOffset + 1];
      target.data[targetOffset + 2] = source.data[sourceOffset + 2];
      target.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }
}

function drawText(
  image: PNG,
  text: string,
  x: number,
  y: number,
  color: Color,
): void {
  let cursorX = x;
  const maxX = x + TILE_WIDTH - 20;
  for (const rawCharacter of text.toLowerCase()) {
    if (cursorX + FONT_WIDTH * FONT_SCALE > maxX) return;
    if (rawCharacter === " ") {
      cursorX += (FONT_WIDTH + FONT_GAP) * FONT_SCALE;
      continue;
    }
    const glyph = FONT[rawCharacter];
    if (!glyph) continue;
    drawGlyph(image, glyph, cursorX, y, color);
    cursorX += (FONT_WIDTH + FONT_GAP) * FONT_SCALE;
  }
}

function overviewLabel(scenario: ScenarioScreenshot): string {
  if (scenario.id === "dispensing") return "dispensing";
  if (scenario.id.startsWith("dispensing-pickup-")) {
    return scenario.id.replace("dispensing-", "");
  }
  return scenario.id;
}

function drawGlyph(
  image: PNG,
  glyph: readonly string[],
  x: number,
  y: number,
  color: Color,
): void {
  for (let row = 0; row < FONT_HEIGHT; row += 1) {
    const line = glyph[row] ?? "";
    for (let column = 0; column < FONT_WIDTH; column += 1) {
      if (line[column] !== "1") continue;
      fillRect(
        image,
        x + column * FONT_SCALE,
        y + row * FONT_SCALE,
        FONT_SCALE,
        FONT_SCALE,
        color,
      );
    }
  }
}

function setPixel(image: PNG, x: number, y: number, color: Color): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color.r;
  image.data[offset + 1] = color.g;
  image.data[offset + 2] = color.b;
  image.data[offset + 3] = color.a;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
