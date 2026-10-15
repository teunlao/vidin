/**
 * MCP server.
 *
 * The tools are shaped around progressive refinement rather than a single dump:
 * `analyze_video` returns the written report plus one contact sheet (cheap, whole
 * video at a glance), `get_frames` pulls full-detail frames for the moments that
 * turned out to matter, and `zoom_clip` re-extracts a narrow window densely.
 * An agent that opened every frame up front would spend its context before it
 * knew which second of the recording the bug is in.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { parseTime } from '../cli.ts';
import { isUrl, sessionNameFor } from '../core/ingest.ts';
import { VERSION, analyze, zoom } from '../core/pipeline.ts';
import { probe } from '../core/probe.ts';
import { profiles } from '../core/profiles.ts';
import { formatTime } from '../core/render.ts';
import { formatTokens } from '../core/report.ts';
import type { Manifest } from '../core/types.ts';

/** Hard ceiling on images returned by one tool call, whatever the caller asks for. */
const MAX_IMAGES = 8;

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'vidin', version: VERSION },
    {
      instructions:
        'vidin converts a video (screen recording, bug report, screencast) into annotated ' +
        'keyframes that a vision model can read. Start with analyze_video, read the returned ' +
        'report and contact sheet, then use get_frames for the two or three moments that matter ' +
        'and zoom_clip when you need to see exactly what happened between two frames.',
    },
  );

  server.registerTool(
    'analyze_video',
    {
      title: 'Analyze a video into keyframes',
      description:
        'Turn a video file or URL into a set of annotated keyframes plus a written report. ' +
        'Frames are chosen adaptively: one is kept each time the screen changes and then settles, ' +
        'so a long recording of someone reading costs almost nothing while every real UI event is ' +
        'captured. Mouse movement alone never spends a frame. Each frame is annotated with a red ' +
        'dashed box around what changed and a timestamp bar. ' +
        'Returns the report text and one contact sheet image showing the whole video at a glance; ' +
        'open individual frame files (or call get_frames) only for the moments that matter.',
      inputSchema: {
        source: z
          .string()
          .describe('Path to a local video file, or an http(s) URL (downloaded with yt-dlp).'),
        out_dir: z
          .string()
          .optional()
          .describe(
            'Where to write frames, sheets, REPORT.md and manifest.json. ' +
              'Defaults to a .vidin folder next to the video.',
          ),
        profile: z
          .enum(Object.keys(profiles) as [string, ...string[]])
          .optional()
          .describe(
            'bug-report (default, balanced) · dense (short clips, catches every twitch) · ' +
              'walkthrough (long recordings, fewer frames) · cheap (smallest context footprint).',
          ),
        max_frames: z.number().int().min(1).max(200).optional()
          .describe('Hard cap on kept frames. The least informative frames are dropped first.'),
        sensitivity: z.number().min(0.05).max(50).optional()
          .describe(
            'Percent of the screen that must change to count as an event. Lower catches subtler ' +
              'changes and produces more frames. Default 0.4.',
          ),
        include_sheet: z.boolean().optional()
          .describe('Return the contact sheet as an image. Default true.'),
      },
    },
    async (args) => {
      const outDir = args.out_dir ?? defaultOutDir(args.source);
      const result = await analyze({
        source: args.source,
        outDir,
        profile: args.profile,
        overrides: {
          maxFrames: args.max_frames,
          enterPct: args.sensitivity,
        },
      });

      const content: Content[] = [{ type: 'text', text: result.report }];

      if (args.include_sheet !== false && result.manifest.sheets.length) {
        const sheets = result.manifest.sheets.slice(0, 2);
        for (const sheet of sheets) {
          content.push({
            type: 'text',
            text: `Contact sheet ${sheet.file} — frames ${sheet.frames.join(', ')}:`,
          });
          content.push(await imageContent(join(result.dir, sheet.file)));
        }
        if (result.manifest.sheets.length > sheets.length) {
          content.push({
            type: 'text',
            text:
              `${result.manifest.sheets.length - sheets.length} more contact sheet(s) on disk in ` +
              `${join(result.dir, 'sheets')} — read them if the timeline above is not enough.`,
          });
        }
      }

      content.push({ type: 'text', text: nextSteps(result.dir, result.manifest) });
      return { content };
    },
  );

  server.registerTool(
    'get_frames',
    {
      title: 'Read specific frames from an analysed video',
      description:
        'Return full-detail frames from a session created by analyze_video, as images. ' +
        'Select them by frame number (as listed in REPORT.md) or by a time range. ' +
        'Use this after reading the report instead of opening every frame: each frame costs ' +
        'roughly 1.5k vision tokens.',
      inputSchema: {
        session: z
          .string()
          .describe('The out_dir reported by analyze_video (the folder holding manifest.json).'),
        indices: z
          .array(z.number().int().min(1))
          .optional()
          .describe('Frame numbers from the report timeline, e.g. [3, 4].'),
        from: z.string().optional().describe('Start of a time range, as SS.s / MM:SS.s.'),
        to: z.string().optional().describe('End of a time range.'),
        max_images: z.number().int().min(1).max(MAX_IMAGES).optional()
          .describe(`How many images to return at most. Default 4, ceiling ${MAX_IMAGES}.`),
      },
    },
    async (args) => {
      const manifest = await loadManifest(args.session);
      const limit = Math.min(args.max_images ?? 4, MAX_IMAGES);

      let picked = manifest.frames;
      if (args.indices?.length) {
        const wanted = new Set(args.indices);
        picked = picked.filter((frame) => wanted.has(frame.index));
      }
      if (args.from || args.to) {
        const fromMs = args.from ? parseTime(args.from) : 0;
        const toMs = args.to ? parseTime(args.to) : Number.POSITIVE_INFINITY;
        picked = picked.filter((frame) => frame.timeMs >= fromMs && frame.timeMs <= toMs);
      }

      if (picked.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                `No frames matched. This session has frames 1..${manifest.frames.length}, ` +
                `covering ${formatTime(0)}–${formatTime(manifest.video.durationMs)}.`,
            },
          ],
        };
      }

      const shown = picked.slice(0, limit);
      const content: Content[] = [];
      for (const frame of shown) {
        content.push({
          type: 'text',
          text:
            `Frame #${frame.index} at ${formatTime(frame.timeMs)} (${frame.reason}` +
            `${frame.deltaPct > 0.05 ? `, ${frame.deltaPct.toFixed(1)}% of the screen changed` : ''}) — ` +
            `${frame.file}`,
        });
        content.push(await imageContent(join(sessionDir(args.session), frame.file)));
      }
      if (picked.length > shown.length) {
        content.push({
          type: 'text',
          text:
            `${picked.length - shown.length} more frame(s) matched but were not returned ` +
            `(max_images=${limit}). Ask again with specific indices.`,
        });
      }
      return { content };
    },
  );

  server.registerTool(
    'zoom_clip',
    {
      title: 'Re-extract a short window at a high frame rate',
      description:
        'Densely sample a narrow time window of the original video — use it when two keyframes ' +
        'are not enough to tell what happened between them (a flash, a transient error, the exact ' +
        'moment a click landed). Keep the window short: frames are returned at the requested fps.',
      inputSchema: {
        session: z
          .string()
          .optional()
          .describe('Session folder from analyze_video; the original video is read from its manifest.'),
        source: z.string().optional().describe('Video path, if you have no session.'),
        from: z.string().describe('Window start, as SS.s / MM:SS.s.'),
        to: z.string().describe('Window end.'),
        fps: z.number().min(0.5).max(30).optional().describe('Frames per second inside the window. Default 4.'),
        max_images: z.number().int().min(1).max(MAX_IMAGES).optional()
          .describe(`How many of the extracted frames to return inline. Default 6, ceiling ${MAX_IMAGES}.`),
      },
    },
    async (args) => {
      if (!args.session && !args.source) {
        return errorContent('zoom_clip needs either a session folder or a source video path.');
      }

      const manifest = args.session ? await loadManifest(args.session) : null;
      const source = args.source ?? manifest!.source.resolved;
      const outDir = args.session ? sessionDir(args.session) : defaultOutDir(source);

      const result = await zoom({
        source,
        outDir,
        fromMs: parseTime(args.from),
        toMs: parseTime(args.to),
        fps: args.fps,
      });

      const limit = Math.min(args.max_images ?? 6, MAX_IMAGES);
      const shown = result.files.slice(0, limit);
      const content: Content[] = [
        {
          type: 'text',
          text:
            `${result.files.length} frames from ${args.from} to ${args.to} at ${args.fps ?? 4}fps, ` +
            `written to ${result.dir}. Showing ${shown.length}; each is labelled with its ` +
            `timestamp in the original video.`,
        },
      ];
      for (const file of shown) content.push(await imageContent(file));
      if (result.files.length > shown.length) {
        content.push({
          type: 'text',
          text: `${result.files.length - shown.length} more frame(s) are on disk in ${result.dir}.`,
        });
      }
      return { content };
    },
  );

  server.registerTool(
    'probe_video',
    {
      title: 'Read video metadata',
      description:
        'Duration, resolution, frame rate, codec and whether the file has an audio track. ' +
        'Cheap — use it to decide on a profile before analysing a long recording.',
      inputSchema: {
        source: z.string().describe('Path to a local video file.'),
      },
    },
    async (args) => {
      const meta = await probe(args.source);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${basename(meta.path)}\n` +
              `duration: ${formatTime(meta.durationMs)}\n` +
              `resolution: ${meta.width}x${meta.height}\n` +
              `frame rate: ${meta.fps.toFixed(2)}\n` +
              `codec: ${meta.videoCodec}\n` +
              `audio track: ${meta.hasAudio ? 'yes' : 'no'}\n` +
              `size: ${(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB`,
          },
        ],
      };
    },
  );

  return server;
}

/** Resolves only once the client has gone, so a caller may exit on return. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const gone = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
    server.server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  await gone;
}

/* ------------------------------------------------------------- internals */

function nextSteps(dir: string, manifest: Manifest): string {
  const heaviest = [...manifest.frames]
    .filter((frame) => frame.reason === 'settled')
    .sort((a, b) => b.deltaPct - a.deltaPct)
    .slice(0, 3)
    .map((frame) => `#${frame.index} (${formatTime(frame.timeMs)})`);

  return (
    `Session: ${dir}\n` +
    `Everything above is on disk; nothing else was loaded into your context.\n` +
    (heaviest.length ? `Biggest visual changes: ${heaviest.join(', ')}.\n` : '') +
    `Next: get_frames({ session: "${dir}", indices: [...] }) for detail, or ` +
    `zoom_clip({ session: "${dir}", from: "MM:SS", to: "MM:SS" }) to see what happened in between. ` +
    `Total on disk: ${(manifest.stats.totalBytes / 1024 / 1024).toFixed(2)} MB, ` +
    `~${formatTokens(manifest.stats.approxTokens)} vision tokens if every image were opened.`
  );
}

function sessionDir(session: string): string {
  return session.endsWith('.json') || session.endsWith('.md') ? dirname(session) : session;
}

async function loadManifest(session: string): Promise<Manifest> {
  const path = join(sessionDir(session), 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(
      `No vidin session at ${session} (expected ${path}). Run analyze_video first.`,
    );
  }
  return JSON.parse(await readFile(path, 'utf8')) as Manifest;
}

function defaultOutDir(source: string): string {
  if (isUrl(source)) return join(tmpdir(), 'vidin', sessionNameFor(source));
  return join(dirname(source), '.vidin', sessionNameFor(source));
}

async function imageContent(path: string): Promise<Content> {
  const bytes = await readFile(path);
  return {
    type: 'image',
    data: bytes.toString('base64'),
    mimeType: path.endsWith('.png') ? 'image/png' : 'image/webp',
  };
}

function errorContent(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}
