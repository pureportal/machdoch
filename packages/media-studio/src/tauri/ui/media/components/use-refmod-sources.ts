import { useEffect, useRef, useState, type RefObject } from "react";
import { releaseFile } from "../media-platform";

export interface RefModSource {
  path: string;
  kind: "image" | "video" | "audio";
  startSeconds: number;
  maskPath?: string;
}

export function useRefModSources(work: RefObject<Promise<void> | null>) {
  const [sources, setSources] = useState<RefModSource[]>([]);
  const active = useRef(true);
  const ownedPaths = useRef(new Set<string>());
  const releasePaths = async (paths: Iterable<string>) => {
    const results = await Promise.allSettled(
      [...new Set(paths)].map(async (path) => {
        await releaseFile(path);
        ownedPaths.current.delete(path);
      }),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Could not release uploaded RefMod files. Try again.",
      );
  };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const release = () => releasePaths(ownedPaths.current);
      void (
        work.current ? work.current.then(release, release) : release()
      ).catch((failure) =>
        console.error(
          "Could not release the closed RefMod creator's uploads",
          failure,
        ),
      );
    };
  }, [work]);
  const takeOwnership = async (paths: string[]) => {
    for (const path of paths) ownedPaths.current.add(path);
    if (active.current) return true;
    await releasePaths(paths);
    return false;
  };
  return {
    sources,
    isActive: () => active.current,
    async append(selected: RefModSource[]) {
      if (
        await takeOwnership(
          selected.flatMap((source) => [
            source.path,
            ...(source.maskPath ? [source.maskPath] : []),
          ]),
        )
      )
        setSources((current) => [...current, ...selected]);
    },
    update(index: number, patch: Partial<Pick<RefModSource, "startSeconds">>) {
      setSources((current) =>
        current.map((source, position) =>
          position === index ? { ...source, ...patch } : source,
        ),
      );
    },
    async remove(index: number) {
      const source = sources[index]!;
      await releasePaths([
        source.path,
        ...(source.maskPath ? [source.maskPath] : []),
      ]);
      if (active.current)
        setSources((current) =>
          current.filter((_, position) => position !== index),
        );
    },
    async setMask(index: number, path?: string) {
      if (path && !(await takeOwnership([path]))) return;
      const previous = sources[index]!.maskPath;
      if (previous && previous !== path) await releasePaths([previous]);
      if (active.current)
        setSources((current) =>
          current.map((source, position) =>
            position === index ? { ...source, maskPath: path } : source,
          ),
        );
    },
  };
}
