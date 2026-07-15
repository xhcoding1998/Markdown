<script setup lang="ts">
import { Minus, Plus } from '@lucide/vue'
const props = defineProps<{ modelValue: number; min: number; max: number; step?: number; suffix?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
function change(delta: number) {
  emit('update:modelValue', Math.min(props.max, Math.max(props.min, props.modelValue + delta * (props.step || 1))))
}
</script>

<template>
  <div class="ui-stepper">
    <button type="button" :disabled="modelValue <= min" aria-label="减小" @click="change(-1)"><Minus :size="13" /></button>
    <span>{{ modelValue }}{{ suffix }}</span>
    <button type="button" :disabled="modelValue >= max" aria-label="增大" @click="change(1)"><Plus :size="13" /></button>
  </div>
</template>

<style scoped>
.ui-stepper { width: 116px; min-width: 116px; height: 32px; display: grid; flex: 0 0 116px; grid-template-columns: 30px 56px 30px; align-items: center; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-subtle); }
.ui-stepper button { width: 30px; min-width: 30px; height: 100%; display: grid; place-items: center; padding: 0; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
.ui-stepper button:hover:not(:disabled) { background: var(--bg-hover); color: var(--accent); }
.ui-stepper button:disabled { opacity: .3; cursor: not-allowed; }
.ui-stepper span { display: grid; place-items: center; height: 18px; border-right: 1px solid var(--border); border-left: 1px solid var(--border); color: var(--text-primary); font-size: 11px; font-variant-numeric: tabular-nums; }
</style>
