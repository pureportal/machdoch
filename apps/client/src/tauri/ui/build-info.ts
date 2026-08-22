declare const __MACHDOCH_DEVELOPMENT__: boolean | undefined;

export const IS_DEVELOPMENT_BUILD =
  typeof __MACHDOCH_DEVELOPMENT__ === "boolean" &&
  __MACHDOCH_DEVELOPMENT__;

export const MACHDOCH_DISPLAY_NAME = IS_DEVELOPMENT_BUILD
  ? "machdoch Developer"
  : "machdoch";
