const loginClientPolicy: RateLimitPolicy = {
  maximumAttempts: 5,
  windowSeconds: 60,
};
const loginGlobalPolicy: RateLimitPolicy = {
  maximumAttempts: 30,
  windowSeconds: 60,
};
const passwordConfirmationPolicy: RateLimitPolicy = {
  maximumAttempts: 5,
  windowSeconds: 5 * 60,
};
const maximumTrackedClients = 4096;
const maximumTrackedSessions = 256;
const maximumConcurrentPasswordOperations = 4;

interface RateLimitPolicy {
  maximumAttempts: number;
  windowSeconds: number;
}

interface AttemptWindow {
  attempts: number;
  startedAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthenticationOperation {
  release(): void;
}

export class AuthenticationRateLimiter {
  private readonly loginClients = new Map<string, AttemptWindow>();
  private readonly passwordSessions = new Map<string, AttemptWindow>();
  private loginGlobal: AttemptWindow | null = null;
  private activePasswordOperations = 0;

  loginAttempt(clientIdentifier: string, now: number): RateLimitResult {
    const clientWindow = currentWindow(
      this.loginClients.get(clientIdentifier),
      now,
      loginClientPolicy,
    );
    const globalWindow = currentWindow(
      this.loginGlobal,
      now,
      loginGlobalPolicy,
    );
    const retryAfterSeconds = Math.max(
      retryAfter(clientWindow, now, loginClientPolicy),
      retryAfter(globalWindow, now, loginGlobalPolicy),
    );
    if (retryAfterSeconds > 0) {
      return { allowed: false, retryAfterSeconds };
    }

    this.loginGlobal = consume(globalWindow, now);
    setBounded(
      this.loginClients,
      clientIdentifier,
      consume(clientWindow, now),
      maximumTrackedClients,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }

  loginSucceeded(clientIdentifier: string): void {
    this.loginClients.delete(clientIdentifier);
  }

  passwordConfirmationAttempt(sessionId: string, now: number): RateLimitResult {
    const window = currentWindow(
      this.passwordSessions.get(sessionId),
      now,
      passwordConfirmationPolicy,
    );
    const retryAfterSeconds = retryAfter(
      window,
      now,
      passwordConfirmationPolicy,
    );
    if (retryAfterSeconds > 0) {
      return { allowed: false, retryAfterSeconds };
    }
    setBounded(
      this.passwordSessions,
      sessionId,
      consume(window, now),
      maximumTrackedSessions,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }

  beginPasswordOperation(): AuthenticationOperation | null {
    if (this.activePasswordOperations >= maximumConcurrentPasswordOperations) {
      return null;
    }
    this.activePasswordOperations += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activePasswordOperations -= 1;
      },
    };
  }
}

function currentWindow(
  window: AttemptWindow | null | undefined,
  now: number,
  policy: RateLimitPolicy,
): AttemptWindow | null {
  if (
    !window ||
    now < window.startedAt ||
    now - window.startedAt >= policy.windowSeconds
  ) {
    return null;
  }
  return window;
}

function retryAfter(
  window: AttemptWindow | null,
  now: number,
  policy: RateLimitPolicy,
): number {
  if (!window || window.attempts < policy.maximumAttempts) return 0;
  return Math.max(1, window.startedAt + policy.windowSeconds - now);
}

function consume(window: AttemptWindow | null, now: number): AttemptWindow {
  if (!window) return { attempts: 1, startedAt: now };
  return { ...window, attempts: window.attempts + 1 };
}

function setBounded(
  windows: Map<string, AttemptWindow>,
  key: string,
  window: AttemptWindow,
  maximumEntries: number,
): void {
  if (!windows.has(key) && windows.size >= maximumEntries) {
    const oldestKey = windows.keys().next().value;
    if (oldestKey !== undefined) windows.delete(oldestKey);
  }
  windows.set(key, window);
}
