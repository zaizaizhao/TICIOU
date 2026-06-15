import { basename, join } from "node:path";

import YAML from "yaml";

import type { Platform, TargetMode } from "../domain/types.js";
import { PLATFORMS } from "../domain/types.js";
import { readTextFileIfExists, writeTextFile } from "../infra/fs.js";
import { CONFIG_PATH } from "./paths.js";

export interface TiciouConfig {
  version: 1;
  projectName: string;
  platforms: Record<Platform, PlatformConfig>;
  target: {
    default: TargetMode;
    allowGitRoot: boolean;
  };
  profiles: {
    defaultUser?: string;
    users: Record<string, ProfileConfig>;
  };
  render: {
    prefix: string;
    conflictPolicy: "fail";
    removeStale: boolean;
    legacyPackagedSkills: boolean;
  };
}

export interface PlatformConfig {
  enabled: boolean;
  scope: "project";
}

export interface ProfileConfig {
  skillhub?: SkillHubProfileConfig;
}

export interface SkillHubProfileConfig {
  registry?: string;
  autoRefresh: boolean;
  backgroundCheck: boolean;
  updatePolicy: SkillHubUpdatePolicy;
  newSkillPolicy: SkillHubNewSkillPolicy;
  deletedSkillPolicy: SkillHubDeletedSkillPolicy;
  selections: SkillHubSelection[];
}

export type SkillHubUpdatePolicy = "prompt" | "auto";
export type SkillHubNewSkillPolicy = "prompt" | "ignore" | "auto-add";
export type SkillHubDeletedSkillPolicy = "keep-cache" | "disable" | "remove";
export type SkillHubSelectionPolicy = "auto" | "prompt-new" | "pinned";

export interface SkillHubSelection {
  namespace: string;
  slug?: string;
  owner?: "self" | string;
  ownerId?: string;
  label?: string;
  version?: string;
  policy: SkillHubSelectionPolicy;
}

export function createDefaultConfig(targetRoot: string): TiciouConfig {
  return {
    version: 1,
    projectName: basename(targetRoot) || "ticiou-project",
    platforms: {
      claude: {
        enabled: false,
        scope: "project",
      },
      copilot: {
        enabled: false,
        scope: "project",
      },
    },
    target: {
      default: "cwd",
      allowGitRoot: true,
    },
    profiles: {
      defaultUser: undefined,
      users: {},
    },
    render: {
      prefix: "ticiou",
      conflictPolicy: "fail",
      removeStale: true,
      legacyPackagedSkills: true,
    },
  };
}

export async function ensureConfig(targetRoot: string): Promise<TiciouConfig> {
  const existing = await readConfig(targetRoot);
  if (existing !== undefined) {
    return existing;
  }

  const config = createDefaultConfig(targetRoot);
  await writeConfig(targetRoot, config);
  return config;
}

export async function readConfig(targetRoot: string): Promise<TiciouConfig | undefined> {
  const content = await readTextFileIfExists(join(targetRoot, CONFIG_PATH));
  if (content === undefined) {
    return undefined;
  }

  return parseConfig(content, targetRoot);
}

export async function writeConfig(targetRoot: string, config: TiciouConfig): Promise<void> {
  await writeTextFile(join(targetRoot, CONFIG_PATH), serializeConfig(config));
}

export async function setPlatformEnabled(targetRoot: string, platform: Platform, enabled: boolean): Promise<TiciouConfig> {
  const config = await ensureConfig(targetRoot);
  config.platforms[platform] = {
    enabled,
    scope: "project",
  };
  await writeConfig(targetRoot, config);
  return config;
}

export function getEnabledPlatforms(config: TiciouConfig): Platform[] {
  return PLATFORMS.filter((platform) => config.platforms[platform].enabled);
}

function parseConfig(content: string, targetRoot: string): TiciouConfig {
  const config = createDefaultConfig(targetRoot);

  const parsed = YAML.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(".ticiou/config.yaml must contain a YAML object.");
  }

  if (parsed.version !== 1) {
    throw new Error("Unsupported .ticiou/config.yaml version. Expected version: 1.");
  }

  const project = asRecord(parsed.project);
  if (typeof project?.name === "string" && project.name.length > 0) {
    config.projectName = project.name;
  }

  const platforms = asRecord(parsed.platforms);
  for (const platform of PLATFORMS) {
    const platformConfig = asRecord(platforms?.[platform]);
    if (typeof platformConfig?.enabled === "boolean") {
      config.platforms[platform].enabled = platformConfig.enabled;
    }
  }

  const target = asRecord(parsed.target);
  if (target?.default === "cwd" || target?.default === "git-root") {
    config.target.default = target.default;
  }
  if (typeof target?.allow_git_root === "boolean") {
    config.target.allowGitRoot = target.allow_git_root;
  }

  const profiles = asRecord(parsed.profiles);
  if (typeof profiles?.default_user === "string" && profiles.default_user.length > 0) {
    config.profiles.defaultUser = profiles.default_user;
  }
  config.profiles.users = parseProfileUsers(profiles?.users);

  const render = asRecord(parsed.render);
  if (typeof render?.prefix === "string" && render.prefix.length > 0) {
    config.render.prefix = render.prefix;
  }
  if (typeof render?.remove_stale === "boolean") {
    config.render.removeStale = render.remove_stale;
  }
  if (typeof render?.legacy_packaged_skills === "boolean") {
    config.render.legacyPackagedSkills = render.legacy_packaged_skills;
  }

  return config;
}

