"use client";

import { Laptop } from "lucide-react";
import { useState } from "react";
import { CopyField } from "@/components/copy-field";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { ReleaseCaptureBrief } from "@/lib/cloud-release-contract";
import { cloudRequest } from "./api-client";
import { ClientLaunch } from "./client-launch";
import type { StudioContext } from "./release-studio";
import { useToast } from "./toast";

export function ReleaseCaptureDialog({
  context,
  onClose,
}: {
  context: StudioContext;
  onClose: () => void;
}) {
  const { release, product } = context;
  const toast = useToast();
  const [shots, setShots] = useState(
    (release.highlights.length
      ? release.highlights.map((entry) => entry.title)
      : release.items
          .filter((item) => item.included)
          .slice(0, 4)
          .map((item) => item.title)
    ).join("\n"),
  );
  const [brief, setBrief] = useState<ReleaseCaptureBrief | null>(null);
  const [pending, setPending] = useState(false);
  const list = shots
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (brief) void context.refresh();
        onClose();
      }}
    >
      <DialogContent className="max-w-2xl" aria-describedby={undefined}>
        <DialogTitle>Capture in sandbox</DialogTitle>
        {!brief ? (
          <>
            <Field label="Shots, one per line" htmlFor="capture-shots">
              <Textarea
                id="capture-shots"
                rows={7}
                value={shots}
                onChange={(event) => setShots(event.target.value)}
              />
            </Field>
            {!product.captureBrief && (
              <p className="text-sm text-muted-foreground">
                Describe how to run {product.name} with mock data in the product
                settings to guide the agent.
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={!list.length || pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    setBrief(
                      await cloudRequest<ReleaseCaptureBrief>(
                        `releases/${release.id}/capture`,
                        {
                          method: "POST",
                          body: { shots: list },
                        },
                      ),
                    );
                  } catch (reason) {
                    toast(
                      reason instanceof Error ? reason.message : "Try again.",
                      "error",
                    );
                  } finally {
                    setPending(false);
                  }
                }}
              >
                Create brief
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Field label="Brief for the agent" htmlFor="capture-brief">
              <Textarea
                id="capture-brief"
                rows={12}
                readOnly
                value={brief.prompt}
                className="font-mono text-xs"
              />
            </Field>
            <CopyField label="Upload link" value={brief.uploadUrl} monospace />
            <p className="text-sm text-muted-foreground">
              Uploads appear in Media. The link expires{" "}
              {new Date(brief.expiresAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              .
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(brief.prompt)
                    .then(() => toast("Brief copied"))
                    .catch(() => toast("Copy failed", "error"))
                }
              >
                Copy brief
              </Button>
              <ClientLaunch
                label="Start on a client"
                icon={<Laptop />}
                variant="outline"
                branch={`release-media/${product.key}-${release.version}`.replace(
                  /[^A-Za-z0-9/._-]/g,
                  "-",
                )}
                draft={() => ({
                  title: `Capture ${product.name} ${release.version}`,
                  prompt: brief.prompt,
                })}
              />
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
