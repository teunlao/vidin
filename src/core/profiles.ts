import type { Profile } from './types.ts';

const base: Omit<Profile, 'name'> = {
  // selection
  //
  // The sampling rate is deliberately high. Decoding dominates the analysis
  // pass — ffmpeg walks every frame regardless, and `fps` only chooses which
  // ones are scaled and handed over — so going from 4 to 12 fps on a 3-minute
  // 1080p recording costs about 0.1s in total. Sampling four times a second
  // bought nothing and lost anything on screen for less than 250ms.
  sampleFps: 12,
  analysisWidth: 400,
  pixelThreshold: 22,
  enterPct: 0.4,
  settlePct: 0.15,
  settleMs: 400,
  minGapMs: 450,
  maxIntervalMs: 15_000,
  ongoingMs: 3_000,
  maxFrames: 40,
  // rendering
  frameWidth: 1456,
  quality: 78,
  annotate: true,
  sheets: true,
  sheetWidth: 1456,
  sheetCols: 3,
};

export const profiles: Record<string, Profile> = {
  /** Default. Someone recorded a screen, narrated a bug, and stopped. */
  'bug-report': { ...base, name: 'bug-report' },

  /** Long walkthroughs: fewer frames, wider anchors, still one per real step. */
  walkthrough: {
    ...base,
    name: 'walkthrough',
    enterPct: 1.2,
    minGapMs: 1_200,
    maxIntervalMs: 25_000,
    ongoingMs: 6_000,
    maxFrames: 40,
  },

  /** Short clips where every twitch matters. */
  dense: {
    ...base,
    name: 'dense',
    sampleFps: 24,
    analysisWidth: 480,
    enterPct: 0.15,
    settleMs: 150,
    minGapMs: 200,
    maxIntervalMs: 6_000,
    ongoingMs: 1_200,
    maxFrames: 80,
  },

  /** Smallest useful context footprint. */
  cheap: {
    ...base,
    name: 'cheap',
    sampleFps: 4,
    enterPct: 1.8,
    minGapMs: 1_500,
    maxIntervalMs: 30_000,
    maxFrames: 12,
    frameWidth: 1092,
    quality: 70,
  },
};

export const defaultProfile = 'bug-report';

export function resolveProfile(name: string | undefined, overrides: Partial<Profile> = {}): Profile {
  const chosen = profiles[name ?? defaultProfile];
  if (!chosen) {
    throw new Error(
      `Unknown profile "${name}". Available: ${Object.keys(profiles).join(', ')}`,
    );
  }
  const merged: Profile = { ...chosen, ...stripUndefined(overrides) };
  if (overrides.name === undefined) merged.name = chosen.name;
  return merged;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
