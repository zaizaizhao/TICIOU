import { join } from "node:path";

import { readManifest } from "../../../infra/manifest.js";
import { resolveTargetRoot } from "../../../infra/target-root.js";
import { readTextFileIfExists } from "../../../infra/fs.js";
import { getEnabledPlatforms, readConfig } from "../../../project/config.js";
import { CURRENT_PROFILE_PATH } from "../../../project/paths.js";
import type { CommandOptions, StatusResult } from "../types.js";

export async function getStatus(options: CommandOptions): Promise<StatusResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd, mode: options.target });
  const config = await readConfig(targetRoot);
  const manifest = await readManifest(targetRoot);
  const currentProfileContent = await readTextFileIfExists(join(targetRoot, CURRENT_PROFILE_PATH));
  const currentProfile = currentProfileContent?.trim();

  return {
    targetRoot,
    currentProfile: currentProfile === "" ? undefined : currentProfile,
    enabledPlatforms: config === undefined ? [] : getEnabledPlatforms(config),
    generatedFileCount: manifest.files.length,
  };
}
