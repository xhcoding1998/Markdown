<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: boolean
  align?: 'left' | 'center' | 'right'
  width?: string
}>(), { align: 'right', width: '240px' })

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const root = ref<HTMLElement>()
const panel = ref<HTMLElement>()
const panelPosition = ref({ top: 0, left: 0 })
const panelStyle = computed(() => ({
  width: props.width,
  top: `${panelPosition.value.top}px`,
  left: `${panelPosition.value.left}px`,
  transformOrigin: props.align === 'right' ? 'top right' : props.align === 'center' ? 'top center' : 'top left',
}))

function close() { emit('update:modelValue', false) }
function toggle() { emit('update:modelValue', !props.modelValue) }

function updatePosition() {
  if (!root.value || !panel.value) return
  const trigger = root.value.getBoundingClientRect()
  const popup = panel.value.getBoundingClientRect()
  const gutter = 8
  let left = trigger.left
  if (props.align === 'right') left = trigger.right - popup.width
  if (props.align === 'center') left = trigger.left + (trigger.width - popup.width) / 2
  left = Math.min(window.innerWidth - popup.width - gutter, Math.max(gutter, left))

  let top = trigger.bottom + 7
  if (top + popup.height > window.innerHeight - gutter && trigger.top - popup.height - 7 >= gutter) {
    top = trigger.top - popup.height - 7
  }
  panelPosition.value = { top: Math.max(gutter, top), left }
}

function handlePointer(event: PointerEvent) {
  const target = event.target as Node
  if (root.value && !root.value.contains(target) && !panel.value?.contains(target)) close()
}

function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape') close()
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointer)
  document.addEventListener('keydown', handleKey)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointer)
  document.removeEventListener('keydown', handleKey)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})

watch(() => props.modelValue, async (open) => {
  if (!open) return
  await nextTick()
  updatePosition()
})
</script>

<template>
  <div ref="root" class="ui-popover-root">
    <slot name="trigger" :toggle="toggle" :close="close" />
    <Teleport to="body">
      <Transition name="ui-dropdown">
        <div v-if="modelValue" ref="panel" class="ui-popover-panel" :style="panelStyle" @pointerdown.stop>
          <slot :close="close" />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.ui-popover-root { position: relative; }
.ui-popover-panel { position: fixed; z-index: 100; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel); box-shadow: var(--shadow); }
</style>
