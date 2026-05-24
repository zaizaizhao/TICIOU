import { resolveTargetRoot } from "../../../infra/target-root.js";
import { ensureConfig } from "../../../project/config.js";
import { ensureProjectScaffold } from "../../../project/scaffold.js";
import type { CommandOptions, CommandResult } from "../types.js";

export async function initProject(options: CommandOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd, mode: options.target });
  await ensureConfig(targetRoot);
  await ensureProjectScaffold(targetRoot);

  return {
    targetRoot,
    messages: [`Initialized Ticiou project at ${targetRoot}`],
  };
}
