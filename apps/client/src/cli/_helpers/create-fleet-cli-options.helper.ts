import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import type { CliTokenValues } from "./cli-token-options.js";
import { FLEET_ACTIONS } from "./cli-args-constants.js";
import type { FleetCliAction, FleetCliOptions } from "./cli-args-types.js";
import { fail } from "./parse-cli-primitive.helper.js";

export const createFleetCliOptions = ({
  rest,
  quickRunRequested,
  rawTask,
  values,
  runtimeOverridesProvided,
}: {
  rest: string[];
  quickRunRequested: boolean;
  rawTask: string | undefined;
  values:
    | Partial<
        Pick<CliTokenValues, "manager-url" | "enrollment-key" | "display-name">
      >
    | undefined;
  runtimeOverridesProvided: boolean;
}): FleetCliOptions => {
  const rawFleetManagerUrl = normalizeOptionalString(values?.["manager-url"]);
  const rawFleetEnrollmentKey = normalizeOptionalString(
    values?.["enrollment-key"],
  );
  const rawFleetDisplayName = normalizeOptionalString(values?.["display-name"]);
  if (quickRunRequested || rawTask) {
    fail("`machdoch fleet` cannot be combined with --quick or --task.");
  }
  const [rawAction, ...extraPositionals] = rest;
  const actionText = normalizeOptionalString(rawAction) ?? "status";
  if (!FLEET_ACTIONS.has(actionText as FleetCliAction)) {
    fail(
      `Expected \`machdoch fleet\` action to be one of ${Array.from(
        FLEET_ACTIONS,
      ).join(", ")}.`,
    );
  }
  const serviceAction =
    actionText === "service" ? (extraPositionals[0] ?? "run") : undefined;
  if (
    serviceAction &&
    ![
      "run",
      "install",
      "uninstall",
      "start",
      "stop",
      "restart",
      "status",
      "unit",
    ].includes(serviceAction)
  ) {
    fail(
      "Expected `fleet service` action to be run, install, uninstall, start, stop, restart, status, or unit.",
    );
  }
  if (extraPositionals.length > (actionText === "service" ? 1 : 0)) {
    fail(
      `Command \`fleet ${actionText}\` has unexpected positional arguments: ${extraPositionals.join(" ")}`,
    );
  }
  if (runtimeOverridesProvided) {
    fail("`machdoch fleet` cannot be combined with runtime override options.");
  }

  const action = actionText as FleetCliAction;
  if (action === "enroll") {
    if (!rawFleetManagerUrl) {
      fail("Expected --manager-url for `machdoch fleet enroll`.");
    }
    if (!rawFleetEnrollmentKey) {
      fail("Expected --enrollment-key for `machdoch fleet enroll`.");
    }
    if (!rawFleetDisplayName) {
      fail("Expected --display-name for `machdoch fleet enroll`.");
    }
  } else if (
    values?.["manager-url"] !== undefined ||
    values?.["enrollment-key"] !== undefined ||
    values?.["display-name"] !== undefined
  ) {
    fail(
      `Fleet enrollment options are only valid for \`machdoch fleet enroll\`.`,
    );
  }

  const fleet: FleetCliOptions = {
    action,
    ...(serviceAction
      ? {
          serviceAction: serviceAction as NonNullable<
            FleetCliOptions["serviceAction"]
          >,
        }
      : {}),
    ...(rawFleetManagerUrl ? { managerUrl: rawFleetManagerUrl } : {}),
    ...(rawFleetEnrollmentKey ? { enrollmentKey: rawFleetEnrollmentKey } : {}),
    ...(rawFleetDisplayName ? { displayName: rawFleetDisplayName } : {}),
  };
  return fleet;
};

export const validateFleetEnrollmentCommand = (
  command: string | undefined,
  values:
    | Partial<
        Pick<CliTokenValues, "manager-url" | "enrollment-key" | "display-name">
      >
    | undefined,
): void => {
  if (
    command !== "fleet" &&
    (values?.["manager-url"] !== undefined ||
      values?.["enrollment-key"] !== undefined ||
      values?.["display-name"] !== undefined)
  ) {
    fail("Fleet enrollment options require `machdoch fleet enroll`.");
  }
};
