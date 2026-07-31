import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { YTDLP, run } from './ffmpeg.ts';

export interface ResolvedSource {
  input: string;
  path: string;
  downloaded: boolean;
}

/**
 * Accepts a local path or a URL. URLs are handed to yt-dlp, which covers plain
 * file links as well as the video hosts people paste into bug tickets.
 */
export async function resolveSource(input: string, workDir: string): Promise<ResolvedSource> {
  if (!isUrl(input)) {
    const path = isAbsolute(input) ? input : resolve(process.cwd(), input);
    if (!existsSync(path)) {
      throw new Error(`Video not found: ${path}`);
    }
    return { input, path, downloaded: false };
  }

  const downloadDir = join(workDir, 'source');
  await mkdir(downloadDir, { recursive: true });

  const probe = await run([YTDLP, '--version']);
  if (probe.code !== 0) {
    throw new Error(
      `Downloading ${input} needs yt-dlp on PATH (brew install yt-dlp), or pass a local file.`,
    );
  }

  const template = join(downloadDir, '%(title).80B.%(ext)s');
  const result = await run([
    YTDLP,
    '--no-playlist',
    '--no-progress',
    '--restrict-filenames',
    '-f',
    'bv*+ba/b',
    '--merge-output-format',
    'mp4',
    '-o',
    template,
    '--print',
    'after_move:filepath',
    input,
  ]);
  if (result.code !== 0) {
    throw new Error(`yt-dlp failed for ${input}: ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }

  const path = result.stdout.trim().split('\n').filter(Boolean).pop();
  if (!path || !existsSync(path)) {
    throw new Error(`yt-dlp reported no output file for ${input}`);
  }
  return { input, path, downloaded: true };
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function sessionNameFor(input: string): string {
  const raw = isUrl(input) ? new URL(input).pathname : input;
  const name = basename(raw).replace(/\.[a-z0-9]+$/i, '') || 'video';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'video';
}
