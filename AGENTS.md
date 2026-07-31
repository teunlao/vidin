# AGENTS.md

vidin turns a screen recording into a small set of annotated keyframes an agent
can read, exposed as a CLI and an MCP server. The design rationale — why frames
are *selected* on events instead of sliced on an interval — is in README.md;
read it before touching the selector.

## Commands

```sh
bun test              # full suite, ~17s; needs ffmpeg, builds the fixture on first run
bunx tsc --noEmit     # typecheck (development runs .ts directly, no build)
bun run build         # tsc → dist/ — what npm ships; runs on plain Node ≥ 20
bun run vidin <file>  # CLI: analyse a video into ./.vidin/<name>/
bun run mcp           # MCP server on stdio
bun run fixture       # regenerate fixtures/screen-bug.mp4 (synthetic, scripted timeline)
```

Toolchain: Bun ≥ 1.1 (development only) and `ffmpeg`/`ffprobe` on PATH.
`yt-dlp` is needed only for URL input. The published package is
`@teunlao/vidin` (plain `vidin` is blocked by npm's similarity check against
`vision`); it targets Node ≥ 20 via npx, and end users never need Bun.

## Hard rules

- **No Bun APIs in `src/` or `bin/`.** The npm package runs under whatever
  `npx` resolves to, so runtime code uses `node:` APIs exclusively. Bun (which
  implements them) is the dev runner; `Bun.*` is allowed only in `scripts/` and
  `test/`.
- **No image libraries.** All drawing (change boxes, labels, contact sheets) is
  ffmpeg filters in `src/core/render.ts`. Do not add sharp/canvas/jimp —
  keeping ffmpeg the only native dependency is a design goal, not an accident.
- **Runtime dependencies stay at two:** `@modelcontextprotocol/sdk` and `zod`.
  Adding one is a design decision to raise, not a convenience.
- Imports carry explicit `.ts` extensions; ESM only. `tsconfig.build.json`
  rewrites them to `.js` when emitting `dist/`.

## Selector invariants (`src/core/select.ts`)

Breaking either one is a correctness bug, not a tuning choice;
`test/regressions.test.ts` pins them:

1. **The diff baseline advances only by emitting.** No code path may fold a
   changed screen into the reference without keeping a frame — every later diff
   would then measure zero against a state the reader never sees.
2. **Annotations describe the surviving neighbour.** After budget pruning, each
   frame's deltaPct and regions are recomputed (`relink`) against the frame
   that actually precedes it in the final list.

Also load-bearing:

- Settling is expressed in **milliseconds** (`settleMs`), never in sample
  counts — retuning `sampleFps` must not silently change what "came to rest"
  means.
- Pixel comparison is **per channel**, not luma: chromatic changes at constant
  brightness (a field turning red, a green toast on grey) are exactly what bug
  reports are about.

## Removed on purpose — don't reintroduce casually

- **Pointer crosshair / click detection.** Measured on real recordings the
  position was wrong about half the time (a growing DevTools list moves like a
  pointer does). A wrong marker asserts a falsehood in a bug report, so the
  claim was removed rather than patched. Reintroduction needs measured
  evidence, not a better heuristic.
- **The cursor-recognition subsystem.** At 400px analysis width a pointer sits
  an order of magnitude below the event threshold; the subsystem changed no
  decision on real recordings and was deleted.

## Tests

- The fixture is generated, never committed (`fixtures/` is gitignored). Each
  suite calls `ensureFixture()` itself so test files run alone and in any
  order.
- New bug → new case in `test/regressions.test.ts` that builds a clip
  reproducing it end to end; don't unit-test private helpers instead.
- Canonical assertions: one staged event ⇒ exactly one `settled` frame;
  pointer-only motion ⇒ no frame at all.

## Conventions

- Comments state constraints and rationale the code cannot show; they never
  narrate the code. Match the existing density — this repo comments heavily on
  *why*, not *what*.
- Commit messages: `area: plain statement`, lowercase (see `git log`), e.g.
  `selector: stop claiming where the mouse is`.
- Analysis output lands in `.vidin/` next to the input; it is generated —
  never commit it.
- The MCP server caps every response at 8 images (`MAX_IMAGES`) so one call
  cannot flood an agent's context. That ceiling is a feature, not a limit to
  raise.
