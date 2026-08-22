export interface RevisionedMediaPageRequest {
  offset: number;
  limit: number;
  knownRevision: string | null;
}

export interface RevisionedMediaPage<T> {
  schemaVersion: number;
  revision: string;
  offset: number;
  totalItems: number | null;
  unchanged: boolean;
  items: T[];
}

export interface RevisionedMediaLibrarySnapshot<T> {
  revision: string;
  items: T[];
}

interface CollectRevisionedMediaPagesOptions<T extends { id: string }> {
  libraryLabel: string;
  itemLabel: string;
  loadPage: (
    request: RevisionedMediaPageRequest,
  ) => Promise<RevisionedMediaPage<T>>;
  cached: RevisionedMediaLibrarySnapshot<T> | null;
  pageSize?: number;
  maxRestarts?: number;
}

const assertPageEnvelope = <T,>(
  page: RevisionedMediaPage<T>,
  expectedOffset: number,
  libraryLabel: string,
): void => {
  if (page.schemaVersion !== 1) {
    throw new Error(
      `Unsupported ${libraryLabel} page schema ${String(page.schemaVersion)}.`,
    );
  }
  if (!page.revision.trim()) {
    throw new Error(`The ${libraryLabel} returned an empty revision.`);
  }
  if (
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    page.offset !== expectedOffset
  ) {
    throw new Error(
      `The ${libraryLabel} returned offset ${String(page.offset)} while ${expectedOffset} was requested.`,
    );
  }
  if (!Array.isArray(page.items)) {
    throw new Error(`The ${libraryLabel} page did not contain an item list.`);
  }
};

/**
 * Collects a coherent, unbounded native library snapshot. The backend may
 * cheaply return "unchanged"; mutation between page reads causes a bounded
 * restart instead of leaking a partial or duplicated list into the UI.
 */
export const collectRevisionedMediaPages = async <T extends { id: string }>({
  libraryLabel,
  itemLabel,
  loadPage,
  cached,
  pageSize = 250,
  maxRestarts = 2,
}: CollectRevisionedMediaPagesOptions<T>): Promise<
  RevisionedMediaLibrarySnapshot<T>
> => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 250) {
    throw new Error(`${itemLabel} page size must be an integer from 1 to 250.`);
  }
  if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 10) {
    throw new Error(
      `${itemLabel} snapshot restart count must be an integer from 0 to 10.`,
    );
  }

  for (let attempt = 0; attempt <= maxRestarts; attempt += 1) {
    const first = await loadPage({
      offset: 0,
      limit: pageSize,
      knownRevision: cached?.revision ?? null,
    });
    assertPageEnvelope(first, 0, libraryLabel);

    if (first.unchanged) {
      if (
        !cached ||
        first.revision !== cached.revision ||
        first.items.length !== 0 ||
        first.totalItems !== null
      ) {
        throw new Error(
          `The ${libraryLabel} returned an invalid unchanged snapshot response.`,
        );
      }
      return cached;
    }

    if (
      first.totalItems === null ||
      !Number.isSafeInteger(first.totalItems) ||
      first.totalItems < 0
    ) {
      throw new Error(`The ${libraryLabel} returned an invalid total item count.`);
    }
    if (first.items.length > first.totalItems) {
      throw new Error(
        `The first ${itemLabel.toLocaleLowerCase()} page contains more items than the snapshot total.`,
      );
    }

    const revision = first.revision;
    const totalItems = first.totalItems;
    const items = [...first.items];
    let changedDuringRead = false;

    while (items.length < totalItems) {
      const page = await loadPage({
        offset: items.length,
        limit: pageSize,
        knownRevision: null,
      });
      assertPageEnvelope(page, items.length, libraryLabel);
      if (
        page.unchanged ||
        page.revision !== revision ||
        page.totalItems !== totalItems
      ) {
        changedDuringRead = true;
        break;
      }
      if (page.items.length === 0) {
        throw new Error(
          `${itemLabel} snapshot ${revision} stalled at ${items.length} of ${totalItems} entries.`,
        );
      }
      if (items.length + page.items.length > totalItems) {
        throw new Error(
          `A ${itemLabel.toLocaleLowerCase()} page exceeded the advertised snapshot total.`,
        );
      }
      items.push(...page.items);
    }

    if (changedDuringRead) continue;

    const uniqueIds = new Set(items.map((item) => item.id));
    if (uniqueIds.size !== items.length) {
      throw new Error(
        `${itemLabel} snapshot ${revision} contains duplicate identifiers.`,
      );
    }
    return { revision, items };
  }

  throw new Error(
    `The ${libraryLabel} kept changing while it was being read. Wait for active changes to settle and refresh again.`,
  );
};
