"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type {
  SettingsCatalog,
  SettingsProfile,
  SettingsProfileSummary,
} from "./types";

export function useSettingsProfiles() {
  const [catalog, setCatalog] = useState<SettingsCatalog | null>(null);
  const [profiles, setProfiles] = useState<SettingsProfileSummary[]>([]);
  const [profile, setProfile] = useState<SettingsProfile | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const selectProfile = useCallback(async (profileId: string) => {
    const request = ++requestId.current;
    setSelectedId(profileId);
    setProfile(null);
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ profile: SettingsProfile }>(
        `/api/settings/profiles/${encodeURIComponent(profileId)}`,
      );
      if (request === requestId.current) setProfile(payload.profile);
    } catch (reason) {
      if (request === requestId.current) setError(settingsError(reason));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const [nextCatalog, payload] = await Promise.all([
        api<SettingsCatalog>("/api/settings/catalog"),
        api<{ profiles: SettingsProfileSummary[] }>("/api/settings/profiles"),
      ]);
      if (request !== requestId.current) return;
      setCatalog(nextCatalog);
      setProfiles(payload.profiles);
      if (payload.profiles[0])
        await selectProfile(payload.profiles[0].profileId);
    } catch (reason) {
      if (request === requestId.current) setError(settingsError(reason));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [selectProfile]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);

  const acceptProfile = (next: SettingsProfile): void => {
    requestId.current++;
    setSelectedId(next.profileId);
    setProfile(next);
    setLoading(false);
    setError("");
    setProfiles((current) => {
      const previous = current.find(
        (item) => item.profileId === next.profileId,
      );
      const summary: SettingsProfileSummary = {
        profileId: next.profileId,
        name: next.name,
        description: next.description,
        revision: next.revision,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
        instructionCount: next.document.instructions.length,
        contextPackCount: next.document.contextPacks.length,
        promptCount: next.document.prompts.length,
        secretCount: next.secrets.length,
        assignmentCount: previous?.assignmentCount ?? 0,
      };
      return previous
        ? current.map((item) =>
            item.profileId === next.profileId ? summary : item,
          )
        : [...current, summary];
    });
  };

  const deleteProfile = async (): Promise<void> => {
    if (!profile) return;
    await api(
      `/api/settings/profiles/${encodeURIComponent(profile.profileId)}`,
      { method: "DELETE" },
    );
    const remaining = profiles.filter(
      (item) => item.profileId !== profile.profileId,
    );
    setProfiles(remaining);
    setProfile(null);
    setSelectedId(null);
    if (remaining[0]) await selectProfile(remaining[0].profileId);
  };

  return {
    catalog,
    profiles,
    profile,
    selectedId,
    loading,
    error,
    selectProfile,
    acceptProfile,
    deleteProfile,
    retry: () => (selectedId && catalog ? selectProfile(selectedId) : load()),
  };
}

export function settingsError(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "Settings request failed. Try again.";
}
