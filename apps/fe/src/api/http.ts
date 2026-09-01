/**
 * The one fetch wrapper. Every call to the panel goes through it, so the
 * cross-cutting decisions live in one place: cookies are always sent, JSON is
 * always the content type, and a non-2xx is an exception rather than a value the
 * caller has to remember to check.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** The one an operator most needs to act on: their session lapsed. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

const request = async <T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const response = await fetch(path, {
    method,
    // The session is a cookie, and the console is same-origin with the panel in
    // production. Without this the browser sends no cookie and every call is a
    // 401 - the single most common way a console like this is quietly broken.
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const parsed: unknown = text === '' ? null : safeJson(text);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      messageOf(parsed) ?? `${method} ${path} failed (${response.status})`,
      parsed,
    );
  }
  return parsed as T;
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const messageOf = (body: unknown): string | undefined => {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ['error', 'message']) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return undefined;
};

export const http = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>('PUT', path, body),
  del: <T>(path: string): Promise<T> => request<T>('DELETE', path),
};
