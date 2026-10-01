import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type {
  EncryptedSettingsFileImportReview,
  SettingsCategoryId,
  SettingsTransferCategory,
  SettingsTransferStatus,
} from "../../shared/settings-transfer.js";
import type { InteractivePrompter } from "./cli-prompter.js";
import { requestDesktopSettings } from "./cli-desktop-config.js";
import { InteractiveInputCancelledError } from "./cli-interactive-commands.js";

const chooseCategories = async (
  prompter: InteractivePrompter,
  categories: SettingsTransferCategory[],
): Promise<SettingsCategoryId[] | undefined> => {
  const selected = new Set(
    categories
      .filter(
        (category) =>
          category.defaultSelected && category.availability !== "unavailable",
      )
      .map((category) => category.id),
  );
  while (true) {
    const value = await prompter.select("Transfer categories", [
      ...categories.map((category) => ({
        value: category.id,
        label: `${selected.has(category.id) ? "[x]" : "[ ]"} ${category.label}`,
      })),
      { value: "__continue", label: "Continue" },
    ]);
    if (!value) return undefined;
    if (value === "__continue") {
      if (selected.size) return [...selected];
      prompter.status("Choose at least one category.", "error");
      continue;
    }
    const category = categories.find((category) => category.id === value)!;
    if (category.availability === "unavailable") {
      prompter.status(
        category.reason ?? "This category is unavailable.",
        "error",
      );
      continue;
    }
    if (selected.has(category.id)) selected.delete(category.id);
    else selected.add(category.id);
  }
};

const confirmReview = async (
  prompter: InteractivePrompter,
  categories: SettingsTransferCategory[],
): Promise<boolean> => {
  const replacements = categories.filter(
    (category) => category.effect === "replace" || category.effect === "clear",
  );
  if (!replacements.length) {
    prompter.status("No settings to import.");
    return false;
  }
  return (
    (await prompter.select(
      "Replace local settings?",
      [
        { value: "cancel", label: "Cancel" },
        { value: "apply", label: "Replace settings" },
      ],
      {
        hint: replacements
          .map(
            (category) =>
              `${category.label}: ${category.effect === "clear" ? "clear" : `${category.itemCount} incoming items`}`,
          )
          .join("\n"),
      },
    )) === "apply"
  );
};

