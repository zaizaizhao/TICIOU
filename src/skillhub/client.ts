import type {
  DiscoverQuery,
  DiscoverResponse,
  ResolveResponse,
  SearchResponse,
  WhoAmIResponse,
} from "./types.js";
import { SkillHubError } from "./types.js";

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export class SkillHubClient {
  constructor(
    readonly registry: string,
    readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async whoami(): Promise<WhoAmIResponse> {
    return this.getJson("/auth/whoami");
  }

  async search(query = "", limit = 20): Promise<SearchResponse> {
    const params = new URLSearchParams();
    if (query.length > 0) {
      params.set("q", query);
    }
    params.set("limit", String(limit));
    return this.getJson(`/skills/search?${params.toString()}`);
  }

  async discover(query: DiscoverQuery): Promise<DiscoverResponse> {
    const params = new URLSearchParams();
    appendParam(params, "q", query.q);
    appendParam(params, "namespace", query.namespace);
    appendParam(params, "owner", query.owner);
    appendParam(params, "ownerId", query.ownerId);
    appendParam(params, "label", query.label);
    appendParam(params, "visibility", query.visibility);
    appendParam(params, "sort", query.sort);
    if (query.page !== undefined) {
      params.set("page", String(query.page));
    }
    if (query.size !== undefined) {
      params.set("size", String(query.size));
    }
    return this.getJson(`/skills/discover?${params.toString()}`);
  }

  async resolve(namespace: string, slug: string, version?: string): Promise<ResolveResponse> {
    const params = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
    return this.getJson(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/resolve${params}`);
  }

  async download(namespace: string, slug: string, version: string): Promise<ArrayBuffer> {
    const response = await this.request(
      `/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/versions/${encodeURIComponent(
        version,
      )}/download`,
    );

    if (response.status >= 300 && response.status < 400) {
      return this.followDownloadRedirect(response);
    }

    if (!response.ok) {
      await this.throwForResponse(response);
    }

    return response.arrayBuffer();
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    if (!response.ok) {
      await this.throwForResponse(response);
    }

    const parsed = (await response.json()) as ApiResponse<T>;
    return parsed.data;
  }

  private async request(path: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.registry}/api/cli/v1${path}`, {
        headers: this.headers(),
      });
    } catch {
      throw new SkillHubError("SkillHub registry unreachable.", { registry: this.registry });
    }
  }

  private async throwForResponse(response: Response): Promise<never> {
    if (response.status === 401) {
      throw new SkillHubError("SkillHub authentication failed.", { status: response.status, registry: this.registry });
    }
    if (response.status === 403) {
      throw new SkillHubError("SkillHub access denied.", { status: response.status, registry: this.registry });
    }
    if (response.status === 404) {
      throw new SkillHubError("SkillHub resource not found.", { status: response.status, registry: this.registry });
    }

    const text = await response.text().catch(() => "");
    throw new SkillHubError(`SkillHub request failed with status ${response.status}.`, {
      status: response.status,
      registry: this.registry,
      detail: text,
    });
  }

  private headers(): Record<string, string> {
    return this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` };
  }

  private async followDownloadRedirect(response: Response): Promise<ArrayBuffer> {
    const location = response.headers.get("location");
    if (location === null || location.length === 0) {
      throw new SkillHubError("SkillHub download redirect did not include a location.", {
        status: response.status,
        registry: this.registry,
      });
    }

    const redirectUrl = new URL(location, this.registry).toString();
    const redirectOrigin = new URL(redirectUrl).origin;
    const registryOrigin = new URL(this.registry).origin;
    let redirected: Response;
    try {
      redirected = await this.fetchImpl(redirectUrl, {
        headers: redirectOrigin === registryOrigin ? this.headers() : {},
      });
    } catch {
      throw new SkillHubError("SkillHub download redirect unreachable.", { registry: this.registry });
    }

    if (!redirected.ok) {
      await this.throwForResponse(redirected);
    }

    return redirected.arrayBuffer();
  }
}

function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    params.append(key, value);
  }
}
