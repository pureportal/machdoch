export function initializeInstallCommands(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-copy-command]",
  )) {
    const command = document.getElementById(button.dataset.copyCommand!)!;
    const status = button
      .closest(".install-command")!
      .querySelector<HTMLElement>(".copy-status")!;

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "";

      try {
        await navigator.clipboard.writeText(command.textContent!.trim());
        status.textContent = "Copied.";
      } catch {
        status.textContent =
          "Could not copy. Select the command and copy it manually.";
      } finally {
        button.disabled = false;
      }
    });
  }
}
