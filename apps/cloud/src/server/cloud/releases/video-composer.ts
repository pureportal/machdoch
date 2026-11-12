import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  visualFormats,
  type VideoInput,
  type VisualInput,
} from "../../../lib/cloud-release-media-contract";
import { CloudError } from "../access";
import { parseDuration, videoArguments, type VideoSegment } from "./video-plan";
import {
  renderCaption,
  renderVisual,
  type VisualContext,
} from "./visual-renderer";

const compositionTimeoutMs = 10 * 60_000;
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export interface CompositionFile {
  bytes: Buffer;
  mime: string;
  kind: "image" | "video";
}

function run(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-20_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export class CloudVideoComposer {
  private availability: Promise<boolean> | null = null;

  constructor(
    private readonly binary = process.env.MACHDOCH_CLOUD_FFMPEG?.trim() ||
      "ffmpeg",
  ) {}

  available(): Promise<boolean> {
    this.availability ??= run(
      this.binary,
      ["-hide_banner", "-version"],
      tmpdir(),
      15_000,
    )
      .then((result) => result.code === 0)
      .catch(() => false);
    return this.availability;
  }

  private async duration(path: string, cwd: string): Promise<number | null> {
    const result = await run(
      this.binary,
      ["-hide_banner", "-i", path],
      cwd,
      30_000,
    );
    return parseDuration(result.output);
  }

  async compose(
    input: VideoInput,
    context: Omit<VisualContext, "image">,
    files: Map<string, CompositionFile>,
  ): Promise<{ bytes: Buffer; durationMs: number }> {
    if (!(await this.available()))
      throw new CloudError(
        503,
        "video_unavailable",
        "Video composition needs ffmpeg on the Cloud server.",
      );
    const size = visualFormats[input.format];
    const directory = await mkdtemp(join(tmpdir(), "machdoch-release-video-"));
    try {
      const segments: VideoSegment[] = [];
      const card = async (
        name: string,
        headline: string,
        subline: string,
        version: string,
      ) => {
        const visual: VisualInput = {
          template: "announcement",
          format: input.format,
          eyebrow: "",
          headline,
          subline,
          items: [],
          mediaId: null,
          theme: "brand",
        };
        const path = join(directory, `${name}.png`);
        await writeFile(
          path,
          await renderVisual(
            visual,
            { ...context, version, image: null },
            size,
          ),
        );
        return path;
      };
      if (input.intro.enabled && input.intro.headline)
        segments.push({
          path: await card(
            "intro",
            input.intro.headline,
            input.intro.subline,
            context.version,
          ),
          kind: "image",
          seconds: input.intro.seconds,
          overlayPath: null,
        });
      for (const [index, clip] of input.clips.entries()) {
        const file = files.get(clip.mediaId);
        if (!file)
          throw new CloudError(
            422,
            "media_unavailable",
            "A clip in this video is unavailable.",
          );
        if (file.kind === "image" && clip.caption) {
          const slide = join(directory, `clip-${index}.png`);
          const visual: VisualInput = {
            template: "spotlight",
            format: input.format,
            eyebrow: "",
            headline: clip.caption,
            subline: "",
            items: [],
            mediaId: clip.mediaId,
            theme: "brand",
          };
          await writeFile(
            slide,
            await renderVisual(visual, { ...context, image: file }, size),
          );
          segments.push({
            path: slide,
            kind: "image",
            seconds: clip.seconds,
            overlayPath: null,
          });
          continue;
        }
        const path = join(directory, `clip-${index}.${extensions[file.mime]!}`);
        await writeFile(path, file.bytes);
        let seconds = clip.seconds;
        if (file.kind === "video") {
          const duration = await this.duration(path, directory);
          if (duration === null)
            throw new CloudError(
              422,
              "media_invalid",
              "A video clip could not be read.",
            );
          seconds = Math.min(seconds, duration);
        }
        let overlayPath: string | null = null;
        if (file.kind === "video" && clip.caption) {
          overlayPath = join(directory, `caption-${index}.png`);
          await writeFile(
            overlayPath,
            await renderCaption(clip.caption, context.product.brand, size),
          );
        }
        segments.push({ path, kind: file.kind, seconds, overlayPath });
      }
      if (input.outro.enabled && input.outro.headline)
        segments.push({
          path: await card(
            "outro",
            input.outro.headline,
            input.outro.subline,
            "",
          ),
          kind: "image",
          seconds: input.outro.seconds,
          overlayPath: null,
        });
      const outputPath = join(directory, "release.mp4");
      const result = await run(
        this.binary,
        videoArguments({
          segments,
          size,
          background: context.product.brand.background,
          outputPath,
        }),
        directory,
        compositionTimeoutMs,
      );
      if (result.code !== 0)
        throw new CloudError(
          422,
          "video_failed",
          `The video could not be composed: ${result.output.trim().split("\n").at(-1)?.slice(0, 300) ?? "ffmpeg failed"}`,
        );
      return {
        bytes: await readFile(outputPath),
        durationMs: Math.round(
          segments.reduce((total, segment) => total + segment.seconds, 0) *
            1000,
        ),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
