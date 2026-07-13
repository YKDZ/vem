export function parseLinuxInterfaceName(value: string): string {
  if (
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9_.-]{1,15}$/.test(value)
  ) {
    throw new Error("invalid Linux interface name");
  }
  return value;
}
