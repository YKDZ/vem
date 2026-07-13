import { callTauriCommand, isTauriRuntime } from "./tauri";

export async function showTouchKeyboard(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return callTauriCommand<boolean>("show_touch_keyboard");
}

export async function hideTouchKeyboard(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return callTauriCommand<boolean>("hide_touch_keyboard");
}

type TouchKeyboardPolicyOptions = {
  isAllowed(): boolean;
  afterEach(handler: () => void): () => void;
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target.hasAttribute("disabled")) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

export function installTouchKeyboardPolicy(
  options: TouchKeyboardPolicyOptions,
): () => void {
  let pendingHide: number | undefined;
  const onFocusIn = (event: FocusEvent) => {
    if (pendingHide !== undefined) window.clearTimeout(pendingHide);
    if (options.isAllowed() && isEditable(event.target)) {
      void showTouchKeyboard();
    }
  };
  const onFocusOut = () => {
    if (!options.isAllowed()) return;
    pendingHide = window.setTimeout(() => {
      pendingHide = undefined;
      if (!isEditable(document.activeElement)) void hideTouchKeyboard();
    });
  };
  const removeAfterEach = options.afterEach(() => {
    if (!options.isAllowed()) {
      if (pendingHide !== undefined) window.clearTimeout(pendingHide);
      pendingHide = undefined;
      void hideTouchKeyboard();
    }
  });

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  if (!options.isAllowed()) void hideTouchKeyboard();

  return () => {
    if (pendingHide !== undefined) window.clearTimeout(pendingHide);
    removeAfterEach();
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
  };
}
