import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MediaImageLayoutEditor, emptyMediaImageLayout } from "../../../../packages/media-studio/src/tauri/ui/media/components/media-image-layout-editor";
import { createImageRecipeFlow, readImageRecipeSettings } from "../../../../packages/media-studio/src/core/media/compiler";
import { validateMediaFlowDocument } from "../../../../packages/media-studio/src/core/media/node-registry";
import { resolveMediaFlowVariables } from "../../../../packages/media-studio/src/core/media/variables";
import { mediaImageLayoutDigest } from "../../../../packages/media-studio/src/core/media/image-layout";
import type { MediaFlow } from "../../../../packages/media-studio/src/core/media/contracts";

function App() {
  const [layout, setLayout] = useState(emptyMediaImageLayout);
  const [status, setStatus] = useState("");
  const flow = () => createImageRecipeFlow({ id: "layout-ui-verification", createdAt: "2026-10-21T00:00:00Z", settings: {
    prompt: "Layout verification", imageLayout: layout, layoutMethod: "native", modelId: "local:moss-image-base", modelPolicy: "quality", providerPolicy: "local",
    outputCount: 1, outputFormat: "png", aspectRatio: "1:1", transparentBackground: false, qualityGateEnabled: false,
    referenceImages: [], baseImageAssetId: null, poseImageAssetId: null, poseStrength: 1, modelAddons: [],
  } });
  return <main style={{ maxWidth: 900, margin: "auto", fontFamily: "Arial" }}>
    <MediaImageLayoutEditor value={layout} onChange={setLayout} />
    <button onClick={async () => {
      const document = flow();
      if (validateMediaFlowDocument(document).length) throw new Error("Invalid flow");
      const response = await fetch("/api/flow", { method: "POST", body: JSON.stringify(document) });
      if (!response.ok) throw new Error(await response.text());
      setStatus("Saved");
    }}>Save workflow</button>
    <button onClick={async () => {
      const saved: MediaFlow = await (await fetch("/api/flow")).json();
      const restored = readImageRecipeSettings(saved);
      if (!restored?.imageLayout) throw new Error("Saved layout missing");
      setLayout(restored.imageLayout); setStatus("Reopened");
    }}>Reopen workflow</button>
    <button onClick={async () => {
      const resolved = resolveMediaFlowVariables(flow());
      if (resolved.issues.length) throw new Error("Variable resolution failed");
      const settings = readImageRecipeSettings(resolved.flow)!;
      const response = await fetch("/api/adapter", { method: "POST", body: JSON.stringify({ imageLayout: settings.imageLayout, layoutMethod: settings.layoutMethod, modelId: settings.modelId }) });
      if (!response.ok) throw new Error(await response.text());
      setStatus("Adapter compiled");
    }}>Compile generation</button>
    <output aria-label="Layout digest">{mediaImageLayoutDigest(layout)}</output>
    <output aria-label="Workflow status">{status}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