const transferFile = async (
  prompter: InteractivePrompter,
  workspaceRoot: string,
  action: "export" | "import",
  categories: SettingsCategoryId[],
  request: typeof requestDesktopSettings,
): Promise<void> => {
  const enteredPath = await prompter.input(
    action === "export" ? "Export file" : "Import file",
    { hint: "File path (.machdoch-settings)" },
  );
  if (!enteredPath) return;
  const path = resolve(workspaceRoot, enteredPath);
  if (action === "export") {
    try {
      await stat(path);
      if (
        (await prompter.select("Replace this file?", [
          { value: "no", label: "Keep file" },
          { value: "yes", label: "Replace file" },
        ])) !== "yes"
      )
        return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const passphrase = await prompter.input("Passphrase", {
    secret: true,
    ...(action === "export" ? { hint: "At least 12 characters" } : {}),
  });
  if (!passphrase) return;
  if (action === "export") {
    const confirmation = await prompter.input("Confirm passphrase", {
      secret: true,
    });
    if (confirmation !== passphrase) {
      prompter.status("Passphrases do not match. Try again.", "error");
      return;
    }
    await request("transfer", "export", {
      categories,
      destinationPath: path,
      passphrase,
    });
    prompter.status("Settings exported.");
    return;
  }
  const operationId = randomUUID();
  try {
    const review = (await request("transfer", "inspect", {
      operationId,
      categories,
      sourcePath: path,
      passphrase,
    })) as EncryptedSettingsFileImportReview;
    if (review.token && (await confirmReview(prompter, review.categories))) {
      await request("transfer", "commit", { token: review.token });
      prompter.status("Settings imported.");
    }
  } finally {
    await request("transfer", "cancel", { operationId });
  }
};

export const runConfigTransfer = async (
  prompter: InteractivePrompter,
  workspaceRoot: string,
  request = requestDesktopSettings,
): Promise<void> => {
  while (true) {
    const status = (await request(
      "transfer",
      "status",
    )) as SettingsTransferStatus;
    const active = !["idle", "completed", "cancelled", "failed"].includes(
      status.phase,
    );
    const action = await prompter.select(
      `Transfer · ${status.phase}`,
      active
        ? [
            ...(status.phase === "discovering"
              ? [{ value: "connect", label: "Connect to sender" }]
              : []),
            ...(status.phase === "advertising"
              ? [{ value: "code", label: "Show connection code" }]
              : []),
            ...(status.phase === "pairing"
              ? [{ value: "pair", label: "Confirm pairing" }]
              : []),
            ...(status.phase === "review"
              ? [{ value: "approve", label: "Review settings" }]
              : []),
            { value: "refresh", label: "Refresh status" },
            { value: "stop", label: "Stop transfer" },
          ]
        : [
            { value: "send", label: "Send to another computer" },
            { value: "receive", label: "Receive from another computer" },
            { value: "export", label: "Export encrypted file" },
            { value: "import", label: "Import encrypted file" },
          ],
      status.message ? { hint: status.message } : undefined,
    );
    if (!action) return;
    try {
      if (["send", "receive", "export", "import"].includes(action)) {
        const catalog = (await request(
          "transfer",
          "catalog",
        )) as SettingsTransferStatus;
        const categories = await chooseCategories(prompter, catalog.categories);
        if (!categories) continue;
        if (action === "export" || action === "import")
          await transferFile(
            prompter,
            workspaceRoot,
            action,
            categories,
            request,
          );
        else {
          const interfaces = await prompter.select("Network interface", [
            { value: "__auto", label: "Automatic" },
            ...catalog.networkInterfaces.map((entry) => ({
              value: entry.id,
              label: `${entry.name} ${entry.addresses.join(", ")}`,
            })),
          ]);
          if (interfaces)
            await request("transfer", action, {
              categories,
              displayName: hostname(),
              interfaceIds: interfaces === "__auto" ? [] : [interfaces],
            });
        }
      } else if (action === "connect") {
        const session = await prompter.select("Sender", [
          ...status.discoveredSessions.map((entry) => ({
            value: entry.id,
            label: entry.label,
          })),
          { value: "__manual", label: "Enter connection code" },
        ]);
        if (session === "__manual") {
          const manualCode = await prompter.input("Connection code");
          if (manualCode)
            await request("transfer", "connect", {
              discoveredId: null,
              manualCode,
            });
        } else if (session)
          await request("transfer", "connect", {
            discoveredId: session,
            manualCode: null,
          });
      } else if (action === "pair") {
        if (
          (await prompter.select(
            `Code ${status.pairingCode ?? ""} matches on both computers?`,
            [
              { value: "no", label: "Cancel pairing" },
              { value: "yes", label: "Codes match" },
            ],
          )) === "yes"
        )
          await request("transfer", "pair");
        else await request("transfer", "stop");
      } else if (action === "approve") {
        const approved =
          status.mode === "send"
            ? (await prompter.select(
                "Send these settings?",
                [
                  { value: "no", label: "Cancel" },
                  { value: "yes", label: "Send settings" },
                ],
                {
                  hint: status.categories
                    .filter((category) =>
                      status.effectiveCategories.includes(category.id),
                    )
                    .map((category) => category.label)
                    .join("\n"),
                },
              )) === "yes"
            : await confirmReview(prompter, status.categories);
        if (approved) await request("transfer", "approve");
      } else if (action === "stop") await request("transfer", "stop");
      else if (action === "code")
        prompter.status(status.manualCode ?? "Connection code is not ready.");
    } catch (error) {
      if (error instanceof InteractiveInputCancelledError) throw error;
      prompter.status(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }
};
