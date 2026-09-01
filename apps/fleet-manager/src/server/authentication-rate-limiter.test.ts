import { describe, expect, it } from "vitest";
import { AuthenticationRateLimiter } from "./authentication-rate-limiter";

describe("authentication rate limiting", () => {
  it("limits repeated login attempts per client and reports the retry delay", () => {
    const limiter = new AuthenticationRateLimiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.loginAttempt("198.51.100.10", 100)).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    }

    expect(limiter.loginAttempt("198.51.100.10", 100)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(limiter.loginAttempt("198.51.100.10", 159)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.loginAttempt("198.51.100.10", 160).allowed).toBe(true);
  });

  it("does not let one client consume another client's allowance", () => {
    const limiter = new AuthenticationRateLimiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.loginAttempt("198.51.100.10", 100);
    }

    expect(limiter.loginAttempt("198.51.100.11", 100).allowed).toBe(true);
  });

  it("caps distributed login attempts across client addresses", () => {
    const limiter = new AuthenticationRateLimiter();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(limiter.loginAttempt(`198.51.100.${attempt}`, 100).allowed).toBe(
        true,
      );
    }

    expect(limiter.loginAttempt("203.0.113.1", 100)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("clears the successful client's failed-attempt window", () => {
    const limiter = new AuthenticationRateLimiter();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.loginAttempt("198.51.100.10", 100);
    }
    limiter.loginSucceeded("198.51.100.10");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.loginAttempt("198.51.100.10", 100).allowed).toBe(true);
    }
  });

  it("limits password confirmation attempts by authenticated session", () => {
    const limiter = new AuthenticationRateLimiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        limiter.passwordConfirmationAttempt("session_one", 100).allowed,
      ).toBe(true);
    }

    expect(limiter.passwordConfirmationAttempt("session_one", 100)).toEqual({
      allowed: false,
      retryAfterSeconds: 300,
    });
    expect(
      limiter.passwordConfirmationAttempt("session_two", 100).allowed,
    ).toBe(true);
  });

  it("bounds concurrent password work and releases capacity exactly once", () => {
    const limiter = new AuthenticationRateLimiter();
    const operations = Array.from({ length: 4 }, () =>
      limiter.beginPasswordOperation(),
    );

    expect(operations.every(Boolean)).toBe(true);
    expect(limiter.beginPasswordOperation()).toBeNull();

    operations[0]?.release();
    operations[0]?.release();
    expect(limiter.beginPasswordOperation()).not.toBeNull();
    expect(limiter.beginPasswordOperation()).toBeNull();
  });
});
