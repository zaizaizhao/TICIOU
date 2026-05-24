import { resolveTargetRoot } from "../../../infra/target-root.js";
import { describePlatform, ensurePlatformInstalled } from "../../../platforms/registry.js";
import { setPlatformEnabled } from "../../../project/config.js";
import { initProject } from "../project/init.js";
import type { CommandResult, InstallPlatformOptions } from "../types.js";

export async function installPlatform(options: InstallPlatformOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd, mode: options.target });
  await initProject({ cwd: targetRoot, target: "cwd" });
  await ensurePlatformInstalled(targetRoot, options.platform);
  await setPlatformEnabled(targetRoot, options.platform, true);

  return {
    targetRoot,
    messages: [`${describePlatform(options.platform)} adapter installed`],
  };
}
