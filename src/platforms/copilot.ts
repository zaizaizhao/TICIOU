import { join } from "node:path";

import { copyDirectoryContentsIfMissing, ensureDirectory, readTextFileIfExists, writeTextFileIfMissing } from "../infra/fs.js";
import { resolvePythonPlaceholders } from "../infra/python-command.js";
import type { PlatformAdapter } from "./adapter.js";
import { resolveRuntimeTemplateDirectory } from "../infra/template-paths.js";

export const copilotAdapter: PlatformAdapter = {
  platform: "copilot",
  displayName: "Copilot",
  outputRoots: {
    skills: ".github/skills",
    hooks: ".github/hooks",
    agents: ".github/agents",
    commands: ".github/commands",
    prompts: ".github/prompts",
  },
  templateDirectory: "copilot",
  async ensureInstalled(targetRoot: string): Promise<void> {
    const templateRoot = resolveRuntimeTemplateDirectory(this.templateDirectory);
    await copyDirectoryContentsIfMissing(
      templateRoot,
      join(targetRoot, ".github"),
      (_, content) => resolvePythonPlaceholders(content),
    );
    await Promise.all(Object.values(this.outputRoots).map((root) => ensureDirectory(join(targetRoot, root))));
    const hooksConfig = await readTextFileIfExists(join(templateRoot, "copilot", "hooks.json"));
    if (hooksConfig !== undefined) {
      await writeTextFileIfMissing(
        join(targetRoot, ".github", "hooks", "ticiou.json"),
        resolvePythonPlaceholders(hooksConfig),
      );
    }
  },
};
