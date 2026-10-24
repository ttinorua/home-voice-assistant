// Keeps the phone screen on while a conversation is running.
// Browsers pause the microphone and sound when a page is locked or hidden, so this is what lets a chat last.

export interface LockLike {
  release(): Promise<void>;
  onRelease(cb: () => void): void;
}

export interface WakeLockEnv {
  request?: () => Promise<LockLike>; // missing when the browser has no screen lock support
  isVisible(): boolean;
  onVisible(cb: () => void | Promise<void>): void;
}

const browserEnv = (): WakeLockEnv => ({
  request:
    typeof navigator !== 'undefined' && 'wakeLock' in navigator
      ? async () => {
          const s = await navigator.wakeLock.request('screen');
          return { release: () => s.release(), onRelease: (cb) => s.addEventListener('release', cb) };
        }
      : undefined,
  isVisible: () => document.visibilityState === 'visible',
  onVisible: (cb) =>
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void cb();
    }),
});

export class ScreenAwake {
  private wanted = false;
  private lock: LockLike | null = null;
  private asking = false;

  constructor(private env: WakeLockEnv = browserEnv()) {
    // The browser drops the lock whenever the page is hidden; take it again when the page returns.
    env.onVisible(() => this.acquire());
  }

  async hold(): Promise<void> {
    this.wanted = true;
    await this.acquire();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const l = this.lock;
    this.lock = null;
    try { await l?.release(); } catch { /* already released */ }
  }

  private async acquire(): Promise<void> {
    if (!this.wanted || this.lock || this.asking || !this.env.request || !this.env.isVisible()) return;
    this.asking = true;
    try {
      const l = await this.env.request();
      if (!this.wanted) { // released while we were asking
        await l.release();
        return;
      }
      l.onRelease(() => { if (this.lock === l) this.lock = null; });
      this.lock = l;
    } catch {
      // Refused (battery saver, unsupported context): the chat still works, the screen may just dim.
    } finally {
      this.asking = false;
    }
  }
}
