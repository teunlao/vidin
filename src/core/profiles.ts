import type { Profile } from './types.ts';

const base: Omit<Profile, 'name'> = {
  // selection
  sampleFps: 4,
  analysisWidth: 400,
  pixelThreshold: 22,
  enterPct: 0.8,
  settlePct: 0.15,
  settleFrames: 2,
  minGapMs: 450,
  maxIntervalMs: 15_000,
  ongoingMs: 3_000,
  maxFrames: 24,
  cursorMaxAreaPct: 0.45,
  cursorMaxSpanPct: 7,
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
    enterPct: 1.5,
    minGapMs: 1_200,
    maxIntervalMs: 25_000,
    ongoingMs: 6_000,
    maxFrames: 30,
  },

  /** Short clips where every twitch matters. */
  dense: {
    ...base,
    name: 'dense',
    sampleFps: 8,
    analysisWidth: 480,
    enterPct: 0.35,
    settleFrames: 1,
    minGapMs: 200,
    maxIntervalMs: 6_000,
    ongoingMs: 1_200,
    maxFrames: 48,
  },

  /** Smallest useful context footprint. */
  cheap: {
    ...base,
    name: 'cheap',
    sampleFps: 2,
    enterPct: 1.8,
    minGapMs: 1_500,
    maxIntervalMs: 30_000,
    maxFrames: 10,
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
