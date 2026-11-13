"use client";

import { useEffect, useState } from "react";
import type {
  GitAvailableRepository,
  GitConnection,
} from "@/lib/cloud-git-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Select } from "@/components/ui/select";
import { cloudRequest, formText } from "./api-client";

export function GitRepositoryPicker({
  connection,
  open,
  onOpenChange,
  onAdded,
}: {
  connection: GitConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => Promise<void>;
}) {
  const [available, setAvailable] = useState<GitAvailableRepository[] | null>(
    null,
  );
  const [error, setError] = useState("");
  const provider = connection.provider;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setAvailable(null);
    setError("");
    cloudRequest<{ repositories: GitAvailableRepository[] }>(
      `git/${provider}/repositories/available`,
      { signal: abort.signal },
    )
      .then((result) => {
        if (!abort.signal.aborted) setAvailable(result.repositories);
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      });
    return () => abort.abort();
  }, [open, provider]);
  const added = new Set(
    connection.repositories.map((repository) =>
      repository.fullName.toLowerCase(),
    ),
  );
  const options =
    available?.filter(
      (repository) => !added.has(repository.fullName.toLowerCase()),
    ) ?? [];
  const id = `${provider}-repository`;
  return (
    <FormDialog
      title="Add repository"
      submitLabel="Add repository"
      open={open}
      onOpenChange={onOpenChange}
      submitDisabled={!options.length}
      onSubmit={async (form) => {
        await cloudRequest(`git/${provider}/repositories`, {
          method: "POST",
          body: { fullName: formText(form, "fullName") },
        });
        await onAdded();
      }}
    >
      {error ? (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      ) : available && !options.length ? (
        <p>No other repository is available to this token.</p>
      ) : (
        <Field label="Repository" htmlFor={id}>
          <Select id={id} name="fullName" required disabled={!available}>
            {available ? (
              options.map((repository) => (
                <option key={repository.fullName} value={repository.fullName}>
                  {repository.fullName}
                </option>
              ))
            ) : (
              <option>Loading…</option>
            )}
          </Select>
        </Field>
      )}
    </FormDialog>
  );
}
