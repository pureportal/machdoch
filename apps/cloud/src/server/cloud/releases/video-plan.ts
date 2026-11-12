export interface VideoSegment {
  path: string;
  kind: "image" | "video";
  seconds: number;
  overlayPath: string | null;
}

const fadeSeconds = 0.4;
const framesPerSecond = 30;

function seconds(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

export function videoArguments(plan: {
  segments: VideoSegment[];
  size: { width: number; height: number };
  background: string;
  outputPath: string;
}): string[] {
  const { width, height } = plan.size;
  const color = `0x${plan.background.replace("#", "")}`;
  const inputs: string[] = [];
  const filters: string[] = [];
  let index = 0;
  const labels: string[] = [];
  plan.segments.forEach((segment, position) => {
    const source = index++;
    inputs.push(
      ...(segment.kind === "image"
        ? ["-loop", "1", "-t", seconds(segment.seconds), "-i", segment.path]
        : ["-t", seconds(segment.seconds), "-i", segment.path]),
    );
    const fadeOut = Math.max(0, segment.seconds - fadeSeconds);
    const base = `s${position}`;
    filters.push(
      `[${source}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1,fps=${framesPerSecond},format=yuv420p,trim=duration=${seconds(segment.seconds)},setpts=PTS-STARTPTS${segment.overlayPath ? "" : `,fade=t=in:st=0:d=${fadeSeconds},fade=t=out:st=${seconds(fadeOut)}:d=${fadeSeconds}`}[${base}]`,
    );
    if (segment.overlayPath) {
      const overlay = index++;
      inputs.push(
        "-loop",
        "1",
        "-t",
        seconds(segment.seconds),
        "-i",
        segment.overlayPath,
      );
      filters.push(
        `[${base}][${overlay}:v]overlay=0:0:shortest=1,format=yuv420p,fade=t=in:st=0:d=${fadeSeconds},fade=t=out:st=${seconds(fadeOut)}:d=${fadeSeconds}[${base}o]`,
      );
      labels.push(`[${base}o]`);
    } else labels.push(`[${base}]`);
  });
  const audio = index;
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[video]`);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[video]",
    "-map",
    `${audio}:a`,
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(framesPerSecond),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    plan.outputPath,
  ];
}

export function parseDuration(output: string): number | null {
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
