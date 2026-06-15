import type { TiciouConfig, SkillHubProfileConfig, SkillHubSelection } from "../project/config.js";
import { DEFAULT_SKILLHUB_REGISTRY, normalizeRegistry } from "./registry.js";
import type { SkillHubProfileRuntimeConfig } from "./types.js";

export function getSkillHubRuntimeConfig(
  config: TiciouConfig,
  user: string,
  registryOverride?: string,
): SkillHubProfileRuntimeConfig {
  const profileConfig = config.profiles.users[user]?.skillhub;
  return {
    registry: normalizeRegistry(registryOverride ?? profileConfig?.registry ?? DEFAULT_SKILLHUB_REGISTRY),
    autoRefresh: profileConfig?.autoRefresh ?? false,
    backgroundCheck: profileConfig?.backgroundCheck ?? true,
    updatePolicy: profileConfig?.updatePolicy ?? "prompt",
    newSkillPolicy: profileConfig?.newSkillPolicy ?? "prompt",
    deletedSkillPolicy: profileConfig?.deletedSkillPolicy ?? "keep-cache",
    selections: profileConfig?.selections ?? [],
  };
}

export function ensureSkillHubProfileConfig(
  config: TiciouConfig,
  user: string,
  registry: string,
): SkillHubProfileConfig {
  config.profiles.users[user] ??= {};
  config.profiles.users[user].skillhub ??= {
    registry,
    autoRefresh: false,
    backgroundCheck: true,
    updatePolicy: "prompt",
    newSkillPolicy: "prompt",
    deletedSkillPolicy: "keep-cache",
    selections: [],
  };
  config.profiles.users[user].skillhub.registry = registry;
  return config.profiles.users[user].skillhub;
}

export function addSelection(profileConfig: SkillHubProfileConfig, selection: SkillHubSelection): boolean {
  const key = selectionKey(selection);
  if (profileConfig.selections.some((existing) => selectionKey(existing) === key)) {
    return false;
  }

  profileConfig.selections.push(selection);
  return true;
}

export function removeSelection(profileConfig: SkillHubProfileConfig, namespace: string, slug: string): boolean {
  const before = profileConfig.selections.length;
  profileConfig.selections = profileConfig.selections.filter(
    (selection) => !(selection.namespace === namespace && selection.slug === slug),
  );
  return profileConfig.selections.length !== before;
}

export function explicitSkillSelections(selections: SkillHubSelection[]): SkillHubSelection[] {
  return selections.filter((selection) => selection.slug !== undefined && selection.slug.length > 0);
}

export function parseSkillRef(value: string): { namespace: string; slug: string } {
  const [namespace, slug, ...rest] = value.split("/");
  if (namespace === undefined || slug === undefined || rest.length > 0 || namespace.length === 0 || slug.length === 0) {
    throw new Error(`Invalid SkillHub skill reference: ${value}. Expected <namespace>/<slug>.`);
  }
  return { namespace, slug };
}

function selectionKey(selection: SkillHubSelection): string {
  if (selection.slug !== undefined) {
    return `skill:${selection.namespace}/${selection.slug}`;
  }

  return [
    "selector",
    selection.namespace,
    selection.owner ?? "",
    selection.ownerId ?? "",
    selection.label ?? "",
    selection.policy,
  ].join(":");
}
