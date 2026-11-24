import { cloudId, type CloudActor } from "../../lib/cloud-contract";
import {
  chatTargetSchema,
  notificationPreferenceUpdateSchema,
  notificationScheduleSchema,
  pushSubscriptionSchema,
} from "../../lib/notification-preferences";
import { CloudError } from "./access";
import { readBody } from "./request-body";
import type { CloudRuntime } from "./runtime";

export async function handleNotificationSettingsApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
  path: string[],
): Promise<Response> {
  const settings = runtime.notifications.settings;
  const route = `${request.method} ${path.slice(1, 2).join("/")}`;
  if (path.length === 1 && request.method === "GET")
    return Response.json(await settings.get(actor));
  if (path.length === 2) {
    if (route === "PUT preferences")
      await settings.setPreference(
        actor,
        await readBody(request, notificationPreferenceUpdateSchema),
      );
    else if (route === "PUT schedule")
      await settings.setSchedule(
        actor,
        await readBody(request, notificationScheduleSchema),
      );
    else if (route === "PUT chat")
      await settings.setChatTarget(
        actor,
        (await readBody(request, chatTargetSchema)).url,
      );
    else if (route === "GET push-key")
      return Response.json(await settings.pushKey(actor));
    else if (route === "POST devices")
      return Response.json(
        await settings.addDevice(
          actor,
          await readBody(request, pushSubscriptionSchema),
        ),
        { status: 201 },
      );
    else return notFound();
    return Response.json(await settings.get(actor));
  }
  if (path.length === 3 && route === "DELETE devices") {
    await settings.removeDevice(actor, cloudId.parse(path[2]));
    return Response.json(await settings.get(actor));
  }
  return notFound();
}

function notFound(): never {
  throw new CloudError(
    404,
    "not_found",
    "This notification settings endpoint does not exist.",
  );
}
