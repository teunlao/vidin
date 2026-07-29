import { join } from 'node:path';
import { probe } from './core/probe.ts';
import { profiles } from './core/profiles.ts';
import { formatTokens } from './core/report.ts';
import { formatTime } from './core/render.ts';
import { VERSION, analyze, zoom } from './core/pipeline.ts';
import type { Profile } from './core/types.ts';

const USAGE = `vidin ${VERSION} — turn a video into an agent-readable set of annotated keyframes

USAGE
  vidin <video|url> [options]            analyse a video (default command)
  vidin zoom <video> --from T --to T     dense frames over a short window
  vidin probe <video>                    print what ffprobe sees
  vidin mcp                              run the MCP server on stdio

OPTIONS
  -o, --out <dir>        output directory        (default ./.vidin/<name>)
  -p, --profile <name>   ${Object.keys(profiles).join(' | ')}
      --max-frames <n>   hard cap on kept frames
      --fps <n>          analysis sampling rate
      --width <px>       output frame width
      --quality <0-100>  WebP quality
      --sensitivity <n>  percent of the screen that counts as a change (lower = more frames)
      --no-annotate      no boxes, no cursor, no timestamp bar
      --no-sheets        skip contact sheets
      --json             print the manifest instead of a summary
  -q, --quiet            only print the output directory

ZOOM OPTIONS
      --from <time>      start, as SS.s or MM:SS.s or HH:MM:SS.s
      --to <time>        end
      --fps <n>          frames per second inside the window (default 4)
  -o, --out <dir>        session directory to write into (default ./.vidin/<name>)

EXAMPLES
  vidin ~/Desktop/bug.mov
  vidin bug.mov -o ./bug-frames --profile dense
  vidin zoom bug.mov --from 00:41 --to 00:45 --fps 6 -o ./bug-frames
`;

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(VERSION);
    return 0;
  }

  const command = args[0] === 'zoom' || args[0] === 'probe' || args[0] === 'mcp' || args[0] === 'analyze'
    ? args.shift()!
    : 'analyze';

  try {
    switch (command) {
      case 'mcp': {
        const { startServer } = await import('./mcp/server.ts');
        await startServer();
        return 0;
      }
      case 'probe':
        return await runProbe(args);
      case 'zoom':
        return await runZoom(args);
      default:
        return await runAnalyze(args);
    }
  } catch (error) {
    console.error(`vidin: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runAnalyze(args: string[]): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const source = positional[0];
  if (!source) {
    console.error('vidin: no video given\n');
    console.log(USAGE);
    return 1;
  }

  const overrides: Partial<Profile> = {
    maxFrames: numberFlag(flags, 'max-frames'),
    sampleFps: numberFlag(flags, 'fps'),
    frameWidth: numberFlag(flags, 'width'),
    quality: numberFlag(flags, 'quality'),
    enterPct: numberFlag(flags, 'sensitivity'),
    annotate: flags['no-annotate'] ? false : undefined,
    sheets: flags['no-sheets'] ? false : undefined,
  };

  const quiet = Boolean(flags.quiet || flags.q || flags.json);
  const result = await analyze({
    source,
    outDir: stringFlag(flags, 'out') ?? stringFlag(flags, 'o'),
    profile: stringFlag(flags, 'profile') ?? stringFlag(flags, 'p'),
    overrides,
    onLog: quiet ? undefined : (message) => console.error(`  ${message}`),
  });

  if (flags.json) {
    console.log(JSON.stringify(result.manifest, null, 2));
    return 0;
  }
  if (quiet) {
    console.log(result.dir);
    return 0;
  }

  const { stats, frames, sheets } = result.manifest;
  console.log('');
  console.log(`  ${result.dir}`);
  console.log('');
  for (const frame of frames) {
    console.log(
      `  #${String(frame.index).padStart(2, ' ')}  ${formatTime(frame.timeMs)}  ` +
        `${frame.reason.padEnd(8)} ${frame.deltaPct > 0.05 ? `${frame.deltaPct.toFixed(1)}%`.padStart(6) : '     —'}  ` +
        `${frame.file}`,
    );
  }
  console.log('');
  console.log(
    `  ${frames.length} frames · ${sheets.length} sheet(s) · ` +
      `${(stats.totalBytes / 1024 / 1024).toFixed(2)} MB · ~${formatTokens(stats.approxTokens)} vision tokens`,
  );
  console.log(`  read first: ${join(result.dir, 'REPORT.md')}`);
  return 0;
}

async function runZoom(args: string[]): Promise<number> {
  const { positional, flags } = parseArgs(args);
  const source = positional[0];
  if (!source) throw new Error('zoom needs a video path');

  const from = stringFlag(flags, 'from');
  const to = stringFlag(flags, 'to');
  if (!from || !to) throw new Error('zoom needs --from and --to');

  const result = await zoom({
    source,
    outDir: stringFlag(flags, 'out') ?? stringFlag(flags, 'o') ?? join(process.cwd(), '.vidin', 'zoom'),
    fromMs: parseTime(from),
    toMs: parseTime(to),
    fps: numberFlag(flags, 'fps'),
    width: numberFlag(flags, 'width'),
    quality: numberFlag(flags, 'quality'),
    annotate: flags['no-annotate'] ? false : undefined,
  });

  console.log(result.dir);
  for (const file of result.files) console.log(`  ${file}`);
  console.log(`  ${result.files.length} frames · ~${formatTokens(result.approxTokens)} vision tokens`);
  return 0;
}

async function runProbe(args: string[]): Promise<number> {
  const { positional } = parseArgs(args);
  const source = positional[0];
  if (!source) throw new Error('probe needs a video path');
  const meta = await probe(source);
  console.log(JSON.stringify(meta, null, 2));
  return 0;
}

/* --------------------------------------------------------------- parsing */

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const name = arg.replace(/^--?/, '');
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }

  return { positional, flags };
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, got "${value}"`);
  return parsed;
}

/** Accepts SS, SS.s, MM:SS(.s) and HH:MM:SS(.s). */
export function parseTime(value: string): number {
  const parts = value.trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Cannot read "${value}" as a timestamp (use SS.s, MM:SS.s or HH:MM:SS.s)`);
  }
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round(seconds * 1000);
}
