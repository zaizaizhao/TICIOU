import { resolveTargetRoot } from "../../../infra/target-root.js";
import { installPlatform } from "../platform/install.js";
import { useProfile } from "../profile/use.js";
import type { CommandResult, SetupProjectOptions } from "../types.js";
import { initProject } from "./init.js";

export async function setupProject(
  options: SetupProjectOptions,
): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({
    cwd: options.cwd,
    mode: options.target,
  });
  const messages: string[] = [];

  const initResult = await initProject({ cwd: targetRoot, target: "cwd" });
  messages.push(...initResult.messages);

  for (const platform of options.platforms) {
    const installResult = await installPlatform({
      cwd: targetRoot,
      platform,
      target: "cwd",
    });
    messages.push(...installResult.messages);
  }

  const useResult = await useProfile({
    cwd: targetRoot,
    user: options.user,
    target: "cwd",
    runner: options.runner,
  });
  messages.push(...useResult.messages);

  return {
    targetRoot,
    messages,
  };
}
