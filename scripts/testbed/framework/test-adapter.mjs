/**
 * 测试适配器接口：VM 或物理机独有能力（文件、命令、后续 CDP/串口）的统一访问点。
 * 本地 fake 与真实实现实现同一契约；业务驱动只依赖该接口。
 */

export function assertAdapterContract(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("adapter must be an object");
  }
  for (const method of ["readFile", "writeFile", "run"]) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`adapter must implement ${method}()`);
    }
  }
}

export function createFakeTestAdapter({
  files = {},
  commands = {},
  defaultExitCode = 0,
} = {}) {
  const store = new Map(Object.entries(files));
  const calls = [];
  return {
    calls,
    async readFile(path) {
      if (!store.has(path)) {
        throw new Error(`missing file: ${path}`);
      }
      return store.get(path);
    },
    async writeFile(path, content) {
      store.set(path, String(content));
    },
    async run(command, args = []) {
      const key = [command, ...args].join(" ");
      calls.push({ command, args });
      const canned = commands[key];
      if (typeof canned === "function") {
        return await canned(args, {
          readFile: this.readFile.bind(this),
          writeFile: this.writeFile.bind(this),
        });
      }
      const resolved = canned ?? {
        exitCode: defaultExitCode,
        stdout: "",
        stderr: "",
      };
      return {
        exitCode: resolved.exitCode ?? defaultExitCode,
        stdout: resolved.stdout ?? "",
        stderr: resolved.stderr ?? "",
      };
    },
  };
}
