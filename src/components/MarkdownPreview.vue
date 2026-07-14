<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import DOMPurify from 'dompurify'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { isTauri } from '../services/desktop'

const props = defineProps<{ content: string }>()
const article = ref<HTMLElement>()
let jumpTimer: number | undefined

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character] || character)
}

function renderCodeBlock(code: string, language = ''): string {
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language }).value
    : escapeHtml(code)
  return `<div class="code-block"><button type="button" class="code-copy-button" data-code-copy aria-label="复制代码" title="复制代码">复制</button><pre class="hljs"><code>${highlighted}</code></pre></div>`
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(code, language): string {
    return renderCodeBlock(code, language)
  },
})

md.renderer.rules.code_block = (tokens, index) => renderCodeBlock(tokens[index].content)

const mappedBlockTypes = new Set([
  'heading_open', 'paragraph_open', 'blockquote_open', 'bullet_list_open',
  'ordered_list_open', 'list_item_open', 'table_open', 'fence', 'code_block',
])

md.core.ruler.after('block', 'source-line-map', (state) => {
  for (const token of state.tokens) {
    if (token.map && mappedBlockTypes.has(token.type)) token.attrSet('data-source-line', String(token.map[0] + 1))
  }
})

const html = computed(() => DOMPurify.sanitize(md.render(props.content)))

async function copyCode(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-code-copy]')
  if (!button) return
  const code = button.parentElement?.querySelector('code')?.textContent || ''
  let copied = false
  button.textContent = '复制中…'
  button.classList.add('copying')
  try {
    if (isTauri()) {
      await writeText(code)
    } else {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await Promise.race([
        navigator.clipboard.writeText(code),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error('Clipboard timeout')), 350)),
      ])
    }
    copied = true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = code
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    copied = document.execCommand('copy')
    textarea.remove()
  }

  button.classList.remove('copying')
  window.clearTimeout(Number(button.dataset.resetTimer || 0))
  button.textContent = copied ? '已复制' : '复制失败'
  button.classList.toggle('copied', copied)
  button.classList.toggle('copy-error', !copied)
  button.dataset.resetTimer = String(window.setTimeout(() => {
    button.textContent = '复制'
    button.classList.remove('copied', 'copy-error')
  }, 1600))
}

function goToSourceLine(event: Event) {
  const requested = (event as CustomEvent<number>).detail
  if (!article.value || !Number.isFinite(requested)) return
  const blocks = [...article.value.querySelectorAll<HTMLElement>('[data-source-line]')]
  const target = blocks.reduce<HTMLElement | undefined>((closest, block) => {
    const line = Number(block.dataset.sourceLine || 0)
    if (line > requested) return closest
    return !closest || line >= Number(closest.dataset.sourceLine || 0) ? block : closest
  }, undefined) || blocks[0]
  if (!target) return
  window.clearTimeout(jumpTimer)
  article.value.querySelector('.preview-jump-highlight')?.classList.remove('preview-jump-highlight')
  target.classList.remove('preview-jump-highlight')
  void target.offsetWidth
  target.classList.add('preview-jump-highlight')
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  jumpTimer = window.setTimeout(() => target.classList.remove('preview-jump-highlight'), 1250)
}

