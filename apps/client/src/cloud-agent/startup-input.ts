export async function readStartupInput(): Promise<{
  message: unknown;
  remainder: Buffer;
}> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    const close = () => reject(new Error("Sandbox startup input closed."));
    const error = (failure: Error) => reject(failure);
    const consume = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      const newline = buffer.indexOf(10);
      if (newline < 0 && buffer.length <= 65536) return;
      process.stdin.pause();
      process.stdin.off("data", consume);
      process.stdin.off("end", close);
      process.stdin.off("error", error);
      if (newline < 0 || newline > 65536) {
        reject(new Error("Sandbox startup input exceeds its limit."));
        return;
      }
      try {
        resolve({
          message: JSON.parse(
            buffer.subarray(0, newline).toString("utf8"),
          ) as unknown,
          remainder: buffer.subarray(newline + 1),
        });
      } catch {
        reject(new Error("Sandbox startup input is invalid."));
      }
    };
    process.stdin.on("data", consume);
    process.stdin.once("end", close);
    process.stdin.once("error", error);
  });
}
