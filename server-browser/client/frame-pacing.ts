import type { BrowserFrameQuality } from '../shared/browser';

/** Cadence per chosen quality; the link and idle backoff can only slow it down. */
export const frameTargetMs: Record<BrowserFrameQuality, number> = { smooth: 250, balanced: 750, sharp: 1200 };
const tiers: readonly BrowserFrameQuality[] = ['smooth', 'balanced', 'sharp'];
/** A changed frame slower than this is saturating a weak (usually relay) link: lower the JPEG quality one step. */
export const SLOW_FRAME_MS = 1500;
/** This many consecutive quick changed frames restore one quality step. */
const FAST_FRAME_MS = 600;
const RECOVER_AFTER = 4;

export type FramePacing = {
  previousRequestAt: number;
  /** Smoothed round trip of every poll, in ms. */
  duration: number;
  /** Consecutive polls without a new frame. */
  unchanged: number;
  /** Quality steps below the viewer's choice (0–2). */
  degrade: number;
  fast: number;
};
export const initialPacing: FramePacing = { previousRequestAt: 0, duration: 0, unchanged: 0, degrade: 0, fast: 0 };

export function recordFrame(pacing: FramePacing, sample: { requestedAt: number; latency: number; changed: boolean; failed?: boolean }): FramePacing {
  if (sample.failed) return { ...pacing, previousRequestAt: sample.requestedAt, unchanged: Math.max(3, pacing.unchanged), fast: 0 };
  const duration = pacing.duration ? pacing.duration * 0.65 + sample.latency * 0.35 : sample.latency;
  let { degrade, fast } = pacing;
  if (sample.changed) {
    if (sample.latency > SLOW_FRAME_MS) { degrade = Math.min(tiers.length - 1, degrade + 1); fast = 0; }
    else if (sample.latency < FAST_FRAME_MS) { fast += 1; if (fast >= RECOVER_AFTER && degrade > 0) { degrade -= 1; fast = 0; } }
    else fast = 0;
  }
  return { previousRequestAt: sample.requestedAt, duration, unchanged: sample.changed ? 0 : pacing.unchanged + 1, degrade, fast };
}

/** The JPEG quality actually requested: the viewer's choice, lowered while changed frames arrive slowly. */
export function effectiveQuality(chosen: BrowserFrameQuality, pacing: Pick<FramePacing, 'degrade'>): BrowserFrameQuality {
  return tiers[Math.max(0, tiers.indexOf(chosen) - pacing.degrade)];
}

/**
 * Next poll delay: the chosen cadence, never faster than twice the observed round trip (frames then use at most
 * about half of a slow link, leaving room for Agent output), backing off up to 5× / 8 s while the page is idle.
 */
export function frameDelay(pacing: Pick<FramePacing, 'duration' | 'unchanged'>, chosen: BrowserFrameQuality, recovering = false): number {
  if (recovering) return 1000;
  const idle = pacing.unchanged < 2 ? 1 : Math.min(5, 1 + (pacing.unchanged - 1) * 0.5);
  return Math.min(8000, Math.max(frameTargetMs[chosen], pacing.duration * 2) * idle);
}

/**
 * Device pixels the stage can show. The server fits the page viewport into this box (never enlarging), so a
 * 1440 px desktop page viewed on a phone is not shipped at full resolution. Pixel ratio is capped at 2.
 */
export function frameLimits(stage: { width: number; height: number }, pixelRatio: number): { maxWidth: number; maxHeight: number } | undefined {
  if (!(stage.width > 0 && stage.height > 0)) return undefined;
  const ratio = Math.min(2, Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1));
  const clamp = (value: number) => Math.max(64, Math.min(8192, Math.ceil(value * ratio)));
  return { maxWidth: clamp(stage.width), maxHeight: clamp(stage.height) };
}
