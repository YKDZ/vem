import { readonly, ref } from "vue";

export type MaintenanceTouchKeyboardSession = {
  identity: string;
  generation: number;
};

const session = ref<MaintenanceTouchKeyboardSession | null>(null);
let generation = 0;

export const maintenanceTouchKeyboardSession = readonly(session);

export function setMaintenanceTouchKeyboardSession(
  identity: string | null,
): void {
  generation += 1;
  session.value = identity === null ? null : { identity, generation };
}
