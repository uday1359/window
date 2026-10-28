/**
 * Every request goes to the NestJS API with the session cookie. State-changing requests
 * carry the CSRF header the server requires. Identity, roles and permissions always come
 * from the server; nothing the browser claims is trusted.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T>(method: Method, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-winagent-csrf': '1' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the WinAgent server. Check that it is running.', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: string | string[]; issues?: Array<{ path: string; message: string }> };
    const message = Array.isArray(d.message) ? d.message.join('; ') : d.message ?? `Request failed (${res.status})`;
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') window.dispatchEvent(new Event('winagent:unauthorized'));
    throw new ApiError(message, res.status, d.issues ?? []);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', path, body ?? {}, headers);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});
export const del = <T>(path: string) => api<T>('DELETE', path);

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const details = err.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    return details ? `${err.message}: ${details}` : err.message;
  }
  return 'Something went wrong. Please try again.';
}

/** Random idempotency key so a double-click or retry never creates two tasks. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
