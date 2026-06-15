import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";

import { pathExists } from "../infra/fs.js";
import type { ResolvedToken, SkillHubCommandAuthOptions } from "./types.js";

interface CredentialsFile {
  tokens: Record<
    string,
    | string
    | {
        token: string;
        savedAt?: string;
        lastVerifiedUser?: string;
      }
  >;
}

export interface ResolveTokenOptions extends SkillHubCommandAuthOptions {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  home?: string;
  prompt?: TokenPrompt;
}

export interface TokenPrompt {
  askToken(registry: string): Promise<{ token?: string; save: boolean }>;
}

export class CredentialsStore {
  readonly path: string;

  constructor(home = homedir()) {
    this.path = join(home, ".ticiou", "skillhub-credentials.json");
  }

  async getToken(registry: string): Promise<string | undefined> {
    const file = await this.read();
    const entry = file.tokens[registry];
    if (typeof entry === "string") {
      return entry;
    }
    return entry?.token;
  }

  async setToken(registry: string, token: string, lastVerifiedUser?: string): Promise<void> {
    const file = await this.read();
    file.tokens[registry] = {
      token,
      savedAt: new Date().toISOString(),
      lastVerifiedUser,
    };
    await this.write(file);
  }

  async deleteToken(registry: string): Promise<void> {
    const file = await this.read();
    delete file.tokens[registry];
    await this.write(file);
  }

  private async read(): Promise<CredentialsFile> {
    if (!(await pathExists(this.path))) {
      return { tokens: {} };
    }

    const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<CredentialsFile>;
    return {
      tokens: typeof parsed.tokens === "object" && parsed.tokens !== null ? parsed.tokens : {},
    };
  }

  private async write(file: CredentialsFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await applyCredentialPermissions(this.path);
  }
}

export async function resolveToken(options: ResolveTokenOptions): Promise<ResolvedToken> {
  if (options.anonymous === true) {
    return { source: "anonymous", persistent: false };
  }

  if (options.token !== undefined && options.token.length > 0) {
    return { token: options.token, source: "flag", persistent: false };
  }

  const envToken = options.env?.SKILLHUB_TOKEN ?? process.env.SKILLHUB_TOKEN;
  if (envToken !== undefined && envToken.length > 0) {
    return { token: envToken, source: "env", persistent: false };
  }

  const store = new CredentialsStore(options.home);
  const storedToken = await store.getToken(options.registry ?? "");
  if (storedToken !== undefined && storedToken.length > 0) {
    return { token: storedToken, source: "ticiou-store", persistent: true };
  }

  if (options.askToken === true && options.interactive !== false) {
    const prompt = options.prompt ?? new TerminalTokenPrompt();
    const answer = await prompt.askToken(options.registry ?? "");
    if (answer.token !== undefined && answer.token.length > 0) {
      if (answer.save) {
        await store.setToken(options.registry ?? "", answer.token);
      }
      return { token: answer.token, source: "prompt", persistent: answer.save };
    }
  }

  return { source: "anonymous", persistent: false };
}

export class TerminalTokenPrompt implements TokenPrompt {
  async askToken(registry: string): Promise<{ token?: string; save: boolean }> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`SkillHub token not found for ${registry}.`);
      const token = await askHidden("Paste SkillHub token: ");
      if (token.trim().length === 0) {
        return { save: false };
      }
      const saveAnswer = await rl.question("Save token locally? [Y/n] ");
      return {
        token: token.trim(),
        save: saveAnswer.trim().toLowerCase() !== "n",
      };
    } finally {
      rl.close();
    }
  }
}

async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }

  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdout.write("\n");
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Token input cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0008" || char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
  });
}

async function applyCredentialPermissions(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  await chmod(path, 0o600);
}
