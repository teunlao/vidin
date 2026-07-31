/**
 * Frame rendering: pull the selected timestamps out of the source at full
 * quality and draw the annotations on top.
 *
 * All drawing is done by ffmpeg filters (drawbox / pad / drawtext), so there is
 * no image library in the dependency tree. Coordinates are computed here in
 * output pixels, which is why the output size is fixed up front rather than
 * left to a `-2` scale expression.
 */

import { unlink, writeFile } from 'node:fs/promises';
import { ffmpeg, findFont } from './ffmpeg.ts';
import type { Rect, SelectedFrame, VideoMeta } from './types.ts';

const CHANGE_COLOR = '0xFF3B30';
const BAR_COLOR = '0x111116';
const TEXT_COLOR = '0xF2F2F5';

export interface OutputSize {
  width: number;
  height: number;
}

export function outputSize(meta: VideoMeta, targetWidth: number): OutputSize {
  const width = Math.min(targetWidth, meta.width);
  const even = (n: number) => Math.max(2, Math.round(n) - (Math.round(n) % 2));
  return { width: even(width), height: even((width * meta.height) / meta.width) };
}

export interface RenderFrameOptions {
  meta: VideoMeta;
  frame: SelectedFrame;
  size: OutputSize;
  outFile: string;
  quality: number;
  annotate: boolean;
  totalFrames: number;
  previousTimeMs: number | null;
}

export async function renderFrame(options: RenderFrameOptions): Promise<void> {
  const { meta, frame, size, outFile, quality, annotate } = options;
  const filters = [`scale=${size.width}:${size.height}:flags=lanczos`];
  const labelFile = `${outFile}.label.txt`;

  if (annotate) {
    for (const region of frame.regions) {
      filters.push(...dashedBox(toPixels(region, size), boxThickness(size)));
    }
    filters.push(...(await labelBar(size, frameLabel(options), labelFile)));
  }

  try {
    await ffmpeg(
      [
        '-ss',
        seekSeconds(frame.timeMs, meta),
        '-i',
        meta.path,
        '-an',
        '-sn',
        '-frames:v',
        '1',
        '-vf',
        filters.join(','),
        '-c:v',
        'libwebp',
        '-compression_level',
        '5',
        '-quality',
        String(quality),
        outFile,
      ],
      `render frame ${frame.index}`,
    );
  } finally {
    if (annotate) await unlink(labelFile).catch(() => {});
  }
}

export interface RenderCellOptions {
  meta: VideoMeta;
  frame: SelectedFrame;
  cell: OutputSize;
  labelHeight: number;
  outFile: string;
  annotate: boolean;
}

/** A contact-sheet cell: same frame, small, with a large index so it stays readable. */
export async function renderCell(options: RenderCellOptions): Promise<void> {
  const { meta, frame, cell, labelHeight, outFile, annotate } = options;
  const filters = [`scale=${cell.width}:${cell.height}:flags=lanczos`];
  const labelFile = `${outFile}.label.txt`;

  if (annotate) {
    for (const region of frame.regions) {
      filters.push(...dashedBox(toPixels(region, cell), Math.max(2, Math.round(cell.width / 220))));
    }
  }

  const fontSize = Math.max(13, Math.round(labelHeight * 0.62));
  filters.push(
    `pad=${cell.width}:${cell.height + labelHeight}:0:0:color=${BAR_COLOR}`,
    await drawTextFile(
      `#${frame.index}  ${formatTime(frame.timeMs)}`,
      labelFile,
      Math.round(cell.width * 0.02),
      cell.height + Math.round((labelHeight - fontSize) / 2) - 1,
      fontSize,
    ),
  );

  try {
    await ffmpeg(
      [
        '-ss',
        seekSeconds(frame.timeMs, meta),
        '-i',
        meta.path,
        '-an',
        '-sn',
        '-frames:v',
        '1',
        '-vf',
        filters.join(','),
        outFile,
      ],
      `render cell ${frame.index}`,
    );
  } finally {
    await unlink(labelFile).catch(() => {});
  }
}

