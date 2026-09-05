import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { terminateProcessTree } from "../_helpers/process-tree.js";
import { Readable } from "node:stream";

export class ManagedMcpStdioTransport extends StdioClientTransport {
  private closing: Promise<void> | undefined;

  constructor(parameters: StdioServerParameters) {
    super(parameters);
    // The SDK pipes stderr into a PassThrough. Without a reader it eventually
    // blocks the child, even when protocol traffic on stdout is healthy.
    const stderr = this.stderr;
    if (stderr instanceof Readable) stderr.resume();
  }

  override close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const pid = this.pid;
      if (process.platform === "win32" && pid !== null) {
        // Kill the tree while its parent still exists. Closing stdin first can
        // let an npm/.cmd wrapper exit and orphan the server it launched.
        await terminateProcessTree(
          {
            pid,
            kill: (signal) => process.kill(pid, signal),
          },
          true,
        );
      }
      try {
        await super.close();
      } finally {
        const stderr = this.stderr;
        if (stderr instanceof Readable) stderr.destroy();
      }
    });
    return this.closing;
  }
}
