/**
 * Frame comparison on downscaled RGB buffers.
 *
 * Everything here works on a coarse cell grid rather than on raw pixels:
 * a screen recording changes in rectangular chunks (a dialog opens, a list
 * repaints), so cells are both cheaper and less noisy than per-pixel blobs.
 */

import type { Rect } from './types.ts';

/**
 * Analysis pixels per cell edge. Small on purpose: a mouse pointer is only a
 * handful of analysis pixels, and at a coarser grid it never reaches a cell's
 * activation threshold — the pointer becomes invisible to the tracker and its
 * movement gets misread as a real change.
 */
export const CELL = 4;
/** Fraction of a cell's pixels that must differ before the cell counts as changed. */
const CELL_ACTIVE_RATIO = 0.2;
/** Absolute floor for the same, so tiny edge cells stay meaningful. */
const CELL_ACTIVE_MIN = 3;

export interface Grid {
  cols: number;
  rows: number;
  /** 1 where the cell changed. */
  cells: Uint8Array;
  /** Number of pixels that differ, over the whole frame. */
  changedPixels: number;
  /** changedPixels as a percentage of the frame. */
  changedPct: number;
}

export interface Blob {
  /** Bounding box in cell coordinates. */
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  /** Number of active cells inside the box. */
  cells: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Compare two RGB buffers and return the changed-cell grid.
 *
 * The comparison is per channel, keeping the largest of the three deltas,
 * rather than on luma. UI changes are often chromatic at nearly constant
 * brightness — a field turning red, a green toast over a grey panel — and a
 * luma-only threshold silently misses exactly the states a bug report is about.
 */
export function diffGrid(
  a: Uint8Array,
  b: Uint8Array,
  size: FrameSize,
  threshold: number,
): Grid {
  const { width, height } = size;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const counts = new Uint16Array(cols * rows);
  let changedPixels = 0;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 3;
    const cellRow = (y / CELL) | 0;
    for (let x = 0; x < width; x++) {
      const p = rowOffset + x * 3;
      let delta = a[p] - b[p];
      if (delta < 0) delta = -delta;
      let other = a[p + 1] - b[p + 1];
      if (other < 0) other = -other;
      if (other > delta) delta = other;
      other = a[p + 2] - b[p + 2];
      if (other < 0) other = -other;
      if (other > delta) delta = other;

      if (delta > threshold) {
        changedPixels++;
        counts[cellRow * cols + ((x / CELL) | 0)]++;
      }
    }
  }

  const cells = new Uint8Array(cols * rows);
  if (changedPixels > 0) {
    for (let r = 0; r < rows; r++) {
      const cellH = Math.min(CELL, height - r * CELL);
      for (let c = 0; c < cols; c++) {
        const cellW = Math.min(CELL, width - c * CELL);
        const need = Math.max(CELL_ACTIVE_MIN, Math.round(cellW * cellH * CELL_ACTIVE_RATIO));
        if (counts[r * cols + c] >= need) cells[r * cols + c] = 1;
      }
    }
  }

  return {
    cols,
    rows,
    cells,
    changedPixels,
    changedPct: (changedPixels / (width * height)) * 100,
  };
}

/**
 * Group active cells into rectangles. Cells within `bridge` of each other are
 * treated as connected, so a dialog with a transparent middle still comes out
 * as one region instead of a constellation of fragments.
 */
export function blobs(grid: Grid, bridge = 4): Blob[] {
  const { cols, rows, cells } = grid;
  const seen = new Uint8Array(cols * rows);
  const found: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);

    let c0 = start % cols;
    let c1 = c0;
    let r0 = (start / cols) | 0;
    let r1 = r0;
    let count = 0;

    while (stack.length) {
      const idx = stack.pop()!;
      const c = idx % cols;
      const r = (idx / cols) | 0;
      count++;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;

      const rMin = Math.max(0, r - bridge);
      const rMax = Math.min(rows - 1, r + bridge);
      const cMin = Math.max(0, c - bridge);
      const cMax = Math.min(cols - 1, c + bridge);
      for (let nr = rMin; nr <= rMax; nr++) {
        for (let nc = cMin; nc <= cMax; nc++) {
          const nIdx = nr * cols + nc;
          if (cells[nIdx] && !seen[nIdx]) {
            seen[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }

    found.push({ c0, r0, c1, r1, cells: count });
  }

  found.sort((x, y) => area(y) - area(x));
  return found;
}

export function area(blob: Blob): number {
  return (blob.c1 - blob.c0 + 1) * (blob.r1 - blob.r0 + 1);
}

/** Convert a cell-space blob to a normalized rectangle, padded by one cell. */
export function blobToRect(blob: Blob, grid: Grid): Rect {
  const x0 = Math.max(0, blob.c0 - 1) / grid.cols;
  const y0 = Math.max(0, blob.r0 - 1) / grid.rows;
  const x1 = Math.min(grid.cols, blob.c1 + 2) / grid.cols;
  const y1 = Math.min(grid.rows, blob.r1 + 2) / grid.rows;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function blobCenter(blob: Blob, grid: Grid): { x: number; y: number } {
  return {
    x: (blob.c0 + blob.c1 + 1) / 2 / grid.cols,
    y: (blob.r0 + blob.r1 + 1) / 2 / grid.rows,
  };
}

/**
 * Vertical scroll estimate: compare row-brightness profiles at several offsets.
 * A scrolling page matches itself well at a non-zero shift, a repainting page
 * does not. Returns the shift in analysis pixels, 0 when there is no match.
 */
export function estimateScroll(
  a: Uint8Array,
  b: Uint8Array,
  size: FrameSize,
  /** Largest shift to consider, as a FRACTION of frame height (not a percent). */
  maxShiftFraction = 0.35,
): number {
  const { width, height } = size;
  const pa = rowProfile(a, width, height);
  const pb = rowProfile(b, width, height);
  const maxShift = Math.max(2, Math.round(height * maxShiftFraction));

  const zero = profileError(pa, pb, 0, height);
  let best = 0;
  let bestError = zero;
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    if (shift === 0) continue;
    const error = profileError(pa, pb, shift, height);
    if (error < bestError) {
      bestError = error;
      best = shift;
    }
  }
  // Require a clear win over "no shift", otherwise this is a repaint, not a scroll.
  return bestError < zero * 0.45 ? best : 0;
}

/** Mean of the green channel per row — close enough to brightness, a third of the work. */
function rowProfile(buf: Uint8Array, width: number, height: number): Float32Array {
  const profile = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const offset = y * width * 3 + 1;
    for (let x = 0; x < width; x++) sum += buf[offset + x * 3];
    profile[y] = sum / width;
  }
  return profile;
}

function profileError(a: Float32Array, b: Float32Array, shift: number, height: number): number {
  let sum = 0;
  let n = 0;
  const from = Math.max(0, -shift);
  const to = Math.min(height, height - shift);
  for (let y = from; y < to; y++) {
    const d = a[y] - b[y + shift];
    sum += d * d;
    n++;
  }
  return n === 0 ? Number.POSITIVE_INFINITY : sum / n;
}
