# vidin

Turn a video into something a coding agent can actually read.

Claude Code, Codex and friends accept images, not video. So when a bug report
arrives as a screen recording, the video is dead weight — someone has to watch it
and retype what happened. vidin converts the recording into a small set of
annotated keyframes plus a written timeline, and exposes that to agents over MCP.

TypeScript on Bun. The only runtime dependency is `ffmpeg` (plus `yt-dlp`, and
only if you hand it a URL); there is no build step and no native image library.

---

## The idea: pick frames, don't slice them

The point is not to save tokens. A 30-second bug report comes out at ~28k
vision tokens for every image it produces, which against a modern context window
is nothing. Cost is not the constraint.

**Repetition is.** One screenshot per second turns three minutes into 180
frames of which ~90% are identical, because the person was reading, thinking or
moving the mouse. Those duplicates don't cost much — they *bury* the handful of
frames where something actually happened, and an agent has to look at all of
them to find out which. Frame selection is a signal-to-noise problem wearing a
cost problem's clothes.

vidin is event driven instead. It walks the video at 12 fps in downscaled RGB
and keeps a frame only when something actually happened:

- **Change is measured against the last *kept* frame**, not the previous sample,
  so slow drift accumulates instead of hiding under the threshold.
- **Cursor movement does not spend a frame.** A pointer is a tiny blob with
  almost no total area — but so is a blinking caret, a spinner or a filling
  progress bar, so size alone is not accepted as evidence. The pointer has to be
  argued for positionally: a blob where it was last seen, a leave-and-arrive
  pair, or a blob that has *moved* since the previous sample. That last one is
  what makes the rule independent of the sampling rate — sample often enough and
  the leave/arrive pair overlaps into a single blob, but a caret still doesn't
  travel. Get this wrong and the small stuff becomes invisible: it is discounted
  on the way in *and* reported as a calm screen.
- **Frames land after the change, not inside it.** When motion starts, nothing is
  emitted yet — the selector waits for the screen to come to rest and keeps the
  settled frame. You get the state *after* the click, not the animation blur.
- **Colour counts as change.** Comparison is per channel, not on brightness. A
  field turning red or a green toast over a grey panel barely moves the luma and
  is exactly what a bug report is about.
- **Guard rails:** a minimum gap, a maximum gap (long still stretches still get an
  anchor frame), periodic samples while a long animation runs, and a hard frame
  budget that drops the least informative frames first while keeping the ends of
  the timeline.

On an M-series Mac a 3-minute 1080p recording takes ~4s to process, and a
30-second one about 3s. The budget is 40 frames; how many the recording actually
earns is up to the recording.

The analysis rate is 12 fps rather than something frugal because sampling is
nearly free: decoding dominates that pass — ffmpeg walks every frame regardless,
and the `fps` filter only picks which ones get scaled and handed over. Measured
on a 3-minute 1080p clip, going 4 → 12 fps moved the total from 3.9s to 4.0s.
Sampling four times a second saved a tenth of a second and lost anything on
screen for less than 250ms: a toast that auto-dismisses, a validation message, a
flash of an error. Settling is expressed in milliseconds, not in samples, so
retuning the rate does not quietly change what "the screen came to rest" means.

Two invariants hold whatever path a frame took:

- **Nothing is dropped silently.** The comparison baseline only ever advances by
  keeping a frame. There is no path that folds a changed screen into the
  baseline without emitting it — that would make the change unrecoverable, since
  every later comparison would measure zero against a state you never see.
- **Annotations describe the neighbour you can actually see.** After the frame
  budget prunes the middle of the timeline, every survivor's change percentage,
  boxes and pointer trail are recomputed against the frame that now precedes it.
  Only the largest three areas are boxed, and the caption says so when there were
  more.

## What you get

```
out/
  REPORT.md        the entry point: timeline table, what changed where, what to open
  manifest.json    the same, machine readable
  sheets/          the whole video as labelled 3x3 grids (~1.3k tokens each)
  frames/          full-detail annotated frames
```

Each frame is annotated:

- **red dashed box** around the regions that changed since the previous kept frame
- **cyan crosshair** on the mouse pointer, faint square where it was before
- **bottom bar** with frame number, timestamp in the original video, gap since the
  previous frame, why the frame was kept, and how much of the screen changed

The timestamp matters: an agent can say "the error appears at 00:41.2" and you can
scrub straight there in the original file.

