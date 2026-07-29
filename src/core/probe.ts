import { FFPROBE, runOrThrow } from './ffmpeg.ts';
import type { VideoMeta } from './types.ts';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string };
}

export async function probe(path: string): Promise<VideoMeta> {
  const { stdout } = await runOrThrow(
    [FFPROBE, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    `ffprobe ${path}`,
  );
  const data = JSON.parse(stdout) as ProbeOutput;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) {
    throw new Error(`No video stream found in ${path}`);
  }

  const rotation = readRotation(video);
  const swapped = rotation === 90 || rotation === 270;
  const width = swapped ? video.height : video.width;
  const height = swapped ? video.width : video.height;

  const durationSec = Number(data.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`Could not determine the duration of ${path}`);
  }

  return {
    path,
    width,
    height,
    durationMs: Math.round(durationSec * 1000),
    fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    videoCodec: video.codec_name ?? 'unknown',
    sizeBytes: Number(data.format?.size ?? 0),
  };
}

function parseRate(rate?: string): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

function readRotation(stream: ProbeStream): number {
  const fromSideData = stream.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation;
  const fromTag = stream.tags?.rotate ? Number(stream.tags.rotate) : undefined;
  const raw = fromSideData ?? fromTag ?? 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}
