import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
export const FIXTURE = join(ROOT, 'fixtures', 'screen-bug.mp4');

/**
 * Build the shared fixture if it is missing. Every suite that needs it calls
 * this itself: a test file that silently depends on another file having run
 * first cannot be executed alone, and fails for reasons unrelated to its name
 * when tests are filtered or reordered.
 */
export async function ensureFixture(): Promise<string> {
  if (await Bun.file(FIXTURE).exists()) return FIXTURE;

  const build = Bun.spawn({
    cmd: ['bun', 'run', join(ROOT, 'scripts', 'make-fixture.ts')],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`fixture build failed: ${stderr}`);
  return FIXTURE;
}
