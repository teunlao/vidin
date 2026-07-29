/**
 * Keyframe selection.
 *
 * The naive approach — one frame per second — spends most of its budget on
 * frames where nothing happened, and the frames it does spend on a change land
 * in the middle of the animation. This selector is event driven instead:
 *
 *   1. Change is measured against the last *emitted* frame, not the previous
 *      sample, so slow drift accumulates and eventually trips the threshold.
 *   2. When a change starts, nothing is emitted yet. The selector waits for the
 *      screen to come to rest and emits the settled frame — the "after" state,
 *      not the motion blur.
 *   3. Cursor-sized changes are recognised and do not spend a frame; the cursor
 *      position is tracked and drawn on the frames that are kept.
 *   4. Guard rails keep the timeline honest: a minimum gap, a maximum gap, and
 *      periodic samples while a long animation is still running.
 */

import { area, blobCenter, blobToRect, blobs, diffGrid, estimateScroll } from './diff.ts';
import type { Blob, FrameSize, Grid } from './diff.ts';
import { analysisSize, sample } from './sample.ts';
import type { Point, Rect, SelectedFrame, SelectionParams, VideoMeta } from './types.ts';

export interface SelectionResult {
  frames: SelectedFrame[];
  sampledFrames: number;
  prunedFrames: number;
  size: FrameSize;
}

type State = 'rest' | 'changing';

export async function selectFrames(
  meta: VideoMeta,
  params: SelectionParams,
  onProgress?: (sampled: number, selected: number) => void,
): Promise<SelectionResult> {
  const size = analysisSize(meta, params.analysisWidth);
  const picked: SelectedFrame[] = [];

  let previous: Uint8Array | null = null;
  let reference: Uint8Array | null = null;
  let referenceTimeMs = 0;
  let state: State = 'rest';
  let calmRun = 0;
  let changeStartedMs = 0;
  let lastOngoingMs = 0;
  let sampled = 0;
  let cursor: Point | undefined;
  let cursorAtReference: Point | undefined;
  let lastSample: Sampled | null = null;

  const emit = (
    timeMs: number,
    reason: SelectedFrame['reason'],
    grid: Grid | null,
    scrolling: boolean,
  ) => {
    const regions = grid ? significantRegions(grid) : [];
    const deltaPct = grid ? grid.changedPct : 0;
    picked.push({
      index: 0,
      timeMs,
      deltaPct,
      reason,
      regions,
      cursor,
      cursorFrom: cursorAtReference,
      scrolling,
      score: rank(reason, deltaPct, regions),
    });
    cursorAtReference = cursor;
    referenceTimeMs = timeMs;
    lastOngoingMs = timeMs;
    onProgress?.(sampled, picked.length);
  };

  for await (const frame of sample(meta, size, params.sampleFps)) {
    sampled++;
    lastSample = { timeMs: frame.timeMs, pixels: frame.pixels };

    if (!reference || !previous) {
      reference = frame.pixels.slice();
      previous = frame.pixels.slice();
      emit(frame.timeMs, 'start', null, false);
      continue;
    }

    const vsPrevious = diffGrid(frame.pixels, previous, size, params.pixelThreshold);
    const vsReference = diffGrid(frame.pixels, reference, size, params.pixelThreshold);

    // Track the cursor from frame-to-frame motion, and decide whether this
    // sample is *only* the cursor moving.
    const motion = classifyMotion(vsPrevious, params, cursor);
    if (motion.cursor) cursor = motion.cursor;

    const referenceMotion = classifyMotion(vsReference, params, cursor);
    const realChangePct = referenceMotion.cursorOnly ? 0 : vsReference.changedPct;
    const calmPct = motion.cursorOnly ? 0 : vsPrevious.changedPct;
    const scrolling = calmPct > params.enterPct
      ? estimateScroll(frame.pixels, previous, size) !== 0
      : false;

    const sinceReference = frame.timeMs - referenceTimeMs;
    const canEmit = sinceReference >= params.minGapMs;

    if (state === 'rest') {
      if (realChangePct >= params.enterPct) {
        state = 'changing';
        changeStartedMs = frame.timeMs;
        lastOngoingMs = frame.timeMs;
        calmRun = 0;
      } else if (sinceReference >= params.maxIntervalMs) {
        reference = frame.pixels.slice();
        emit(frame.timeMs, 'anchor', vsReference, false);
      }
    } else {
      calmRun = calmPct <= params.settlePct ? calmRun + 1 : 0;
      const settled = calmRun >= params.settleFrames;
      const ongoingBudget = scrolling ? params.ongoingMs * 2 : params.ongoingMs;
      const runningLong = frame.timeMs - lastOngoingMs >= ongoingBudget;

      if (settled && canEmit) {
        state = 'rest';
        calmRun = 0;
        const settledGrid = diffGrid(frame.pixels, reference, size, params.pixelThreshold);
        reference = frame.pixels.slice();
        emit(frame.timeMs, 'settled', settledGrid, scrolling);
      } else if (settled) {
        // Settled, but too close to the previous frame — fold it into the
        // reference so the next event is measured from here.
        state = 'rest';
        calmRun = 0;
        reference = frame.pixels.slice();
        referenceTimeMs = frame.timeMs;
      } else if (runningLong && canEmit) {
        const ongoingGrid = diffGrid(frame.pixels, reference, size, params.pixelThreshold);
        reference = frame.pixels.slice();
        emit(frame.timeMs, 'ongoing', ongoingGrid, scrolling);
      } else if (frame.timeMs - changeStartedMs >= params.maxIntervalMs) {
        // A change that never settles (video playing, spinner): stop waiting.
        state = 'rest';
        calmRun = 0;
        reference = frame.pixels.slice();
        referenceTimeMs = frame.timeMs;
      }
    }

    previous.set(frame.pixels);
  }

  // The final state of the screen is where a bug report usually ends up.
  if (lastSample && reference && lastSample.timeMs - referenceTimeMs >= params.minGapMs) {
    const grid = diffGrid(lastSample.pixels, reference, size, params.pixelThreshold);
    emit(lastSample.timeMs, 'end', grid, false);
  } else if (picked.length > 1) {
    picked[picked.length - 1]!.reason = 'end';
  }

  const before = picked.length;
  const frames = prune(picked, params.maxFrames);
  frames.forEach((frame, i) => {
    frame.index = i + 1;
  });

  return { frames, sampledFrames: sampled, prunedFrames: before - frames.length, size };
}

