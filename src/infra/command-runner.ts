import { execFile } from "node:child_process";

export interface CommandRunResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandRunResult>;

export const defaultCommandRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        shell: process.platform === "win32",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }

        resolve({
          stdout,
          stderr,
        });
      },
    );
  });