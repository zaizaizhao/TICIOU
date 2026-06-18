import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { clearManagedFiles, writeManagedFiles } from "../src/infra/manifest.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ticiou-manifest-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeManagedFiles", () => {
  test("writes files and records them in the runtime manifest", async () => {
    const root = await makeTempRoot();

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-shared-azure-devops/SKILL.md",
          content: "# Azure DevOps\n",
          kind: "skills",
          platform: "claude",
          source: "shared",
        },
      ],
      removeStale: true,
    });

    await expect(readFile(join(root, ".claude/skills/ticiou-shared-azure-devops/SKILL.md"), "utf8")).resolves.toBe(
      "# Azure DevOps\n",
    );

    const manifest = await readFile(join(root, ".ticiou/.runtime/manifest.json"), "utf8");
    expect(manifest).toContain(".claude/skills/ticiou-shared-azure-devops/SKILL.md");
  });

  test("writes binary files and protects them with byte hashes", async () => {
    const root = await makeTempRoot();
    const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x41]);
    const path = join(root, ".claude/skills/ticiou-shared-demo/assets/logo.png");

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-shared-demo/assets/logo.png",
          content,
          kind: "skills",
          platform: "claude",
          source: "shared",
        },
      ],
      removeStale: true,
    });

    await expect(readFile(path)).resolves.toEqual(Buffer.from(content));

    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]));

    await expect(clearManagedFiles(root, (entry) => entry.source === "shared")).rejects.toThrow(
      "Refusing to remove modified managed file",
    );
  });

  test("refuses to overwrite a file that Ticiou did not generate", async () => {
    const root = await makeTempRoot();
    const unmanagedPath = join(root, ".claude/skills/ticiou-shared-azure-devops/SKILL.md");
    await mkdir(join(root, ".claude/skills/ticiou-shared-azure-devops"), { recursive: true });
    await writeFile(unmanagedPath, "# Hand written\n");

    await expect(
      writeManagedFiles({
        targetRoot: root,
        files: [
          {
            relativePath: ".claude/skills/ticiou-shared-azure-devops/SKILL.md",
            content: "# Azure DevOps\n",
            kind: "skills",
            platform: "claude",
            source: "shared",
          },
        ],
        removeStale: true,
      }),
    ).rejects.toThrow("Refusing to overwrite unmanaged file");
  });

  test("removes stale files that are still owned by the previous manifest", async () => {
    const root = await makeTempRoot();

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md",
          content: "# Kaibin\n",
          kind: "skills",
          platform: "claude",
          source: "profile",
        },
      ],
      removeStale: true,
    });

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md",
          content: "# Yanan\n",
          kind: "skills",
          platform: "claude",
          source: "profile",
        },
      ],
      removeStale: true,
    });

    expect(existsSync(join(root, ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/ticiou-user-kaibin-xu-personal"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills"))).toBe(true);
    expect(existsSync(join(root, ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md"))).toBe(true);
  });

  test("keeps previous rendered files when writing replacement files fails", async () => {
    const root = await makeTempRoot();
    const previousPath = join(root, ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md");

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md",
          content: "# Kaibin\n",
          kind: "skills",
          platform: "claude",
          source: "profile",
        },
      ],
      removeStale: true,
    });
    const unwritableDirectory = join(root, ".claude/skills/ticiou-user-yanan-zhao-personal");
    await mkdir(unwritableDirectory, { recursive: true });
    await chmod(unwritableDirectory, 0o555);

    try {
      await expect(
        writeManagedFiles({
          targetRoot: root,
          files: [
            {
              relativePath: ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md",
              content: "# Yanan\n",
              kind: "skills",
              platform: "claude",
              source: "profile",
            },
          ],
          removeStale: true,
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(unwritableDirectory, 0o755);
    }

    await expect(readFile(previousPath, "utf8")).resolves.toBe("# Kaibin\n");
  });

  test("removes newly written files when a later replacement file fails", async () => {
    const root = await makeTempRoot();
    const previousPath = join(root, ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md");
    const firstNewPath = join(root, ".claude/skills/ticiou-user-a-personal/SKILL.md");

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md",
          content: "# Kaibin\n",
          kind: "skills",
          platform: "claude",
          source: "profile",
        },
      ],
      removeStale: true,
    });
    const unwritableDirectory = join(root, ".claude/skills/ticiou-user-z-personal");
    await mkdir(unwritableDirectory, { recursive: true });
    await chmod(unwritableDirectory, 0o555);

    try {
      await expect(
        writeManagedFiles({
          targetRoot: root,
          files: [
            {
              relativePath: ".claude/skills/ticiou-user-a-personal/SKILL.md",
              content: "# First\n",
              kind: "skills",
              platform: "claude",
              source: "profile",
            },
            {
              relativePath: ".claude/skills/ticiou-user-z-personal/SKILL.md",
              content: "# Fails\n",
              kind: "skills",
              platform: "claude",
              source: "profile",
            },
          ],
          removeStale: true,
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(unwritableDirectory, 0o755);
    }

    expect(existsSync(firstNewPath)).toBe(false);
    await expect(readFile(previousPath, "utf8")).resolves.toBe("# Kaibin\n");
  });

  test("prunes nested empty managed directories up to the platform skill root only", async () => {
    const root = await makeTempRoot();

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-user-kaibin-xu/skills/personal/SKILL.md",
          content: "# Kaibin\n",
          kind: "skills",
          platform: "claude",
          source: "profile",
        },
      ],
      removeStale: true,
    });

    await clearManagedFiles(root, (entry) => entry.source === "profile");

    expect(existsSync(join(root, ".claude/skills/ticiou-user-kaibin-xu"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills"))).toBe(true);
    expect(existsSync(join(root, ".claude"))).toBe(true);
  });

  test("clears selected managed files and keeps the remaining manifest entries", async () => {
    const root = await makeTempRoot();

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-shared-azure-devops/SKILL.md",
          content: "# Azure DevOps\n",
          kind: "skills",
          platform: "claude",
          source: "shared",
        },
        {
          relativePath: ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md",
          content: "# Yanan\n",
          kind: "skills",
          platform: "claude",
          source: "profile",
        },
      ],
      removeStale: true,
    });

    const manifest = await clearManagedFiles(root, (entry) => entry.source === "profile");

    expect(existsSync(join(root, ".claude/skills/ticiou-shared-azure-devops/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/ticiou-user-yanan-zhao-personal"))).toBe(false);
    expect(manifest.files.map((entry) => entry.relativePath)).toEqual([
      ".claude/skills/ticiou-shared-azure-devops/SKILL.md",
    ]);
  });

  test("refuses to clear a managed file that was modified after rendering", async () => {
    const root = await makeTempRoot();

    await writeManagedFiles({
      targetRoot: root,
      files: [
        {
          relativePath: ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md",
          content: "# Yanan\n",
          kind: "skills",
          platform: "claude",
          source: "profile",
        },
      ],
      removeStale: true,
    });
    await writeFile(join(root, ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md"), "# Edited\n");

    await expect(clearManagedFiles(root, (entry) => entry.source === "profile")).rejects.toThrow(
      "Refusing to remove modified managed file",
    );
  });
});