/** A blank filler cell so every contact sheet is a complete grid. */
export async function renderBlankCell(
  cell: OutputSize,
  labelHeight: number,
  outFile: string,
): Promise<void> {
  await ffmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      `color=c=${BAR_COLOR}:s=${cell.width}x${cell.height + labelHeight}`,
      '-frames:v',
      '1',
      outFile,
    ],
    'render blank cell',
  );
}

export interface BuildSheetOptions {
  cellPattern: string;
  cols: number;
  rows: number;
  outPattern: string;
  quality: number;
}

export async function buildSheets(options: BuildSheetOptions): Promise<void> {
  const { cellPattern, cols, rows, outPattern, quality } = options;
  await ffmpeg(
    [
      '-f',
      'image2',
      '-framerate',
      '1',
      '-i',
      cellPattern,
      '-vf',
      `tile=${cols}x${rows}:margin=8:padding=8:color=0x0B0B0F`,
      '-c:v',
      'libwebp',
      '-compression_level',
      '5',
      '-quality',
      String(quality),
      outPattern,
    ],
    'build contact sheets',
  );
}

export interface RenderZoomOptions {
  meta: VideoMeta;
  fromMs: number;
  toMs: number;
  fps: number;
  size: OutputSize;
  outPattern: string;
  quality: number;
  annotate: boolean;
}

/** Dense, evenly spaced frames over a short window — used to zoom into a moment. */
export async function renderZoom(options: RenderZoomOptions): Promise<void> {
  const { meta, fromMs, toMs, fps, size, outPattern, quality, annotate } = options;
  const filters = [`fps=${fps}`, `scale=${size.width}:${size.height}:flags=lanczos`];
  const labelFile = `${outPattern}.label.txt`;

  if (annotate) {
    const barHeight = labelHeight(size);
    const fontSize = Math.max(12, Math.round(barHeight * 0.55));
    // The timestamp is expanded per frame, so one ffmpeg pass labels the whole window.
    filters.push(
      `pad=${size.width}:${size.height + barHeight}:0:0:color=${BAR_COLOR}`,
      await drawTextFile(
        `zoom  %{pts:hms:${(fromMs / 1000).toFixed(3)}}`,
        labelFile,
        Math.round(size.width * 0.012),
        size.height + Math.round((barHeight - fontSize) / 2) - 1,
        fontSize,
        'normal',
      ),
    );
  }

  try {
    await ffmpeg(
      [
        '-ss',
        (fromMs / 1000).toFixed(3),
        '-to',
        (toMs / 1000).toFixed(3),
        '-i',
        meta.path,
        '-an',
        '-sn',
        '-vf',
        filters.join(','),
        '-c:v',
        'libwebp',
        '-compression_level',
        '5',
        '-quality',
        String(quality),
        outPattern,
      ],
      'render zoom clip',
    );
  } finally {
    if (annotate) await unlink(labelFile).catch(() => {});
  }
}

/* ---------------------------------------------------------------- drawing */

function toPixels(rect: Rect, size: OutputSize) {
  const x = clamp(Math.round(rect.x * size.width), 0, size.width - 4);
  const y = clamp(Math.round(rect.y * size.height), 0, size.height - 4);
  const w = clamp(Math.round(rect.w * size.width), 4, size.width - x);
  const h = clamp(Math.round(rect.h * size.height), 4, size.height - y);
  return { x, y, w, h };
}

function boxThickness(size: OutputSize): number {
  return Math.max(2, Math.round(size.width / 420));
}

/**
 * A dashed rectangle, built from short filled drawboxes. Dashes are used rather
 * than a solid outline so the marker never reads as part of the UI underneath.
 */
