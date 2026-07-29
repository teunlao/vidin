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
 *
 * Two invariants hold no matter which path a frame took through here:
 *
 *   A. The reference frame only ever advances by EMITTING. No path folds a
 *      changed screen into the reference silently — that would make the change
 *      unrecoverable, because every later diff would then measure zero against
 *      a state the reader never sees.
 *   B. Every frame's deltaPct/regions/cursorFrom describe its neighbour in the
 *      FINAL list. They are relinked after pruning, so neither the drawn box nor
 *      the report can claim a change against a frame that was dropped.
 */

import { area, blobCenter, blobToRect, blobs, diffGrid, estimateScroll } from './diff.ts';
import type { FrameSize, Grid } from './diff.ts';
import { analysisSize, sample } from './sample.ts';
import type { Point, Rect, SelectedFrame, SelectionParams, VideoMeta } from './types.ts';

export interface SelectionResult {
  frames: SelectedFrame[];
  sampledFrames: number;
  prunedFrames: number;
  size: FrameSize;
}

type State = 'rest' | 'changing';

/** A kept frame plus the analysis pixels behind it, so deltas can be relinked. */
interface Candidate {
  frame: SelectedFrame;
  pixels: Uint8Array;
}

export async function selectFrames(
  meta: VideoMeta,
  params: SelectionParams,
  onProgress?: (sampled: number, selected: number) => void,
): Promise<SelectionResult> {
  const size = analysisSize(meta, params.analysisWidth);
  const candidates: Candidate[] = [];
  // Relinking needs the analysis pixels of every kept frame, so the list is
  // trimmed as it grows rather than only at the end — otherwise an hour-long
  // recording would hold thousands of buffers before the budget is applied.
  const softCap = Math.max(params.maxFrames * 3, params.maxFrames + 8);

  let previous: Uint8Array | null = null;
  let reference: Uint8Array | null = null;
  let referenceTimeMs = 0;
  let state: State = 'rest';
  let calmRun = 0;
  let lastOngoingMs = 0;
  let episodeScrolling = false;
  let sampled = 0;
  let pruned = 0;
  let cursor: Point | undefined;
  let cursorSeenMs = Number.NEGATIVE_INFINITY;
  let lastSample: Sampled | null = null;

  /** The pointer is only reported while the sighting is recent. */
  const freshCursor = (timeMs: number): Point | undefined =>
    timeMs - cursorSeenMs <= params.cursorStaleMs ? cursor : undefined;

  const emit = (
    timeMs: number,
    reason: SelectedFrame['reason'],
    pixels: Uint8Array,
    grid: Grid | null,
    scrolling: boolean,
  ) => {
    const stored = pixels.slice();
    const found = grid ? significantRegions(grid) : { regions: [], total: 0 };
    const regions = found.regions;
    const deltaPct = grid ? grid.changedPct : 0;
    candidates.push({
      frame: {
        index: 0,
        timeMs,
        deltaPct,
        reason,
        regions,
        regionsFound: found.total,
        cursor: freshCursor(timeMs),
        cursorFrom: candidates.at(-1)?.frame.cursor,
        scrolling,
        score: rank(reason, deltaPct, regions),
      },
      pixels: stored,
    });

    // Invariant A: the reference is exactly the last emitted frame.
    reference = stored;
    referenceTimeMs = timeMs;
    lastOngoingMs = timeMs;

    if (candidates.length > softCap) {
      pruned += prune(candidates, Math.max(params.maxFrames, 2));
    }
    onProgress?.(sampled, candidates.length);
  };

  for await (const frame of sample(meta, size, params.sampleFps)) {
    sampled++;
    lastSample = { timeMs: frame.timeMs, pixels: frame.pixels };

    if (!reference || !previous) {
      previous = frame.pixels.slice();
      emit(frame.timeMs, 'start', frame.pixels, null, false);
      continue;
    }

    const vsPrevious = diffGrid(frame.pixels, previous, size, params.pixelThreshold);
    const vsReference = diffGrid(frame.pixels, reference, size, params.pixelThreshold);

    // Track the pointer from frame-to-frame motion, and decide whether this
    // sample is *only* the pointer moving.
    const motion = classifyMotion(vsPrevious, params, freshCursor(frame.timeMs));
    if (motion.cursor) {
      cursor = motion.cursor;
      cursorSeenMs = frame.timeMs;
    }

    const calmPct = motion.cursorOnly ? 0 : vsPrevious.changedPct;
    const realChangePct = classifyMotion(vsReference, params, freshCursor(frame.timeMs)).cursorOnly
      ? 0
      : vsReference.changedPct;

    const sinceReference = frame.timeMs - referenceTimeMs;
    const canEmit = sinceReference >= params.minGapMs;

    if (state === 'rest') {
      if (realChangePct >= params.enterPct) {
        state = 'changing';
        calmRun = 0;
        // The periodic-sample clock starts with the episode. Leaving it at the
        // previous emit makes the very first sample of a change look overdue,
        // and fires an `ongoing` frame in the middle of the animation — the one
        // frame this selector exists to avoid.
        lastOngoingMs = frame.timeMs;
        // Decided once, at the start of the episode. A per-sample flag could
        // never be true on a settled frame: settling requires a calm sample and
        // scrolling requires a busy one, so the two can never coincide.
        episodeScrolling = estimateScroll(frame.pixels, previous, size) !== 0;
      } else if (sinceReference >= params.maxIntervalMs) {
        // A still screen does not deserve a duplicate of the frame already
        // kept; only a screen that drifted below the event threshold does.
        if (vsReference.changedPct > 0) {
          emit(frame.timeMs, 'anchor', frame.pixels, vsReference, false);
        } else {
          referenceTimeMs = frame.timeMs;
        }
      }
    } else {
      calmRun = calmPct <= params.settlePct ? calmRun + 1 : 0;
      if (calmPct > params.enterPct && estimateScroll(frame.pixels, previous, size) !== 0) {
        episodeScrolling = true;
      }

      const settled = calmRun >= params.settleFrames;
      const ongoingBudget = episodeScrolling ? params.ongoingMs * 2 : params.ongoingMs;

      if (settled && canEmit) {
        state = 'rest';
        calmRun = 0;
        emit(frame.timeMs, 'settled', frame.pixels, vsReference, episodeScrolling);
      } else if (settled) {
        // Settled, but too soon after the previous kept frame. Hold the state
        // and let the next calm sample past minGapMs emit it. Folding it into
        // the reference here would destroy the event outright (invariant A).
      } else if (frame.timeMs - lastOngoingMs >= ongoingBudget && canEmit) {
        emit(frame.timeMs, 'ongoing', frame.pixels, vsReference, episodeScrolling);
      }
    }

    previous.set(frame.pixels);
  }

  // Where a bug report ends up is usually the point of it, so the final state is
  // kept whenever it differs at all — a clip shorter than minGapMs would
  // otherwise show nothing but its first frame.
  if (lastSample && reference && lastSample.timeMs > referenceTimeMs) {
    const grid = diffGrid(lastSample.pixels, reference, size, params.pixelThreshold);
    if (grid.changedPct > 0 || lastSample.timeMs - referenceTimeMs >= params.minGapMs) {
      emit(lastSample.timeMs, 'end', lastSample.pixels, grid, false);
    }
  }
  if (candidates.length > 1) candidates.at(-1)!.frame.reason = 'end';

  pruned += prune(candidates, params.maxFrames);
  relink(candidates, size, params.pixelThreshold);

  const frames = candidates.map((candidate, i) => {
    candidate.frame.index = i + 1;
    return candidate.frame;
  });

  return { frames, sampledFrames: sampled, prunedFrames: pruned, size };
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
 * Decide whether a diff is just the mouse pointer moving.
 *
 * Size alone is not evidence. A blinking text caret, a spinner, a filling
 * progress bar and a ticking counter are all small and compact, and calling any
 * of them "pointer noise" makes them invisible twice over: the change is
 * discounted on the way in, and the screen is simultaneously reported as calm.
 * So a positional argument is required as well — either a blob sitting where
 * the pointer last was (the spot it is leaving), or, when no pointer is known
 * yet, the two-blob leave-and-arrive signature that a moving pointer produces
 * and a blinking caret does not.
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

  const centers = found.map((blob) => blobCenter(blob, grid));
  if (previousCursor) {
    const near = params.cursorNearPct / 100;
    if (!centers.some((c) => distance(c, previousCursor) <= near)) return { cursorOnly: false };
  } else if (found.length < 2) {
    return { cursorOnly: false };
  }

  return { cursorOnly: true, cursor: pickCursorBlob(centers, previousCursor) };
}

