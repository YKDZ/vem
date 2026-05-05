import type { PermissionCode } from "@vem/shared";

import { defineStore } from "pinia";

import { loginApi, meApi, refreshApi, type CurrentAdmin } from "@/api/auth";
import { tokenStorage } from "@/api/request";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    accessToken: tokenStorage.getAccessToken(),
    refreshToken: tokenStorage.getRefreshToken(),
    currentAdmin: null as CurrentAdmin | null,
    loading: false,
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.accessToken),
    permissions: (state): PermissionCode[] =>
      state.currentAdmin?.permissions ?? [],
  },
  actions: {
    hasPermission(permission: PermissionCode): boolean {
      return this.permissions.includes(permission);
    },
    hasEveryPermission(permissions: PermissionCode[]): boolean {
      return permissions.every((permission) => this.hasPermission(permission));
    },
    async login(input: { username: string; password: string }): Promise<void> {
      this.loading = true;
      try {
        const tokens = await loginApi(input);
        tokenStorage.setTokens(tokens.accessToken, tokens.refreshToken);
        this.accessToken = tokens.accessToken;
        this.refreshToken = tokens.refreshToken ?? null;
        await this.fetchMe();
      } finally {
        this.loading = false;
      }
    },
    async fetchMe(): Promise<void> {
      if (!this.accessToken) return;
      this.currentAdmin = await meApi();
    },
    async refresh(): Promise<void> {
      if (!this.refreshToken) throw new Error("refresh token missing");
      const tokens = await refreshApi(this.refreshToken);
      tokenStorage.setTokens(tokens.accessToken, tokens.refreshToken);
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken ?? this.refreshToken;
    },
    logout(): void {
      tokenStorage.clear();
      this.accessToken = null;
      this.refreshToken = null;
      this.currentAdmin = null;
    },
  },
});