function dashedBox(
  rect: { x: number; y: number; w: number; h: number },
  thickness: number,
): string[] {
  const filters: string[] = [];
  const color = `${CHANGE_COLOR}@0.95`;

  const run = (length: number): { dash: number; step: number; count: number } => {
    const target = clamp(Math.round(length / 46), 3, 14);
    const dash = Math.max(5, Math.floor(length / (target * 2 - 1)));
    const step = dash * 2;
    return { dash, step, count: Math.max(1, Math.ceil(length / step)) };
  };

  const horizontal = run(rect.w);
  for (let i = 0; i < horizontal.count; i++) {
    const x = rect.x + i * horizontal.step;
    const w = Math.min(horizontal.dash, rect.x + rect.w - x);
    if (w <= 0) break;
    filters.push(box(x, rect.y, w, thickness, color));
    filters.push(box(x, rect.y + rect.h - thickness, w, thickness, color));
  }

  const vertical = run(rect.h);
  for (let i = 0; i < vertical.count; i++) {
    const y = rect.y + i * vertical.step;
    const h = Math.min(vertical.dash, rect.y + rect.h - y);
    if (h <= 0) break;
    filters.push(box(rect.x, y, thickness, h, color));
    filters.push(box(rect.x + rect.w - thickness, y, thickness, h, color));
  }

  return filters;
}

function box(x: number, y: number, w: number, h: number, color: string): string {
  return `drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.round(w)}:h=${Math.round(h)}:color=${color}:t=fill`;
}

export function labelHeight(size: OutputSize): number {
  return Math.max(24, Math.round(size.width / 44));
}

async function labelBar(size: OutputSize, text: string, labelFile: string): Promise<string[]> {
  const bar = labelHeight(size);
  const fontSize = Math.max(12, Math.round(bar * 0.55));
  return [
    `pad=${size.width}:${size.height + bar}:0:0:color=${BAR_COLOR}`,
    await drawTextFile(
      text,
      labelFile,
      Math.round(size.width * 0.012),
      size.height + Math.round((bar - fontSize) / 2) - 1,
      fontSize,
    ),
  ];
}

function frameLabel(options: RenderFrameOptions): string {
  const { frame, totalFrames, previousTimeMs } = options;
  const parts = [
    `#${String(frame.index).padStart(2, '0')}/${totalFrames}`,
    formatTime(frame.timeMs),
  ];
  if (previousTimeMs !== null) {
    parts.push(`+${((frame.timeMs - previousTimeMs) / 1000).toFixed(1)}s`);
  }
  parts.push(frame.reason);
  if (frame.deltaPct > 0.05) parts.push(`delta ${frame.deltaPct.toFixed(1)}%`);
  if (frame.regions.length) {
    const drawn = frame.regions.length;
    const found = Math.max(frame.regionsFound, drawn);
    parts.push(
      found > drawn
        ? `${drawn} of ${found} changed areas boxed`
        : `${drawn} region${drawn > 1 ? 's' : ''} boxed`,
    );
  }
  if (frame.scrolling) parts.push('scrolling');
  return parts.join('  |  ');
}

let fontPath: string | null = null;
let fontResolved = false;

/**
 * Labels go through `textfile=` rather than `text=`.
 *
 * ffmpeg unquotes a filter option before the filter's own parser splits it on
 * `:`, so a timestamp like `00:41.2` in an inline `text=` ends the option no
 * matter how it is quoted, and a literal `%` trips the expander. A side file
 * sidesteps both: the content is taken verbatim, and `expansion=none` keeps
 * percent signs literal. `normal` is only used where per-frame expansion of
 * `%{pts:...}` is the point.
 */
async function drawTextFile(
  text: string,
  labelFile: string,
  x: number,
  y: number,
  fontSize: number,
  expansion: 'none' | 'normal' = 'none',
): Promise<string> {
  await ensureFont();
  await writeFile(labelFile, text);
  const font = fontPath ? `fontfile='${fontPath}':` : '';
  return (
    `drawtext=${font}textfile='${labelFile}':expansion=${expansion}` +
    `:x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=${TEXT_COLOR}`
  );
}

/** Resolve the label font once; rendering calls this before drawing. */
export async function ensureFont(): Promise<void> {
  if (fontResolved) return;
  fontPath = await findFont();
  fontResolved = true;
}

/* ------------------------------------------------------------- utilities */

function seekSeconds(timeMs: number, meta: VideoMeta): string {
  const limit = Math.max(0, meta.durationMs - 40);
  return (Math.min(timeMs, limit) / 1000).toFixed(3);
}

export function formatTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

export function fileStamp(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}m${seconds.toFixed(1).padStart(4, '0')}s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
