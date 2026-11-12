import { describe, expect, it } from "vitest";
import { parseDuration, videoArguments } from "./video-plan";

describe("videoArguments", () => {
  it("normalizes every segment, overlays captions and concatenates with silent audio", () => {
    const args = videoArguments({
      segments: [
        { path: "intro.png", kind: "image", seconds: 2.5, overlayPath: null },
        {
          path: "clip.mp4",
          kind: "video",
          seconds: 6,
          overlayPath: "caption.png",
        },
      ],
      size: { width: 1920, height: 1080 },
      background: "#141519",
      outputPath: "out.mp4",
    });
    expect(args.slice(0, 4)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
    ]);
    expect(args).toEqual(
      expect.arrayContaining(["-loop", "1", "-t", "2.5", "-i", "intro.png"]),
    );
    expect(args.join(" ")).toContain(
      "-t 6 -i clip.mp4 -loop 1 -t 6 -i caption.png",
    );
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain(
      "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x141519",
    );
    expect(filter).toContain("fade=t=out:st=2.1:d=0.4[s0]");
    expect(filter).toContain("[s1][2:v]overlay=0:0:shortest=1");
    expect(filter).toContain("[s0][s1o]concat=n=2:v=1:a=0[video]");
    expect(args).toEqual(
      expect.arrayContaining(["-map", "[video]", "-map", "3:a"]),
    );
    expect(args.at(-1)).toBe("out.mp4");
  });
});

describe("parseDuration", () => {
  it("reads ffmpeg's duration line", () => {
    expect(parseDuration("  Duration: 00:01:02.50, start: 0.000000")).toBe(
      62.5,
    );
    expect(parseDuration("no duration")).toBeNull();
  });
});
