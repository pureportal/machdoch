import { z } from "zod";
import type { AgentModelImageMediaType } from "@machdoch/model-runtime/types";
import { maximumModelImageBytes } from "../../../lib/cloud-attachment-contract";
import { agentTool, type AgentTool } from "./agent-tool";

const maximumViewedImages = 4;
const documentCharacters = 12_000;

export const attachmentTools: AgentTool[] = [
  agentTool({
    name: "view_attachment",
    description:
      "Open a file attached to an issue or to this conversation by its attachment ID. An image is shown to you with your next step; a text document returns its content.",
    schema: z.strictObject({ attachment: z.uuid() }),
    async run(session, input) {
      const { attachment, bytes } = await session.services.attachments.bytes(
        session.actor,
        input.attachment,
      );
      const file = {
        attachment: attachment.id,
        name: attachment.name,
        kind: attachment.kind,
        url: attachment.url,
      };
      if (attachment.kind === "image") {
        const path = `${attachment.name} (attachment ${attachment.id})`;
        if (session.viewedImages.some((image) => image.path === path))
          return {
            output: { ...file, note: "This image is already shown to you." },
            label: `Viewed ${attachment.name}`,
          };
        if (bytes.length > maximumModelImageBytes)
          return {
            output: { ...file, note: "This image is too large to view." },
            label: `Skipped ${attachment.name}`,
          };
        if (session.viewedImages.length >= maximumViewedImages)
          return {
            output: {
              ...file,
              note: `You can view up to ${maximumViewedImages} images per answer.`,
            },
            label: `Skipped ${attachment.name}`,
          };
        session.viewedImages.push({
          path,
          mediaType: attachment.mime as AgentModelImageMediaType,
          data: bytes.toString("base64"),
        });
        return {
          output: {
            ...file,
            width: attachment.width,
            height: attachment.height,
            note: `The image is included after the request images as image ${session.viewedImages.length} of the viewed images.`,
          },
          label: `Viewed ${attachment.name}`,
        };
      }
      if (attachment.kind === "document") {
        const text = new TextDecoder().decode(bytes);
        return {
          output: {
            ...file,
            content: text.slice(0, documentCharacters),
            truncated: text.length > documentCharacters,
          },
          label: `Read ${attachment.name}`,
        };
      }
      return {
        output: {
          ...file,
          note: "This file type cannot be read. Refer to it by name or link.",
        },
        label: `Checked ${attachment.name}`,
      };
    },
  }),
];
