import { KeyRound } from "lucide-react";
import { CopyField } from "@/components/copy-field";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import type { useEnrollmentKeys } from "./use-enrollment-keys";

export function EnrollmentKeyForm({
  enrollment,
}: {
  enrollment: ReturnType<typeof useEnrollmentKeys>;
}): React.ReactElement {
  const { grant, error, pending, revoking, create } = enrollment;
  return (
    <div className="grid gap-5">
      {grant ? (
        <>
          <p className="text-sm text-muted-foreground">
            Enter the URL and key in the device’s Fleet Manager settings.
          </p>
          <CopyField label="Fleet Manager URL" value={grant.managerUrl} />
          <CopyField
            label="Enrollment key"
            value={grant.enrollmentKey}
            monospace
          />
          <div className="grid gap-1 text-xs text-muted-foreground">
            <p>Expires {formatTime(grant.expiresAt)}.</p>
            <p>Copy the key before leaving. It is shown only once.</p>
          </div>
        </>
      ) : null}
      <Button
        className="w-fit"
        variant={grant ? "outline" : "default"}
        disabled={pending || revoking !== null}
        onClick={() => void create()}
      >
        <KeyRound />
        {pending
          ? "Creating…"
          : grant
            ? "Create another key"
            : "Create enrollment key"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
