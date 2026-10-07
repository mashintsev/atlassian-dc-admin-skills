/**
 * HTTP error type and error-body summarisation.
 *
 * Adapted from mcp-atlassian-for-admins (src/errors.ts, MIT); extended with
 * Confluence's `{message, reason}` bodies and admin-oriented hints per status.
 */

const ERROR_DETAIL_MAX_CHARS = 500;

/**
 * The human-readable reason from an error response body: Jira's
 * `{errorMessages, errors}` joined, Confluence's `message`, or a short plain-text
 * body. HTML error pages carry nothing useful and yield "".
 */
export function errorDetail(body: string): string {
  const text = (body ?? "").trim();
  if (!text || text.startsWith("<")) return "";
  let detail = text;
  try {
    const data = JSON.parse(text);
    const parts: string[] = [];
    if (Array.isArray(data?.errorMessages)) parts.push(...data.errorMessages.map(String));
    if (data?.errors && typeof data.errors === "object" && !Array.isArray(data.errors)) {
      for (const [k, v] of Object.entries(data.errors)) parts.push(`${k}: ${String(v)}`);
    }
    if (parts.length === 0 && typeof data?.message === "string") parts.push(data.message);
    if (parts.length === 0 && typeof data?.errorMessage === "string") parts.push(data.errorMessage);
    if (parts.length > 0) detail = parts.join("; ");
  } catch {
    // not JSON — keep the raw text
  }
  return detail.length > ERROR_DETAIL_MAX_CHARS ? `${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : detail;
}

const STATUS_HINTS: Record<number, string> = {
  401: "check the PAT or username/password",
  403: "the account needs administrator / system administrator rights, or the action requires WebSudo",
  404: "the resource does not exist or is not visible to this account",
};

/** Raised on a non-2xx response. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;

  constructor(status: number, body: string, url: string, method = "GET") {
    const detail = errorDetail(body);
    const hint = STATUS_HINTS[status];
    super(`${method} ${url} failed with HTTP ${status}${detail ? `: ${detail}` : ""}${hint ? ` (${hint})` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function isHttpStatusError(e: unknown): e is HttpStatusError {
  return e instanceof HttpStatusError;
}

/** Bad tool arguments. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** A confirmed change was sent, but reading the target back shows a different state. */
export class VerificationError extends Error {
  readonly state: unknown;
  constructor(message: string, state?: unknown) {
    super(message);
    this.name = "VerificationError";
    this.state = state;
  }
}

/** The operation cannot be performed through the API on this instance (version gate, websudo...). */
export class UnsupportedError extends Error {
  readonly details?: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "Unsupported";
    this.details = details;
  }
}

/** The account lacks a right that a check before the request established (maps to exit 3). */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDenied";
  }
}

/** Jira or Confluence answered with its login page: the token is missing, expired or rejected (exit 6). */
export class AuthenticationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationRequired";
  }
}

/** The resource needs a websudo (secure administrator) session, which token calls cannot open (exit 3). */
export class WebSudoRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSudoRequired";
  }
}

/** A proxy or gateway answered instead of the application (exit 10). */
export class UpstreamError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}
