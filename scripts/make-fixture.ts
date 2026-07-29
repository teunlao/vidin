#!/usr/bin/env bun
/**
 * Builds a synthetic "screen recording with a bug" so the selector can be
 * checked against a known timeline:
 *
 *   0.0–3.0   idle app, cursor parked            → 1 frame (the start)
 *   3.0–6.0   cursor travels across the window   → no frames (cursor noise)
 *   6.0       a form panel appears               → 1 frame, boxed
 *   8.0–9.0   cursor moves to the button         → no frames
 *   9.5       an error dialog appears            → 1 frame, boxed
 *  14.0       a toast appears bottom-right       → 1 frame, boxed
 *  16.0       the dialog closes                  → 1 frame, boxed
 *  16.0–20.0  idle                               → the final frame
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findFont } from '../src/core/ffmpeg.ts';

const WIDTH = 1280;
const HEIGHT = 800;
const DURATION = 20;

const out = join(import.meta.dir, '..', 'fixtures');
await mkdir(out, { recursive: true });
const target = join(out, 'screen-bug.mp4');
const font = await findFont();

const box = (
  x: string | number,
  y: string | number,
  w: string | number,
  h: string | number,
  color: string,
  enable?: string,
) =>
  `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill` +
  (enable ? `:enable='${enable}'` : '');

const text = (value: string, x: number, y: number, size: number, color: string, enable?: string) =>
  `drawtext=${font ? `fontfile='${font}':` : ''}text='${value}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}` +
  (enable ? `:enable='${enable}'` : '');

// Piecewise cursor path: parked, sweeping right, parked, nudging to the button.
const cursorX =
  `'if(lt(t,3),220, if(lt(t,6), 220+(t-3)/3*620, if(lt(t,8),840, if(lt(t,9), 840+(t-8)*90, 930))))'`;
const cursorY =
  `'if(lt(t,3),430, if(lt(t,6), 430-(t-3)/3*120, if(lt(t,8),310, if(lt(t,9), 310+(t-8)*150, 460))))'`;

const filters = [
  // chrome
  box(0, 0, WIDTH, 64, '0x24242E'),
  box(0, 64, 220, HEIGHT - 64, '0x1C1C24'),
  text('Orders', 28, 22, 22, '0xE8E8F0'),
  ...[0, 1, 2, 3, 4].map((i) => box(28, 110 + i * 44, 150, 14, '0x3A3A48')),

  // content cards
  ...[0, 1, 2].map((i) => box(260, 110 + i * 150, 960, 120, '0x2B2B36')),
  ...[0, 1, 2].map((i) => box(285, 135 + i * 150, 420, 16, '0x4C4C5E')),
  ...[0, 1, 2].map((i) => box(285, 165 + i * 150, 640, 12, '0x3C3C4A')),

  // a form panel slides in at 6s
  box(880, 620, 340, 140, '0x33334A', 'gte(t,6)'),
  text('Refund amount', 900, 640, 18, '0xD8D8E8', 'gte(t,6)'),
  box(900, 672, 300, 30, '0x50506E', 'gte(t,6)'),
  box(900, 714, 120, 32, '0x4C7CF0', 'gte(t,6)'),

  // the bug: an error dialog between 9.5s and 16s
  box(390, 260, 500, 220, '0x3A1F26', 'between(t,9.5,16)'),
  box(390, 260, 500, 6, '0xFF4D4D', 'between(t,9.5,16)'),
  text('Request failed', 420, 300, 30, '0xFF8080', 'between(t,9.5,16)'),
  text('500 Internal Server Error', 420, 350, 20, '0xE0C0C0', 'between(t,9.5,16)'),
  text('POST /api/orders/4821/refund', 420, 385, 18, '0xC0A0A0', 'between(t,9.5,16)'),
  box(760, 420, 100, 34, '0x8A3A3A', 'between(t,9.5,16)'),

  // a toast at 14s
  box(300, 690, 300, 70, '0x2E4A32', 'gte(t,14)'),
  text('Retrying in 5s', 325, 715, 18, '0xB8E6C0', 'gte(t,14)'),
];

// The cursor is a separate input composited with overlay rather than a drawbox:
// drawbox has no eval=frame, so it resolves its expressions once with t=NAN and
// the pointer would sit still for the whole clip.
const args = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  `color=c=0x16161C:s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=30`,
  '-f',
  'lavfi',
  '-i',
  `color=c=0xF5F5F5:s=13x19:d=${DURATION}:r=30`,
  '-filter_complex',
  `[0:v]${filters.join(',')}[base];[base][1:v]overlay=x=${cursorX}:y=${cursorY}:eval=frame[out]`,
  '-map',
  '[out]',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '20',
  '-pix_fmt',
  'yuv420p',
  target,
];

const proc = Bun.spawn({ cmd: ['ffmpeg', ...args], stdout: 'pipe', stderr: 'pipe' });
const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
if (code !== 0) {
  console.error(stderr);
  process.exit(1);
}
console.log(target);
