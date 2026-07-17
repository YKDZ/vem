export function shouldShowMockPaymentControls(input: {
  dev: boolean;
  paymentMethod: string | null | undefined;
  flag: string | boolean | undefined;
}): boolean {
  return (
    input.dev &&
    input.paymentMethod === "mock" &&
    (input.flag === true || input.flag === "true")
  );
}

export function shouldShowPaymentCodeDevScan(input: {
  dev: boolean;
  mockDaemon: boolean;
  flag: string | boolean | undefined;
}): boolean {
  return (
    input.dev &&
    input.mockDaemon &&
    (input.flag === true || input.flag === "true")
  );
}
