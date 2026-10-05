export const isRalphRunOwnerAlive = (ownerId: string): boolean => {
  const match =
    /^([1-9]\d*):[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.exec(
      ownerId,
    );
  if (!match) return true;

  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid > 0xffffffff) return true;
  if (pid === process.pid) return true;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
