<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { X } from '@lucide/vue'

withDefaults(defineProps<{ modelValue: boolean; title: string; width?: string }>(), { width: '430px' })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
function close() { emit('update:modelValue', false) }
function handleKey(event: KeyboardEvent) { if (event.key === 'Escape') close() }
onMounted(() => document.addEventListener('keydown', handleKey))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-modal">
      <div v-if="modelValue" class="ui-modal-backdrop" @mousedown.self="close">
        <section class="ui-modal-card" role="dialog" aria-modal="true" :aria-label="title" :style="{ '--ui-modal-width': width }">
          <header><strong>{{ title }}</strong><button type="button" aria-label="关闭" @click="close"><X :size="17" /></button></header>
          <div class="ui-modal-content"><slot /></div>
          <footer v-if="$slots.footer"><slot name="footer" :close="close" /></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-modal-backdrop { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 16px; background: rgba(10, 15, 24, .42); backdrop-filter: blur(3px); }
.ui-modal-card { width: min(var(--ui-modal-width), 100%); max-height: calc(100vh - 32px); overflow: hidden; border: 1px solid var(--border); border-radius: 13px; background: var(--bg-panel); box-shadow: var(--shadow); }
header { height: 58px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid var(--border); color: var(--text-strong); font-size: 15px; }
header button { width: 29px; height: 29px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--text-tertiary); cursor: pointer; transition: background 140ms ease, color 140ms ease; }
header button:hover { background: var(--bg-hover); color: var(--text-primary); }
.ui-modal-content { padding: 20px; }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--border); background: var(--bg-subtle); }
</style>
