export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A failed Jira request. `status` is 0 for network failures. Never carries credentials. */
export class JiraError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(message: string, details: { status: number; method: string; path: string }) {
    super(message);
    this.name = 'JiraError';
    this.status = details.status;
    this.method = details.method;
    this.path = details.path;
  }
}

const MAX_DETAIL_CHARS = 300;

/** Thin Jira Cloud REST client with basic auth and credential-safe errors. */
export class JiraClient {
  readonly baseUrl: string;
  private readonly authorization: string;
  private readonly secrets: string[];
  private readonly fetchFn: typeof fetch;

  constructor(options: JiraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const encoded = Buffer.from(`${options.email}:${options.apiToken}`).toString('base64');
    this.authorization = `Basic ${encoded}`;
    this.secrets = [encoded, options.apiToken, options.email].filter((secret) => secret.length > 0);
    this.fetchFn = options.fetch ?? fetch;
  }

  async getJson<T>(path: string): Promise<T> {
    const response = await this.request('GET', path, { headers: { Accept: 'application/json' } });
    return (await response.json()) as T;
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request('POST', path, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const textBody = await response.text();
    return (textBody ? JSON.parse(textBody) : undefined) as T;
  }

  /** Posts multipart form data (e.g. attachments). Jira requires the XSRF bypass header. */
  async postMultipart(path: string, form: FormData): Promise<void> {
    await this.request('POST', path, {
      headers: { Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
      body: form,
    });
  }

  private async request(method: string, path: string, init: { headers: Record<string, string>; body?: RequestInit['body'] }) {
    const details = { method, path: path.split('?')[0] ?? path };
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { ...init.headers, Authorization: this.authorization },
        ...(init.body == null ? {} : { body: init.body }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new JiraError(this.scrub(`Jira request ${method} ${details.path} failed: ${reason}`), {
        ...details,
        status: 0,
      });
    }
    if (!response.ok) {
      const detail = await this.describeBody(response);
      throw new JiraError(
        this.scrub(`Jira request ${method} ${details.path} returned ${response.status}${detail ? `: ${detail}` : ''}`),
        { ...details, status: response.status },
      );
    }
    return response;
  }

  private async describeBody(response: Response): Promise<string> {
    const raw = await response.text().catch(() => '');
    try {
      const parsed = JSON.parse(raw) as { errorMessages?: unknown; errors?: unknown };
      const messages = [
        ...(Array.isArray(parsed.errorMessages) ? parsed.errorMessages.map(String) : []),
        ...(parsed.errors && typeof parsed.errors === 'object' ? Object.values(parsed.errors).map(String) : []),
      ];
      if (messages.length > 0) return messages.join('; ').slice(0, MAX_DETAIL_CHARS);
    } catch {
      // Not JSON: fall through to the raw text.
    }
    return raw.slice(0, MAX_DETAIL_CHARS);
  }

  private scrub(message: string): string {
    return this.secrets.reduce((current, secret) => current.split(secret).join('***'), message);
  }
}
