import type { CivitaiModel, CivitaiSearch, CivitaiSearchPage } from "../../../core/media/civitai.js";

export const CIVITAI_RESULT_BATCH_SIZE = 48;

export class CivitaiSearchResults {
  private pending: CivitaiModel[] = [];
  private seen = new Set<number>();
  private visited = new Set<string>();
  private cursor: string | null = null;
  private started = false;

  constructor(
    private readonly request: CivitaiSearch,
    private readonly search: (request: CivitaiSearch) => Promise<CivitaiSearchPage>,
  ) {}

  async next(isActive: () => boolean): Promise<{ items: CivitaiModel[]; hasMore: boolean }> {
    for (let scanned = 0; scanned < 5 && this.pending.length < CIVITAI_RESULT_BATCH_SIZE; scanned++) {
      if (!isActive() || (this.started && !this.cursor)) break;
      const page = await this.search({ ...this.request, cursor: this.cursor });
      if (!isActive()) return { items: [], hasMore: false };
      if (page.nextCursor && this.visited.has(page.nextCursor)) {
        throw new Error("Civitai repeated a results page. Try searching again.");
      }
      if (page.nextCursor) this.visited.add(page.nextCursor);
      this.started = true;
      this.cursor = page.nextCursor;
      for (const item of page.items) {
        if (this.seen.has(item.id)) continue;
        this.seen.add(item.id);
        this.pending.push(item);
      }
    }
    return {
      items: this.pending.splice(0, CIVITAI_RESULT_BATCH_SIZE),
      hasMore: this.pending.length > 0 || this.cursor !== null,
    };
  }
}
