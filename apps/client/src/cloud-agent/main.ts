import { loadRuntimeConfig } from "../core/config.js";
import { discoverCustomizations } from "../core/customizations.js";
import { executeTask } from "../core/execution.js";
import { withProviderAdapterFactory } from "../core/_helpers/provider-adapters.js";
import { CloudAgentChannel } from "../core/cloud/agent-channel.js";
import { CloudAgentModelAdapter } from "../core/cloud/model-adapter.js";
import { withAgentToolPolicy } from "../core/_helpers/agent-tool-policy.js";
import { cloudTaskToolPolicy } from "../core/cloud/tool-policy.js";
import { join } from "node:path";
import { withWorkspaceRuntimeStorage } from "../core/workspace-runtime-storage.js";

async function main(): Promise<void> {
  const stateDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;
  if (!stateDirectory)
    throw new Error("The cloud agent requires its private runtime directory.");
  return withWorkspaceRuntimeStorage(
    process.cwd(),
    join(stateDirectory, "workspace"),
    async () => {
      const channel = new CloudAgentChannel();
      try {
        const input = await channel.start;
        const config = await loadRuntimeConfig(
          process.cwd(),
          "machdoch",
          input.model,
          input.provider,
        );
        config.offline = false;
        config.reasoningMode = "standard";
        config.reviewModel = { mode: "base" };
        config.internalTaskModel = {
          provider: input.provider,
          model: input.model,
          reasoning: config.reasoning,
        };
        config.providerAvailability = config.providerAvailability.map(
          (entry) => ({
            ...entry,
            configured: entry.provider === input.provider,
          }),
        );
        const customizations = await discoverCustomizations(
          config.workspaceRoot,
          {
            discoverGithubCustomizations:
              config.compatibility.discoverGithubCustomizations === true,
          },
        );
        const result = await withAgentToolPolicy(cloudTaskToolPolicy, () =>
          withProviderAdapterFactory(
            (requested) => {
              if (
                requested.provider !== input.provider ||
                requested.model !== input.model
              )
                throw new Error(
                  "The requested provider differs from the cloud task grant.",
                );
              return new CloudAgentModelAdapter(
                input.model,
                input.contextLimitBytes,
                (request, signal) => channel.inference(request, signal),
              );
            },
            () =>
              executeTask(input.task, config, customizations, {
                signal: channel.signal,
                maxDurationMs: input.durationMs,
                idleTimeoutMs: null,
                onStateChange: (progress) =>
                  channel.send({ kind: "progress", state: progress.state }),
              }),
          ),
        );
        await channel.send({
          kind: "complete",
          status: result.status,
          summary: result.summary.slice(0, 8192),
          reason: result.reason?.slice(0, 8192) ?? null,
          executedTools: result.executedTools,
        });
      } finally {
        channel.close();
      }
    },
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Cloud agent failed."}\n`,
  );
  process.exitCode = 1;
});
