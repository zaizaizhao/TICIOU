import { join } from "node:path";

import { copyDirectoryContentsIfMissing, ensureDirectory } from "../infra/fs.js";
import { resolvePythonPlaceholders } from "../infra/python-command.js";
import type { PlatformAdapter } from "./adapter.js";
import { resolveRuntimeTemplateDirectory } from "../infra/template-paths.js";

export const claudeAdapter: PlatformAdapter = {
  platform: "claude",
  displayName: "Claude",
  outputRoots: {
    skills: ".claude/skills",
    hooks: ".claude/hooks",
    agents: ".claude/agents",
    commands: ".claude/commands",
    prompts: ".claude/prompts",
  },
  templateDirectory: "claude",
  async ensureInstalled(targetRoot: string): Promise<void> {
    await copyDirectoryContentsIfMissing(
      resolveRuntimeTemplateDirectory(this.templateDirectory),
      join(targetRoot, ".claude"),
      (_, content) => resolvePythonPlaceholders(content),
    );
    await Promise.all(Object.values(this.outputRoots).map((root) => ensureDirectory(join(targetRoot, root))));
  },
};
