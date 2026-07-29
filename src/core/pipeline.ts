import { mkdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { FFPROBE, assertToolchain, runOrThrow } from './ffmpeg.ts';
import { resolveSource, sessionNameFor } from './ingest.ts';
import { probe } from './probe.ts';
import { resolveProfile } from './profiles.ts';
import {
  buildSheets,
  ensureFont,
  fileStamp,
  labelHeight,
  outputSize,
  renderBlankCell,
  renderCell,
  renderFrame,
  renderZoom,
} from './render.ts';
import { buildReport } from './report.ts';
import { selectFrames } from './select.ts';
import type {
  FrameArtifact,
  Manifest,
  Profile,
  SheetArtifact,
  VideoMeta,
} from './types.ts';

export const VERSION = '0.1.0';

const RENDER_CONCURRENCY = 4;

export interface AnalyzeOptions {
  source: string;
  outDir?: string;
  profile?: string;
  overrides?: Partial<Profile>;
  onLog?: (message: string) => void;
}

export interface AnalyzeResult {
  dir: string;
  reportPath: string;
  manifestPath: string;
  report: string;
  manifest: Manifest;
}

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  await assertToolchain();
  await ensureFont();

  const log = options.onLog ?? (() => {});
  const profile = resolveProfile(options.profile, options.overrides);
  const dir = options.outDir ?? join(process.cwd(), '.vidin', sessionNameFor(options.source));

  await mkdir(dir, { recursive: true });
  for (const stale of ['frames', 'sheets', '.cells']) {
    await rm(join(dir, stale), { recursive: true, force: true });
  }
  await mkdir(join(dir, 'frames'), { recursive: true });

  const source = await resolveSource(options.source, dir);
  if (source.downloaded) log(`downloaded → ${source.path}`);

  const meta = await probe(source.path);
  log(
    `${meta.width}x${meta.height} · ${(meta.durationMs / 1000).toFixed(1)}s · ` +
      `${meta.fps.toFixed(1)}fps · ${meta.videoCodec}${meta.hasAudio ? ' · audio' : ''}`,
  );

  const analysisStart = performance.now();
  const selection = await selectFrames(meta, profile);
  const analysisMs = Math.round(performance.now() - analysisStart);
  log(
    `analysed ${selection.sampledFrames} samples at ${profile.sampleFps}fps → ` +
      `${selection.frames.length} frames kept` +
      (selection.prunedFrames ? ` (${selection.prunedFrames} pruned to fit the budget)` : '') +
      ` in ${analysisMs}ms`,
  );

  const renderStart = performance.now();
  const size = outputSize(meta, profile.frameWidth);
  const frames: FrameArtifact[] = new Array(selection.frames.length);

  await pool(selection.frames, RENDER_CONCURRENCY, async (frame, i) => {
    const name = `${String(frame.index).padStart(3, '0')}_t${fileStamp(frame.timeMs)}.webp`;
    const file = join(dir, 'frames', name);
    await renderFrame({
      meta,
      frame,
      size,
      outFile: file,
      quality: profile.quality,
      annotate: profile.annotate,
      totalFrames: selection.frames.length,
      previousTimeMs: i > 0 ? selection.frames[i - 1]!.timeMs : null,
    });
    const dimensions = await imageSize(file);
    const bytes = Bun.file(file).size;
    frames[i] = {
      ...frame,
      file: relative(dir, file),
      width: dimensions.width,
      height: dimensions.height,
      bytes,
      approxTokens: visionTokens(dimensions.width, dimensions.height),
    };
  });

  const sheets = profile.sheets && frames.length > 1
    ? await makeSheets(dir, meta, selection.frames, profile)
    : [];
  const renderMs = Math.round(performance.now() - renderStart);
  log(`rendered ${frames.length} frames and ${sheets.length} contact sheet(s) in ${renderMs}ms`);

  const totalBytes =
    frames.reduce((sum, f) => sum + f.bytes, 0) + sheets.reduce((sum, s) => sum + s.bytes, 0);
  const approxTokens =
    frames.reduce((sum, f) => sum + f.approxTokens, 0) +
    sheets.reduce((sum, s) => sum + s.approxTokens, 0);

  const manifest: Manifest = {
    tool: 'vidin',
    version: VERSION,
    createdAt: new Date().toISOString(),
    source: { input: options.source, resolved: source.path, downloaded: source.downloaded },
    video: meta,
    profile,
    stats: {
      sampledFrames: selection.sampledFrames,
      selectedFrames: frames.length,
      prunedFrames: selection.prunedFrames,
      analysisMs,
      renderMs,
      totalBytes,
      approxTokens,
    },
    frames,
    sheets,
  };

  const report = buildReport(manifest);
  const reportPath = join(dir, 'REPORT.md');
  const manifestPath = join(dir, 'manifest.json');
  await Bun.write(reportPath, report);
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(join(dir, '.cells'), { recursive: true, force: true });

  return { dir, reportPath, manifestPath, report, manifest };
}

