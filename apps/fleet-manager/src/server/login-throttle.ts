const loginWindowSeconds = 5 * 60;
const loginBlockSeconds = 30;
const maximumLoginFailures = 5;

interface ThrottleEntry {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export class LoginThrottle {
  private entry: ThrottleEntry | null = null;

  allows(now: number): boolean {
    if (!this.entry) return true;
    if (now - this.entry.windowStartedAt > loginWindowSeconds) {
      this.entry = null;
      return true;
    }
    return now >= this.entry.blockedUntil;
  }

  failure(now: number): void {
    if (!this.entry || now - this.entry.windowStartedAt > loginWindowSeconds) {
      this.entry = { failures: 0, windowStartedAt: now, blockedUntil: 0 };
    }
    this.entry.failures += 1;
    if (this.entry.failures >= maximumLoginFailures) {
      this.entry.blockedUntil = now + loginBlockSeconds;
    }
  }

  success(): void {
    this.entry = null;
  }
}
