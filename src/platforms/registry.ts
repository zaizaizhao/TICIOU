import type { Platform } from "../domain/types.js";
import type { ResourceKind } from "../domain/types.js";
import { claudeAdapter } from "./claude.js";
import { copilotAdapter } from "./copilot.js";
import type { PlatformAdapter } from "./adapter.js";

const PLATFORM_ADAPTERS: Record<Platform, PlatformAdapter> = {
  claude: claudeAdapter,
  copilot: copilotAdapter,
};

export function getPlatformAdapter(platform: Platform): PlatformAdapter {
  return PLATFORM_ADAPTERS[platform];
}

export function platformSkillRoot(platform: Platform): string {
  return platformResourceRoot(platform, "skills");
}

export function platformResourceRoot(platform: Platform, kind: ResourceKind): string {
  return getPlatformAdapter(platform).outputRoots[kind];
}

export async function ensurePlatformInstalled(targetRoot: string, platform: Platform): Promise<void> {
  await getPlatformAdapter(platform).ensureInstalled(targetRoot);
}

export function describePlatform(platform: Platform): string {
  return getPlatformAdapter(platform).displayName;
}