/**
 * Of the small blobs, the one nearest the previous pointer position is where the
 * pointer *was*; the other one is where it is now.
 */
function pickCursorBlob(centers: Point[], previous: Point | undefined): Point {
  if (centers.length === 1 || !previous) return centers[0]!;

  let departedIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  centers.forEach((center, i) => {
    const gap = distance(center, previous);
    if (gap < bestDistance) {
      bestDistance = gap;
      departedIndex = i;
    }
  });

  return centers.find((_, i) => i !== departedIndex) ?? centers[0]!;
}

/**
 * Change boxes worth drawing: drop cursor-sized specks when a real region
 * exists, and report how many survived that filter even though only the largest
 * few are drawn.
 */
const MAX_DRAWN_REGIONS = 3;

function significantRegions(grid: Grid): { regions: Rect[]; total: number } {
  const found = blobs(grid, 4);
  if (found.length === 0) return { regions: [], total: 0 };

  const totalCells = grid.cols * grid.rows;
  const minCells = Math.max(3, Math.round(totalCells * 0.0025));
  const big = found.filter((blob) => area(blob) >= minCells);
  const kept = big.length ? big : found.slice(0, 1);
  return {
    regions: kept.slice(0, MAX_DRAWN_REGIONS).map((blob) => blobToRect(blob, grid)),
    total: kept.length,
  };
}

