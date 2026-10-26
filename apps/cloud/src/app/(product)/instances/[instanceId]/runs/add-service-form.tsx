import { Plus } from "lucide-react";
import { Field } from "@/components/field";
import { ShowMore } from "@/components/show-more";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ServiceInput {
  name: string;
  command: string;
  directory: string;
  port: string;
}

export function AddServiceForm({
  pending,
  blocked,
  servicesRunning,
  onAdd,
}: {
  pending: boolean;
  blocked: boolean;
  servicesRunning: boolean;
  onAdd: (input: ServiceInput) => Promise<boolean>;
}): React.ReactElement {
  return (
    <details className="fleet-disclosure rounded-2xl border bg-card p-5 sm:p-6">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Plus className="size-4" aria-hidden="true" />
        Add service
      </summary>
      <form
        className="mt-4 grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked) return;
          const element = event.currentTarget;
          const form = new FormData(element);
          void onAdd({
            name: String(form.get("name")),
            command: String(form.get("command")),
            directory: String(form.get("directory")),
            port: String(form.get("port")),
          }).then((saved) => {
            if (saved) element.reset();
          });
        }}
      >
        <fieldset disabled={pending} className="grid min-w-0 gap-4">
          <Field label="Name" htmlFor="service-name">
            <Input id="service-name" name="name" required maxLength={120} />
          </Field>
          <Field label="Command" htmlFor="service-command">
            <Input
              id="service-command"
              name="command"
              required
              maxLength={8000}
              className="font-mono"
            />
          </Field>
          <ShowMore>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Working directory" htmlFor="service-directory">
                <Input
                  id="service-directory"
                  name="directory"
                  defaultValue="."
                />
              </Field>
              <Field label="HTTP port" htmlFor="service-port">
                <Input
                  id="service-port"
                  name="port"
                  type="number"
                  min={1024}
                  max={65535}
                />
              </Field>
            </div>
          </ShowMore>
          {servicesRunning ? (
            <p className="text-sm text-muted-foreground">
              Stop running services before changing the configuration.
            </p>
          ) : null}
          <Button type="submit" className="w-full sm:w-fit" disabled={blocked}>
            {pending ? "Saving…" : "Save service"}
          </Button>
        </fieldset>
      </form>
    </details>
  );
}
