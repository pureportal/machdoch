import { useEffect, useRef, useState } from "react";
import { open } from "../media-platform";
import { invoke } from "../media-platform";
import { openUrl } from "../media-platform";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export function MediaWorkflowModelField({
  id,
  value,
  directory,
  modelKind,
  onChange,
}: {
  id: string;
  value: string;
  directory: boolean;
  modelKind: "prompt" | "upscale" | "sam3" | "vision";
  onChange: (value: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [upscaler, setUpscaler] = useState("upscale");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const install = async () => {
    setError(null);
    setInstalling(true);
    try {
      const path = await invoke<string>("media_install_workflow_model", {
        kind: modelKind === "upscale" ? upscaler : modelKind,
      });
      if (mounted.current) onChange(path);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not download the model. Check your connection and retry.",
      );
    } finally {
      setInstalling(false);
    }
  };
  const browse = async () => {
    setError(null);
    try {
      const selected = await open({
        directory,
        multiple: false,
        ...(directory
          ? {}
          : {
              filters: [
                { name: "Upscaler models", extensions: ["pth", "safetensors"] },
              ],
            }),
      });
      if (mounted.current && typeof selected === "string") onChange(selected);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not open the file picker. Enter the model path.",
      );
    }
  };
  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          disabled={installing}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={installing}
          onClick={() => void browse()}
        >
          Browse
        </Button>
      </div>
      {!value && modelKind !== "sam3" ? (
        <div className="flex flex-wrap gap-2">
          {modelKind === "upscale" ? (
            <select
              aria-label="Upscaler to download"
              value={upscaler}
              disabled={installing}
              onChange={(event) => setUpscaler(event.target.value)}
              className="min-w-0 rounded-md border border-input bg-background p-2 text-xs"
            >
              <option value="upscale">Real-ESRGAN · 67 MB</option>
              <option value="upscale-span">SPAN · 9 MB</option>
            </select>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing
              ? "Downloading model…"
              : modelKind === "prompt"
                ? "Download Qwen3 · 1.5 GB"
                : modelKind === "vision"
                  ? "Download Qwen3-VL · 4.3 GB"
                  : "Download model"}
          </Button>
        </div>
      ) : null}
      {!value && modelKind === "sam3" ? (
        <Button
          variant="link"
          size="sm"
          onClick={() =>
            void openUrl("https://huggingface.co/facebook/sam3").catch(() =>
              setError(
                "Open huggingface.co/facebook/sam3 to request access and download the model.",
              ),
            )
          }
        >
          Get SAM3 access
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
