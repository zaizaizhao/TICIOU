import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveTargetRoot } from "../src/infra/target-root.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ticiou-target-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveTargetRoot", () => {
  test("uses the current working directory by default", async () => {
    const root = await makeTempRoot();

    await expect(resolveTargetRoot({ cwd: root })).resolves.toBe(root);
  });

  test("uses the current working directory when target mode is cwd", async () => {
    const root = await makeTempRoot();

    await expect(resolveTargetRoot({ cwd: root, mode: "cwd" })).resolves.toBe(root);
  });

  test("finds the nearest git root when target mode is git-root", async () => {
    const root = await makeTempRoot();
    const nested = join(root, "services", "api");
    await mkdir(join(root, ".git"));
    await mkdir(nested, { recursive: true });

    await expect(resolveTargetRoot({ cwd: nested, mode: "git-root" })).resolves.toBe(root);
  });

  test("treats a .git file as a git root marker", async () => {
    const root = await makeTempRoot();
    const nested = join(root, "packages", "web");
    await writeFile(join(root, ".git"), "gitdir: ../.git/worktrees/web\n");
    await mkdir(nested, { recursive: true });

    await expect(resolveTargetRoot({ cwd: nested, mode: "git-root" })).resolves.toBe(root);
  });

  test("explains how to continue when no git root can be found", async () => {
    const root = await makeTempRoot();

    await expect(resolveTargetRoot({ cwd: root, mode: "git-root" })).rejects.toThrow(
      "No git root found. Re-run without --target git-root to enhance the current directory.",
    );
  });
});
