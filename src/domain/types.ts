export const PLATFORMS = ["claude", "copilot"] as const;

export type Platform = (typeof PLATFORMS)[number];
export type TargetMode = "cwd" | "git-root";
export const RESOURCE_KINDS = ["skills", "hooks", "agents", "commands", "prompts"] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type ManagedSource = "shared" | "profile" | "adapter" | "skillhub" | "legacy-skill";

export function isPlatform(value: string): value is Platform {
  return PLATFORMS.includes(value as Platform);
}

export function isTargetMode(value: string): value is TargetMode {
  return value === "cwd" || value === "git-root";
}
