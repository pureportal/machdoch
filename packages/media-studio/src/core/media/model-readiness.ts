import type {
  MediaModelDescriptor,
  MediaModelManagement,
} from "./contracts.js";

export type MediaModelReadinessIssue =
  | "lifecycle-removed"
  | "provider-unconfigured"
  | "not-installed"
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
        action:
          "Configure its provider in Settings, then refresh model readiness.",
      };
    case "not-installed":
      if (model.management.acquisition === "workspace-discovery") {
        return {
          message: `${model.displayName} is incomplete or has not finished downloading.`,
          action:
            "Complete the model package, then scan workspace models again.",
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
        action: "Browse Civitai to find a model.",
      };
    case "runtime-unavailable":
      return {
        message: `${model.displayName} is not ready to use.`,
        action: "Set up Media Studio to use local models.",
      };
  }
};
