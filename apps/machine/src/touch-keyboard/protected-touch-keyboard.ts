import { reactive } from "vue";

export type ProtectedTouchKeyboardAccess = {
  routeName: string;
  maintenanceAuthorized: boolean;
};

type EligibleInput = HTMLInputElement | HTMLTextAreaElement;

export type ProtectedTouchKeyboardState = {
  open: boolean;
  layout: "letters" | "numbers" | "symbols";
  uppercase: boolean;
  target: EligibleInput | null;
};

function routeAllowsInput(access: ProtectedTouchKeyboardAccess): boolean {
  return (
    access.routeName === "bring-up" ||
    (access.routeName === "maintenance" && access.maintenanceAuthorized)
  );
}

function isEligibleInput(target: EventTarget | null): target is EligibleInput {
  if (
    !(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) ||
    target.disabled ||
    target.readOnly
  ) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement) return true;
  return [
    "text",
    "password",
    "number",
    "tel",
    "url",
    "email",
    "search",
  ].includes(target.type);
}

function initialLayout(
  target: EligibleInput,
): ProtectedTouchKeyboardState["layout"] {
  if (
    target instanceof HTMLInputElement &&
    (target.type === "number" || target.inputMode === "numeric")
  ) {
    return "numbers";
  }
  return "letters";
}

function updateTargetValue(
  target: EligibleInput,
  transform: (
    value: string,
    start: number,
    end: number,
  ) => {
    value: string;
    cursor: number;
  },
): void {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  const next = transform(target.value, start, end);
  if (target.maxLength >= 0 && next.value.length > target.maxLength) return;
  target.value = next.value;
  if (target.type !== "number") {
    target.setSelectionRange(next.cursor, next.cursor);
  }
  target.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText" }),
  );
}

export function createProtectedTouchKeyboardController(
  getAccess: () => ProtectedTouchKeyboardAccess,
) {
  const state = reactive<ProtectedTouchKeyboardState>({
    open: false,
    layout: "letters",
    uppercase: false,
    target: null,
  });

  function close(): void {
    state.open = false;
    state.uppercase = false;
    state.target = null;
  }

  function reconcileAccess(): void {
    if (!routeAllowsInput(getAccess())) close();
  }

  function onFocusIn(event: FocusEvent): void {
    if (!routeAllowsInput(getAccess()) || !isEligibleInput(event.target)) {
      close();
      return;
    }
    state.target = event.target;
    state.layout = initialLayout(event.target);
    state.uppercase = false;
    state.open = true;
  }

  function install(ownerDocument: Document): () => void {
    ownerDocument.addEventListener("focusin", onFocusIn);
    return () => {
      ownerDocument.removeEventListener("focusin", onFocusIn);
      close();
    };
  }

  function enter(character: string): void {
    const target = state.target;
    if (!state.open || !target || character.length === 0) return;
    const inserted = state.uppercase ? character.toUpperCase() : character;
    updateTargetValue(target, (value, start, end) => ({
      value: `${value.slice(0, start)}${inserted}${value.slice(end)}`,
      cursor: start + inserted.length,
    }));
  }

  function backspace(): void {
    const target = state.target;
    if (!state.open || !target) return;
    updateTargetValue(target, (value, start, end) => {
      const deleteFrom = start === end ? Math.max(0, start - 1) : start;
      return {
        value: `${value.slice(0, deleteFrom)}${value.slice(end)}`,
        cursor: deleteFrom,
      };
    });
  }

  function submit(): void {
    const target = state.target;
    if (!state.open || !target) return;
    const form = target.form;
    if (!form) {
      close();
      return;
    }
    if (!form.reportValidity()) return;
    form.requestSubmit();
    close();
  }

  function setLayout(layout: ProtectedTouchKeyboardState["layout"]): void {
    if (!state.open) return;
    state.layout = layout;
    state.uppercase = false;
  }

  function toggleUppercase(): void {
    if (!state.open || state.layout !== "letters") return;
    state.uppercase = !state.uppercase;
  }

  function dismiss(): void {
    state.target?.blur();
    close();
  }

  return {
    state,
    backspace,
    dismiss,
    enter,
    install,
    reconcileAccess,
    setLayout,
    submit,
    toggleUppercase,
  };
}
