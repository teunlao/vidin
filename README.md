# vidin

Turn a video into something a coding agent can actually read.

Claude Code, Codex and friends accept images, not video. So when a bug report
arrives as a screen recording, the video is dead weight — someone has to watch it
and retype what happened. vidin converts the recording into a small set of
annotated keyframes plus a written timeline, and exposes that to agents over MCP.

TypeScript on Bun. The only runtime dependency is `ffmpeg`; there is no build
step and no native image library.

---

## The idea: pick frames, don't slice them

One screenshot per second is the obvious approach and it does not work. Three
minutes of video becomes 180 frames ≈ **285k vision tokens**, and roughly 90% of
them are identical because the person was reading, thinking, or moving the mouse.

vidin is event driven instead. It walks the video at 4 fps in downscaled RGB and
keeps a frame only when something actually happened:

- **Change is measured against the last *kept* frame**, not the previous sample,
  so slow drift accumulates instead of hiding under the threshold.
- **Cursor movement never spends a frame.** A pointer produces one or two tiny
  blobs and almost no total area; that signature is recognised, the position is
  tracked, and the frame budget is left alone.
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

A 3-minute 1080p recording takes ~4.5s to process and comes out as ~24 frames and
three contact sheets, 0.4 MB total.

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
| `dense` | short clips where every twitch matters (8 fps analysis, up to 48 frames) |
| `walkthrough` | long recordings; fewer frames, wider anchors |
| `cheap` | smallest context footprint (up to 10 frames at 1092px) |

Tuning without leaving the profile: `--max-frames`, `--sensitivity` (percent of
the screen that counts as an event, lower = more frames), `--fps`, `--width`,
`--quality`, `--no-annotate`, `--no-sheets`.

## How it works

```
ffmpeg ──raw RGB @4fps, 400px── selector ──timestamps+regions── ffmpeg ──annotated WebP
         one decode pass,         event state machine            drawbox/drawtext
         constant memory          in plain TypeScript            per frame
```

Analysis never holds more than two frames in memory, so video length costs time,
not RAM. All drawing is done by ffmpeg filters, which is why there is no `sharp`
in `package.json`.

## Tests

```sh
bun test
```

The fixture (`bun run fixture`) is a synthetic screen recording with a scripted
timeline — a panel appears at 6s, an error dialog at 9.5s, a toast at 14s, the
dialog closes at 16s, and the pointer moves during two stretches where nothing
else happens. The suite asserts that each staged event yields exactly one settled
frame and that pointer-only motion yields none.

## Not there yet

- **Audio transcript.** Bug reports are often narrated, and that narration is the
  highest-signal part of the recording. Needs a local Whisper (`whisper.cpp` or
  `mlx-whisper`); the plan is a `transcript.md` aligned to the frame timeline.
- **OCR.** Running text extraction over kept frames would let an agent grep an
  error message without spending vision tokens at all.
- **Click detection.** Cursor position is tracked, but a click is only inferred
  from what changes afterwards.
- **Horizontal scroll** is not detected; vertical is.
