import { watch, type WatchStopHandle } from "vue";

import { useCheckoutStore } from "@/stores/checkout";

type TransactionStage = "none" | "payment" | "dispensing" | "result";

export function installActiveTransactionSync(input?: {
  stage?: () => TransactionStage;
  refresh?: () => Promise<unknown>;
  intervalMs?: number;
}): () => void {
  const checkoutStore = useCheckoutStore();
  const stage = input?.stage ?? (() => checkoutStore.customerCheckoutView.stage);
  const refresh = input?.refresh ?? (() => checkoutStore.refreshCurrentTransaction());
  const refreshIfActive = (): void => {
    const currentStage = stage();
    if (currentStage !== "payment" && currentStage !== "dispensing") return;
    void refresh();
  };
  const stopWatch: WatchStopHandle = watch(stage, refreshIfActive);
  const timer = window.setInterval(refreshIfActive, input?.intervalMs ?? 2_000);

  return () => {
    stopWatch();
    window.clearInterval(timer);
  };
}
