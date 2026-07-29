import { expect, test } from 'bun:test';
import { blobToRect, blobs, diffGrid, estimateScroll } from '../src/core/diff.ts';

const SIZE = { width: 64, height: 48 };

function canvas(color: [number, number, number]): Uint8Array {
  const buffer = new Uint8Array(SIZE.width * SIZE.height * 3);
  for (let i = 0; i < buffer.length; i += 3) {
    buffer[i] = color[0];
    buffer[i + 1] = color[1];
    buffer[i + 2] = color[2];
  }
  return buffer;
}

function paint(
  buffer: Uint8Array,
  rect: { x: number; y: number; w: number; h: number },
  color: [number, number, number],
): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const p = (y * SIZE.width + x) * 3;
      buffer[p] = color[0];
      buffer[p + 1] = color[1];
      buffer[p + 2] = color[2];
    }
  }
}

test('a change that keeps brightness but shifts colour is still detected', () => {
  // Two colours ~1 luma step apart: a luma-only diff would score this as nothing.
  const before = canvas([90, 90, 90]);
  const after = canvas([90, 90, 90]);
  paint(after, { x: 10, y: 10, w: 20, h: 12 }, [150, 70, 70]);

  const grid = diffGrid(after, before, SIZE, 22);
  expect(grid.changedPixels).toBe(20 * 12);
  expect(blobs(grid).length).toBe(1);
});

test('a difference under the threshold is not a change', () => {
  const before = canvas([90, 90, 90]);
  const after = canvas([90, 90, 90]);
  paint(after, { x: 10, y: 10, w: 20, h: 12 }, [100, 100, 100]);

  expect(diffGrid(after, before, SIZE, 22).changedPixels).toBe(0);
});

test('separate changes stay separate, fragments of one change merge', () => {
  const before = canvas([20, 20, 24]);
  const after = canvas([20, 20, 24]);
  // Two halves of one dialog, a 2px gap apart.
  paint(after, { x: 4, y: 4, w: 12, h: 8 }, [200, 60, 60]);
  paint(after, { x: 4, y: 14, w: 12, h: 8 }, [200, 60, 60]);
  // A separate element far away.
  paint(after, { x: 48, y: 36, w: 10, h: 8 }, [60, 200, 60]);

  const found = blobs(diffGrid(after, before, SIZE, 22));
  expect(found.length).toBe(2);

  const grid = diffGrid(after, before, SIZE, 22);
  const rect = blobToRect(found[0]!, grid);
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.w).toBeLessThanOrEqual(1);
});

test('vertical scrolling is told apart from a repaint', () => {
  const stripes = canvas([30, 30, 30]);
  for (let y = 0; y < SIZE.height; y += 6) {
    paint(stripes, { x: 0, y, w: SIZE.width, h: 3 }, [200, 200, 200]);
  }

  const scrolled = canvas([30, 30, 30]);
  for (let y = 4; y < SIZE.height; y += 6) {
    paint(scrolled, { x: 0, y, w: SIZE.width, h: 3 }, [200, 200, 200]);
  }
  expect(estimateScroll(scrolled, stripes, SIZE)).not.toBe(0);

  const repainted = canvas([120, 40, 40]);
  expect(estimateScroll(repainted, stripes, SIZE)).toBe(0);
});
