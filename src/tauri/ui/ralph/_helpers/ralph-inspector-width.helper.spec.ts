import {
  RALPH_INSPECTOR_DEFAULT_WIDTH,
  RALPH_INSPECTOR_MAX_WIDTH,
  RALPH_INSPECTOR_MIN_WIDTH,
  RALPH_INSPECTOR_STORAGE_KEY,
  clampRalphInspectorWidth,
  loadRalphInspectorWidth,
  saveRalphInspectorWidth,
} from "./ralph-inspector-width.helper";

const createLocalStorageStub = (): Storage => {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

const stubWindowStorage = (): Storage => {
  const localStorage = createLocalStorageStub();

  vi.stubGlobal("window", { localStorage });

  return localStorage;
};

describe("ralph inspector width helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clamps to configured min and max widths", () => {
    expect(clampRalphInspectorWidth(100, 2_000)).toBe(RALPH_INSPECTOR_MIN_WIDTH);
    expect(clampRalphInspectorWidth(1_000, 2_000)).toBe(RALPH_INSPECTOR_MAX_WIDTH);
  });

  it("uses the viewport cap when the viewport is narrower than the max width", () => {
    expect(clampRalphInspectorWidth(700, 1_000)).toBe(480);
    expect(clampRalphInspectorWidth(300, 600)).toBe(RALPH_INSPECTOR_MIN_WIDTH);
  });

  it("loads the stored inspector width when it is valid", () => {
    const localStorage = stubWindowStorage();

    localStorage.setItem(RALPH_INSPECTOR_STORAGE_KEY, "512");

    expect(loadRalphInspectorWidth()).toBe(512);
  });

  it("falls back to the default width when storage is empty or invalid", () => {
    const localStorage = stubWindowStorage();

    expect(loadRalphInspectorWidth()).toBe(RALPH_INSPECTOR_DEFAULT_WIDTH);

    localStorage.setItem(RALPH_INSPECTOR_STORAGE_KEY, "not-a-number");

    expect(loadRalphInspectorWidth()).toBe(RALPH_INSPECTOR_DEFAULT_WIDTH);
  });

  it("saves the inspector width preference", () => {
    const localStorage = stubWindowStorage();

    saveRalphInspectorWidth(520);

    expect(localStorage.getItem(RALPH_INSPECTOR_STORAGE_KEY)).toBe("520");
  });
});