function serializeConfig(config: TiciouConfig): string {
  const defaultUser = config.profiles.defaultUser === undefined ? "" : `  default_user: ${config.profiles.defaultUser}\n`;
  const users = serializeProfileUsers(config.profiles.users);

  return `version: ${config.version}

project:
  name: ${config.projectName}

platforms:
  claude:
    enabled: ${config.platforms.claude.enabled}
    scope: ${config.platforms.claude.scope}
  copilot:
    enabled: ${config.platforms.copilot.enabled}
    scope: ${config.platforms.copilot.scope}

target:
  default: ${config.target.default}
  allow_git_root: ${config.target.allowGitRoot}

profiles:
${defaultUser.length === 0 ? "  default_user:\n" : defaultUser}${users}

render:
  prefix: ${config.render.prefix}
  conflict_policy: ${config.render.conflictPolicy}
  remove_stale: ${config.render.removeStale}
  legacy_packaged_skills: ${config.render.legacyPackagedSkills}
`;
}

function parseProfileUsers(value: unknown): Record<string, ProfileConfig> {
  const users = asRecord(value);
  if (users === undefined) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(users)
      .filter(([user]) => user.length > 0)
      .map(([user, rawProfile]) => [user, parseProfileConfig(rawProfile)]),
  );
}

function parseProfileConfig(value: unknown): ProfileConfig {
  const profile = asRecord(value);
  if (profile === undefined) {
    return {};
  }

  const skillhub = parseSkillHubProfileConfig(profile.skillhub);
  return skillhub === undefined ? {} : { skillhub };
}

function parseSkillHubProfileConfig(value: unknown): SkillHubProfileConfig | undefined {
  const raw = asRecord(value);
  if (raw === undefined) {
    return undefined;
  }

  return {
    registry: parseRegistry(raw.registry),
    autoRefresh: typeof raw.auto_refresh === "boolean" ? raw.auto_refresh : false,
    backgroundCheck: typeof raw.background_check === "boolean" ? raw.background_check : true,
    updatePolicy: parseEnum(raw.update_policy, ["prompt", "auto"], "prompt"),
    newSkillPolicy: parseEnum(raw.new_skill_policy, ["prompt", "ignore", "auto-add"], "prompt"),
    deletedSkillPolicy: parseEnum(raw.deleted_skill_policy, ["keep-cache", "disable", "remove"], "keep-cache"),
    selections: parseSelections(raw.selections),
  };
}

function parseRegistry(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`Invalid SkillHub registry URL: ${normalized}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid SkillHub registry protocol: ${url.protocol}`);
  }

  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function parseSelections(value: unknown): SkillHubSelection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((rawSelection) => {
    const selection = asRecord(rawSelection);
    if (selection === undefined || typeof selection.namespace !== "string" || selection.namespace.length === 0) {
      throw new Error("Invalid SkillHub selection: namespace is required.");
    }

    if (
      selection.owner !== undefined &&
      (typeof selection.owner !== "string" || selection.owner.length === 0)
    ) {
      throw new Error("Invalid SkillHub selection: owner must be a non-empty string.");
    }

    return {
      namespace: selection.namespace,
      slug: typeof selection.slug === "string" && selection.slug.length > 0 ? selection.slug : undefined,
      owner: typeof selection.owner === "string" && selection.owner.length > 0 ? selection.owner : undefined,
      ownerId: typeof selection.owner_id === "string" && selection.owner_id.length > 0 ? selection.owner_id : undefined,
      label: typeof selection.label === "string" && selection.label.length > 0 ? selection.label : undefined,
      version: typeof selection.version === "string" && selection.version.length > 0 ? selection.version : undefined,
      policy: parseEnum(selection.policy, ["auto", "prompt-new", "pinned"], "auto"),
    };
  });
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  if (!allowed.includes(value as T)) {
    throw new Error(`Unsupported .ticiou/config.yaml value: ${value}.`);
  }
  return value as T;
}

function serializeProfileUsers(users: Record<string, ProfileConfig>): string {
  const entries = Object.entries(users).filter(([, profile]) => profile.skillhub !== undefined);
  if (entries.length === 0) {
    return "";
  }

  const serialized = YAML.stringify(
    Object.fromEntries(entries.map(([user, profile]) => [user, serializeProfileConfig(profile)])),
    { indent: 2 },
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `    ${line}`)
    .join("\n");

  return `  users:\n${serialized}\n`;
}

function serializeProfileConfig(profile: ProfileConfig): unknown {
  return profile.skillhub === undefined
    ? {}
    : {
        skillhub: {
          registry: profile.skillhub.registry,
          auto_refresh: profile.skillhub.autoRefresh,
          background_check: profile.skillhub.backgroundCheck,
          update_policy: profile.skillhub.updatePolicy,
          new_skill_policy: profile.skillhub.newSkillPolicy,
          deleted_skill_policy: profile.skillhub.deletedSkillPolicy,
          selections: profile.skillhub.selections.map((selection) => ({
            namespace: selection.namespace,
            slug: selection.slug,
            owner: selection.owner,
            owner_id: selection.ownerId,
            label: selection.label,
            version: selection.version,
            policy: selection.policy,
          })),
        },
      };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
