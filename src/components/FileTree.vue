<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronRight, FileText, Folder, FolderOpen, LocateFixed, Pencil, Trash2 } from '@lucide/vue'
import type { FileNode } from '../types'

const props = defineProps<{
  nodes: FileNode[]
  activePath: string
  depth?: number
}>()

const emit = defineEmits<{
  open: [node: FileNode]
  rename: [node: FileNode]
  delete: [node: FileNode]
  reveal: [node: FileNode]
  move: [sourcePath: string, targetDirectory: string]
  import: [files: FileList, targetDirectory: string]
}>()
const expanded = ref(new Set<string>())
const draggingPath = ref('')
const dropTarget = ref('')
const contextMenu = ref<{ node: FileNode; x: number; y: number } | null>(null)
let pointerStart: { x: number; y: number } | undefined
let pointerDragging = false
let pointerGhost: HTMLElement | undefined
let pointerTarget: HTMLElement | undefined
let suppressClick = false
let activePointerMove: ((event: PointerEvent) => void) | undefined
let activePointerUp: ((event: PointerEvent) => void) | undefined

watch(() => props.nodes, (nodes) => {
  const next = new Set(expanded.value)
  nodes.filter((node) => node.kind === 'directory').forEach((node) => next.add(node.relativePath))
  expanded.value = next
}, { immediate: true })

function toggle(node: FileNode) {
  if (suppressClick) return
  if (node.kind === 'file') {
    emit('open', node)
    return
  }
  const next = new Set(expanded.value)
  if (next.has(node.relativePath)) next.delete(node.relativePath)
  else next.add(node.relativePath)
  expanded.value = next
}

function isOpen(node: FileNode) {
  return expanded.value.has(node.relativePath)
}

function cleanupPointerDrag() {
  if (activePointerMove) window.removeEventListener('pointermove', activePointerMove)
  if (activePointerUp) window.removeEventListener('pointerup', activePointerUp)
  pointerGhost?.remove()
  pointerTarget?.classList.remove('pointer-drop-target')
  pointerStart = undefined
  pointerDragging = false
  pointerGhost = undefined
  pointerTarget = undefined
  activePointerMove = undefined
  activePointerUp = undefined
  draggingPath.value = ''
}

function startPointerDrag(event: PointerEvent, node: FileNode) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('.tree-actions')) return
  pointerStart = { x: event.clientX, y: event.clientY }
  draggingPath.value = node.relativePath

  function createGhost() {
    pointerGhost = document.createElement('div')
    pointerGhost.className = 'tree-drag-ghost'
    pointerGhost.textContent = node.name
    document.body.appendChild(pointerGhost)
  }

  function updateTarget(clientX: number, clientY: number) {
    pointerTarget?.classList.remove('pointer-drop-target')
    const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    const row = element?.closest<HTMLElement>('.tree-row[data-directory="true"]')
    const targetPath = row?.dataset.path || ''
    const invalid = node.kind === 'directory' && (targetPath === node.relativePath || targetPath.startsWith(`${node.relativePath}/`))
    pointerTarget = invalid ? undefined : (row || undefined)
    pointerTarget?.classList.add('pointer-drop-target')
  }

  function handleMove(event: PointerEvent) {
    if (!pointerStart) return
    if (!pointerDragging && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 5) return
    event.preventDefault()
    if (!pointerDragging) {
      pointerDragging = true
      createGhost()
    }
    if (pointerGhost) pointerGhost.style.transform = `translate3d(${event.clientX + 12}px, ${event.clientY + 12}px, 0)`
    updateTarget(event.clientX, event.clientY)
  }

  function handleUp(event: PointerEvent) {
    const wasDragging = pointerDragging
    const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
    const insideTree = !!element?.closest('.file-tree-scroll')
    const targetDirectory = pointerTarget?.dataset.path || ''
    cleanupPointerDrag()
    if (!wasDragging || !insideTree) return
    suppressClick = true
    window.setTimeout(() => { suppressClick = false }, 0)
    emit('move', node.relativePath, targetDirectory)
  }
  activePointerMove = handleMove
  activePointerUp = handleUp
  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp, { once: true })
}

