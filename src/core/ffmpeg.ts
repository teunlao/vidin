/**
 * Thin wrappers around the system ffmpeg/ffprobe binaries.
 *
 * vidin deliberately shells out instead of linking a native image library:
 * ffmpeg already does decoding, scaling, drawing and WebP encoding, and it can
 * hand us raw grayscale bytes on stdout for the analysis pass. That keeps the
 * dependency list at "a working ffmpeg".
 *
 * Only node: APIs here — the published package runs under whatever `npx`
 * resolves to, so the runtime code cannot assume Bun.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export const FFMPEG = process.env.VIDIN_FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.VIDIN_FFPROBE ?? 'ffprobe';
export const YTDLP = process.env.VIDIN_YTDLP ?? 'yt-dlp';

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a command to completion and capture its output as text. */
export async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const [bin, ...args] = cmd;
  const proc = spawn(bin!, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => (stdout += chunk));
  proc.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await exited(proc, (message) => (stderr += message));
  return { stdout, stderr, code };
}

/**
 * Exit code of a child, with a missing binary read as 127 rather than an
 * unhandled 'error' event — callers probe for tools by checking the code.
 */
function exited(proc: ChildProcess, onSpawnError: (message: string) => void): Promise<number> {
  return new Promise((resolve) => {
    proc.once('error', (error) => {
      onSpawnError(String(error));
      resolve(127);
    });
    proc.once('close', (code) => resolve(code ?? 1));
  });
}

/** Run a command and throw with the captured stderr when it fails. */
export async function runOrThrow(cmd: string[], what: string): Promise<RunResult> {
  const result = await run(cmd);
  if (result.code !== 0) {
    throw new FfmpegError(
      `${what} failed (exit ${result.code}): ${lastLines(result.stderr, 4)}`,
      result.code,
      result.stderr,
    );
  }
  return result;
}

export async function ffmpeg(args: string[], what = 'ffmpeg'): Promise<RunResult> {
  return runOrThrow([FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], what);
}

/**
 * Stream fixed-size raw frames out of ffmpeg without buffering the whole video.
 * Yields exactly `frameBytes`-sized chunks in decode order.
 */
export async function* rawFrames(args: string[], frameBytes: number): AsyncGenerator<Uint8Array> {
  const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drain stderr concurrently, otherwise a chatty ffmpeg can deadlock on a full pipe.
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => (stderr += chunk));
  const done = exited(proc, (message) => (stderr += message));

  let pending = new Uint8Array(frameBytes);
  let filled = 0;

  try {
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - offset);
        pending.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === frameBytes) {
          yield pending;
          pending = new Uint8Array(frameBytes);
          filled = 0;
        }
      }
    }
  } catch (error) {
    // A dead process closes stdout mid-iteration; report the ffmpeg failure,
    // not the stream teardown it caused.
    const code = await done;
    if (code !== 0) {
      throw new FfmpegError(
        `ffmpeg raw pass failed (exit ${code}): ${lastLines(stderr, 4)}`,
        code,
        stderr,
      );
    }
    throw error;
  } finally {
    // Reached with the pipe still open only when the consumer bailed early.
    if (proc.exitCode === null) proc.kill();
  }

  const code = await done;
  if (code !== 0) {
    throw new FfmpegError(
      `ffmpeg raw pass failed (exit ${code}): ${lastLines(stderr, 4)}`,
      code,
      stderr,
    );
  }
}

/** Resolve a monospace font file for drawtext, or null when none is available. */
let cachedFont: string | null | undefined;
export async function findFont(): Promise<string | null> {
  if (cachedFont !== undefined) return cachedFont;
  const override = process.env.VIDIN_FONT;
  const candidates = [
    ...(override ? [override] : []),
    '/System/Library/Fonts/SFNSMono.ttf',
    '/System/Library/Fonts/Monaco.ttf',
    '/System/Library/Fonts/Supplemental/Andale Mono.ttf',
    '/System/Library/Fonts/Menlo.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      cachedFont = path;
      return cachedFont;
    }
  }
  cachedFont = null;
  return cachedFont;
}

export async function assertToolchain(): Promise<void> {
  const missing: string[] = [];
  for (const bin of [FFMPEG, FFPROBE]) {
    const probe = await run([bin, '-version']);
    if (probe.code !== 0) missing.push(bin);
  }
  if (missing.length) {
    throw new Error(
      `vidin needs ${missing.join(' and ')} on PATH. Install ffmpeg (brew install ffmpeg) ` +
        `or point VIDIN_FFMPEG / VIDIN_FFPROBE at the binaries.`,
    );
  }
}

function lastLines(text: string, count: number): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-count).join(' | ');
}
