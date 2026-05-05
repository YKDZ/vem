export function dispenseCommandTopic(machineCode: string): string {
  return `vem/machines/${machineCode}/commands/dispense`;
}

export function commandAckTopic(
  machineCode: string,
  commandNo: string,
): string {
  return `vem/machines/${machineCode}/commands/${commandNo}/ack`;
}

export function dispenseResultTopic(machineCode: string): string {
  return `vem/machines/${machineCode}/events/dispense-result`;
}

export function heartbeatTopic(machineCode: string): string {
  return `vem/machines/${machineCode}/events/heartbeat`;
}
