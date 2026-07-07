import {
  hasStoredUiDebugTransaction,
  installUiDebugDaemon,
  resetUiDebugTransaction,
  setUiDebugTransaction,
} from "@/dev/ui-debug-daemon";
import {
  getActiveUiDebugScenario,
  getSaleViewForScenario,
  isUiDebugModeEnabled,
  type UiDebugScenario,
} from "@/dev/ui-debug-fixtures";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";

export function applyUiDebugScenarioToStores(scenario: UiDebugScenario): void {
  const saleView = getSaleViewForScenario(scenario.id);
  useMachineStore().configSummary = scenario.config;
  useMachineStore().configLoaded = true;
  useMachineStore().applyHealth(scenario.health);
  useConnectivityStore().applyHealth(scenario.health);
  useConnectivityStore().applyReady(scenario.ready);
  useConnectivityStore().applySaleReadiness(scenario.saleReadiness);
  useCatalogStore().applySnapshot(saleView);
  useMqttStore().applySync(scenario.sync);
  useScannerStore().applyStatus(scenario.scanner);
  useVisionStore().applyStatus(scenario.vision);
  useRemoteOpsStore().applyStatus(scenario.remoteOps);
  useAudioCueStore().applySettings(scenario.config.public.audioCueSettings);
  void useNaturalContextStore()
    .refresh()
    .catch(() => undefined);

  const hasScenarioTransaction = Boolean(scenario.transaction.orderNo);
  const canRestoreStoredTransaction =
    !hasScenarioTransaction && scenario.id === "ready";

  if (hasScenarioTransaction) {
    resetUiDebugTransaction();
    const checkoutStore = useCheckoutStore();
    checkoutStore.dismissedTerminalOrderNos =
      checkoutStore.dismissedTerminalOrderNos.filter(
        (orderNo) => orderNo !== scenario.transaction.orderNo,
      );
    checkoutStore.applyTransaction(scenario.transaction);
    setUiDebugTransaction(scenario.transaction);
  } else if (canRestoreStoredTransaction && hasStoredUiDebugTransaction()) {
    useCheckoutStore().reset();
  } else {
    resetUiDebugTransaction();
    useCheckoutStore().reset();
  }
}

export function installActiveUiDebugRuntimeScenario(): void {
  if (!import.meta.env.DEV || !isUiDebugModeEnabled()) return;
  installUiDebugDaemon();
  applyUiDebugScenarioToStores(getActiveUiDebugScenario());
}
