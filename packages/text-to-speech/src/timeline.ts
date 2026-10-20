import type { SpeechTimelineClip, SpeechClipTiming } from "@machdoch/speech";

export function splitTimelineClip<T extends SpeechClipTiming>(
  clip: T,
  position: number,
  id: string,
): [T, T] {
  const duration = clip.out - clip.in;
  const offset = position - clip.start;
  if (!Number.isFinite(offset) || offset <= 0 || offset >= duration)
    throw new Error("Split at a time inside the clip.");
  if (offset < clip.fadeIn || duration - offset < clip.fadeOut)
    throw new Error(
      "Split outside the clip's fades or shorten the fades first.",
    );
  return [
    { ...clip, out: clip.in + offset, fadeOut: 0 },
    { ...clip, id, start: position, in: clip.in + offset, fadeIn: 0 },
  ];
}

export function insertTimelineSilence<T extends SpeechClipTiming>(
  clips: T[],
  position: number,
  duration: number,
  id: () => string,
): T[] {
  if (
    !Number.isFinite(position) ||
    position < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new Error(
      "Enter a nonnegative position and a positive silence duration.",
    );
  return clips.flatMap((clip) => {
    if (clip.start >= position)
      return [{ ...clip, start: clip.start + duration }];
    if (clip.start + clip.out - clip.in <= position) return [clip];
    const [before, after] = splitTimelineClip(clip, position, id());
    return [before, { ...after, start: after.start + duration }];
  });
}

export function crossfadeTimelineClips<T extends SpeechClipTiming>(
  first: T,
  second: T,
  duration: number,
): [T, T] {
  if (
    first.id === second.id ||
    first.track !== second.track ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    throw new Error(
      "Choose two different clips on the same track and a positive crossfade duration.",
    );
  if (
    duration + first.fadeIn > first.out - first.in ||
    duration + second.fadeOut > second.out - second.in
  )
    throw new Error(
      "Shorten the crossfade to fit both clips and their other fades.",
    );
  return [
    { ...first, fadeOut: duration },
    {
      ...second,
      start: first.start + first.out - first.in - duration,
      fadeIn: duration,
    },
  ];
}

export function replaceTimelineTake(
  clip: SpeechTimelineClip,
  takeId: string,
  duration: number,
): SpeechTimelineClip {
  if (!takeId || !Number.isFinite(duration) || clip.out > duration)
    throw new Error(
      "Choose a replacement take that contains the current trim range, or shorten the trim first.",
    );
  return { ...clip, takeId };
}