export interface ZoomOptions {
  source: string;
  outDir: string;
  fromMs: number;
  toMs: number;
  fps?: number;
  width?: number;
  quality?: number;
  annotate?: boolean;
}

export interface ZoomResult {
  dir: string;
  files: string[];
  meta: VideoMeta;
  approxTokens: number;
}

/** Dense frames over a short window, for drilling into one moment. */
export async function zoom(options: ZoomOptions): Promise<ZoomResult> {
  await assertToolchain();
  await ensureFont();

  const meta = await probe(options.source);
  const fromMs = Math.max(0, Math.min(options.fromMs, meta.durationMs));
  const toMs = Math.max(fromMs + 100, Math.min(options.toMs, meta.durationMs));
  const fps = options.fps ?? 4;
  const spanSec = (toMs - fromMs) / 1000;
  if (spanSec * fps > 60) {
    throw new Error(
      `That window is ${spanSec.toFixed(1)}s at ${fps}fps = ${Math.round(spanSec * fps)} frames. ` +
        `Narrow the range or lower --fps (60 frames max).`,
    );
  }

  const dir = join(options.outDir, 'zoom', `${fileStamp(fromMs)}-${fileStamp(toMs)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const size = outputSize(meta, options.width ?? 1456);
  await renderZoom({
    meta,
    fromMs,
    toMs,
    fps,
    size,
    outPattern: join(dir, 'z%03d.webp'),
    quality: options.quality ?? 74,
    annotate: options.annotate ?? true,
  });

  const files = [...new Bun.Glob('z*.webp').scanSync({ cwd: dir, absolute: true })].sort();
  const perFrame = visionTokens(size.width, size.height + labelHeight(size));
  return { dir, files, meta, approxTokens: perFrame * files.length };
}

/* ------------------------------------------------------------- internals */

async function makeSheets(
  dir: string,
  meta: VideoMeta,
  frames: Manifest['frames'] | Awaited<ReturnType<typeof selectFrames>>['frames'],
  profile: Profile,
): Promise<SheetArtifact[]> {
  const cellsDir = join(dir, '.cells');
  await mkdir(cellsDir, { recursive: true });
  await mkdir(join(dir, 'sheets'), { recursive: true });

  const cols = frames.length <= 4 ? 2 : profile.sheetCols;
  const rows = frames.length <= 4 ? 2 : frames.length <= 6 ? 2 : 3;
  const perSheet = cols * rows;

  const margin = 8;
  const padding = 8;
  const cellWidth = even(
    Math.floor((profile.sheetWidth - 2 * margin - (cols - 1) * padding) / cols),
  );
  const cell = { width: cellWidth, height: even((cellWidth * meta.height) / meta.width) };
  const cellLabel = Math.max(18, Math.round(cellWidth / 22));

  await pool(frames, RENDER_CONCURRENCY, async (frame, i) => {
    await renderCell({
      meta,
      frame,
      cell,
      labelHeight: cellLabel,
      outFile: join(cellsDir, `${String(i + 1).padStart(3, '0')}.png`),
      annotate: profile.annotate,
    });
  });

  // Pad the last grid so tile always emits complete sheets.
  const sheetCount = Math.ceil(frames.length / perSheet);
  for (let i = frames.length; i < sheetCount * perSheet; i++) {
    await renderBlankCell(cell, cellLabel, join(cellsDir, `${String(i + 1).padStart(3, '0')}.png`));
  }

  await buildSheets({
    cellPattern: join(cellsDir, '%03d.png'),
    cols,
    rows,
    outPattern: join(dir, 'sheets', 'sheet-%02d.webp'),
    quality: profile.quality,
  });

  const files = [...new Bun.Glob('sheet-*.webp').scanSync({ cwd: join(dir, 'sheets'), absolute: true })].sort();
  const sheets: SheetArtifact[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const dimensions = await imageSize(file);
    sheets.push({
      file: relative(dir, file),
      frames: frames
        .slice(i * perSheet, (i + 1) * perSheet)
        .map((frame) => frame.index),
      width: dimensions.width,
      height: dimensions.height,
      bytes: Bun.file(file).size,
      approxTokens: visionTokens(dimensions.width, dimensions.height),
    });
  }
  return sheets;
}

async function imageSize(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await runOrThrow(
    [
      FFPROBE,
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=s=x:p=0',
      path,
    ],
    `probe ${path}`,
  );
  const [width, height] = stdout.trim().split('x').map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

/** Claude counts an image as width * height / 750 tokens. */
export function visionTokens(width: number, height: number): number {
  return Math.round((width * height) / 750);
}

async function pool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}

function even(value: number): number {
  const rounded = Math.round(value);
  return Math.max(2, rounded - (rounded % 2));
}
