"use client";

import {
  RemoteProductApp,
  createFleetOperationTransport,
  type RemoteComposerProps,
  type RemoteConversationProps,
} from "@machdoch/product-ui";
import { SessionSidebarCommands } from "@machdoch/client-ui/sessions/sidebar-commands";
import { RemoteComposerHost } from "@machdoch/client-ui/composer/remote-composer-host";
import { RemoteConversationHost } from "@machdoch/client-ui/conversation/remote-conversation-host";
import { createSessionDataSource } from "@machdoch/client-ui/conversation/session-data-source";
import { createFleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import {
  ralphRequestSchema,
  workspaceRequestSchema,
} from "@machdoch/fleet-protocol";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { useMemo } from "react";
import { createInstanceRuntime } from "@/lib/instance-runtime";

export function InstanceProduct({
  instanceId,
  instanceName,
  initialSessionId,
}: {
  instanceId: string;
  instanceName: string;
  initialSessionId?: string;
}): React.ReactElement {
  const workspaceTransport = useMemo(
    () =>
      createFleetOperationTransport((request) =>
        api(
          "/api/instances/" +
            encodeURIComponent(instanceId) +
            "/product/workspace",
          {
            method: "POST",
            body: jsonBody(workspaceRequestSchema.parse(request)),
          },
        ),
      ),
    [instanceId],
  );
  const mediaTransport = useMemo(
    () =>
      createFleetMediaTransport(instanceId, (request) =>
        api(
          "/api/instances/" + encodeURIComponent(instanceId) + "/product/media",
          { method: "POST", body: jsonBody(request) },
        ),
      ),
    [instanceId],
  );
  const ralphTransport = useMemo(
    () =>
      createFleetOperationTransport((request) =>
        api(`/api/instances/${encodeURIComponent(instanceId)}/product/ralph`, {
          method: "POST",
          body: jsonBody(ralphRequestSchema.parse(request)),
        }),
      ),
    [instanceId],
  );
  const sessionData = useMemo(
    () => createSessionDataSource(workspaceTransport, mediaTransport),
    [workspaceTransport, mediaTransport],
  );
  const runtime = useMemo(
    () =>
      createInstanceRuntime(
        instanceId,
        initialSessionId,
        sessionData.composerText,
      ),
    [instanceId, initialSessionId, sessionData],
  );
  const Composer = useMemo(
    () =>
      function InstanceComposer(
        props: RemoteComposerProps,
      ): React.ReactElement {
        return (
          <RemoteComposerHost
            {...props}
            workspaceTransport={workspaceTransport}
            ralphTransport={ralphTransport}
            mediaTransport={mediaTransport}
          />
        );
      },
    [workspaceTransport, ralphTransport, mediaTransport],
  );

  const Conversation = useMemo(
    () =>
      function InstanceConversation(
        props: RemoteConversationProps,
      ): React.ReactElement {
        return (
          <RemoteConversationHost
            {...props}
            workspaceTransport={workspaceTransport}
            mediaTransport={mediaTransport}
          />
        );
      },
    [workspaceTransport, mediaTransport],
  );

  return (
    <TooltipProvider>
      <CommandProvider activeView="chat">
        <RemoteProductApp
          Composer={Composer}
          Conversation={Conversation}
          SidebarCommands={SessionSidebarCommands}
          instanceName={instanceName}
          runtime={runtime}
          sessionData={sessionData}
          {...(initialSessionId ? { initialView: "chat" } : {})}
        />
      </CommandProvider>
    </TooltipProvider>
  );
}
