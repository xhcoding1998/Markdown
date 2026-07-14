<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'

const props = defineProps<{ modelValue: string; dark: boolean; fontSize: number; tabSize: number }>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'format-state': [value: Record<string, boolean>]
  'cursor-line': [line: number]
  'drop-files': [files: FileList]
}>()

const host = ref<HTMLElement>()
let view: EditorView | undefined
let flashTimer: number | undefined
let flashVariant = false

const flashLineEffect = StateEffect.define<{ from: number; className: string }>()
const clearFlashEffect = StateEffect.define<void>()
const flashLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(flashLineEffect)) {
        next = Decoration.set([Decoration.line({ attributes: { class: effect.value.className } }).range(effect.value.from)])
      }
      if (effect.is(clearFlashEffect)) next = Decoration.none
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

function createEditor() {
  if (!host.value) return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
  })
  emitFormatState()
}

function extensions() {
  return [
    lineNumbers(), drawSelection({ cursorBlinkRate: 1100 }), highlightActiveLine(), highlightActiveLineGutter(), history(), bracketMatching(), markdown(), flashLineField,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    placeholder('开始书写 Markdown…'),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
      if (update.docChanged || update.selectionSet) emitFormatState(update.view)
      if (update.selectionSet && update.transactions.some((transaction) => transaction.isUserEvent('select'))) emitCursorLine(update.view)
    }),
    EditorView.domEventHandlers({
      pointerup: (_event, editor) => {
        window.setTimeout(() => emitCursorLine(editor), 0)
        return false
      },
      dragover: (event) => {
        const dragEvent = event as DragEvent
        if (!dragEvent.dataTransfer?.types.includes('Files')) return false
        dragEvent.preventDefault()
        dragEvent.stopPropagation()
        if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'copy'
        return true
      },
      drop: (event) => {
        const dragEvent = event as DragEvent
        if (!dragEvent.dataTransfer?.files.length) return false
        dragEvent.preventDefault()
        dragEvent.stopPropagation()
        emit('drop-files', dragEvent.dataTransfer.files)
        return true
      },
    }),
    EditorView.theme({
      '&': { height: '100%', background: 'var(--bg-editor)', fontSize: `${props.fontSize}px` },
      '.cm-scroller': { fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace", lineHeight: '1.72' },
      '.cm-content': { padding: '20px 0 80px' },
      '.cm-line': { padding: '0 20px 0 14px' },
      '.cm-gutters': { background: 'var(--editor-gutter)', color: 'var(--text-tertiary)', border: 'none', paddingTop: '20px' },
      '.cm-activeLine, .cm-activeLineGutter': { background: 'var(--editor-active)' },
      '.cm-focused': { outline: 'none' },
    }),
    ...(props.dark ? [oneDark] : []),
    EditorView.theme({
      '.cm-cursor, .cm-dropCursor': {
        borderLeft: '2px solid var(--accent) !important',
        filter: 'drop-shadow(0 0 2px color-mix(in srgb, var(--accent) 72%, transparent))',
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
        background: 'color-mix(in srgb, var(--accent) 22%, transparent) !important',
      },
      '.cm-content ::selection': {
        background: 'color-mix(in srgb, var(--accent) 24%, transparent)',
      },
    }),
    EditorState.tabSize.of(props.tabSize),
  ]
}

watch(() => props.modelValue, (value) => {
  if (!view || value === view.state.doc.toString()) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
})