## Install

Needs `ffmpeg` (and `yt-dlp` only if you pass URLs):

```sh
brew install ffmpeg yt-dlp
```

Then:

```sh
git clone <this repo> && cd vidin && bun install
```

## Use it from an agent (MCP)

Claude Code:

```sh
claude mcp add vidin -- bun run /path/to/vidin/bin/vidin-mcp.ts
```

Or in `.mcp.json` / `~/.codex/config.toml` equivalents:

```json
{
  "mcpServers": {
    "vidin": { "command": "bun", "args": ["run", "/path/to/vidin/bin/vidin-mcp.ts"] }
  }
}
```

Four tools, shaped so an agent spends context in the right order:

| tool | what it does |
|------|--------------|
| `analyze_video` | video → frames on disk; returns the report text **and one contact sheet image** |
| `get_frames` | full-detail frames by number or time range, capped so a call can't flood the context |
| `zoom_clip` | re-extract a narrow window at a higher frame rate — for the moment two frames don't explain |
| `probe_video` | duration / resolution / fps / audio, cheap |

The intended loop: analyse → look at the sheet → read the timeline → open two or
three frames → zoom in if the moment between them is still unclear. Opening
everything up front would burn the context before knowing which second matters.

## Use it from the shell

```sh
vidin ~/Desktop/bug.mov                        # → ./.vidin/bug/
vidin bug.mov -o ./bug-frames --profile dense
vidin https://example.com/screencast.mp4       # downloaded with yt-dlp
vidin zoom bug.mov --from 00:41 --to 00:45 --fps 6 -o ./bug-frames
vidin probe bug.mov
```

Profiles:

| profile | for |
|---------|-----|
| `bug-report` | default — someone recorded a screen, narrated a bug, stopped |
| `dense` | short clips where every twitch matters (24 fps analysis, up to 80 frames) |
| `walkthrough` | long recordings; fewer frames, wider anchors |
| `cheap` | smallest footprint, for when the context really is tight (12 frames at 1092px) |

Tuning without leaving the profile: `--max-frames`, `--sensitivity` (percent of
the screen that counts as an event, lower = more frames), `--fps`, `--width`,
`--quality`, `--no-annotate`, `--no-sheets`.

## How it works

```
ffmpeg ─raw RGB @12fps, 400px─ selector ──timestamps+regions── ffmpeg ──annotated WebP
         one decode pass,         event state machine            drawbox/drawtext
         streamed                 in plain TypeScript            per frame
```

Decoding streams two frames at a time, and the selector additionally keeps the
downscaled buffers of the frames it has kept so it can recompute their deltas
after pruning. That is bounded by the frame budget, not by video length: ~32 MB
at the defaults, ~90 MB on `dense`. An hour-long recording costs time, not RAM.

All drawing is done by ffmpeg filters, which is why there is no `sharp` in
`package.json`.

## Tests

```sh
bun test
```

The fixture (`bun run fixture`) is a synthetic screen recording with a scripted
timeline — a panel appears at 6s, an error dialog at 9.5s, a toast at 14s, the
dialog closes at 16s, and the pointer moves during two stretches where nothing
else happens. The suite asserts that each staged event yields exactly one settled
frame and that pointer-only motion yields none.

`test/regressions.test.ts` builds its own clips and pins the failures a review
found in the first version: an event that settles sooner than the minimum gap
being dropped outright, a frame labelled "final state" that was not the final
state, a blinking caret reported as a mouse pointer, pruned frames keeping
annotations that described a frame no longer in the output, a one-frame budget
returning two, and a still recording billed for duplicate frames.

## Not there yet

- **Audio transcript.** Bug reports are often narrated, and that narration is the
  highest-signal part of the recording. Needs a local Whisper (`whisper.cpp` or
  `mlx-whisper`); the plan is a `transcript.md` aligned to the frame timeline.
- **OCR.** Running text extraction over kept frames would let an agent grep an
  error message without spending vision tokens at all.
- **Click detection.** Cursor position is tracked, but a click is only inferred
  from what changes afterwards.
- **Horizontal scroll** is not detected; vertical is.
- **Small elements need a nudge.** The default event threshold is 0.8% of the
  screen, so a progress bar or a badge below that is not an event on its own.
  `--sensitivity 0.2` or `--profile dense` catches them, at the cost of more
  frames.
