import { rm } from "node:fs/promises";
import { join } from "node:path";

import { clearManagedFiles } from "../../../infra/manifest.js";
import { resolveTargetRoot } from "../../../infra/target-root.js";
import { CURRENT_PROFILE_PATH, SKILLHUB_LEGACY_LOCK_PATH, SKILLHUB_LOCKS_DIR } from "../../../project/paths.js";
import type { ClearResourcesOptions, CommandResult } from "../types.js";

export async function clearResources(options: ClearResourcesOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd, mode: options.target });
  const manifest = await clearManagedFiles(
    targetRoot,
    (entry) => options.scope === "all" || entry.source === "profile" || entry.source === "skillhub",
  );
  await rm(join(targetRoot, CURRENT_PROFILE_PATH), { force: true });
  if (options.scope === "all") {
    await rm(join(targetRoot, SKILLHUB_LOCKS_DIR), { recursive: true, force: true });
    await rm(join(targetRoot, SKILLHUB_LEGACY_LOCK_PATH), { force: true });
  }

  return {
    targetRoot,
    messages: [
      options.scope === "all" ? "Cleared all rendered Ticiou resources" : "Cleared user profile resources",
      `Remaining managed files: ${manifest.files.length}`,
    ],
  };
}
