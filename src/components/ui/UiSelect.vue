<script setup lang="ts">
import { ref } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import UiPopover from './UiPopover.vue'

type Option = { label: string; value: string | number; description?: string }
defineProps<{ modelValue: string | number; options: Option[]; ariaLabel?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()
const open = ref(false)

function choose(value: string | number) {
  emit('update:modelValue', value)
  open.value = false
}
</script>

<template>
  <UiPopover v-model="open" align="right" width="210px">
    <template #trigger>
      <button type="button" class="ui-select-trigger" :aria-label="ariaLabel" :aria-expanded="open" @click="open = !open">
        <span>{{ options.find(option => option.value === modelValue)?.label }}</span><ChevronDown :size="14" />
      </button>
    </template>
    <div class="ui-select-menu">
      <button v-for="option in options" :key="option.value" type="button" :class="{ selected: option.value === modelValue }" @click="choose(option.value)">
        <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
        <Check v-if="option.value === modelValue" :size="15" />
      </button>
    </div>
  </UiPopover>
</template>

<style scoped>
.ui-select-trigger { min-width: 112px; height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-subtle); color: var(--text-primary); cursor: pointer; transition: border-color 140ms ease, box-shadow 140ms ease; font-size: 12px; }
.ui-select-trigger:hover, .ui-select-trigger[aria-expanded=true] { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent); }
.ui-select-menu { display: flex; flex-direction: column; gap: 3px; }
.ui-select-menu button { width: 100%; min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; }
.ui-select-menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
.ui-select-menu button.selected { background: var(--accent-soft); color: var(--accent); }
.ui-select-menu span { display: flex; flex-direction: column; gap: 2px; }
.ui-select-menu strong { font-size: 12px; font-weight: 600; }
.ui-select-menu small { color: var(--text-tertiary); font-size: 10px; }
</style>
