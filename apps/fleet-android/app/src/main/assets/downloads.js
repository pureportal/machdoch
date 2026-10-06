(() => {
  let downloading = false;
  let receive;
  machdochDownload.onmessage = (message) => receive?.(message.data);
  const wait = () =>
    new Promise((resolve) => {
      receive = resolve;
    });
  const send = (message) =>
    machdochDownload.postMessage(JSON.stringify(message));
  async function downloadTransfer(address, name) {
    if (downloading) {
      send({ id: "busy", operation: "busy" });
      return;
    }
    downloading = true;
    const id = crypto.randomUUID();
    let reader;
    try {
      const response = await fetch(address.href, {
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
      });
      if (!response.ok || !response.body) throw new Error("Download failed.");
      if (Number(response.headers.get("Content-Length")) > 512 * 1024 * 1024)
        throw new Error("Download exceeds the size limit.");
      reader = response.body.getReader();
      let acknowledgement = wait();
      send({
        id,
        operation: "begin",
        url: address.href,
        name: name || "download",
      });
      if ((await acknowledgement) !== "ready") return;
      let received = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        received += part.value.byteLength;
        if (received > 512 * 1024 * 1024)
          throw new Error("Download exceeds the size limit.");
        for (let offset = 0; offset < part.value.length; offset += 32_768) {
          acknowledgement = wait();
          send({
            id,
            operation: "chunk",
            data: btoa(
              String.fromCharCode(
                ...part.value.subarray(offset, offset + 32_768),
              ),
            ),
          });
          if ((await acknowledgement) !== "continue") return;
        }
      }
      send({ id, operation: "complete" });
    } catch (error) {
      send({
        id,
        operation: "error",
        reason:
          error.message === "Download exceeds the size limit."
            ? "size"
            : "network",
      });
    } finally {
      try {
        await reader?.cancel();
      } catch {
        send({ id, operation: "error" });
      }
      receive = undefined;
      downloading = false;
    }
  }
  document.addEventListener(
    "click",
    async (event) => {
      const link =
        event.target instanceof Element
          ? event.target.closest("a[download]")
          : null;
      if (!link) return;
      const address = new URL(link.href);
      if (
        address.origin !== location.origin ||
        !["https:", "blob:"].includes(address.protocol)
      )
        return;
      event.preventDefault();
      await downloadTransfer(address, link.download);
    },
    true,
  );
})();
