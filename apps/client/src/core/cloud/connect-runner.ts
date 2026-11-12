import { RunnerConnection } from "@machdoch/cloud-client";
import { sourceCliAllowsLoopbackHttp } from "../fleet-connection.js";

export const connectRunner = (
  origin: string,
  token: string,
): RunnerConnection =>
  new RunnerConnection(origin, token, fetch, {
    allowLoopbackHttp: sourceCliAllowsLoopbackHttp(),
  });
