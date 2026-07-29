/**
 * Each test here pins a bug that shipped in the first version and that the
 * original suite did not catch. They are written against behaviour a reader of
 * the output would notice, not against internals.
 *
 * The fixtures are deliberately crude — flat colour blocks appearing at known
 * times — because every one of these defects was about *which* frames come out
 * and *what the report says about them*, not about image fidelity.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/core/pipeline.ts';
import { profiles } from '../src/core/profiles.ts';
import type { Manifest } from '../src/core/types.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vidin-regress-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build a clip from lavfi filter fragments; returns its path. */
async function clip(
  name: string,
  seconds: number,
  filters: string[],
  size = '640x360',
): Promise<string> {
  const path = join(dir, `${name}.mp4`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${size}:d=${seconds}:r=30`,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    path,
  ];
  const proc = Bun.spawn({ cmd: ['ffmpeg', ...args], stdout: 'pipe', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`fixture ${name} failed to build: ${stderr}`);
  return path;
}

const fill = (color: string, from: number, size = '640:360') =>
  `drawbox=x=0:y=0:w=${size.split(':')[0]}:h=${size.split(':')[1]}:color=${color}:t=fill:enable='gte(t,${from})'`;

async function run(source: string, name: string, options: Parameters<typeof analyze>[0] extends infer T ? Partial<Omit<T & object, 'source' | 'outDir'>> : never = {}): Promise<Manifest> {
  const out = join(dir, `out-${name}`);
  const result = await analyze({ source, outDir: out, ...options });
  return result.manifest;
}

test('an event that settles sooner than minGapMs is still reported', async () => {
  // Three full-screen states. Under `walkthrough` the middle one settles ~750ms
  // after the previous kept frame while minGapMs is 1200 — it used to be folded
  // into the reference and vanish completely.
  const source = await clip('three-states', 8, [fill('white', 0.5), fill('red', 3)]);
  const manifest = await run(source, 'three-states', { profile: 'walkthrough' });

  const middle = manifest.frames.filter((f) => f.timeMs > 500 && f.timeMs < 3000);
  expect(middle.length, 'the white state must produce a frame').toBeGreaterThan(0);
  expect(manifest.frames.length).toBeGreaterThanOrEqual(4);
}, 60_000);

test('the frame labelled "final state" really is the end of the video', async () => {
  // A change close to the end used to move the internal reference without
  // emitting, after which an older frame was relabelled as the final state.
  const source = await clip('late-change', 5, [fill('white', 0.5), fill('red', 3), fill('green', 3.9)]);
  const manifest = await run(source, 'late-change', { profile: 'walkthrough' });

  const last = manifest.frames.at(-1)!;
  expect(last.reason).toBe('end');
  expect(
    last.timeMs,
    'the last frame must come after the final change, not before it',
  ).toBeGreaterThanOrEqual(3900);
}, 60_000);

test('a clip shorter than minGapMs still shows what it ended on', async () => {
  // 0.6s at the default 4fps analysis rate is sampled at 0 / 250 / 500ms, so the
  // change at 200ms is comfortably inside the sampled range. The whole clip is
  // shorter than minGapMs (450ms), which used to suppress the closing frame and
  // leave only the opening black screen.
  const source = await clip('tiny', 0.6, [fill('white', 0.2, '320:240')], '320x240');
  const manifest = await run(source, 'tiny');

  expect(manifest.frames.length).toBeGreaterThanOrEqual(2);
  const last = manifest.frames.at(-1)!;
  expect(last.timeMs).toBeGreaterThanOrEqual(250);
  expect(last.deltaPct, 'the closing frame must be the changed screen').toBeGreaterThan(50);
}, 60_000);

test('a blinking caret neither spends a frame nor hides a real event', async () => {
  // Small, compact and repeating. The classifier used to accept anything of that
  // shape as pointer noise, which both discounted it on the way in and told the
  // state machine the screen was calm — so a real change could be swallowed.
  const source = await clip('caret', 8, [
    `drawbox=x=0:y=0:w=640:h=360:color=white:t=fill`,
    `drawbox=x=100:y=90:w=3:h=20:color=black:t=fill:enable='lt(mod(t,1),0.5)'`,
    `drawbox=x=380:y=40:w=220:h=150:color=0x3050C0:t=fill:enable='gte(t,4)'`,
  ]);
  const manifest = await run(source, 'caret');

  const blinks = manifest.frames.filter((f) => f.timeMs > 500 && f.timeMs < 3800);
  expect(blinks, 'a blinking caret is not an event').toEqual([]);

  const panel = manifest.frames.filter((f) => f.timeMs >= 4000 && f.timeMs < 5500);
  expect(panel.length, 'the panel at 4s must survive the caret').toBe(1);
  expect(panel[0]!.reason).toBe('settled');
}, 60_000);

test('a change is captured once it settles, not mid-animation', async () => {
  const source = await clip('single-event', 8, [
    `drawbox=x=0:y=0:w=640:h=360:color=white:t=fill`,
    `drawbox=x=380:y=40:w=220:h=150:color=0x3050C0:t=fill:enable='gte(t,4)'`,
  ]);
  const manifest = await run(source, 'single-event');

  const mid = manifest.frames.filter((f) => f.reason === 'ongoing');
  expect(mid, 'an instant change has no middle to sample').toEqual([]);
  const settled = manifest.frames.filter((f) => f.reason === 'settled');
  expect(settled.length).toBe(1);
}, 60_000);

test('pruning relinks the annotations to the frames that survived', async () => {
  // Nine squares appear one per second in nine places. With a tight budget the
  // gaps between kept frames widen, so each survivor must report MORE change,
  // not the same amount it saw against a neighbour that was dropped.
  const squares = [
    [40, 40], [300, 40], [520, 60], [80, 180], [280, 160],
    [500, 180], [60, 290], [300, 280], [520, 290],
  ];
  const source = await clip('cumulative', 11, [
    `drawbox=x=0:y=0:w=640:h=360:color=white:t=fill`,
    ...squares.map(
      ([x, y], i) => `drawbox=x=${x}:y=${y}:w=60:h=60:color=black:t=fill:enable='gte(t,${i + 1})'`,
    ),
  ]);

  const full = await run(source, 'cumulative-full');
  const capped = await run(source, 'cumulative-capped', { overrides: { maxFrames: 4 } });

  expect(capped.frames.length).toBe(4);

  const widest = Math.max(...capped.frames.map((f) => f.deltaPct));
  const unpruned = Math.max(...full.frames.map((f) => f.deltaPct));
  expect(
    widest,
    'a frame spanning several dropped events must report their combined change',
  ).toBeGreaterThan(unpruned * 1.5);

  // And the caption must not imply the drawn boxes were all there was.
  const crowded = capped.frames.find((f) => f.regionsFound > f.regions.length);
  expect(crowded, 'more areas changed than can be drawn; that has to be recorded').toBeDefined();
}, 120_000);

test('an animated transition is captured after it finishes, not during it', async () => {
  // A panel slides in between 2.0s and 3.2s. The whole point of waiting for the
  // screen to settle is that none of those in-between frames is kept.
  const source = await clip(
    'slide',
    7,
    [`drawbox=x=0:y=0:w=640:h=360:color=white:t=fill`],
  );
  const slid = join(dir, 'slide-anim.mp4');
  const proc = Bun.spawn({
    cmd: [
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-f', 'lavfi', '-i', 'color=c=0x3050C0:s=200x200:d=7:r=30',
      '-filter_complex',
      "[0:v][1:v]overlay=x='if(lt(t,2),640,if(lt(t,3.2),640-(t-2)/1.2*240,400))':y=80:eval=frame[out]",
      '-map', '[out]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-pix_fmt', 'yuv420p', slid,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`slide fixture failed: ${stderr}`);

  const manifest = await run(slid, 'slide');
  const midAnimation = manifest.frames.filter((f) => f.timeMs > 2000 && f.timeMs < 3200);
  expect(midAnimation, 'nothing may be kept while the panel is still moving').toEqual([]);
  expect(manifest.frames.some((f) => f.reason === 'settled' && f.timeMs >= 3200)).toBe(true);
}, 90_000);

test('a scrolling stretch is reported as scrolling', async () => {
  // `scrolling` used to be computed per sample under a condition that could
  // never hold on a settled frame, so it was effectively always false.
  const stripes = Array.from(
    { length: 20 },
    (_, i) => `drawbox=x=0:y=${i * 60}:w=640:h=30:color=0x${i % 2 ? '303030' : 'B0B0B0'}:t=fill`,
  );
  const source = await clip(
    'scroll',
    8,
    // crop evaluates its x/y expressions per frame; it has no `eval` option.
    [...stripes, `crop=w=640:h=360:x=0:y='min(max((t-2)*200\\,0)\\,800)'`],
    '640x1200',
  );
  const manifest = await run(source, 'scroll');

  expect(
    manifest.frames.some((f) => f.scrolling),
    'a 4-second scroll must be recognised somewhere in the timeline',
  ).toBe(true);
}, 90_000);

test('a frame budget of one is honoured', async () => {
  const source = await clip('budget', 6, [fill('white', 2), fill('red', 4)]);
  const manifest = await run(source, 'budget', { overrides: { maxFrames: 1 } });

  expect(manifest.frames.length).toBe(1);
  expect(manifest.frames[0]!.index).toBe(1);
}, 60_000);

test('a still recording is not billed for duplicate frames', async () => {
  // maxIntervalMs is 15s, so 40s of nothing used to produce two anchor frames
  // pixel-identical to the first one.
  const source = await clip('still', 40, []);
  const manifest = await run(source, 'still');

  expect(manifest.frames.length).toBeLessThanOrEqual(2);
}, 120_000);

test('every profile keeps the ends of the timeline', async () => {
  const source = await clip('profiles', 8, [fill('white', 2), fill('red', 5)]);
  for (const name of Object.keys(profiles)) {
    const manifest = await run(source, `profile-${name}`, { profile: name });
    expect(manifest.frames.length, `${name} produced nothing`).toBeGreaterThan(1);
    expect(manifest.frames[0]!.reason, `${name} first frame`).toBe('start');
    expect(manifest.frames.at(-1)!.reason, `${name} last frame`).toBe('end');
  }
}, 180_000);
