import { spawn } from "node:child_process";

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string },
) => Promise<{ stdout: string; stderr: string }>;

export const runCommand: CommandRunner = async (command, args, options = {}) =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(`${command} exited ${code ?? "unknown"}: ${stderr.trim()}`),
      );
    });
    child.stdin.end(options.input ?? "");
  });
