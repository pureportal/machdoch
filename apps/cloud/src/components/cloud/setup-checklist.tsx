import Link from "next/link";
import { Check } from "lucide-react";
import type { SetupStep } from "@/lib/setup-checklist";
import { Button } from "@/components/ui/button";

export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  if (!steps.length)
    return (
      <div className="cloud-empty">
        <p>Nothing to set up.</p>
      </div>
    );
  const next = steps.find((step) => !step.done);
  const completed = steps.filter((step) => step.done).length;
  return (
    <div className="cloud-settings">
      <section
        className="cloud-settings-section"
        aria-label={`${completed} of ${steps.length} done`}
      >
        <ol className="cloud-setup-steps">
          {steps.map((step, index) => (
            <li key={step.id} data-done={step.done ? "" : undefined}>
              <span className="cloud-setup-marker" aria-hidden="true">
                {step.done ? <Check size={14} strokeWidth={2.4} /> : index + 1}
              </span>
              {step.done ? (
                <Link className="cloud-setup-label" href={step.href}>
                  {step.label}
                  <span className="sr-only"> (done)</span>
                </Link>
              ) : (
                <>
                  <span className="cloud-setup-label">{step.label}</span>
                  <Button
                    asChild
                    size="sm"
                    variant={step === next ? "default" : "outline"}
                  >
                    <Link href={step.href}>{step.action}</Link>
                  </Button>
                </>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
