import {
  getLocalMarkdownLinkTarget,
  getWorkspaceMarkdownLinkTarget,
} from "@machdoch/client-ui/conversation/workspace-markdown-links";
import { resolveLocalFilePreviewSource } from "../../local-file-runtime";
import { resolveWorkspaceFilePreviewSource } from "../../runtime";

export type MarkdownImageSourceResolver = (href: string) => Promise<string>;

export const resolveMarkdownImageSource = async (
  href: string,
  workspaceRoot: string | null | undefined,
  sourcePath?: string,
): Promise<string> => {
  const workspaceTarget = getWorkspaceMarkdownLinkTarget(
    href,
    workspaceRoot,
    sourcePath,
  );
  if (workspaceTarget && workspaceRoot) {
    return resolveWorkspaceFilePreviewSource(
      workspaceRoot,
      workspaceTarget.relativePath,
    );
  }
  const localTarget = getLocalMarkdownLinkTarget(href, sourcePath);
  if (localTarget) return resolveLocalFilePreviewSource(localTarget.path);
  throw new Error("Unable to resolve this image path.");
};
