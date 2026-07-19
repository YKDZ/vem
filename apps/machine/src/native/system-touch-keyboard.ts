import { callTauriCommand, isTauriRuntime } from "@/native/tauri";

type InvokeKeyboardCommand = (command: string) => Promise<unknown>;
type ReportKeyboardFailure = (command: string, error: unknown) => void;

interface SystemTouchKeyboardOptions {
  enabled?: boolean;
  invokeCommand?: InvokeKeyboardCommand;
  reportFailure?: ReportKeyboardFailure;
}

const EDITABLE_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

export function isSystemTouchKeyboardTarget(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) {
    return !target.disabled && !target.readOnly;
  }
  return (
    target instanceof HTMLInputElement &&
    !target.disabled &&
    !target.readOnly &&
    EDITABLE_INPUT_TYPES.has(target.type)
  );
}

export function installMaintenanceSystemTouchKeyboard(
  owner: HTMLElement,
  options: SystemTouchKeyboardOptions = {},
): () => void {
  const enabled = options.enabled ?? isTauriRuntime();
  const invokeCommand =
    options.invokeCommand ??
    (async (command) => await callTauriCommand(command));
  let disposed = false;

  async function invoke(command: string): Promise<void> {
    if (!enabled) return;
    try {
      await invokeCommand(command);
    } catch (error) {
      options.reportFailure?.(command, error);
    }
  }

  function handleFocusIn(event: FocusEvent): void {
    if (isSystemTouchKeyboardTarget(event.target)) {
      void invoke("show_system_touch_keyboard");
    }
  }

  function handleFocusOut(): void {
    window.setTimeout(() => {
      if (
        !disposed &&
        !isSystemTouchKeyboardTarget(owner.ownerDocument.activeElement)
      ) {
        void invoke("hide_system_touch_keyboard");
      }
    }, 0);
  }

  owner.addEventListener("focusin", handleFocusIn);
  owner.addEventListener("focusout", handleFocusOut);

  return () => {
    disposed = true;
    owner.removeEventListener("focusin", handleFocusIn);
    owner.removeEventListener("focusout", handleFocusOut);
    void invoke("hide_system_touch_keyboard");
  };
}