watch([() => props.dark, () => props.fontSize, () => props.tabSize], () => {
  const value = view?.state.doc.toString() ?? props.modelValue
  view?.destroy()
  if (host.value) host.value.innerHTML = ''
  createEditor()
  if (view && value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
})

function goToLine(event: Event) {
  if (!view) return
  const requested = (event as CustomEvent<number>).detail
  const line = view.state.doc.line(Math.min(Math.max(requested, 1), view.state.doc.lines))
  flashVariant = !flashVariant
  window.clearTimeout(flashTimer)
  view.dispatch({
    selection: { anchor: line.from },
    effects: [
      EditorView.scrollIntoView(line.from, { y: 'center' }),
      flashLineEffect.of({ from: line.from, className: flashVariant ? 'cm-jump-highlight-a' : 'cm-jump-highlight-b' }),
    ],
  })
  view.focus()
  flashTimer = window.setTimeout(() => view?.dispatch({ effects: clearFlashEffect.of() }), 1250)
}

function applyFormat(event: Event) {
  if (!view) return
  const type = (event as CustomEvent<string>).detail
  const selection = view.state.selection.main
  const selected = view.state.sliceDoc(selection.from, selection.to)
  const line = view.state.doc.lineAt(selection.from)
  const wrappers: Record<string, [string, string, string]> = {
    bold: ['**', '**', '粗体文字'], italic: ['*', '*', '斜体文字'],
    strike: ['~~', '~~', '删除文字'], code: ['```\n', '\n```', 'code'],
  }

  if (wrappers[type]) {
    const [before, after, fallback] = wrappers[type]
    const document = view.state.doc.toString()
    const wrappedSelection = selected.startsWith(before) && selected.endsWith(after)
      && selected.length >= before.length + after.length
      && validMarkerAt(selected, 0, before) && validMarkerAt(selected, selected.length - after.length, after)
    const openingIndex = selection.from - before.length
    const closingIndex = selection.to
    const surrounded = openingIndex >= 0
      && document.slice(openingIndex, selection.from) === before
      && document.slice(selection.to, selection.to + after.length) === after
      && validMarkerAt(document, openingIndex, before) && validMarkerAt(document, closingIndex, after)

    if (wrappedSelection) {
      const inner = selected.slice(before.length, selected.length - after.length)
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert: inner }, selection: { anchor: selection.from, head: selection.from + inner.length } })
    } else if (surrounded) {
      view.dispatch({
        changes: [{ from: selection.from - before.length, to: selection.from }, { from: selection.to, to: selection.to + after.length }],
        selection: { anchor: selection.from - before.length, head: selection.to - before.length },
      })
    } else if (selection.empty) {
      const bounds = inlineBounds(document, selection.from, before, after)
      if (bounds) {
        view.dispatch({
          changes: [{ from: bounds.left, to: bounds.left + before.length }, { from: bounds.right, to: bounds.right + after.length }],
          selection: { anchor: Math.max(bounds.left, selection.from - before.length) },
        })
      } else {
        view.dispatch({
          changes: { from: selection.from, insert: `${before}${fallback}${after}` },
          selection: { anchor: selection.from + before.length, head: selection.from + before.length + fallback.length },
        })
      }
    } else {
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: `${before}${selected}${after}` },
        selection: { anchor: selection.from + before.length, head: selection.to + before.length },
      })
    }
  } else {
    const prefixes: Record<string, { insert: string; pattern: RegExp }> = {
      heading: { insert: '## ', pattern: /^#{1,6}\s/ },
      list: { insert: '- ', pattern: /^[-*+]\s(?!\[[ xX]\]\s)/ },
      task: { insert: '- [ ] ', pattern: /^[-*+]\s\[[ xX]\]\s/ },
      quote: { insert: '> ', pattern: /^>\s/ },
    }
    const prefix = prefixes[type]
    if (!prefix) return
    const match = prefix.pattern.exec(line.text)
    if (match) {
      view.dispatch({
        changes: { from: line.from, to: line.from + match[0].length },
        selection: { anchor: Math.max(line.from, selection.from - match[0].length), head: Math.max(line.from, selection.to - match[0].length) },
      })
    } else {
      view.dispatch({
        changes: { from: line.from, insert: prefix.insert },
        selection: { anchor: selection.from + prefix.insert.length, head: selection.to + prefix.insert.length },
      })
    }
  }
  view.focus()
}

function inlineBounds(document: string, position: number, before: string, after: string) {
  if (before.includes('\n') || after.includes('\n')) return undefined
  const lineStart = document.lastIndexOf('\n', Math.max(0, position - 1)) + 1
  const lineEndIndex = document.indexOf('\n', position)
  const lineEnd = lineEndIndex === -1 ? document.length : lineEndIndex
  let left = document.lastIndexOf(before, position - 1)
  while (left >= lineStart && !validMarkerAt(document, left, before)) {
    const nextSearchEnd = left - 1
    if (nextSearchEnd < lineStart) {
      left = -1
      break
    }
    const nextLeft = document.lastIndexOf(before, nextSearchEnd)
    if (nextLeft >= left) {
      left = -1
      break
    }
    left = nextLeft
  }
  let right = document.indexOf(after, position)
  while (right !== -1 && right <= lineEnd && !validMarkerAt(document, right, after)) right = document.indexOf(after, right + 1)
  if (left >= lineStart && right >= position && right <= lineEnd) return { left, right }
  return undefined
}

function validMarkerAt(document: string, index: number, marker: string) {
  if (marker !== '*') return true
  return document[index - 1] !== '*' && document[index + 1] !== '*'
}

function emitFormatState(editor = view) {
  if (!editor) return
  const selection = editor.state.selection.main
  const document = editor.state.doc.toString()
  const selected = document.slice(selection.from, selection.to)
  const line = editor.state.doc.lineAt(selection.from)
  const isInlineActive = (before: string, after: string) => {
    if (selected.startsWith(before) && selected.endsWith(after)
      && validMarkerAt(selected, 0, before) && validMarkerAt(selected, selected.length - after.length, after)) return true
    const openingIndex = selection.from - before.length
    if (openingIndex >= 0 && document.slice(openingIndex, selection.from) === before
      && document.slice(selection.to, selection.to + after.length) === after
      && validMarkerAt(document, openingIndex, before) && validMarkerAt(document, selection.to, after)) return true
    return !!inlineBounds(document, selection.from, before, after)
  }
  emit('format-state', {
    heading: /^#{1,6}\s/.test(line.text), bold: isInlineActive('**', '**'), italic: isInlineActive('*', '*'),
    strike: isInlineActive('~~', '~~'), list: /^[-*+]\s(?!\[[ xX]\]\s)/.test(line.text),
    task: /^[-*+]\s\[[ xX]\]\s/.test(line.text), quote: /^>\s/.test(line.text), code: isInlineActive('```\n', '\n```'),
  })
}

function emitCursorLine(editor = view) {
  if (!editor) return
  emit('cursor-line', editor.state.doc.lineAt(editor.state.selection.main.head).number)
}

onMounted(() => {
  createEditor()
  window.addEventListener('studio:goto-line', goToLine)
  window.addEventListener('studio:format', applyFormat)
})

onBeforeUnmount(() => {
  window.clearTimeout(flashTimer)
  window.removeEventListener('studio:goto-line', goToLine)
  window.removeEventListener('studio:format', applyFormat)
  view?.destroy()
})
</script>

<template><div ref="host" class="editor-host" /></template>

<style scoped>
.editor-host { height: 100%; min-width: 0; overflow: hidden; background: var(--bg-editor); }
</style>
