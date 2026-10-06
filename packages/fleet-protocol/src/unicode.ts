export const hasUnpairedUtf16Surrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

export const sliceUtf16PrefixAtCodePointBoundary = (
  value: string,
  maxCodeUnits: number,
): string => {
  if (value.length <= maxCodeUnits) return value;
  const boundedLength = Number.isFinite(maxCodeUnits)
    ? Math.max(0, Math.trunc(maxCodeUnits))
    : 0;
  const finalCodeUnit = value.charCodeAt(boundedLength - 1);
  const nextCodeUnit = value.charCodeAt(boundedLength);
  const safeLength =
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
      ? boundedLength - 1
      : boundedLength;
  return value.slice(0, safeLength);
};

export const sliceUtf16SuffixAtCodePointBoundary = (
  value: string,
  maxCodeUnits: number,
): string => {
  if (value.length <= maxCodeUnits) return value;
  const boundedLength = Number.isFinite(maxCodeUnits)
    ? Math.max(0, Math.trunc(maxCodeUnits))
    : 0;
  const start = value.length - boundedLength;
  const firstCodeUnit = value.charCodeAt(start);
  const previousCodeUnit = value.charCodeAt(start - 1);
  const safeStart =
    firstCodeUnit >= 0xdc00 &&
    firstCodeUnit <= 0xdfff &&
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff
      ? start + 1
      : start;
  return value.slice(safeStart);
};
