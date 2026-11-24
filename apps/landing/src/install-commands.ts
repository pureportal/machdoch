export function initializeInstallCommands(): void {
  const container = document.querySelector<HTMLElement>(".install-commands")!;
  const { copySucceeded, copyFailed } = container.dataset;

  for (const button of container.querySelectorAll<HTMLButtonElement>(
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
        status.textContent = copySucceeded!;
      } catch {
        status.textContent = copyFailed!;
      } finally {
        button.disabled = false;
      }
    });
  }
}
