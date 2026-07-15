import { readonly, ref } from "vue";

const authorized = ref(false);

export const maintenanceTouchKeyboardAuthorized = readonly(authorized);

export function setMaintenanceTouchKeyboardAuthorized(value: boolean): void {
  authorized.value = value;
}
