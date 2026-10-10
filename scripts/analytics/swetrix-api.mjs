export const apiBase = "https://swetrix.pureportal.io/backend";

export async function swetrixRequest(path, { method = "GET", body } = {}) {
  const apiKey = process.env.SWETRIX_API_KEY;
  if (!apiKey)
    throw new Error("Set SWETRIX_API_KEY before running this command.");
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : null;
    throw Object.assign(
      new Error(`Swetrix ${method} ${path} failed (${response.status}).`),
      { status: response.status, detail: detail?.message },
    );
  }
  if (response.status === 204) return null;
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(`Swetrix returned a non-JSON response for ${path}.`);
  return response.json();
}
