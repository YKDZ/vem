/**
 * 测试适配器接口：VM 或物理机独有能力（文件、命令、后续 CDP/串口）的统一访问点。
 * 本地 fake 与真实实现实现同一契约；业务驱动只依赖该接口。
 */

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TestAdapter {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  run(command: string, args?: string[]): Promise<CommandResult>;
}

export interface FakeCommandContext {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export function assertAdapterContract(adapter: TestAdapter): void {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("adapter must be an object");
  }
  for (const method of ["readFile", "writeFile", "run"]) {
    if (
      typeof (adapter as unknown as Record<string, unknown>)[method] !==
      "function"
    ) {
      throw new TypeError(`adapter must implement ${method}()`);
    }
  }
}

export function createFakeTestAdapter({
  files = {},
  commands = {},
  defaultExitCode = 0,
}: {
  files?: Record<string, string>;
  commands?: Record<
    string,
    | CommandResult
    | ((
        args: string[],
        context: FakeCommandContext,
      ) => CommandResult | Promise<CommandResult>)
  >;
  defaultExitCode?: number;
} = {}) {
  const store = new Map<string, string>(Object.entries(files));
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    async readFile(path: string): Promise<string> {
      if (!store.has(path)) {
        throw new Error(`missing file: ${path}`);
      }
      return store.get(path)!;
    },
    async writeFile(path: string, content: string): Promise<void> {
      store.set(path, String(content));
    },
    async run(command: string, args: string[] = []): Promise<CommandResult> {
      const key = [command, ...args].join(" ");
      calls.push({ command, args });
      const canned = commands[key];
      if (typeof canned === "function") {
        return await canned(args, {
          readFile: this.readFile.bind(this),
          writeFile: this.writeFile.bind(this),
        });
      }
      const resolved: CommandResult = canned ?? {
        exitCode: defaultExitCode,
        stdout: "",
        stderr: "",
      };
      return {
        exitCode: resolved.exitCode,
        stdout: resolved.stdout,
        stderr: resolved.stderr,
      };
    },
  };
}
