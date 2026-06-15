import { rm } from "node:fs/promises";
import { join } from "node:path";

import { clearManagedFiles } from "../../../infra/manifest.js";
import { resolveTargetRoot } from "../../../infra/target-root.js";
import { getEnabledPlatforms, readConfig } from "../../../project/config.js";
import { CURRENT_PROFILE_PATH } from "../../../project/paths.js";
import {
  syncClaudeLocalProfilePluginSettings,
  uninstallClaudeLocalProfilePlugin,
} from "../../../rendering/claude-local-plugin.js";
import type { ClearResourcesOptions, CommandResult } from "../types.js";

export async function clearResources(options: ClearResourcesOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd, mode: options.target });
  const config = await readConfig(targetRoot);
  const manifest = await clearManagedFiles(
    targetRoot,
    (entry) => options.scope === "all" || entry.source === "profile" || entry.source === "skillhub",
  );
  if (config !== undefined && getEnabledPlatforms(config).includes("claude")) {
    await uninstallClaudeLocalProfilePlugin({
      targetRoot,
      config,
      runner: options.runner,
    });
    await syncClaudeLocalProfilePluginSettings(targetRoot, undefined, config);
  }
  await rm(join(targetRoot, CURRENT_PROFILE_PATH), { force: true });

  return {
    targetRoot,
    messages: [
      options.scope === "all" ? "Cleared all rendered Ticiou resources" : "Cleared user profile resources",
      `Remaining managed files: ${manifest.files.length}`,
    ],
  };
}
