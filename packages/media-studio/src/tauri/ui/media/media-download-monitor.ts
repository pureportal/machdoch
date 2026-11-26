import type { MediaModelInstallJob } from "../../../core/media/contracts.js";
import { listMediaModelInstallJobs } from "./media-runtime";
import {
  EMPTY_MEDIA_RUNTIME_SETUP,
  getMediaRuntimeSetup,
  isMediaRuntimeSetupActive,
  type MediaRuntimeSetupStatus,
} from "./media-runtime-setup";

const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 10_000;
const SPEED_SMOOTHING = 0.3;
const ACTIVE_INSTALL_STATES = ["queued", "downloading", "verifying", "activating", "canceling"];

export interface MediaDownloadMonitorSnapshot {
  installJobs: readonly MediaModelInstallJob[];
  runtimeSetup: MediaRuntimeSetupStatus;
  bytesPerSecond: Readonly<Record<string, number>>;
  error: string | null;
}

export const mediaDownloadSourceLabel = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
};

export const isMediaModelInstallJobActive = (job: MediaModelInstallJob): boolean =>
  ACTIVE_INSTALL_STATES.includes(job.status);

class MediaDownloadMonitor {
  private snapshot: MediaDownloadMonitorSnapshot = {
    installJobs: [],
    runtimeSetup: EMPTY_MEDIA_RUNTIME_SETUP,
    bytesPerSecond: {},
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly samples = new Map<string, { bytes: number; time: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private pollRequested = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.poll();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  };

  readonly getSnapshot = (): MediaDownloadMonitorSnapshot => this.snapshot;

  refresh(): void {
    if (this.listeners.size > 0) void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      this.pollRequested = true;
      return;
    }
    this.polling = true;
    this.pollRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const [installJobs, runtimeSetup] = await Promise.all([
        listMediaModelInstallJobs(),
        getMediaRuntimeSetup(),
      ]);
      this.snapshot = {
        installJobs,
        runtimeSetup,
        bytesPerSecond: this.measure(installJobs),
        error: null,
      };
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.polling = false;
    }
    for (const listener of this.listeners) listener();
    if (this.listeners.size === 0) return;
    if (this.pollRequested) {
      void this.poll();
      return;
    }
    const active =
      this.snapshot.installJobs.some(isMediaModelInstallJobActive) ||
      isMediaRuntimeSetupActive(this.snapshot.runtimeSetup);
    this.timer = setTimeout(() => void this.poll(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  private measure(jobs: readonly MediaModelInstallJob[]): Record<string, number> {
    const now = Date.now();
    const speeds: Record<string, number> = {};
    for (const job of jobs) {
      const previous = this.samples.get(job.id);
      this.samples.set(job.id, { bytes: job.bytesDownloaded, time: now });
      if (job.status !== "downloading" || !previous || now <= previous.time) continue;
      const current = ((job.bytesDownloaded - previous.bytes) * 1000) / (now - previous.time);
      const prior = this.snapshot.bytesPerSecond[job.id];
      speeds[job.id] = Math.max(
        0,
        prior === undefined ? current : prior + SPEED_SMOOTHING * (current - prior),
      );
    }
    for (const id of this.samples.keys())
      if (!jobs.some((job) => job.id === id)) this.samples.delete(id);
    return speeds;
  }
}

export const mediaDownloadMonitor = new MediaDownloadMonitor();