function dragOverFolder(event: DragEvent, node: FileNode) {
  if (node.kind !== 'directory' || !event.dataTransfer) return
  const external = event.dataTransfer.types.includes('Files')
  if (!external) return
  event.preventDefault()
  event.stopPropagation()
  event.dataTransfer.dropEffect = 'copy'
  dropTarget.value = node.relativePath
}

function leaveFolder(event: DragEvent, node: FileNode) {
  const next = event.relatedTarget as Node | null
  if (!next || !(event.currentTarget as HTMLElement).contains(next)) {
    if (dropTarget.value === node.relativePath) dropTarget.value = ''
  }
}

function dropOnFolder(event: DragEvent, node: FileNode) {
  if (node.kind !== 'directory' || !event.dataTransfer) return
  event.preventDefault()
  event.stopPropagation()
  dropTarget.value = ''
  if (event.dataTransfer.files.length) emit('import', event.dataTransfer.files, node.relativePath)
  const next = new Set(expanded.value)
  next.add(node.relativePath)
  expanded.value = next
}

function relayMove(sourcePath: string, targetDirectory: string) {
  emit('move', sourcePath, targetDirectory)
}

function relayImport(files: FileList, targetDirectory: string) {
  emit('import', files, targetDirectory)
}

function openContextMenu(event: MouseEvent, node: FileNode) {
  const menuWidth = 210
  const menuHeight = 124
  contextMenu.value = {
    node,
    x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
    y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
  }
}

function closeContextMenu() {
  contextMenu.value = null
}

function runContextAction(action: 'reveal' | 'rename' | 'delete') {
  const node = contextMenu.value?.node
  closeContextMenu()
  if (!node) return
  if (action === 'reveal') emit('reveal', node)
  else if (action === 'rename') emit('rename', node)
  else emit('delete', node)
}

function handleContextKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeContextMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', closeContextMenu)
  window.addEventListener('blur', closeContextMenu)
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('keydown', handleContextKeydown)
})

onBeforeUnmount(() => {
  cleanupPointerDrag()
  window.removeEventListener('pointerdown', closeContextMenu)
  window.removeEventListener('blur', closeContextMenu)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('keydown', handleContextKeydown)
})
</script>

<template>
  <div class="tree" :class="{ nested: (depth || 0) > 0 }">
    <template v-for="node in nodes" :key="node.relativePath">
      <div
        class="tree-row"
        role="button"
        tabindex="0"
        :data-path="node.relativePath"
        :data-directory="node.kind === 'directory'"
        :class="{
          active: node.kind === 'file' && node.relativePath === activePath,
          dragging: draggingPath === node.relativePath,
          'drop-target': dropTarget === node.relativePath,
        }"
        :style="{ '--depth': depth || 0 }"
        :title="node.relativePath"
        @click="toggle(node)"
        @keydown.enter="toggle(node)"
        @keydown.space.prevent="toggle(node)"
        @pointerdown="startPointerDrag($event, node)"
        @dragover="dragOverFolder($event, node)"
        @dragleave="leaveFolder($event, node)"
        @drop="dropOnFolder($event, node)"
        @contextmenu.prevent.stop="openContextMenu($event, node)"
      >
        <ChevronRight v-if="node.kind === 'directory'" :size="14" class="chevron" :class="{ open: isOpen(node) }" />
        <span v-else class="chevron-spacer" />
        <FolderOpen v-if="node.kind === 'directory' && isOpen(node)" :size="16" class="folder-icon" />
        <Folder v-else-if="node.kind === 'directory'" :size="16" class="folder-icon" />
        <FileText v-else :size="15" class="file-icon" />
        <span class="node-name">{{ node.name }}</span>
        <span class="tree-actions">
          <button type="button" class="tree-action" :aria-label="`重命名 ${node.name}`" @click.stop="emit('rename', node)"><Pencil :size="12" /></button>
          <button type="button" class="tree-action danger" :aria-label="`删除 ${node.name}`" @click.stop="emit('delete', node)"><Trash2 :size="13" /></button>
        </span>
      </div>
      <Transition name="tree-expand">
        <FileTree
          v-if="node.kind === 'directory' && isOpen(node) && node.children?.length"
          :nodes="node.children"
          :active-path="activePath"
          :depth="(depth || 0) + 1"
          @open="emit('open', $event)"
          @rename="emit('rename', $event)"
          @delete="emit('delete', $event)"
          @reveal="emit('reveal', $event)"
          @move="relayMove"
          @import="relayImport"
        />
      </Transition>
    </template>
    <Teleport to="body">
      <Transition name="context-menu-pop">
        <div
          v-if="contextMenu"
          class="file-context-menu"
          role="menu"
          :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
          @pointerdown.stop
          @contextmenu.prevent
        >
          <div class="file-context-title" :title="contextMenu.node.path">{{ contextMenu.node.name }}</div>
          <button role="menuitem" @click="runContextAction('reveal')"><LocateFixed :size="15" /><span>在文件资源管理器中显示</span></button>
          <div class="file-context-divider" />
          <button role="menuitem" @click="runContextAction('rename')"><Pencil :size="14" /><span>重命名</span></button>
          <button class="danger" role="menuitem" @click="runContextAction('delete')"><Trash2 :size="14" /><span>删除</span></button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.tree { display: flex; flex-direction: column; gap: 2px; }
