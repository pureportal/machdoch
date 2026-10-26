import { isIP } from "node:net";

export interface CloudSessionContext {
  browser: string | null;
  platform: string | null;
  address: string | null;
}

export function browserSessionContext(
  request: Request,
  address: string,
): CloudSessionContext {
  const agent = (request.headers.get("user-agent") ?? "").slice(0, 1024);
  const browser = /Edg(?:e|A|iOS)?\//.test(agent)
    ? "Edge"
    : /(?:Firefox|FxiOS)\//.test(agent)
      ? "Firefox"
      : /(?:OPR|Opera)\//.test(agent)
        ? "Opera"
        : /(?:Chrome|CriOS)\//.test(agent)
          ? "Chrome"
          : /Safari\//.test(agent)
            ? "Safari"
            : null;
  const platform = /iPhone|iPad|iPod|Macintosh.*Mobile/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Windows/.test(agent)
        ? "Windows"
        : /Macintosh|Mac OS X/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : null;
  return {
    browser,
    platform,
    address: address.length <= 64 && isIP(address) ? address : null,
  };
}
