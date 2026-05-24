import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDirectory, pathExists } from "../infra/fs.js";
import { SOURCE_DIRECTORIES } from "./paths.js";

export async function ensureProjectScaffold(targetRoot: string): Promise<void> {
  await ensureSourceDirectories(targetRoot);
  await ensureRuntimeGitignore(targetRoot);
}

async function ensureSourceDirectories(targetRoot: string): Promise<void> {
  await Promise.all(SOURCE_DIRECTORIES.map((directory) => ensureDirectory(join(targetRoot, directory))));
}

async function ensureRuntimeGitignore(targetRoot: string): Promise<void> {
  const gitignorePath = join(targetRoot, ".gitignore");
  const runtimeIgnore = ".ticiou/";

  if (await pathExists(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf8");
    if (content.split(/\r?\n/).includes(runtimeIgnore)) {
      return;
    }
    const prefix = content.endsWith("\n") || content.length === 0 ? "" : "\n";
    await appendFile(gitignorePath, `${prefix}${runtimeIgnore}\n`, "utf8");
    return;
  }

  await mkdir(targetRoot, { recursive: true });
  await appendFile(gitignorePath, `${runtimeIgnore}\n`, "utf8");
}
