<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, watch } from "vue";

import {
  touchKeyboardLetterRows,
  touchKeyboardNumberRows,
  touchKeyboardSymbolRows,
} from "@/touch-keyboard/layouts";
import { createTouchKeyboardController } from "@/touch-keyboard/touch-keyboard";

const controller = createTouchKeyboardController();
const { state } = controller;
let removeFocusPolicy: (() => void) | null = null;

const activeRows = computed(() => {
  if (state.layout === "numbers") return touchKeyboardNumberRows;
  if (state.layout === "symbols") return touchKeyboardSymbolRows;
  return touchKeyboardLetterRows;
});
const numericOnly = computed(
  () =>
    state.target instanceof HTMLInputElement && state.target.type === "number",
);

watch(
  () => state.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    state.target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  },
);

onMounted(() => {
  removeFocusPolicy = controller.install(document);
});

onUnmounted(() => {
  removeFocusPolicy?.();
  removeFocusPolicy = null;
});
</script>

<template>
  <section
    data-test="touch-keyboard"
    class="touch-keyboard"
    :hidden="!state.open"
    aria-label="触摸键盘"
  >
    <div class="touch-keyboard__toolbar">
      <span>触摸键盘</span>
      <button
        class="touch-keyboard__utility"
        type="button"
        data-test="touch-keyboard-dismiss"
        @pointerdown.prevent
        @click="controller.dismiss"
      >
        收起
      </button>
    </div>

    <div
      v-for="(row, rowIndex) in activeRows"
      :key="`${state.layout}-${rowIndex}`"
      class="touch-keyboard__row"
    >
      <button
        v-for="key in row"
        :key="key"
        class="touch-keyboard__key"
        type="button"
        :data-key="key"
        @pointerdown.prevent
        @click="controller.enter(key)"
      >
        {{ state.uppercase ? key.toUpperCase() : key }}
      </button>
    </div>

    <div class="touch-keyboard__row">
      <button
        v-if="state.layout === 'letters'"
        class="touch-keyboard__utility"
        type="button"
        data-test="touch-keyboard-shift"
        @pointerdown.prevent
        @click="controller.toggleUppercase"
      >
        {{ state.uppercase ? "小写" : "大写" }}
      </button>
      <button
        v-if="!numericOnly && state.layout !== 'letters'"
        class="touch-keyboard__utility"
        type="button"
        @pointerdown.prevent
        @click="controller.setLayout('letters')"
      >
        ABC
      </button>
      <button
        v-if="!numericOnly && state.layout !== 'numbers'"
        class="touch-keyboard__utility"
        type="button"
        @pointerdown.prevent
        @click="controller.setLayout('numbers')"
      >
        123
      </button>
      <button
        v-if="!numericOnly && state.layout !== 'symbols'"
        class="touch-keyboard__utility"
        type="button"
        @pointerdown.prevent
        @click="controller.setLayout('symbols')"
      >
        符号
      </button>
      <button
        v-if="!numericOnly"
        class="touch-keyboard__space"
        type="button"
        data-key=" "
        @pointerdown.prevent
        @click="controller.enter(' ')"
      >
        空格
      </button>
      <button
        class="touch-keyboard__utility"
        type="button"
        data-test="touch-keyboard-backspace"
        @pointerdown.prevent
        @click="controller.backspace"
      >
        删除
      </button>
      <button
        class="touch-keyboard__submit"
        type="button"
        data-test="touch-keyboard-submit"
        @pointerdown.prevent
        @click="controller.submit"
      >
        确认
      </button>
    </div>
  </section>
</template>

<style scoped>
.touch-keyboard {
  position: fixed;
  z-index: 1000;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 14px 18px 20px;
  border-top: 1px solid rgb(148 163 184 / 35%);
  background: rgb(2 6 23 / 98%);
  box-shadow: 0 -18px 40px rgb(2 6 23 / 45%);
  color: white;
  touch-action: manipulation;
}

.touch-keyboard[hidden] {
  display: none;
}

.touch-keyboard__toolbar,
.touch-keyboard__row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 auto 8px;
  max-width: 1040px;
}

.touch-keyboard__toolbar {
  justify-content: space-between;
  font-weight: 700;
}

.touch-keyboard button {
  min-width: 64px;
  min-height: 58px;
  border: 1px solid rgb(148 163 184 / 28%);
  border-radius: 14px;
  background: rgb(30 41 59);
  color: white;
  font-size: 22px;
  font-weight: 700;
}

.touch-keyboard button:active {
  background: rgb(14 165 233);
}

.touch-keyboard__key {
  flex: 1 1 0;
}

.touch-keyboard__utility {
  padding: 0 18px;
}

.touch-keyboard__space {
  flex: 1 1 260px;
}

.touch-keyboard__submit {
  padding: 0 24px;
  background: rgb(52 211 153) !important;
  color: rgb(2 6 23) !important;
}
</style>
