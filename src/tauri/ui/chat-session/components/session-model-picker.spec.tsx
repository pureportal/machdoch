import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderModelCatalogSnapshot } from "../../model-catalog";
import { SessionModelPicker } from "./session-model-picker";

const { loadProviderModelCatalogMock } = vi.hoisted(() => ({
  loadProviderModelCatalogMock: vi.fn(),
}));

vi.mock("../../runtime", () => ({
  loadProviderModelCatalog: loadProviderModelCatalogMock,
}));

const liveCatalog = {
  generatedAt: 1,
  providers: [
    {
      provider: "copilot-cli",
      source: "provider-sdk",
      available: true,
      models: [
        { id: "auto", label: "Auto" },
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
        { id: "mai-code-1-flash", label: "MAI-Code-1-Flash" },
      ],
    },
  ],
} satisfies ProviderModelCatalogSnapshot;

const unavailableCatalog = {
  generatedAt: 1,
  providers: [
    {
      provider: "copilot-cli",
      source: "provider-sdk",
      available: false,
      error:
        "Copilot CLI binary was not found. Configure MACHDOCH_COPILOT_CLI_PATH or install `copilot` on PATH.",
      models: [],
    },
  ],
} satisfies ProviderModelCatalogSnapshot;

const renderModelPicker = (): ReturnType<typeof vi.fn> => {
  const onSessionModelSelection = vi.fn();

  render(
    <SessionModelPicker
      chooserProviders={["codex-cli", "copilot-cli"]}
      activeProvider="copilot-cli"
      activeModel="auto"
      onSessionModelSelection={onSessionModelSelection}
    />,
  );

  return onSessionModelSelection;
};

const openModelPicker = async (): Promise<HTMLElement> => {
  fireEvent.click(
    screen.getByRole("button", {
      name: "Session model: Copilot CLI Auto",
    }),
  );

  return await screen.findByRole("searchbox", { name: "Search models" });
};

describe("SessionModelPicker", () => {
  beforeEach(() => {
    loadProviderModelCatalogMock.mockReset();
    loadProviderModelCatalogMock.mockResolvedValue(liveCatalog);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows no fallback models while refreshing the live catalog", async () => {
    let resolveCatalog: ((catalog: ProviderModelCatalogSnapshot) => void) | null =
      null;
    loadProviderModelCatalogMock.mockReturnValue(
      new Promise<ProviderModelCatalogSnapshot>((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    renderModelPicker();

    const searchInput = await openModelPicker();

    expect(loadProviderModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(searchInput);
    expect(screen.getByText("Checking availability")).toBeTruthy();
    expect(screen.getByText("Checking Copilot CLI model list…")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Choose Copilot CLI Auto" }),
    ).toBeNull();

    resolveCatalog?.(liveCatalog);

    expect(await screen.findByText("4 available")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose Copilot CLI Auto" }),
    ).toBeTruthy();
  });

  it("shows the provider failure without exposing fallback models", async () => {
    loadProviderModelCatalogMock.mockResolvedValue(unavailableCatalog);
    renderModelPicker();

    await openModelPicker();

    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "Copilot CLI binary was not found. Configure MACHDOCH_COPILOT_CLI_PATH or install `copilot` on PATH.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Choose Copilot CLI Auto" }),
    ).toBeNull();
  });

  it("filters live models by label or model ID", async () => {
    renderModelPicker();

    const searchInput = await openModelPicker();
    await screen.findByText("Kimi K2.7 Code");
    fireEvent.change(searchInput, { target: { value: "k2.7" } });

    expect(screen.getByText("Kimi K2.7 Code")).toBeTruthy();
    expect(screen.queryByText("GPT-5.5")).toBeNull();
    expect(screen.queryByText("MAI-Code-1-Flash")).toBeNull();
  });

  it("selects the highest-ranked model when Enter is pressed in search", async () => {
    const onSessionModelSelection = renderModelPicker();

    const searchInput = await openModelPicker();
    await screen.findByText("MAI-Code-1-Flash");
    fireEvent.change(searchInput, { target: { value: "mai code" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(onSessionModelSelection).toHaveBeenCalledWith(
      "copilot-cli",
      "mai-code-1-flash",
    );
  });
});
