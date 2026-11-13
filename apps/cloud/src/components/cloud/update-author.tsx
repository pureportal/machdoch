import { Sparkles } from "lucide-react";
import type { CloudProjectUpdate } from "@/lib/cloud-project-update-contract";
import { PersonAvatar } from "./person-avatar";

export function UpdateAuthor({ update }: { update: CloudProjectUpdate }) {
  return (
    <span className="cloud-update-author">
      {update.generated ? (
        <span
          className="cloud-update-agent"
          title={`Written by Agent for ${update.author}`}
        >
          <Sparkles size={12} aria-hidden="true" />
        </span>
      ) : (
        <PersonAvatar name={update.author} className="cloud-avatar-tiny" />
      )}
      <strong>{update.generated ? "Agent" : update.author}</strong>
    </span>
  );
}
