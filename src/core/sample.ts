import { rawFrames } from './ffmpeg.ts';
import type { FrameSize } from './diff.ts';
import type { VideoMeta } from './types.ts';

/** Bytes per analysis pixel. RGB, not luma — see diffGrid for why. */
export const CHANNELS = 3;

export interface Sample {
  timeMs: number;
  pixels: Uint8Array;
}

/** Analysis resolution: a fixed width, height derived from the source aspect, both even. */
export function analysisSize(meta: VideoMeta, targetWidth: number): FrameSize {
  const width = Math.min(targetWidth, meta.width) | 0;
  const even = (n: number) => Math.max(2, n - (n % 2));
  return {
    width: even(width),
    height: even(Math.round((width * meta.height) / meta.width)),
  };
}

/**
 * Walk the video at `fps`, yielding downscaled RGB frames.
 * One ffmpeg process, one decode pass, constant memory.
 */
export async function* sample(
  meta: VideoMeta,
  size: FrameSize,
  fps: number,
): AsyncGenerator<Sample> {
  const args = [
    '-i',
    meta.path,
    '-an',
    '-sn',
    '-vf',
    `fps=${fps},scale=${size.width}:${size.height}:flags=bilinear,format=rgb24`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ];

  let index = 0;
  for await (const pixels of rawFrames(args, size.width * size.height * CHANNELS)) {
    yield { timeMs: Math.round((index * 1000) / fps), pixels };
    index++;
  }
}
