export const clampFiniteNumber = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
};

export const clampIntegerSetting = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  return Math.round(clampFiniteNumber(value, min, max, fallback));
};

export const clampDecimalSetting = (
  value: number,
  min: number,
  max: number,
  fallback: number,
  decimals: number,
): number => {
  const clampedValue = clampFiniteNumber(value, min, max, fallback);

  return Number(clampedValue.toFixed(decimals));
};

export const parseIntegerSettingInput = (
  value: string,
  min: number,
  max: number,
  fallback: number,
): number => {
  return clampIntegerSetting(Number(value), min, max, fallback);
};

export const parseDecimalSettingInput = (
  value: string,
  min: number,
  max: number,
  fallback: number,
  decimals: number,
): number => {
  return clampDecimalSetting(Number(value), min, max, fallback, decimals);
};
