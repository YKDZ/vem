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

export function shouldShowAdvancedMaintenanceConfig(input: {
  flag: string | boolean | undefined;
}): boolean {
  return input.flag === true || input.flag === "true";
}
