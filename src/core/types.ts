/** Normalized rectangle, all values in 0..1 relative to the frame. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalized point, 0..1 relative to the frame. */
export interface Point {
  x: number;
  y: number;
}

export interface VideoMeta {
  path: string;
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  sizeBytes: number;
}

/**
 * Why a frame made it into the output.
 * - start/end   — always kept, they anchor the timeline
 * - settled     — the screen changed and then came to rest; this is the "after" state
 * - ongoing     — change is still running (animation, video playback); periodic sample
 * - anchor      — nothing happened for a long time, keep one frame so the gap is visible
 */
export type FrameReason = 'start' | 'settled' | 'ongoing' | 'anchor' | 'end';

export interface SelectedFrame {
  /** 1-based position in the final timeline. */
  index: number;
  timeMs: number;
  /** Percent of pixels that differ from the previously selected frame. */
  deltaPct: number;
  reason: FrameReason;
  /** Regions that changed since the previous selected frame, largest first. */
  regions: Rect[];
  /**
   * How many distinct regions were found. `regions` is capped so the frame stays
   * readable, and without this the caption would quietly imply the cap was all
   * there was.
   */
  regionsFound: number;
  /** Estimated cursor position at this moment, when it could be tracked. */
  cursor?: Point;
  /** Where the cursor was at the previously selected frame. */
  cursorFrom?: Point;
  /** True when the frame-to-frame change looked like vertical scrolling. */
  scrolling: boolean;
  /** Internal ranking weight used when the frame budget forces pruning. */
  score: number;
}

export interface SelectionParams {
  /** How often the analyser looks at the video (frames per second). */
  sampleFps: number;
  /** Width of the downscaled grayscale frames used for analysis. */
  analysisWidth: number;
  /** Per-pixel luma delta that counts as "this pixel changed". */
  pixelThreshold: number;
  /** Percent of changed pixels (vs last selected frame) that starts an event. */
  enterPct: number;
  /** Percent of changed pixels (vs previous sample) below which the screen is at rest. */
  settlePct: number;
  /** How many consecutive calm samples confirm that the screen settled. */
  settleFrames: number;
  /** Never emit two frames closer than this. */
  minGapMs: number;
  /** Emit an anchor frame if nothing happened for this long. */
  maxIntervalMs: number;
  /** During continuous change, emit a frame at least this often. */
  ongoingMs: number;
  /** Hard cap on the number of frames in the output. */
  maxFrames: number;
  /** Total changed area below this percent may be dismissed as cursor movement. */
  cursorMaxAreaPct: number;
  /** A blob wider/taller than this percent of the frame is not a cursor. */
  cursorMaxSpanPct: number;
  /**
   * How close (percent of the frame) a blob must be to the last known pointer
   * position to count as that pointer leaving. Without this test, any small
   * compact change — a caret, a spinner, a progress bar — passes as cursor noise.
   */
  cursorNearPct: number;
  /** After this long without a sighting, the pointer is no longer reported. */
  cursorStaleMs: number;
}

export interface RenderParams {
  /** Long-edge width of the full-size frames. */
  frameWidth: number;
  /** WebP quality for the full-size frames. */
  quality: number;
  /** Draw change boxes, cursor markers and the timestamp bar. */
  annotate: boolean;
  /** Build contact sheets. */
  sheets: boolean;
  /** Target width of a contact sheet. */
  sheetWidth: number;
  /** Columns in a contact sheet; rows are derived from the frame count. */
  sheetCols: number;
}

export interface Profile extends SelectionParams, RenderParams {
  name: string;
}

export interface FrameArtifact extends SelectedFrame {
  /** Path relative to the session directory. */
  file: string;
  width: number;
  height: number;
  bytes: number;
  /** Rough Claude vision cost: width * height / 750. */
  approxTokens: number;
}

export interface SheetArtifact {
  file: string;
  frames: number[];
  width: number;
  height: number;
  bytes: number;
  approxTokens: number;
}

export interface Manifest {
  tool: 'vidin';
  version: string;
  createdAt: string;
  source: {
    input: string;
    resolved: string;
    downloaded: boolean;
  };
  video: VideoMeta;
  profile: Profile;
  stats: {
    sampledFrames: number;
    selectedFrames: number;
    prunedFrames: number;
    analysisMs: number;
    renderMs: number;
    totalBytes: number;
    approxTokens: number;
  };
  frames: FrameArtifact[];
  sheets: SheetArtifact[];
}
