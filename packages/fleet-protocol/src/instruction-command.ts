import type { InstructionMutationInput } from "./instruction-contract.js";

const appendInstructionOption = (
  argumentsList: string[],
  flag: string,
  value: string | number | undefined,
): void => {
  if (value === undefined) {
    return;
  }

  argumentsList.push(flag);
  argumentsList.push(String(value));
};

export const createInstructionMutationArguments = (
  input: InstructionMutationInput,
): string[] => {
  const args: string[] = [];
  switch (input.operation) {
    case "profile-create":
      args.push("profiles", "create");
      appendInstructionOption(args, "--name", input.name);
      appendInstructionOption(args, "--description", input.description);
      appendInstructionOption(args, "--prompt", input.body);
      appendInstructionOption(
        args,
        "--metadata-json",
        JSON.stringify({
          ...(input.profileId === undefined ? {} : { id: input.profileId }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.global === undefined ? {} : { global: input.global }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.match === undefined ? {} : { match: input.match }),
        }),
      );
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "profile-edit":
      args.push("profiles", "edit", input.profileId);
      appendInstructionOption(args, "--name", input.name);
      if (input.description !== undefined) {
        args.push("--description", input.description);
      }
      appendInstructionOption(args, "--prompt", input.body);
      appendInstructionOption(
        args,
        "--metadata-json",
        JSON.stringify({
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.global === undefined ? {} : { global: input.global }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.match === undefined ? {} : { match: input.match }),
        }),
      );
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "profile-duplicate":
      args.push("profiles", "duplicate", input.profileId);
      appendInstructionOption(args, "--name", input.name);
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "profile-delete":
      args.push("profiles", "delete", input.profileId);
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "workspace-configure":
      args.push("workspaces", "configure", input.root);
      appendInstructionOption(args, "--name", input.displayName);
      appendInstructionOption(
        args,
        "--metadata-json",
        JSON.stringify({
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.profileIds === undefined
            ? {}
            : { profileIds: input.profileIds }),
        }),
      );
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "workspace-relink":
      args.push("workspaces", "relink", input.workspaceId);
      appendInstructionOption(args, "--path", input.root);
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "workspace-remove":
      args.push("workspaces", "remove", input.workspaceId);
      if (input.confirmAssignedRemoval) {
        args.push("--confirm-assignment-removal");
      }
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "workspace-scope-set":
      if (input.profileIds.length === 0) {
        args.push("assignments", "remove", input.workspaceId);
      } else {
        args.push("assignments", "set", input.workspaceId);
        for (const profileId of input.profileIds) {
          appendInstructionOption(args, "--profile", profileId);
        }
      }
      appendInstructionOption(args, "--path", input.path);
      appendInstructionOption(
        args,
        "--expected-revision",
        input.expectedRevision,
      );
      break;
    case "recovery-restore":
      args.push("recovery", "restore");
      appendInstructionOption(args, "--expected-digest", input.expectedDigest);
      break;
    case "recovery-reset":
      args.push("recovery", "reset");
      appendInstructionOption(args, "--expected-digest", input.expectedDigest);
      break;
  }
  return args;
};