interface Sampled {
  timeMs: number;
  pixels: Uint8Array;
}

interface Motion {
  cursorOnly: boolean;
  cursor?: Point;
}

/**
 * Decide whether a diff is just the mouse pointer moving. A pointer produces
 * one or two small blobs — the spot it left and the spot it arrived at — and
 * almost no total area. Anything bigger is a real change.
 */
function classifyMotion(
  grid: Grid,
  params: SelectionParams,
  previousCursor: Point | undefined,
): Motion {
  if (grid.changedPct === 0) return { cursorOnly: true };
  if (grid.changedPct > params.cursorMaxAreaPct) return { cursorOnly: false };

  // No active cells at all: a few stray pixels of compression noise, not an event.
  const found = blobs(grid, 2);
  if (found.length === 0) return { cursorOnly: true };
  if (found.length > 3) return { cursorOnly: false };

  const maxSpanCols = (params.cursorMaxSpanPct / 100) * grid.cols;
  const maxSpanRows = (params.cursorMaxSpanPct / 100) * grid.rows;
  for (const blob of found) {
    if (blob.c1 - blob.c0 + 1 > maxSpanCols) return { cursorOnly: false };
    if (blob.r1 - blob.r0 + 1 > maxSpanRows) return { cursorOnly: false };
  }

  return { cursorOnly: true, cursor: pickCursorBlob(found, grid, previousCursor) };
}

/**
 * Of the small blobs, the one nearest the previous cursor position is where the
 * pointer *was*; the other one is where it is now.
 */
function pickCursorBlob(found: Blob[], grid: Grid, previous: Point | undefined): Point {
  const centers = found.map((blob) => blobCenter(blob, grid));
  if (centers.length === 1 || !previous) return centers[0]!;

  let departedIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  centers.forEach((center, i) => {
    const distance = Math.hypot(center.x - previous.x, center.y - previous.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      departedIndex = i;
    }
  });

  const arrived = centers.find((_, i) => i !== departedIndex);
  return arrived ?? centers[0]!;
}

/** Change boxes worth drawing: drop cursor-sized specks when a real region exists. */
function significantRegions(grid: Grid): Rect[] {
  const found = blobs(grid, 4);
  if (found.length === 0) return [];

  const totalCells = grid.cols * grid.rows;
  const minCells = Math.max(3, Math.round(totalCells * 0.0025));
  const big = found.filter((blob) => area(blob) >= minCells);
  const kept = (big.length ? big : found.slice(0, 1)).slice(0, 3);
  return kept.map((blob) => blobToRect(blob, grid));
}

function rank(reason: SelectedFrame['reason'], deltaPct: number, regions: Rect[]): number {
  const base: Record<SelectedFrame['reason'], number> = {
    start: 1000,
    end: 1000,
    settled: 20,
    ongoing: 6,
    anchor: 3,
  };
  // A change confined to a few regions is a discrete UI event and usually more
  // informative than a full repaint (page navigation, window switch).
  const focus = regions.length > 0 && regions.length <= 2 ? 6 : 0;
  return base[reason] + Math.min(deltaPct, 45) + focus;
}

/**
 * Enforce the frame budget. Frames are removed one at a time, always the one
 * whose loss costs least: low score and close in time to its surviving
 * neighbours, so the timeline keeps its spread instead of collapsing into the
 * busiest few seconds.
 */
function prune(frames: SelectedFrame[], maxFrames: number): SelectedFrame[] {
  if (frames.length <= maxFrames) return frames;
  const kept = [...frames];

  while (kept.length > maxFrames) {
    let victim = -1;
    let victimCost = Number.POSITIVE_INFINITY;
    for (let i = 1; i < kept.length - 1; i++) {
      const gap = (kept[i + 1]!.timeMs - kept[i - 1]!.timeMs) / 1000;
      const cost = kept[i]!.score * Math.log1p(gap);
      if (cost < victimCost) {
        victimCost = cost;
        victim = i;
      }
    }
    if (victim < 0) break;
    kept.splice(victim, 1);
  }

  return kept;
}
