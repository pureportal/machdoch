import { expect, it } from "vitest";
import { sortDevices, type ClientDevice } from "./use-client-devices";

it("lists online clients first by name and hides revoked ones", () => {
  const device = (
    displayName: string,
    status: ClientDevice["status"],
  ): ClientDevice => ({ instanceId: displayName, displayName, status });
  expect(
    sortDevices([
      device("Laptop 10", "offline"),
      device("Laptop 2", "online"),
      device("Build box", "revoked"),
      device("Laptop 9", "online"),
      device("Desk", "offline"),
    ]).map((entry) => entry.displayName),
  ).toEqual(["Laptop 2", "Laptop 9", "Desk", "Laptop 10"]);
});