function followCursorLine(event: Event) {
  const requested = (event as CustomEvent<number>).detail
  const target = sourceBlockAtLine(requested)
  if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function sourceBlockAtLine(requested: number) {
  if (!article.value || !Number.isFinite(requested)) return undefined
  const blocks = [...article.value.querySelectorAll<HTMLElement>('[data-source-line]')]
  return blocks.reduce<HTMLElement | undefined>((closest, block) => {
    const line = Number(block.dataset.sourceLine || 0)
    if (line > requested) return closest
    return !closest || line >= Number(closest.dataset.sourceLine || 0) ? block : closest
  }, undefined) || blocks[0]
}

onMounted(() => {
  window.addEventListener('studio:goto-line', goToSourceLine)
  window.addEventListener('studio:cursor-line', followCursorLine)
})
onBeforeUnmount(() => {
  window.clearTimeout(jumpTimer)
  window.removeEventListener('studio:goto-line', goToSourceLine)
  window.removeEventListener('studio:cursor-line', followCursorLine)
})

</script>

<template>
  <article ref="article" class="markdown-body" v-html="html" @click="copyCode" />
</template>

<style>
.markdown-body { max-width: 860px; margin: 0 auto; padding: 38px 44px 100px; color: var(--text-primary); font-size: 15px; line-height: 1.78; overflow-wrap: anywhere; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { color: var(--text-strong); line-height: 1.3; font-weight: 720; letter-spacing: -0.02em; }
.markdown-body h1 { margin: 0 0 32px; font-size: 32px; }
.markdown-body h2 { margin: 34px 0 14px; font-size: 23px; }
.markdown-body h3 { margin: 28px 0 12px; font-size: 18px; }
.markdown-body p { margin: 12px 0; }
.markdown-body blockquote { margin: 18px 0; padding: 7px 0 7px 18px; border-left: 3px solid var(--border-strong); color: var(--text-secondary); }
.markdown-body ul, .markdown-body ol { padding-left: 26px; }
.markdown-body li { margin: 7px 0; }
.markdown-body table { width: 100%; margin: 16px 0; border-collapse: separate; border-spacing: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; font-size: 14px; }
.markdown-body th, .markdown-body td { padding: 9px 12px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; }
.markdown-body th:last-child, .markdown-body td:last-child { border-right: 0; }
.markdown-body tr:last-child td { border-bottom: 0; }
.markdown-body th { background: var(--bg-subtle); font-weight: 650; }
.markdown-body :not(pre) > code { padding: 2px 6px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-family: 'Cascadia Code', Consolas, monospace; font-size: 0.88em; }
.markdown-body .code-block { position: relative; margin: 18px 0; }
.markdown-body pre.hljs { margin: 0; padding: 20px; overflow: auto; border-radius: 9px; background: #18202d; color: #dbe5f5; font-size: 13px; line-height: 1.7; }
.markdown-body .code-copy-button { position: absolute; z-index: 2; top: 10px; right: 10px; height: 28px; padding: 0 9px; border: 1px solid rgba(255,255,255,.13); border-radius: 6px; background: rgba(34,43,57,.88); color: #aeb9c9; cursor: pointer; font-size: 11px; line-height: 1; opacity: 0; backdrop-filter: blur(8px); transition: opacity 140ms ease, color 140ms ease, border-color 140ms ease, background 140ms ease; }
.markdown-body .code-block:hover .code-copy-button, .markdown-body .code-copy-button:focus-visible, .markdown-body .code-copy-button.copying, .markdown-body .code-copy-button.copied, .markdown-body .code-copy-button.copy-error { opacity: 1; }
.markdown-body .code-copy-button:hover { border-color: rgba(255,255,255,.25); background: rgba(52,64,82,.96); color: #f4f7fb; }
.markdown-body .code-copy-button:focus-visible { outline: 2px solid #66a0ff; outline-offset: 2px; }
.markdown-body .code-copy-button.copied { border-color: rgba(85,200,150,.35); background: rgba(28,89,66,.92); color: #7ce1b5; }
.markdown-body .code-copy-button.copy-error { border-color: rgba(255,113,130,.35); background: rgba(100,39,49,.92); color: #ff9ba7; }
.markdown-body a { color: var(--accent); text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
.markdown-body .preview-jump-highlight { border-radius: 4px; animation: preview-target-highlight 1.2s ease-out; }
@keyframes preview-target-highlight {
  0%, 28% { background: color-mix(in srgb, var(--accent) 22%, var(--bg-preview)); box-shadow: inset 3px 0 0 var(--accent); }
  100% { background: transparent; box-shadow: inset 3px 0 0 transparent; }
}
@media (max-width: 900px) { .markdown-body { padding: 28px 28px 80px; } }
</style>
