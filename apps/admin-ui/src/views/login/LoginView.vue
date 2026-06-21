<script setup lang="ts">
import { App } from "antdv-next";
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const { message } = App.useApp();

const formState = reactive({ username: "", password: "" });
const loginError = ref<string | null>(null);

async function submit(): Promise<void> {
  loginError.value = null;
  try {
    await authStore.login(formState);
    void message.success("登录成功");
    const redirect =
      typeof route.query.redirect === "string"
        ? route.query.redirect
        : "/dashboard";
    await router.replace(redirect);
  } catch {
    loginError.value = "登录失败，请检查用户名和密码。";
  }
}
</script>

<template>
  <main class="grid min-h-screen place-items-center bg-slate-950 px-4">
    <section class="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
      <h1 class="text-2xl font-semibold text-slate-950">VEM 管理后台</h1>
      <p class="mt-2 text-sm text-slate-500">请使用后台管理员账号登录</p>
      <a-form
        class="mt-8"
        layout="vertical"
        :model="formState"
        @finish="submit"
      >
        <a-alert
          v-if="loginError"
          class="mb-4"
          type="error"
          show-icon
          :message="loginError"
        />
        <a-form-item
          label="用户名"
          name="username"
          :rules="[{ required: true, message: '请输入用户名' }]"
        >
          <a-input v-model:value="formState.username" autocomplete="username" />
        </a-form-item>
        <a-form-item
          label="密码"
          name="password"
          :rules="[{ required: true, message: '请输入密码' }]"
        >
          <a-input-password
            v-model:value="formState.password"
            autocomplete="current-password"
          />
        </a-form-item>
        <a-button
          type="primary"
          html-type="submit"
          block
          :loading="authStore.loading"
        >
          登录
        </a-button>
      </a-form>
    </section>
  </main>
</template>
