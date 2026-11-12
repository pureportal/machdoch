export function uploadInstructions(url: string, issueLabel: string): string {
  return [
    `Upload every file you create for ${issueLabel}, such as images, videos and documents, so it appears on the issue:`,
    "```sh",
    `curl -sS -X POST -H "Content-Type: <MIME type>" --data-binary @<file> "${url}?name=<file name>"`,
    "```",
    "The upload link is valid for 24 hours and accepts up to 50 files.",
  ].join("\n");
}
