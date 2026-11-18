"use client";

import { useState } from "react";
import {
  sandboxArtifactNames,
  type ExecutionSandbox,
  type SandboxArtifactName,
} from "@machdoch/fleet-protocol/cloud-sandbox";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest, formText } from "./api-client";

const artifactLabels: Record<SandboxArtifactName, string> = {
  supervisor: "Supervisor",
  qemu: "QEMU",
  kernel: "Kernel",
  initramfs: "Initramfs",
  image: "Disk image",
};

export function ExecutionSandboxSettings({
  sandbox,
  onSaved,
}: {
  sandbox: ExecutionSandbox;
  onSaved: (sandbox: ExecutionSandbox) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="cloud-settings-section mt-8">
      <header>
        <h2>Sandbox on this server</h2>
      </header>
      <form
        className="grid max-w-3xl gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setPending(true);
          try {
            const result = await cloudRequest<{ sandbox: ExecutionSandbox }>(
              "execution-sandbox",
              {
                method: "POST",
                body: {
                  cgroupRoot:
                    sandbox.backend === "kvm"
                      ? formText(form, "cgroupRoot")
                      : null,
                  artifacts: Object.fromEntries(
                    sandboxArtifactNames.map((name) => [
                      name,
                      formText(form, name),
                    ]),
                  ),
                },
              },
            );
            setError("");
            onSaved(result.sandbox);
          } catch (reason) {
            setError((reason as Error).message);
          } finally {
            setPending(false);
          }
        }}
      >
        {sandboxArtifactNames.map((name) => (
          <Field
            key={name}
            label={artifactLabels[name]}
            htmlFor={`sandbox-${name}`}
          >
            <Input
              id={`sandbox-${name}`}
              name={name}
              required
              maxLength={1000}
              defaultValue={sandbox.artifacts[name]}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ))}
        {sandbox.backend === "kvm" && (
          <Field label="Cgroup" htmlFor="sandbox-cgroup">
            <Input
              id="sandbox-cgroup"
              name="cgroupRoot"
              required
              maxLength={1000}
              defaultValue={sandbox.cgroupRoot ?? ""}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
        <div className="cloud-editor-actions">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : sandbox.savedAt ? "Save" : "Use sandbox"}
          </Button>
        </div>
      </form>
    </section>
  );
}
