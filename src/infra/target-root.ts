import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { TargetMode } from "../domain/types.js";
import { isNodeError } from "./fs.js";

export interface ResolveTargetRootOptions {
  cwd: string;
  mode?: TargetMode;
}

export async function resolveTargetRoot(options: ResolveTargetRootOptions): Promise<string> {
  const mode = options.mode ?? "cwd";
  const cwd = resolve(options.cwd);

  if (mode === "cwd") {
    return cwd;
  }

  return findGitRoot(cwd);
}

async function findGitRoot(cwd: string): Promise<string> {
  let current = cwd;

  while (true) {
    if (await hasGitMarker(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error("No git root found. Re-run without --target git-root to enhance the current directory.");
    }
    current = parent;
  }
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
