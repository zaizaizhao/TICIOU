import type { ManagedSource } from "./types.js";

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug === "" ? "item" : slug;
}

export function skillOutputDirectoryName(options: {
  prefix: string;
  source: ManagedSource;
  skillName: string;
  user?: string;
}): string {
  if (options.source === "shared") {
    return `${slugify(options.prefix)}-shared-${slugify(options.skillName)}`;
  }

  return `${slugify(options.prefix)}-user-${slugify(options.user ?? "unknown")}-${slugify(options.skillName)}`;
}

export function userPluginName(options: { prefix: string; user: string }): string {
  return `${slugify(options.prefix)}-${slugify(options.user)}`;
}
