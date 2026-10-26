"use client";

import { useEffect, useRef, useState } from "react";
import { cloudId } from "@/lib/cloud-contract";
import { CloudRequestError, cloudRequest } from "./api-client";

function navigationSource() {
  return {
    pathname: location.pathname,
    token: location.hash.slice(1),
    confirmationId: cloudId.safeParse(
      new URLSearchParams(location.search).get("confirmation"),
    ).data,
  };
}

export function useAuthConfirmation<T extends { confirmationId: string }>(
  resource: "auth/magic" | "invitations",
  missingLink: string,
) {
  const [preview, setPreview] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [navigation, setNavigation] = useState(0);
  const preparation = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const source = useRef<ReturnType<typeof navigationSource> | null>(null);
  useEffect(() => {
    const cancel = () => {
      preparation.current?.abort();
      operation.current?.abort();
    };
    const changed = () => {
      cancel();
      source.current = navigationSource();
      setNavigation((value) => value + 1);
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) changed();
    };
    const fragmentChanged = (event: HashChangeEvent) => {
      if (event.newURL === location.href) changed();
    };
    const historyChanged = () => {
      if (!location.hash) changed();
    };
    window.addEventListener("hashchange", fragmentChanged);
    window.addEventListener("popstate", historyChanged);
    window.addEventListener("pageshow", restored);
    window.addEventListener("pagehide", cancel);
    return () => {
      cancel();
      window.removeEventListener("hashchange", fragmentChanged);
      window.removeEventListener("popstate", historyChanged);
      window.removeEventListener("pageshow", restored);
      window.removeEventListener("pagehide", cancel);
    };
  }, []);
  useEffect(() => {
    operation.current?.abort();
    operation.current = null;
    setPreview(null);
    setLoading(true);
    setPending(false);
    setError(null);
    const controller = new AbortController();
    preparation.current = controller;
    source.current ??= navigationSource();
    const { token, confirmationId, pathname } = source.current;
    if (token) history.replaceState(null, "", pathname);
    if (!token && !confirmationId) {
      setError(new Error(missingLink));
      setLoading(false);
      return;
    }
    void cloudRequest<T>(`${resource}/${token ? "prepare" : "preview"}`, {
      method: "POST",
      body: token ? { token } : { confirmationId },
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted || location.pathname !== pathname) return;
        const parsed =
          value && typeof value === "object"
            ? cloudId.safeParse(value.confirmationId)
            : undefined;
        if (!parsed?.success)
          throw new CloudRequestError(
            "Cloud returned an invalid confirmation. Try again.",
            502,
            "invalid_response",
          );
        const id = parsed.data;
        history.replaceState(null, "", `${pathname}?confirmation=${id}`);
        source.current = { pathname, token: "", confirmationId: id };
        setPreview(value);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [resource, missingLink, navigation]);
  async function run(action: (value: T, signal: AbortSignal) => Promise<void>) {
    if (
      !preview ||
      operation.current ||
      location.hash ||
      location.pathname !== source.current?.pathname ||
      new URLSearchParams(location.search).get("confirmation") !==
        preview.confirmationId
    )
      return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setError(null);
    try {
      await action(preview, controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason
            : new Error("The request could not be completed. Try again."),
        );
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (operation.current === controller) operation.current = null;
    }
  }
  return {
    preview,
    loading,
    pending,
    error,
    run,
    refresh: () => setNavigation((value) => value + 1),
  };
}
