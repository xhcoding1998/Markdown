<script setup lang="ts">
withDefaults(defineProps<{
  type?: 'button' | 'submit' | 'reset'
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
}>(), { type: 'button', variant: 'secondary', size: 'md', disabled: false })
</script>

<template>
  <button :type="type" class="ui-button" :class="[`is-${variant}`, `is-${size}`]" :disabled="disabled">
    <slot />
  </button>
</template>

<style scoped>
.ui-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: 7px; cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 120ms ease, box-shadow 140ms ease; }
.ui-button:active:not(:disabled) { transform: translateY(1px); }
.ui-button:disabled { opacity: .5; cursor: not-allowed; }
.is-md { min-height: 36px; padding: 0 14px; font-size: 12px; }
.is-sm { min-height: 30px; padding: 0 10px; font-size: 11px; }
.is-primary { border: 1px solid var(--accent); background: var(--accent); color: white; font-weight: 650; box-shadow: 0 4px 10px color-mix(in srgb, var(--accent) 18%, transparent); }
.is-primary:hover { border-color: var(--accent-hover); background: var(--accent-hover); }
.is-secondary { border: 1px solid var(--border); background: var(--bg-panel); color: var(--text-secondary); }
.is-secondary:hover { border-color: var(--border-strong); background: var(--bg-hover); color: var(--text-primary); }
.is-ghost { border: 1px solid transparent; background: transparent; color: var(--text-secondary); }
.is-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
.is-danger { border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--border)); background: color-mix(in srgb, var(--danger) 8%, var(--bg-panel)); color: var(--danger); font-weight: 650; }
.is-danger:hover { background: var(--danger); color: white; }
</style>
