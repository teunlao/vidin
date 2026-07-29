/**
 * The fixture has a known timeline (see scripts/make-fixture.ts), which makes it
 * possible to assert the two properties the whole tool rests on: every real UI
 * event produces exactly one frame, and pointer movement produces none.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/core/pipeline.ts';
import type { Manifest } from '../src/core/types.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'screen-bug.mp4');

/** Events staged in the fixture, in seconds. */
const EVENTS = { panel: 6, dialog: 9.5, toast: 14, dialogClosed: 16 };
/** Stretches where only the mouse pointer moves. */
const CURSOR_ONLY = [
  { from: 3.2, to: 5.9 },
  { from: 8.1, to: 8.9 },
];

let manifest: Manifest;
let dir: string;

beforeAll(async () => {
  if (!(await Bun.file(FIXTURE).exists())) {
    const build = Bun.spawn({
      cmd: ['bun', 'run', join(import.meta.dir, '..', 'scripts', 'make-fixture.ts')],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  }
  dir = await mkdtemp(join(tmpdir(), 'vidin-test-'));
  manifest = (await analyze({ source: FIXTURE, outDir: dir })).manifest;
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('every staged UI event produces one frame, shortly after it happens', () => {
  for (const [name, at] of Object.entries(EVENTS)) {
    const matches = manifest.frames.filter(
      (frame) => frame.timeMs >= at * 1000 && frame.timeMs <= (at + 1.5) * 1000,
    );
    expect(matches.length, `${name} at ${at}s should produce exactly one frame`).toBe(1);
    expect(matches[0]!.reason).toBe('settled');
  }
});

test('the settled frame shows the state after the change, not mid-animation', () => {
  // Every event frame lands after its trigger, never before it.
  for (const [name, at] of Object.entries(EVENTS)) {
    const frame = manifest.frames.find(
      (f) => f.timeMs >= at * 1000 && f.timeMs <= (at + 1.5) * 1000,
    );
    expect(frame!.timeMs, `${name} frame must come after the change started`).toBeGreaterThanOrEqual(
      at * 1000,
    );
  }
});

test('pointer movement alone never spends a frame', () => {
  for (const window of CURSOR_ONLY) {
    const inside = manifest.frames.filter(
      (frame) => frame.timeMs > window.from * 1000 && frame.timeMs < window.to * 1000,
    );
    expect(inside, `frames kept during cursor-only motion ${window.from}-${window.to}s`).toEqual([]);
  }
});

test('the pointer is tracked and carried onto later frames', () => {
  const tracked = manifest.frames.filter((frame) => frame.cursor !== undefined);
  expect(tracked.length).toBeGreaterThan(0);
  for (const frame of tracked) {
    expect(frame.cursor!.x).toBeGreaterThanOrEqual(0);
    expect(frame.cursor!.x).toBeLessThanOrEqual(1);
    expect(frame.cursor!.y).toBeGreaterThanOrEqual(0);
    expect(frame.cursor!.y).toBeLessThanOrEqual(1);
  }
});

test('changed regions are boxed and stay inside the frame', () => {
  const events = manifest.frames.filter((frame) => frame.reason === 'settled');
  expect(events.length).toBeGreaterThan(0);
  for (const frame of events) {
    expect(frame.regions.length).toBeGreaterThan(0);
    for (const region of frame.regions) {
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.w).toBeLessThanOrEqual(1.0001);
      expect(region.y + region.h).toBeLessThanOrEqual(1.0001);
    }
  }
});

test('the timeline is bounded by the first and last frame', () => {
  expect(manifest.frames[0]!.reason).toBe('start');
  expect(manifest.frames.at(-1)!.reason).toBe('end');
});

test('a 20s recording costs a fraction of one-frame-per-second', () => {
  // 20s at 1fps would be ~20 frames ≈ 32k vision tokens.
  expect(manifest.frames.length).toBeLessThan(10);
  expect(manifest.stats.approxTokens).toBeLessThan(20_000);
});

test('the frame budget is honoured and keeps the ends of the timeline', async () => {
  const capped = await mkdtemp(join(tmpdir(), 'vidin-cap-'));
  try {
    const result = await analyze({ source: FIXTURE, outDir: capped, overrides: { maxFrames: 3 } });
    expect(result.manifest.frames.length).toBe(3);
    expect(result.manifest.frames[0]!.reason).toBe('start');
    expect(result.manifest.frames.at(-1)!.reason).toBe('end');
    expect(result.manifest.frames.map((frame) => frame.index)).toEqual([1, 2, 3]);
  } finally {
    await rm(capped, { recursive: true, force: true });
  }
}, 60_000);
