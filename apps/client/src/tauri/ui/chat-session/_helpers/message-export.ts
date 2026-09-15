import type { ChatSessionMessage } from "../../chat-session.model";

const createMessageExportElement = (bubble: HTMLElement): HTMLElement => {
  const clone = bubble.cloneNode(true) as HTMLElement;
  const markdown = clone.querySelector<HTMLElement>(".app-markdown");

  if (!markdown) {
    throw new Error(
      "The message is no longer displayed. Open it and try again.",
    );
  }

  clone.replaceChildren(markdown);
  markdown
    .querySelectorAll(
      "button:not([data-workspace-path]), [role='status'], [role='alert']",
    )
    .forEach((element) => element.remove());

  const style = getComputedStyle(bubble);
  Object.assign(clone.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${Math.ceil(bubble.getBoundingClientRect().width)}px`,
    height: "auto",
    maxHeight: "none",
    margin: "0",
    font: style.font,
    color: style.color,
    contentVisibility: "visible",
    boxShadow: "none",
  });
  clone.style.setProperty("max-width", "none", "important");
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  document.body.append(clone);
  return clone;
};

export const getMessagePlainText = (bubble: HTMLElement): string => {
  const clone = createMessageExportElement(bubble);

  try {
    clone.querySelectorAll("img").forEach((image) => {
      image.replaceWith(document.createTextNode(image.alt));
    });
    clone
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((checkbox) => {
        checkbox.replaceWith(
          document.createTextNode(checkbox.checked ? "☑ " : "☐ "),
        );
      });
    clone.querySelectorAll("li").forEach((item) => {
      const list = item.parentElement;
      const index = list ? Array.from(list.children).indexOf(item) : 0;
      const marker =
        list instanceof HTMLOListElement ? `${list.start + index}. ` : "• ";
      item.prepend(document.createTextNode(marker));
    });

    return clone.innerText.replace(/^\n+|\n+$/gu, "");
  } finally {
    clone.remove();
  }
};

export const copyMessageText = async (content: string): Promise<void> => {
  if (!navigator.clipboard?.writeText) {
    throw new Error(
      "Clipboard access is unavailable. Select the message and copy it manually.",
    );
  }

  await navigator.clipboard.writeText(content);
};

const renderMessageImage = async (bubble: HTMLElement): Promise<Blob> => {
  const clone = createMessageExportElement(bubble);

  try {
    const images = Array.from(clone.querySelectorAll("img"));
    images.forEach((image) => {
      image.loading = "eager";
    });
    const [{ toBlob }] = await Promise.all([
      import("html-to-image"),
      document.fonts.ready,
      ...images.map((image) => image.decode()),
    ]);
    const overflow = Math.max(
      0,
      ...Array.from(
        clone.querySelectorAll<HTMLElement>(
          ".app-markdown, pre, [role='region']",
        ),
        (element) => element.scrollWidth - element.clientWidth,
      ),
    );
    clone.style.width = `${Math.ceil(clone.getBoundingClientRect().width + overflow)}px`;

    const image = await toBlob(clone, {
      pixelRatio: Math.min(window.devicePixelRatio, 2),
      style: { position: "static", left: "auto", top: "auto" },
    });

    if (!image) {
      throw new Error("The message image could not be created. Try again.");
    }

    return image;
  } catch (error) {
    throw new Error(
      "The message image could not be created. Check that its images have loaded and try again.",
      { cause: error },
    );
  } finally {
    clone.remove();
  }
};

export const copyMessageImage = async (bubble: HTMLElement): Promise<void> => {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error(
      "Image copying is unavailable. Use Copy as text or Save Markdown.",
    );
  }

  const image = renderMessageImage(bubble);

  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": image }),
    ]);
  } finally {
    await image;
  }
};

export const createMessageMarkdownFileName = (
  message: ChatSessionMessage,
): string => {
  const role = message.role === "agent" ? "assistant" : "user";
  const timestamp =
    typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
      ? new Date(message.createdAt).toISOString().replace(/[:.]/g, "-")
      : null;
  const id = message.id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return `machdoch-${role}-message-${timestamp ?? (id || "message")}.md`;
};

export const saveMessageMarkdown = (
  content: string,
  fileName: string,
): void => {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");

  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
};