.tree-row { position: relative; width: 100%; height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 5px 0 calc(5px + var(--depth) * 15px); border: 0; border-radius: 6px; color: var(--text-secondary); background: transparent; font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.tree-row:hover { background: var(--bg-hover); color: var(--text-primary); }
.tree-row.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.tree-row.active::before { position: absolute; top: 3px; bottom: 3px; left: 0; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); content: ''; }
.tree-row.dragging { opacity: .42; }
.tree-row.drop-target { background: var(--accent-soft); color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 42%, transparent); }
.tree-row.pointer-drop-target { background: var(--accent-soft); color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 48%, transparent); }
.chevron { flex: none; transition: transform 140ms ease; }
.chevron.open { transform: rotate(90deg); }
.chevron-spacer { width: 14px; flex: none; }
.folder-icon { color: #7c8ba1; flex: none; }
.file-icon { color: #8b98aa; flex: none; }
.active .file-icon { color: var(--accent); }
.node-name { min-width: 0; flex: 1; overflow: hidden; padding-right: 0; text-overflow: ellipsis; white-space: nowrap; transition: padding-right 130ms ease; }
.tree-row:hover .node-name, .tree-row:focus-within .node-name { padding-right: 50px; }
.tree-actions { position: absolute; top: 50%; right: 3px; display: flex; align-items: center; opacity: 0; pointer-events: none; transform: translateY(-50%); transition: opacity 120ms ease; }
.tree-row:hover .tree-actions, .tree-actions:focus-within { opacity: 1; }
.tree-row:hover .tree-actions, .tree-actions:focus-within { pointer-events: auto; }
.tree-action { width: 23px; height: 25px; display: grid; place-items: center; flex: none; border: 0; border-radius: 5px; background: var(--bg-sidebar); color: var(--text-tertiary); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.tree-action:hover { background: var(--bg-hover-strong); color: var(--accent); }
.tree-action.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
.file-context-menu { position: fixed; z-index: 5000; width: 210px; padding: 6px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--bg-panel); box-shadow: 0 12px 34px rgba(18, 29, 46, .18), 0 2px 8px rgba(18, 29, 46, .1); color: var(--text-secondary); }
.file-context-title { overflow: hidden; padding: 5px 8px 7px; color: var(--text-tertiary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.file-context-menu button { width: 100%; height: 32px; display: flex; align-items: center; gap: 9px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 12px; text-align: left; }
.file-context-menu button:hover { background: var(--bg-hover); color: var(--accent); }
.file-context-menu button.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
.file-context-divider { height: 1px; margin: 4px 5px; background: var(--border); }
.context-menu-pop-enter-active, .context-menu-pop-leave-active { transition: opacity 110ms ease, transform 130ms cubic-bezier(.2,.8,.2,1); transform-origin: top left; }
.context-menu-pop-enter-from, .context-menu-pop-leave-to { opacity: 0; transform: translateY(-3px) scale(.97); }
.tree-expand-enter-active, .tree-expand-leave-active { overflow: hidden; transition: max-height 220ms cubic-bezier(.2,.8,.2,1), opacity 150ms ease, transform 200ms ease; }
.tree-expand-enter-from, .tree-expand-leave-to { max-height: 0; opacity: 0; transform: translateY(-4px); }
.tree-expand-enter-to, .tree-expand-leave-from { max-height: 1600px; opacity: 1; transform: translateY(0); }
</style>
