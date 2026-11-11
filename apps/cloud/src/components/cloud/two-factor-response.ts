import { CloudRequestError } from "./api-client";

export function restartStaleSignIn(reason: unknown, signIn: string): boolean {
  if (!(reason instanceof CloudRequestError)) return false;
  if (reason.status === 401) {
    location.assign(signIn);
    return true;
  }
  if (
    reason.code === "two_factor_enabled" ||
    reason.code === "two_factor_setup_required"
  ) {
    location.reload();
    return true;
  }
  return false;
}

export function isTwoFactorLock(reason: unknown): boolean {
  return (
    reason instanceof CloudRequestError &&
    (reason.code === "two_factor_locked" ||
      reason.code === "two_factor_blocked")
  );
}

export function selectForRetry(input: HTMLInputElement | null): void {
  input?.focus();
  input?.select();
}
