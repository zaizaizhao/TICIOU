import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ticiou-build-smoke-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("built CLI", () => {
  test("loads copied templates from dist when installing Claude", async () => {
    const root = await makeTempRoot();
    const cliPath = resolve("dist/cli/index.js");

    await execFileAsync(process.execPath, [cliPath, "install", "claude"], { cwd: root });

    await expect(execFileAsync(process.execPath, [cliPath, "status"], { cwd: root })).resolves.toMatchObject({
      stdout: expect.stringContaining("● platforms claude"),
    });
  });

  test("clears user resources from the built CLI", async () => {
    const root = await makeTempRoot();
    const claudeConfig = await makeTempRoot();
    const cliPath = resolve("dist/cli/index.js");
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig };

    await execFileAsync(process.execPath, [cliPath, "install", "claude"], { cwd: root, env });
    await execFileAsync(process.execPath, [cliPath, "use", "-u", "yanan.zhao"], { cwd: root, env });

    await expect(execFileAsync(process.execPath, [cliPath, "clear", "user"], { cwd: root, env })).resolves.toMatchObject({
      stdout: expect.stringContaining("Cleared user profile resources"),
    });
    await expect(execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, env })).resolves.toMatchObject({
      stdout: expect.stringContaining("● profile (none)"),
    });
    await expect(execFileAsync("claude", ["plugin", "list", "--json"], { cwd: root, env })).resolves.toMatchObject({
      stdout: "[]\n",
    });
  });

  test("installs Claude local profile plugin from the built CLI", async () => {
    const root = await makeTempRoot();
    const claudeConfig = await makeTempRoot();
    const cliPath = resolve("dist/cli/index.js");
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig };

    await execFileAsync(process.execPath, [cliPath, "install", "claude"], { cwd: root, env });
    await execFileAsync(process.execPath, [cliPath, "use", "-u", "yanan.zhao"], { cwd: root, env });

    await expect(execFileAsync("claude", ["plugin", "list", "--json"], { cwd: root, env })).resolves.toMatchObject({
      stdout: expect.stringContaining("ticiou-yanan-zhao@ticiou-local-profiles"),
    });
    await expect(execFileAsync(process.execPath, [cliPath, "doctor"], { cwd: root, env })).resolves.toMatchObject({
      stdout: expect.stringContaining("Claude local profile plugin installed and enabled"),
    });
  });
});
