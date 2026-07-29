/**
 * Drives the server the way an agent's client would: over stdio, through the SDK.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'fixtures', 'screen-bug.mp4');

let client: Client;
let session: string;

interface ToolResult {
  content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  isError?: boolean;
}

beforeAll(async () => {
  session = await mkdtemp(join(tmpdir(), 'vidin-mcp-'));
  client = new Client({ name: 'vidin-test', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: 'bun', args: [join(ROOT, 'bin', 'vidin-mcp.ts')], cwd: ROOT }),
  );
}, 60_000);

afterAll(async () => {
  await client.close();
  await rm(session, { recursive: true, force: true });
});

test('the server advertises the progressive-refinement toolset', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    'analyze_video',
    'get_frames',
    'probe_video',
    'zoom_clip',
  ]);
});

test('analyze_video returns a readable report and a contact sheet image', async () => {
  const result = (await client.callTool({
    name: 'analyze_video',
    arguments: { source: FIXTURE, out_dir: session },
  })) as ToolResult;

  expect(result.isError).toBeFalsy();
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  expect(text).toContain('## Timeline');
  expect(text).toContain(session);

  const images = result.content.filter((part) => part.type === 'image');
  expect(images.length).toBe(1);
  expect(images[0]!.mimeType).toBe('image/webp');
  expect(images[0]!.data!.length).toBeGreaterThan(1000);
}, 120_000);

test('get_frames returns exactly the requested frames', async () => {
  const result = (await client.callTool({
    name: 'get_frames',
    arguments: { session, indices: [2, 3] },
  })) as ToolResult;

  expect(result.isError).toBeFalsy();
  expect(result.content.filter((part) => part.type === 'image').length).toBe(2);
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  expect(text).toContain('Frame #2');
  expect(text).toContain('Frame #3');
}, 60_000);

test('get_frames says so instead of returning nothing when a frame does not exist', async () => {
  const result = (await client.callTool({
    name: 'get_frames',
    arguments: { session, indices: [999] },
  })) as ToolResult;

  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('No frames matched');
}, 30_000);

test('zoom_clip re-extracts a window from the session source', async () => {
  const result = (await client.callTool({
    name: 'zoom_clip',
    arguments: { session, from: '00:09', to: '00:10', fps: 4 },
  })) as ToolResult;

  expect(result.isError).toBeFalsy();
  const images = result.content.filter((part) => part.type === 'image');
  expect(images.length).toBeGreaterThanOrEqual(4);
  expect(images.length).toBeLessThanOrEqual(6);
}, 60_000);

test('the image budget is capped even when more frames match', async () => {
  const result = (await client.callTool({
    name: 'zoom_clip',
    arguments: { session, from: '00:09', to: '00:11', fps: 4, max_images: 2 },
  })) as ToolResult;

  const images = result.content.filter((part) => part.type === 'image');
  expect(images.length).toBe(2);
  const text = result.content.map((part) => part.text ?? '').join('\n');
  expect(text).toContain('more frame(s) are on disk');
}, 60_000);
