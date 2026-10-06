import {
  memo,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import type { MermaidConfig } from "mermaid";

type MermaidTheme = "dark" | "default";

interface MermaidDiagramProps {
  fallback: ReactNode;
  source: string;
}

interface MermaidRenderState {
  imageSource?: string;
  imageWidth?: number;
  source: string;
  status: "error" | "loading" | "rendered";
  theme: MermaidTheme;
}

const MERMAID_RENDER_DELAY_MS = 150;
const MERMAID_SECURE_CONFIG_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "theme",
  "themeVariables",
  "themeCSS",
  "darkMode",
  "htmlLabels",
  "fontFamily",
] as const;

let mermaidModulePromise: Promise<typeof import("mermaid")> | undefined;

const loadMermaid = (): Promise<typeof import("mermaid")> => {
  mermaidModulePromise ??= import("mermaid").catch((error: unknown) => {
    mermaidModulePromise = undefined;
    throw error;
  });

  return mermaidModulePromise;
};

const getMermaidTheme = (): MermaidTheme =>
  document.documentElement.dataset.theme === "light" ? "default" : "dark";

const subscribeToMermaidTheme = (onThemeChange: () => void): (() => void) => {
  const observer = new MutationObserver(onThemeChange);
  observer.observe(document.documentElement, {
    attributeFilter: ["data-theme"],
    attributes: true,
  });

  return () => observer.disconnect();
};

const createMermaidConfig = (theme: MermaidTheme): MermaidConfig => ({
  darkMode: theme === "dark",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  htmlLabels: false,
  logLevel: "fatal",
  maxEdges: 500,
  maxTextSize: 50_000,
  secure: [...MERMAID_SECURE_CONFIG_KEYS],
  securityLevel: "strict",
  startOnLoad: false,
  suppressErrorRendering: true,
  theme,
});

const getSvgViewBoxWidth = (svg: string): number | undefined => {
  const documentRoot = new DOMParser().parseFromString(
    svg,
    "image/svg+xml",
  ).documentElement;

  if (documentRoot.localName !== "svg") {
    throw new Error("Mermaid did not return an SVG document.");
  }

  const viewBox = documentRoot.getAttribute("viewBox");
  const width = Number(viewBox?.trim().split(/[\s,]+/u)[2]);

  return Number.isFinite(width) && width > 0 ? Math.ceil(width) : undefined;
};

const createSvgImageSource = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const renderMermaid = async (
  id: string,
  source: string,
  theme: MermaidTheme,
): Promise<Pick<MermaidRenderState, "imageSource" | "imageWidth">> => {
  const { default: mermaid } = await loadMermaid();
  mermaid.initialize(createMermaidConfig(theme));

  const parseResult = await mermaid.parse(source, { suppressErrors: true });
  if (!parseResult) {
    throw new Error("Invalid Mermaid diagram.");
  }

  const { svg } = await mermaid.render(id, source);

  return {
    imageSource: createSvgImageSource(svg),
    imageWidth: getSvgViewBoxWidth(svg),
  };
};

export const MermaidDiagram = memo(function MermaidDiagram({
  fallback,
  source,
}: MermaidDiagramProps): JSX.Element {
  const theme = useSyncExternalStore<MermaidTheme>(
    subscribeToMermaidTheme,
    getMermaidTheme,
    () => "dark",
  );
  const reactId = useId();
  const diagramId = useMemo(
    () => `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/gu, "")}`,
    [reactId],
  );
  const [renderState, setRenderState] = useState<MermaidRenderState>(() => ({
    source,
    status: "loading",
    theme,
  }));
  const hasCurrentRender =
    renderState.source === source && renderState.theme === theme;
  const status = hasCurrentRender ? renderState.status : "loading";

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void renderMermaid(diagramId, source, theme).then(
        ({ imageSource, imageWidth }) => {
          if (!cancelled) {
            setRenderState({
              imageSource,
              imageWidth,
              source,
              status: "rendered",
              theme,
            });
          }
        },
        () => {
          if (!cancelled) {
            setRenderState({ source, status: "error", theme });
          }
        },
      );
    }, MERMAID_RENDER_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [diagramId, source, theme]);

  return (
    <div
      aria-busy={status === "loading"}
      className="app-mermaid-diagram"
      data-mermaid-status={status}
    >
      {status === "rendered" && renderState.imageSource ? (
        <div
          role="region"
          aria-label="Mermaid diagram"
          tabIndex={0}
          className="app-mermaid-diagram-scroll"
        >
          <img
            src={renderState.imageSource}
            alt=""
            draggable={false}
            decoding="async"
            className="app-mermaid-diagram-image"
            style={
              renderState.imageWidth
                ? { width: `${renderState.imageWidth}px` }
                : undefined
            }
          />
        </div>
      ) : (
        <>
          {status === "error" ? (
            <p role="status" className="app-mermaid-diagram-error">
              Diagram could not be rendered. Check its Mermaid syntax.
            </p>
          ) : null}
          {fallback}
        </>
      )}
    </div>
  );
});
