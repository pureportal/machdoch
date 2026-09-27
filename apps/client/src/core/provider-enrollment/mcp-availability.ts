import { connect } from "node:net";

const MCP_CONNECT_TIMEOUT_MS = 1_000;

export const isMcpHttpEndpointReachable = async (
  endpoint: string,
): Promise<boolean> => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return true;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return true;
  }

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return await new Promise<boolean>((resolve) => {
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const socket = connect({ host: hostname, port });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(MCP_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
};
