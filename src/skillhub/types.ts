import type { Platform } from "../domain/types.js";
import type {
  SkillHubDeletedSkillPolicy,
  SkillHubNewSkillPolicy,
  SkillHubSelection,
  SkillHubUpdatePolicy,
} from "../project/config.js";

export type TokenSource = "flag" | "env" | "ticiou-store" | "prompt" | "anonymous";

export interface ResolvedToken {
  token?: string;
  source: TokenSource;
  persistent: boolean;
}

export interface SkillHubCommandAuthOptions {
  registry?: string;
  token?: string;
  askToken?: boolean;
  anonymous?: boolean;
}

export interface WhoAmIResponse {
  handle: string;
  displayName: string;
  email?: string;
}

export interface SearchItem {
  namespace: string;
  slug: string;
  latestVersion?: string;
  summary?: string;
}

export interface SearchResponse {
  items: SearchItem[];
  total: number;
  limit: number;
}

export interface DiscoverItem {
  namespace: string;
  slug: string;
  displayName?: string;
  summary?: string;
  ownerId?: string;
  ownerDisplayName?: string;
  visibility?: SkillVisibility;
  status?: string;
  publishedVersion?: string;
  publishedVersionId?: number;
  fingerprint?: string;
  labels?: string[];
  updatedAt?: string;
}

export interface DiscoverResponse {
  items: DiscoverItem[];
  total: number;
  page: number;
  size: number;
}

export interface DiscoverQuery {
  q?: string;
  namespace?: string;
  owner?: string;
  ownerId?: string;
  label?: string;
  visibility?: SkillVisibility;
  page?: number;
  size?: number;
  sort?: string;
}

export interface ResolveResponse {
  namespace: string;
  slug: string;
  version: string;
  versionId: number;
  fingerprint: string;
  downloadUrl: string;
}

export type SkillVisibility = "PUBLIC" | "NAMESPACE_ONLY" | "PRIVATE";
export type SkillHubLockStatus =
  | "installed"
  | "update_available"
  | "new_remote"
  | "missing_remote"
  | "forbidden"
  | "stale_cache"
  | "disabled";

export interface SkillHubLockFile {
  version: 1;
  profile: string;
  registry: string;
  generatedAt: string;
  skills: SkillHubLockEntry[];
}

export interface SkillHubLockEntry {
  namespace: string;
  slug: string;
  selector?: SkillHubSelection;
  version: string;
  versionId?: number;
  fingerprint: string;
  visibility?: SkillVisibility;
  installTargets: SkillHubInstallTarget[];
  status: SkillHubLockStatus;
  updatedAt: string;
}

export interface SkillHubInstallTarget {
  agent: Platform;
  path: string;
}

export interface SkillHubProfileRuntimeConfig {
  registry: string;
  autoRefresh: boolean;
  backgroundCheck: boolean;
  updatePolicy: SkillHubUpdatePolicy;
  newSkillPolicy: SkillHubNewSkillPolicy;
  deletedSkillPolicy: SkillHubDeletedSkillPolicy;
  selections: SkillHubSelection[];
}

export interface SkillHubInstallResult {
  lockEntry: SkillHubLockEntry;
}

export interface SkillHubErrorDetails {
  status?: number;
  registry?: string;
  detail?: string;
  cause?: unknown;
}

export class SkillHubError extends Error {
  readonly status?: number;
  readonly registry?: string;
  readonly detail?: string;

  constructor(message: string, details: SkillHubErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = "SkillHubError";
    this.status = details.status;
    this.registry = details.registry;
    this.detail = details.detail;
  }
}
