/**
 * Thin wrappers around the system ffmpeg/ffprobe binaries.
 *
 * vidin deliberately shells out instead of linking a native image library:
 * ffmpeg already does decoding, scaling, drawing and WebP encoding, and it can
 * hand us raw grayscale bytes on stdout for the analysis pass. That keeps the
 * dependency list at "a working ffmpeg" and lets Bun run the sources directly.
 */

export const FFMPEG = Bun.env.VIDIN_FFMPEG ?? 'ffmpeg';
export const FFPROBE = Bun.env.VIDIN_FFPROBE ?? 'ffprobe';
export const YTDLP = Bun.env.VIDIN_YTDLP ?? 'yt-dlp';

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
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
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
  const proc = Bun.spawn({
    cmd: [FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  // Drain stderr concurrently, otherwise a chatty ffmpeg can deadlock on a full pipe.
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  let pending = new Uint8Array(frameBytes);
  let filled = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.length) {
        const take = Math.min(frameBytes - filled, value.length - offset);
        pending.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === frameBytes) {
          yield pending;
          pending = new Uint8Array(frameBytes);
          filled = 0;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const code = await proc.exited;
  const stderr = await stderrPromise;
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
  const override = Bun.env.VIDIN_FONT;
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
    if (await Bun.file(path).exists()) {
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