function rank(reason: SelectedFrame['reason'], deltaPct: number, regions: readonly Rect[]): number {
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
 * Recompute each frame's difference against the frame that actually precedes it
 * in the final list. Pruning removes frames from the middle, and without this
 * the survivors keep describing neighbours that are no longer there — the report
 * would understate the change exactly where the most happened, and the drawn box
 * would imply the rest of it had already been visible.
 */
function relink(candidates: Candidate[], size: FrameSize, threshold: number): void {
  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i]!;
    if (i === 0) {
      current.frame.deltaPct = 0;
      current.frame.regions = [];
      current.frame.regionsFound = 0;
      current.frame.cursorFrom = undefined;
      continue;
    }
    const before = candidates[i - 1]!;
    const grid = diffGrid(current.pixels, before.pixels, size, threshold);
    const found = significantRegions(grid);
    current.frame.deltaPct = grid.changedPct;
    current.frame.regions = found.regions;
    current.frame.regionsFound = found.total;
    current.frame.cursorFrom = before.frame.cursor;
  }
}

/**
 * Enforce the frame budget. Frames are removed one at a time, always the one
 * whose loss costs least: low score and close in time to its surviving
 * neighbours, so the timeline keeps its spread instead of collapsing into the
 * busiest few seconds. Returns how many were removed.
 */
function prune(candidates: Candidate[], maxFrames: number): number {
  if (candidates.length <= maxFrames) return 0;

  // The loop below protects the first and last entries, so a budget below two
  // has to be honoured explicitly instead of silently returning two frames.
  // The final state is the more useful single frame for a bug report.
  if (maxFrames <= 1) {
    const removed = candidates.length - 1;
    candidates.splice(0, removed);
    return removed;
  }

  let removed = 0;
  while (candidates.length > maxFrames) {
    let victim = -1;
    let victimCost = Number.POSITIVE_INFINITY;
    for (let i = 1; i < candidates.length - 1; i++) {
      const gap = (candidates[i + 1]!.frame.timeMs - candidates[i - 1]!.frame.timeMs) / 1000;
      const cost = candidates[i]!.frame.score * Math.log1p(gap);
      if (cost < victimCost) {
        victimCost = cost;
        victim = i;
      }
    }
    if (victim < 0) break;
    candidates.splice(victim, 1);
    removed++;
  }
  return removed;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
