export function providerSecretContext(
  organizationId: string,
  providerId: string,
  kind: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      organizationId: organizationId.toLowerCase(),
      providerId: providerId.toLowerCase(),
      kind,
    }),
  );
}
