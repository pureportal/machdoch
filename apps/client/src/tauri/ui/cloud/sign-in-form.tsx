import { useEffect, useState, type JSX } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  cancelCloudSignIn,
  defaultCloudClientName,
  enrollCloudServer,
  signInCloudServer,
  type FleetConnectionStatus,
} from "../runtime";
import { ShowMore } from "./show-more";

const fieldClass = "h-9 border-slate-700 bg-slate-950 text-sm text-slate-100";
const labelClass = "text-xs font-medium text-slate-500";

export function CloudSignInForm({
  busy,
  onAction,
}: {
  busy: boolean;
  onAction: (action: () => Promise<FleetConnectionStatus>) => Promise<boolean>;
}): JSX.Element {
  const [managerUrl, setManagerUrl] = useState("");
  const [name, setName] = useState("");
  const [enrollmentKey, setEnrollmentKey] = useState("");
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    let active = true;
    void defaultCloudClientName()
      .then((suggested) => {
        if (active) setName((current) => current || suggested);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const ready = Boolean(managerUrl.trim() && name.trim());
  const signIn = async (): Promise<void> => {
    setWaiting(true);
    await onAction(() => signInCloudServer(managerUrl, name));
    setWaiting(false);
  };
  const enroll = async (): Promise<void> => {
    if (
      await onAction(() => enrollCloudServer(managerUrl, enrollmentKey, name))
    )
      setEnrollmentKey("");
  };
  if (waiting)
    return (
      <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <p role="status" className="text-sm text-slate-200">
          Finish signing in in your browser.
        </p>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void cancelCloudSignIn()}
            className="h-9 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void signIn();
      }}
    >
      <div className="grid gap-1">
        <label htmlFor="cloud-url" className={labelClass}>
          Cloud URL
        </label>
        <Input
          id="cloud-url"
          type="url"
          value={managerUrl}
          maxLength={2048}
          placeholder="https://"
          onChange={(event) => setManagerUrl(event.currentTarget.value)}
          required
          className={fieldClass}
        />
      </div>
      <div>
        <Button
          type="submit"
          disabled={busy || !ready}
          className="h-9 rounded-lg bg-sky-600 px-3 text-xs text-white hover:bg-sky-700"
        >
          <LogIn className="size-4" aria-hidden="true" />
          Sign in
        </Button>
      </div>
      <ShowMore>
        <div className="grid gap-1">
          <label htmlFor="fleet-instance-name" className={labelClass}>
            Client name
          </label>
          <Input
            id="fleet-instance-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            className={fieldClass}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="fleet-enrollment-key" className={labelClass}>
            Enrollment key
          </label>
          <div className="flex gap-2">
            <Input
              id="fleet-enrollment-key"
              type="password"
              autoComplete="off"
              value={enrollmentKey}
              maxLength={54}
              onChange={(event) => setEnrollmentKey(event.currentTarget.value)}
              className={fieldClass}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy || !ready || !enrollmentKey.trim()}
              onClick={() => void enroll()}
              className="h-9 shrink-0 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200"
            >
              Connect with key
            </Button>
          </div>
        </div>
      </ShowMore>
    </form>
  );
}
