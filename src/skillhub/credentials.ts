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
  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  async askToken(registry: string): Promise<{ token?: string; save: boolean }> {
    const rl = readline.createInterface({ input: this.input, output: this.output });
    const lines = rl[Symbol.asyncIterator]();
    try {
      this.output.write(`SkillHub token not found for ${registry}.\n`);
      const token = await askLine(lines, this.output, "Paste SkillHub token: ");
      if (token.trim().length === 0) {
        return { save: false };
      }
      const saveAnswer = await askLine(lines, this.output, "Save token locally? [Y/n] ");
      return {
        token: token.trim(),
        save: saveAnswer.trim().toLowerCase() !== "n",
      };
    } finally {
      rl.close();
    }
  }
}

async function askLine(
  lines: AsyncIterator<string>,
  output: NodeJS.WriteStream,
  prompt: string,
): Promise<string> {
  output.write(prompt);
  const result = await lines.next();
  return result.done === true ? "" : result.value;
}

async function applyCredentialPermissions(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  await chmod(path, 0o600);
}
