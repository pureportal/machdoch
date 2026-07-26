import type {
  MediaModelDescriptor,
  MediaModelManagement,
} from "./contracts.js";

export type MediaModelReadinessIssue =
  | "lifecycle-removed"
  | "provider-unconfigured"
  | "not-installed"
  | "verification-required"
  | "verification-failed"
  | "runtime-unavailable";

export interface MediaModelReadiness {
  ready: boolean;
  issue: MediaModelReadinessIssue | null;
  management: MediaModelManagement;
}

export interface MediaModelReadinessGuidance {
  message: string;
  action: string;
}

/**
 * Readiness is model metadata, not a provider-name convention. Executors may
 * still implement family-specific loading, but model selection and UI actions
 * only depend on this capability-oriented contract.
 */
export const inspectMediaModelReadiness = (
  model: MediaModelDescriptor,
): MediaModelReadiness => {
  if (model.lifecycle === "removed") {
    return {
      ready: false,
      issue: "lifecycle-removed",
      management: model.management,
    };
  }

  if (
    model.target === "remote" ||
    model.management.acquisition === "external-runtime"
  ) {
    return {
      ready: model.configured,
      issue: model.configured ? null : "provider-unconfigured",
      management: model.management,
    };
  }

  if (!model.installed) {
    return {
      ready: false,
      issue: "not-installed",
      management: model.management,
    };
  }

  switch (model.runtimeReadiness) {
    case "unverified":
      return {
        ready: false,
        issue: "verification-required",
        management: model.management,
      };
    case "failed":
      return {
        ready: false,
        issue: "verification-failed",
        management: model.management,
      };
    case "runtime-unavailable":
      return {
        ready: false,
        issue: "runtime-unavailable",
        management: model.management,
      };
    default:
      return {
        ready: model.configured,
        issue: model.configured ? null : "provider-unconfigured",
        management: model.management,
      };
  }
};

export const isMediaModelReady = (model: MediaModelDescriptor): boolean =>
  inspectMediaModelReadiness(model).ready;

export const describeMediaModelReadiness = (
  model: MediaModelDescriptor,
): MediaModelReadinessGuidance | null => {
  const { issue } = inspectMediaModelReadiness(model);
  switch (issue) {
    case null:
      return null;
    case "lifecycle-removed":
      return {
        message: `${model.displayName} has been removed from its source catalog.`,
        action: "Choose an active compatible model.",
      };
    case "provider-unconfigured":
      return {
        message: `${model.displayName} requires a configured provider or runtime.`,
        action: "Configure its provider in Settings, then refresh model readiness.",
      };
    case "not-installed":
      if (model.management.acquisition === "workspace-discovery") {
        return {
          message: `${model.displayName} is incomplete or has not finished downloading.`,
          action: "Complete the model package, then scan workspace models again.",
        };
      }
      if (model.management.acquisition === "file-import") {
        return {
          message: `${model.displayName} is no longer available at its imported location.`,
          action: "Import the compatible model file again.",
        };
      }
      return {
        message: `${model.displayName} is not installed on this device.`,
        action: "Review the license and disk estimate, then install the model.",
      };
    case "verification-required":
      return {
        message: `${model.displayName} has not passed a clean offline runtime verification on this device.`,
        action:
          model.management.verification === "runtime-probe"
            ? "Re-probe the local runtime from Models."
            : "Open Models and run Verify model.",
      };
    case "verification-failed":
      return {
        message: `${model.displayName} failed its most recent verification.`,
        action:
          model.management.verification === "runtime-probe"
            ? "Review the runtime diagnostic and re-probe after correcting it."
            : "Review the model diagnostic and run Verify model again.",
      };
    case "runtime-unavailable":
      return {
        message: `${model.displayName} requires a compatible local runtime that is not currently available.`,
        action: "Review the runtime diagnostic and re-probe the local runtime from Models.",
      };
  }
};
