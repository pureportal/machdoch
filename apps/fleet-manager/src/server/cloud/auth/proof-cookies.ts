export const magicConfirmationCookie = "__Host-machdoch_cloud_magic";
export const ssoBrowserCookie = "__Host-machdoch_cloud_sso";
export const invitationCookie = "__Host-machdoch_cloud_invitation";

const cookies = {
  magic: { name: magicConfirmationCookie, age: 300, sameSite: "Strict" },
  sso: { name: ssoBrowserCookie, age: 600, sameSite: "Lax" },
  invitation: { name: invitationCookie, age: 900, sameSite: "Strict" },
} as const;
export function setProofCookie(
  response: Response,
  kind: keyof typeof cookies,
  value: string,
): Response {
  const cookie = cookies[kind];
  response.headers.append(
    "Set-Cookie",
    `${cookie.name}=${value}; Path=/; Max-Age=${value ? cookie.age : 0}; HttpOnly; Secure; SameSite=${cookie.sameSite}`,
  );
  return response;
}
export function clearProofCookies(response: Response): Response {
  for (const kind of ["magic", "sso", "invitation"] as const)
    setProofCookie(response, kind, "");
  return response;
}
