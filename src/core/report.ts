/**
 * REPORT.md is the entry point an agent reads first. It has to answer, in text,
 * "what happens in this video and which images should I actually open" — so the
 * agent spends vision tokens on two or three frames instead of all of them.
 */

import { formatTime } from './render.ts';
import type { Manifest, Rect, SelectedFrame } from './types.ts';

export function buildReport(manifest: Manifest): string {
  const { video, frames, sheets, stats, profile, source } = manifest;
  const lines: string[] = [];

  lines.push(`# ${sourceTitle(source.input)} — vidin frames`);
  lines.push('');
  lines.push(
    [
      `**${formatTime(video.durationMs)}**`,
      `${video.width}x${video.height}`,
      `${video.fps.toFixed(0)} fps`,
      video.hasAudio ? 'audio: yes' : 'audio: no',
    ].join(' · '),
  );
  lines.push('');
  lines.push(
    `${frames.length} frames selected from ${stats.sampledFrames} samples ` +
      `(profile \`${profile.name}\`, adaptive: a frame is kept when the screen changes and then settles). ` +
      `Vision cost of everything below: ~${formatTokens(stats.approxTokens)} tokens.`,
  );
  lines.push('');

  lines.push('## Read this in order');
  lines.push('');
  if (sheets.length) {
    lines.push(
      `1. Open ${sheets.map((s) => `\`${s.file}\``).join(', ')} — the whole video as a labelled grid ` +
        `(~${formatTokens(sheets.reduce((sum, s) => sum + s.approxTokens, 0))} tokens).`,
    );
    lines.push('2. Find the moment that matters in the timeline below.');
    lines.push('3. Open only those frame files for full detail.');
  } else {
    lines.push('1. Use the timeline below to pick the moments that matter.');
    lines.push('2. Open only those frame files.');
  }
  lines.push(
    `4. Need more detail between two frames? \`vidin zoom "${manifest.source.resolved}" --from MM:SS --to MM:SS --fps 4\``,
  );
  lines.push('');

  if (manifest.profile.annotate) {
    lines.push('## What the annotations mean');
    lines.push('');
    lines.push('- **Red dashed box** — the area that changed since the previous frame in this list.');
    lines.push('- **Bottom bar** — frame number, timestamp in the original video, time since the previous frame, why it was kept.');
    lines.push('');
  }

  lines.push('## Timeline');
  lines.push('');
  lines.push('| # | time | gap | changed | what moved | frame |');
  lines.push('|---|------|-----|---------|------------|-------|');
  frames.forEach((frame, i) => {
    const previous = i > 0 ? frames[i - 1]! : null;
    const gap = previous ? `+${((frame.timeMs - previous.timeMs) / 1000).toFixed(1)}s` : '—';
    const changed = frame.deltaPct > 0.05 ? `${frame.deltaPct.toFixed(1)}%` : '—';
    lines.push(
      `| ${frame.index} | \`${formatTime(frame.timeMs)}\` | ${gap} | ${changed} | ` +
        `${describeFrame(frame)} | \`${frame.file}\` |`,
    );
  });
  lines.push('');

  const gaps = longGaps(frames);
  if (gaps.length) {
    lines.push('## Quiet stretches');
    lines.push('');
    lines.push('Nothing changed on screen here, so no frames were kept:');
    lines.push('');
    for (const gap of gaps) {
      lines.push(`- \`${formatTime(gap.fromMs)}\` → \`${formatTime(gap.toMs)}\` (${((gap.toMs - gap.fromMs) / 1000).toFixed(1)}s)`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `Machine-readable version: \`manifest.json\`. Source: \`${source.resolved}\`` +
      (source.downloaded ? ' (downloaded)' : '') + '.',
  );
  lines.push('');
  return lines.join('\n');
}

export function describeFrame(frame: SelectedFrame): string {
  if (frame.reason === 'start') return 'first frame';
  if (frame.reason === 'end') return 'final state';
  if (frame.reason === 'anchor') return 'time passing, screen nearly unchanged';

  if (frame.regions.length === 0) {
    if (frame.scrolling) return 'scrolling';
    return frame.reason === 'ongoing' ? 'still changing' : 'minor change';
  }

  const drawn = frame.regions.length;
  const found = Math.max(frame.regionsFound, drawn);
  const extra = found > drawn ? ` (+${found - drawn} more area${found - drawn > 1 ? 's' : ''})` : '';
  const where = frame.regions.map(describeRect).join('; ') + extra;
  if (frame.scrolling) return `scrolling; ${where}`;
  return frame.reason === 'ongoing' ? `mid-change: ${where}` : where;
}

/** Turn a normalized rect into words an agent can act on without opening the image. */
export function describeRect(rect: Rect): string {
  const coverage = rect.w * rect.h;
  if (coverage > 0.72) return 'most of the screen';
  if (rect.w > 0.85 && rect.h < 0.25) return `full-width band, ${vertical(rect)}`;
  if (rect.h > 0.85 && rect.w < 0.25) return `full-height strip, ${horizontal(rect)}`;

  const size = coverage > 0.25 ? 'large area' : coverage > 0.05 ? 'panel' : 'small element';
  return `${size} ${vertical(rect)}-${horizontal(rect)}`;
}

function vertical(rect: Rect): string {
  const center = rect.y + rect.h / 2;
  return center < 0.33 ? 'top' : center < 0.67 ? 'middle' : 'bottom';
}

function horizontal(rect: Rect): string {
  const center = rect.x + rect.w / 2;
  return center < 0.33 ? 'left' : center < 0.67 ? 'center' : 'right';
}

function longGaps(frames: SelectedFrame[]): Array<{ fromMs: number; toMs: number }> {
  const gaps: Array<{ fromMs: number; toMs: number }> = [];
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1]!;
    const current = frames[i]!;
    if (current.reason === 'anchor' && current.timeMs - previous.timeMs > 8_000) {
      gaps.push({ fromMs: previous.timeMs, toMs: current.timeMs });
    }
  }
  return gaps;
}

function sourceTitle(input: string): string {
  const name = input.split('/').pop() ?? input;
  return name || input;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
