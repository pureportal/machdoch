export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: HeadersInit,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(
      { error: error.message },
      { status: error.status, headers: error.headers },
    );
  }
  console.error(error);
  return Response.json(
    { error: "Fleet Manager is unavailable." },
    { status: 500 },
  );
}
