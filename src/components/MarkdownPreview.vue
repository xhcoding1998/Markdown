<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import { Minus, Plus, RotateCcw, X, ZoomIn } from '@lucide/vue'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { isTauri, resolveImageUrl as resolveDesktopImageUrl } from '../services/desktop'
import { resolveAssetUrl as resolveWebImageUrl } from '../services/webWorkspace'
import type { CodeBlockMode, CodeTheme, CodeWrapMode } from '../types'

const props = defineProps<{
  content: string
  fontSize: number
  documentPath: string
  codeBlockMode: CodeBlockMode
  codeBlockMaxHeight: number
  codeTheme: CodeTheme
  codeWrapMode: CodeWrapMode
}>()
const emit = defineEmits<{ 'update:content': [value: string] }>()
const article = ref<HTMLElement>()
const lightboxStage = ref<HTMLElement>()
const lightboxImage = ref<HTMLImageElement>()
const assetUrls = ref(new Map<string, string>())
const assetRevision = ref(0)
const renderedContent = ref(props.content)
const lightboxUrl = ref('')
const lightboxAlt = ref('')
const lightboxZoom = ref(100)
const lightboxPan = ref({ x: 0, y: 0 })
const lightboxDragging = ref(false)
const lightboxViewChanged = computed(() => lightboxZoom.value !== 100 || lightboxPan.value.x !== 0 || lightboxPan.value.y !== 0)
let panStart = { pointerX: 0, pointerY: 0, x: 0, y: 0 }
let pendingPresentationContent = ''
let imageSizeDrag: { handle: HTMLElement; frame: HTMLElement; source: string; pointerId: number; width: number; startX: number; startWidth: number; availableWidth: number; side: 'left' | 'right'; centered: boolean } | undefined
let jumpTimer: number | undefined
let assetGeneration = 0

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
  html: true,
  linkify: true,
  typographer: true,
  highlight(code, language): string {
    return renderCodeBlock(code, language)
  },
})

md.core.ruler.after('inline', 'task-list-items', (state) => {
  const openItems: number[] = []
  state.tokens.forEach((token, index) => {
    if (token.type === 'list_item_open') {
      openItems.push(index)
      return
    }
    if (token.type === 'list_item_close') {
      openItems.pop()
      return
    }
    if (token.type !== 'inline' || !openItems.length || !token.children?.length) return

    const textToken = token.children.find((child) => child.type === 'text')
    const task = textToken && /^\[([ xX])\]\s+/.exec(textToken.content)
    if (!textToken || !task) return

    const checked = task[1].toLowerCase() === 'x'
    textToken.content = textToken.content.slice(task[0].length)
    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input class="task-checkbox" type="checkbox" disabled aria-label="${checked ? '已完成' : '未完成'}"${checked ? ' checked' : ''}>`
    token.children.unshift(checkbox)
    state.tokens[openItems[openItems.length - 1]].attrJoin('class', 'task-list-item')
  })
})

md.renderer.rules.code_block = (tokens, index) => renderCodeBlock(tokens[index].content)

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (
    node.nodeName === 'IMG'
    && data.attrName === 'src'
    && (/^blob:/i.test(data.attrValue) || /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif);base64,/i.test(data.attrValue))
  ) {
    data.forceKeepAttr = true
  }
})

const defaultImageRenderer = md.renderer.rules.image || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const source = tokens[index].attrGet('src') || ''
  let decodedSource = source
  try { decodedSource = decodeURIComponent(source) } catch { /* Keep malformed paths unchanged. */ }
  const resolved = assetUrls.value.get(source) || assetUrls.value.get(decodedSource)
  if (resolved) tokens[index].attrSet('src', resolved)
  tokens[index].attrSet('class', 'preview-image')
  tokens[index].attrSet('loading', 'lazy')
  tokens[index].attrSet('decoding', 'async')
  const image = defaultImageRenderer(tokens, index, options, env, self)
  const presentation = imagePresentation(decodedSource)
  const widthStyle = presentation.width ? ` style="--preview-image-width:${presentation.width}%"` : ''
  const widthLabel = presentation.width ? `${presentation.width}%` : '自动'
  return `<span class="preview-image-frame image-align-${presentation.align}" data-preview-image data-image-source="${md.utils.escapeHtml(decodedSource)}" data-image-width="${presentation.width}"${widthStyle}>${image}<span class="preview-image-tools"><span class="preview-image-align-tools"><button type="button" class="${presentation.align === 'left' ? 'active' : ''}" data-image-align="left" title="左对齐" aria-label="左对齐"><i class="align-glyph left"></i></button><button type="button" class="${presentation.align === 'center' ? 'active' : ''}" data-image-align="center" title="居中" aria-label="居中"><i class="align-glyph center"></i></button><button type="button" class="${presentation.align === 'right' ? 'active' : ''}" data-image-align="right" title="右对齐" aria-label="右对齐"><i class="align-glyph right"></i></button></span><span class="preview-image-tool-divider"></span><button type="button" class="preview-image-width-label" data-image-size="reset" title="恢复自适应宽度">${widthLabel}</button></span><button type="button" class="preview-image-action" data-image-preview title="放大预览">预览</button><i class="preview-image-resize-handle" data-image-resize="right" title="拖动调整图片大小"></i></span>`
}

const mappedBlockTypes = new Set([
  'heading_open', 'paragraph_open', 'blockquote_open', 'bullet_list_open',
  'ordered_list_open', 'list_item_open', 'table_open', 'fence', 'code_block',
])

md.core.ruler.after('block', 'source-line-map', (state) => {
  for (const token of state.tokens) {
    if (token.map && mappedBlockTypes.has(token.type)) token.attrSet('data-source-line', String(token.map[0] + 1))
  }
})

const html = computed(() => {
  void assetRevision.value
  return DOMPurify.sanitize(md.render(renderedContent.value))
})

function imageReferences(content: string) {
  return [...content.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => match[1] || match[2])
    .filter((reference) => reference && !/^(?:data:|https?:|blob:|\/\/)/i.test(reference))
}

async function refreshAssetUrls() {
  const generation = ++assetGeneration
  const next = new Map<string, string>()
  if (props.documentPath) {
    await Promise.all([...new Set(imageReferences(props.content))].map(async (reference) => {
      const url = isTauri()
        ? await resolveDesktopImageUrl(reference, props.documentPath)
        : await resolveWebImageUrl(reference, props.documentPath)
      if (url) next.set(reference, url)
    }))
  }
  if (generation !== assetGeneration) {
    next.forEach((url) => URL.revokeObjectURL(url))
    return
  }
  assetUrls.value.forEach((url) => URL.revokeObjectURL(url))
  assetUrls.value = next
  assetRevision.value += 1
}

const assetReferenceSignature = computed(() => imageReferences(props.content).map((reference) => reference.split('#')[0]).join('\n'))
watch(() => [assetReferenceSignature.value, props.documentPath], refreshAssetUrls, { immediate: true })
watch(() => props.content, (value) => {
  if (value === pendingPresentationContent) {
    pendingPresentationContent = ''
    return
  }
  pendingPresentationContent = ''
  renderedContent.value = value
})
watch(html, async () => {
  await nextTick()
  article.value?.querySelectorAll<HTMLImageElement>('.preview-image').forEach((image) => {
    if (image.complete && image.naturalWidth === 0) showMissingImage(image)
  })
}, { immediate: true })

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

function handleArticleClick(event: MouseEvent) {
  const command = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-image-align], [data-image-size]')
  if (command) {
    event.preventDefault()
    event.stopPropagation()
    const frame = command.closest<HTMLElement>('.preview-image-frame')
    const source = frame?.dataset.imageSource
    if (!source) return
    if (command.dataset.imageAlign) {
      applyImageFramePresentation(frame, command.dataset.imageAlign as 'left' | 'center' | 'right')
      updateImagePresentation(source, 'align', command.dataset.imageAlign, frame)
    }
    else if (command.dataset.imageSize) {
      applyImageFramePresentation(frame, undefined, 0)
      updateImagePresentation(source, 'width', '0', frame)
    }
    return
  }
  void copyCode(event)
  const previewButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-image-preview]')
  if (!previewButton) return
  const image = previewButton.closest<HTMLElement>('.preview-image-frame')?.querySelector<HTMLImageElement>('img')
  if (!image?.src || image.closest('.image-load-error')) return
  lightboxUrl.value = image.src
  lightboxAlt.value = image.alt || '图片预览'
  lightboxZoom.value = 100
  lightboxPan.value = { x: 0, y: 0 }
}

function applyImageFramePresentation(frame: HTMLElement, align?: 'left' | 'center' | 'right', width?: number) {
  if (align) {
    frame.classList.remove('image-align-left', 'image-align-center', 'image-align-right')
    frame.classList.add(`image-align-${align}`)
    frame.querySelectorAll<HTMLElement>('[data-image-align]').forEach((button) => button.classList.toggle('active', button.dataset.imageAlign === align))
  }
  if (width === undefined) return
  frame.dataset.imageWidth = String(width)
  if (width) frame.style.setProperty('--preview-image-width', `${width}%`)
  else frame.style.removeProperty('--preview-image-width')
  const label = frame.querySelector<HTMLElement>('.preview-image-width-label')
  if (label) label.textContent = width ? `${width}%` : '自动'
}

function handleImageSizePointerDown(event: PointerEvent) {
  const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-image-resize]')
  const frame = handle?.closest<HTMLElement>('.preview-image-frame')
  const source = frame?.dataset.imageSource
  if (!handle || !frame || !source || event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  const parent = frame.parentElement || article.value
  const parentStyle = parent ? getComputedStyle(parent) : undefined
  const availableWidth = parent
    ? parent.clientWidth - parseFloat(parentStyle?.paddingLeft || '0') - parseFloat(parentStyle?.paddingRight || '0')
    : frame.getBoundingClientRect().width
  const bounds = frame.getBoundingClientRect()
  imageSizeDrag = {
    handle,
    frame,
    source,
    pointerId: event.pointerId,
    width: Number(frame.dataset.imageWidth || 0) || Math.round((bounds.width / availableWidth) * 100),
    startX: event.clientX,
    startWidth: bounds.width,
    availableWidth,
    side: handle.dataset.imageResize === 'left' ? 'left' : 'right',
    centered: frame.classList.contains('image-align-center'),
  }
  frame.classList.add('resizing')
  handle.setPointerCapture(event.pointerId)
}

function handleImageSizePointerMove(event: PointerEvent) {
  if (!imageSizeDrag || imageSizeDrag.pointerId !== event.pointerId) return
  updateDraggedImageWidth(event.clientX)
}

function handleImageSizePointerUp(event: PointerEvent) {
  if (!imageSizeDrag || imageSizeDrag.pointerId !== event.pointerId) return
  const drag = imageSizeDrag
  imageSizeDrag = undefined
  drag.frame.classList.remove('resizing')
  if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId)
  updateImagePresentation(drag.source, 'width', String(drag.width), drag.frame)
}

function updateDraggedImageWidth(clientX: number) {
  if (!imageSizeDrag) return
  const rawDelta = imageSizeDrag.side === 'left' ? imageSizeDrag.startX - clientX : clientX - imageSizeDrag.startX
  const delta = rawDelta * (imageSizeDrag.centered ? 2 : 1)
  const width = Math.min(100, Math.max(20, Math.round(((imageSizeDrag.startWidth + delta) / imageSizeDrag.availableWidth) * 100)))
  imageSizeDrag.width = width
  applyImageFramePresentation(imageSizeDrag.frame, undefined, width)
}

function imagePresentation(source: string) {
  const fragment = source.includes('#') ? source.slice(source.indexOf('#') + 1) : ''
  const params = new URLSearchParams(fragment)
  const requestedAlign = params.get('madang-align')
  const align = requestedAlign === 'left' || requestedAlign === 'right' ? requestedAlign : 'center'
  const requestedWidth = Number(params.get('madang-width') || 0)
  const width = Number.isFinite(requestedWidth) && requestedWidth >= 20 && requestedWidth <= 100 ? requestedWidth : 0
  return { align, width }
}

function updateImagePresentation(source: string, property: 'align' | 'width', value: string, frame?: HTMLElement) {
  let updated = false
  const nextContent = props.content.replace(
    /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))((?:\s+["'][^"']*["'])?)\)/g,
    (whole, alt: string, angleReference: string | undefined, plainReference: string | undefined, title: string) => {
      if (updated) return whole
      const reference = angleReference || plainReference || ''
      let decodedReference = reference
      try { decodedReference = decodeURIComponent(reference) } catch { /* Keep malformed paths unchanged. */ }
      if (decodedReference !== source) return whole

      const hashIndex = decodedReference.indexOf('#')
      const base = hashIndex >= 0 ? decodedReference.slice(0, hashIndex) : decodedReference
      const params = new URLSearchParams(hashIndex >= 0 ? decodedReference.slice(hashIndex + 1) : '')
      if (property === 'align') {
        if (value === 'center') params.delete('madang-align')
        else params.set('madang-align', value)
      } else {
        const width = Number(value)
        if (!width) params.delete('madang-width')
        else params.set('madang-width', String(width))
      }
      const serialized = params.toString()
      const nextReference = serialized ? `${base}#${serialized}` : base
      if (frame) frame.dataset.imageSource = nextReference
      updated = true
      return `![${alt}](${angleReference ? `<${nextReference}>` : nextReference}${title || ''})`
    },
  )
  if (updated && nextContent !== props.content) {
    pendingPresentationContent = nextContent
    emit('update:content', nextContent)
  }
}

function handlePreviewImageError(event: Event) {
  const image = event.target as HTMLImageElement
  if (image.matches('.preview-image')) showMissingImage(image)
}

function handlePreviewImageLoad(event: Event) {
  const image = event.target as HTMLImageElement
  if (!image.matches('.preview-image') || !image.naturalWidth) return
  const frame = image.closest<HTMLElement>('.preview-image-frame')
  frame?.classList.remove('image-load-error')
  frame?.querySelector('.preview-image-missing')?.remove()
  image.hidden = false
}

function showMissingImage(image: HTMLImageElement) {
  const frame = image.closest<HTMLElement>('.preview-image-frame')
  if (!frame || frame.classList.contains('image-load-error')) return
  frame.classList.add('image-load-error')
  image.hidden = true
  const fallback = document.createElement('span')
  fallback.className = 'preview-image-missing'
  const title = document.createElement('strong')
  title.textContent = '图片资源不可用'
  const source = document.createElement('small')
  const rawSource = frame.dataset.imageSource || image.alt || '无法读取图片'
  let decodedSource = rawSource
  try { decodedSource = decodeURIComponent(rawSource) } catch { /* Keep malformed paths readable. */ }
  source.textContent = decodedSource.split(/[\\/]/).pop() || decodedSource
  source.title = decodedSource
  fallback.append(title, source)
  frame.append(fallback)
}

function closeLightbox() {
  lightboxUrl.value = ''
  lightboxAlt.value = ''
  lightboxZoom.value = 100
  lightboxPan.value = { x: 0, y: 0 }
  lightboxDragging.value = false
}

function changeLightboxZoom(delta: number) {
  zoomLightboxTo(lightboxZoom.value + delta)
}

function zoomLightboxTo(nextZoom: number, clientX?: number, clientY?: number) {
  const stage = lightboxStage.value
  const oldZoom = lightboxZoom.value
  const zoom = Math.min(400, Math.max(50, nextZoom))
  if (!stage || zoom === oldZoom) return
  const bounds = stage.getBoundingClientRect()
  const pointX = (clientX ?? bounds.left + bounds.width / 2) - (bounds.left + bounds.width / 2)
  const pointY = (clientY ?? bounds.top + bounds.height / 2) - (bounds.top + bounds.height / 2)
  const ratio = zoom / oldZoom
  const nextPan = {
    x: pointX - (pointX - lightboxPan.value.x) * ratio,
    y: pointY - (pointY - lightboxPan.value.y) * ratio,
  }
  lightboxZoom.value = zoom
  lightboxPan.value = clampLightboxPan(nextPan.x, nextPan.y, zoom)
}

function resetLightboxView() {
  lightboxZoom.value = 100
  lightboxPan.value = { x: 0, y: 0 }
}

function handleLightboxWheel(event: WheelEvent) {
  const direction = event.deltaY < 0 ? 10 : -10
  zoomLightboxTo(lightboxZoom.value + direction, event.clientX, event.clientY)
}

function startLightboxPan(event: PointerEvent) {
  if (event.button !== 0 || !(event.target as HTMLElement).closest('img')) return
  lightboxDragging.value = true
  panStart = { pointerX: event.clientX, pointerY: event.clientY, x: lightboxPan.value.x, y: lightboxPan.value.y }
  lightboxStage.value?.setPointerCapture(event.pointerId)
}

function moveLightboxPan(event: PointerEvent) {
  if (!lightboxDragging.value) return
  lightboxPan.value = clampLightboxPan(
    panStart.x + event.clientX - panStart.pointerX,
    panStart.y + event.clientY - panStart.pointerY,
    lightboxZoom.value,
  )
}

function stopLightboxPan(event: PointerEvent) {
  if (!lightboxDragging.value) return
  lightboxDragging.value = false
  if (lightboxStage.value?.hasPointerCapture(event.pointerId)) lightboxStage.value.releasePointerCapture(event.pointerId)
}

function clampLightboxPan(x: number, y: number, zoom: number) {
  const stage = lightboxStage.value
  const image = lightboxImage.value
  if (!stage || !image) return { x: 0, y: 0 }
  const scale = zoom / 100
  const style = getComputedStyle(stage)
  const viewportWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  const viewportHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  const maxX = Math.max(0, (image.clientWidth * scale - viewportWidth) / 2)
  const maxY = Math.max(0, (image.clientHeight * scale - viewportHeight) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  }
}

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && lightboxUrl.value) closeLightbox()
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
  window.addEventListener('keydown', handleWindowKeydown)
})
onBeforeUnmount(() => {
  window.clearTimeout(jumpTimer)
  assetGeneration += 1
  assetUrls.value.forEach((url) => URL.revokeObjectURL(url))
  window.removeEventListener('studio:goto-line', goToSourceLine)
  window.removeEventListener('studio:cursor-line', followCursorLine)
  window.removeEventListener('keydown', handleWindowKeydown)
})

</script>

<template>
  <article ref="article" class="markdown-body" :class="[`code-theme-${codeTheme}`, { 'code-blocks-limited': codeBlockMode === 'limited', 'code-blocks-wrap': codeWrapMode === 'wrap' }]" :style="{ '--preview-font-size': `${fontSize}px`, '--code-block-max-height': `${codeBlockMaxHeight}px` }" v-html="html" @click="handleArticleClick" @pointerdown="handleImageSizePointerDown" @pointermove="handleImageSizePointerMove" @pointerup="handleImageSizePointerUp" @pointercancel="handleImageSizePointerUp" @error.capture="handlePreviewImageError" @load.capture="handlePreviewImageLoad" />
  <Teleport to="body">
    <Transition name="image-lightbox">
      <div v-if="lightboxUrl" class="image-lightbox" role="dialog" aria-modal="true" :aria-label="lightboxAlt" @mousedown.self="closeLightbox">
        <section class="image-lightbox-card">
          <div class="image-lightbox-toolbar">
            <span class="image-lightbox-title"><ZoomIn :size="15" />{{ lightboxAlt }}</span>
            <div class="image-lightbox-controls">
              <button type="button" title="缩小" :disabled="lightboxZoom <= 50" @click="changeLightboxZoom(-20)"><Minus :size="16" /></button>
              <button type="button" class="image-lightbox-percent" title="适应窗口" @click="resetLightboxView">{{ lightboxZoom }}%</button>
              <button type="button" title="放大" :disabled="lightboxZoom >= 400" @click="changeLightboxZoom(20)"><Plus :size="16" /></button>
              <span class="image-lightbox-divider" />
              <button type="button" class="image-lightbox-reset" title="重置缩放与位置" :disabled="!lightboxViewChanged" @click="resetLightboxView"><RotateCcw :size="14" /><span>重置</span></button>
              <span class="image-lightbox-divider" />
              <button type="button" title="关闭" @click="closeLightbox"><X :size="17" /></button>
            </div>
          </div>
          <div ref="lightboxStage" class="image-lightbox-stage" :class="{ dragging: lightboxDragging }" @wheel.prevent="handleLightboxWheel" @pointerdown="startLightboxPan" @pointermove="moveLightboxPan" @pointerup="stopLightboxPan" @pointercancel="stopLightboxPan" @dblclick="resetLightboxView">
            <img ref="lightboxImage" :src="lightboxUrl" :alt="lightboxAlt" draggable="false" :style="{ transform: `translate3d(${lightboxPan.x}px, ${lightboxPan.y}px, 0) scale(${lightboxZoom / 100})` }">
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.markdown-body { max-width: 860px; margin: 0 auto; padding: 38px 44px 100px; color: var(--text-primary); font-family: var(--font-app); font-size: var(--preview-font-size, 15px); line-height: 1.78; overflow-wrap: anywhere; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { color: var(--text-strong); line-height: 1.3; font-weight: 720; letter-spacing: -0.02em; }
.markdown-body h1 { margin: 0 0 32px; font-size: 2.133em; }
.markdown-body h2 { margin: 34px 0 14px; font-size: 1.533em; }
.markdown-body h3 { margin: 28px 0 12px; font-size: 1.2em; }
.markdown-body p { margin: 12px 0; }
.markdown-body blockquote { margin: 18px 0; padding: 7px 0 7px 18px; border-left: 3px solid var(--border-strong); color: var(--text-secondary); }
.markdown-body ul, .markdown-body ol { padding-left: 26px; }
.markdown-body li { margin: 7px 0; }
.markdown-body .task-list-item { list-style: none; }
.markdown-body .task-checkbox { width: 15px; height: 15px; margin: 0 8px 0 -23px; border: 1px solid var(--border-strong); border-radius: 3px; appearance: none; background: var(--bg-panel); vertical-align: -2px; pointer-events: none; }
.markdown-body .task-checkbox:checked { border-color: var(--accent); background-color: var(--accent); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='white' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m4 8 2.5 2.5L12 5'/%3E%3C/svg%3E"); }
.markdown-body table { width: 100%; margin: 16px 0; border-collapse: separate; border-spacing: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; font-size: .933em; }
.markdown-body th, .markdown-body td { padding: 9px 12px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; }
.markdown-body th:last-child, .markdown-body td:last-child { border-right: 0; }
.markdown-body tr:last-child td { border-bottom: 0; }
.markdown-body th { background: var(--bg-subtle); font-weight: 650; }
.markdown-body :not(pre) > code { padding: 2px 6px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-family: var(--font-app); font-size: 0.88em; }
.markdown-body .code-block { position: relative; margin: 18px 0; }
.markdown-body pre.hljs { margin: 0; padding: 20px; overflow: auto; border: 1px solid var(--code-border); border-radius: 9px; background: var(--code-bg); color: var(--code-text); font-family: var(--font-app); font-size: .867em; font-variant-ligatures: contextual; line-height: 1.7; scrollbar-gutter: stable; }
.markdown-body pre.hljs code { font-family: inherit; }
.markdown-body.code-blocks-limited pre.hljs { max-height: var(--code-block-max-height, 420px); }
.markdown-body.code-blocks-wrap pre.hljs { white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; }
.markdown-body .code-copy-button { position: absolute; z-index: 2; top: 10px; right: 10px; height: 28px; padding: 0 9px; border: 1px solid var(--code-button-border); border-radius: 6px; background: var(--code-button-bg); color: var(--code-button-text); cursor: pointer; font-family: var(--font-app); font-size: 11px; font-weight: 500; line-height: 1; opacity: 0; backdrop-filter: blur(8px); transition: opacity 140ms ease, color 140ms ease, border-color 140ms ease, background 140ms ease; }
.markdown-body .code-block:hover .code-copy-button, .markdown-body .code-copy-button:focus-visible, .markdown-body .code-copy-button.copying, .markdown-body .code-copy-button.copied, .markdown-body .code-copy-button.copy-error { opacity: 1; }
.markdown-body .code-copy-button:hover { border-color: var(--code-button-hover-border); background: var(--code-button-hover-bg); color: var(--code-button-hover-text); }
.markdown-body .code-copy-button:focus-visible { outline: 2px solid #66a0ff; outline-offset: 2px; }
.markdown-body .code-copy-button.copied { border-color: rgba(85,200,150,.35); background: rgba(28,89,66,.92); color: #7ce1b5; }
.markdown-body .code-copy-button.copy-error { border-color: rgba(255,113,130,.35); background: rgba(100,39,49,.92); color: #ff9ba7; }
.markdown-body.code-theme-vscode { --code-bg: #18202d; --code-text: #dbe5f5; --code-border: #293448; --code-button-bg: rgba(34,43,57,.9); --code-button-text: #aeb9c9; --code-button-border: rgba(255,255,255,.13); --code-button-hover-bg: rgba(52,64,82,.97); --code-button-hover-text: #f4f7fb; --code-button-hover-border: rgba(255,255,255,.25); }
.markdown-body.code-theme-vscode .hljs-comment, .markdown-body.code-theme-vscode .hljs-quote { color: #77859a; }
.markdown-body.code-theme-vscode .hljs-keyword, .markdown-body.code-theme-vscode .hljs-selector-tag, .markdown-body.code-theme-vscode .hljs-literal { color: #c792ea; }
.markdown-body.code-theme-vscode .hljs-string, .markdown-body.code-theme-vscode .hljs-attr, .markdown-body.code-theme-vscode .hljs-addition { color: #c3e88d; }
.markdown-body.code-theme-vscode .hljs-title, .markdown-body.code-theme-vscode .hljs-section, .markdown-body.code-theme-vscode .hljs-name, .markdown-body.code-theme-vscode .hljs-type { color: #82aaff; }
.markdown-body.code-theme-vscode .hljs-number, .markdown-body.code-theme-vscode .hljs-symbol, .markdown-body.code-theme-vscode .hljs-bullet { color: #f78c6c; }
.markdown-body.code-theme-vscode .hljs-built_in, .markdown-body.code-theme-vscode .hljs-meta { color: #ffcb6b; }
.markdown-body.code-theme-vscode .hljs-variable, .markdown-body.code-theme-vscode .hljs-template-variable, .markdown-body.code-theme-vscode .hljs-params { color: #f07178; }

.markdown-body.code-theme-jetbrains { --code-bg: #2b2b2b; --code-text: #a9b7c6; --code-border: #3d3f41; --code-button-bg: rgba(60,63,65,.94); --code-button-text: #b8c0c8; --code-button-border: #55585a; --code-button-hover-bg: #4c5052; --code-button-hover-text: #fff; --code-button-hover-border: #6b6f72; }
.markdown-body.code-theme-jetbrains .hljs-comment, .markdown-body.code-theme-jetbrains .hljs-quote { color: #808080; font-style: italic; }
.markdown-body.code-theme-jetbrains .hljs-keyword, .markdown-body.code-theme-jetbrains .hljs-selector-tag, .markdown-body.code-theme-jetbrains .hljs-literal { color: #cc7832; }
.markdown-body.code-theme-jetbrains .hljs-string, .markdown-body.code-theme-jetbrains .hljs-attr, .markdown-body.code-theme-jetbrains .hljs-addition { color: #6a8759; }
.markdown-body.code-theme-jetbrains .hljs-title, .markdown-body.code-theme-jetbrains .hljs-section, .markdown-body.code-theme-jetbrains .hljs-name, .markdown-body.code-theme-jetbrains .hljs-type { color: #ffc66d; }
.markdown-body.code-theme-jetbrains .hljs-number, .markdown-body.code-theme-jetbrains .hljs-symbol, .markdown-body.code-theme-jetbrains .hljs-bullet { color: #6897bb; }
.markdown-body.code-theme-jetbrains .hljs-built_in, .markdown-body.code-theme-jetbrains .hljs-meta { color: #bbb529; }
.markdown-body.code-theme-jetbrains .hljs-variable, .markdown-body.code-theme-jetbrains .hljs-template-variable, .markdown-body.code-theme-jetbrains .hljs-params { color: #9876aa; }

.markdown-body.code-theme-github { --code-bg: #f6f8fa; --code-text: #24292f; --code-border: #d8dee4; --code-button-bg: rgba(255,255,255,.92); --code-button-text: #57606a; --code-button-border: #d0d7de; --code-button-hover-bg: #f3f4f6; --code-button-hover-text: #24292f; --code-button-hover-border: #afb8c1; }
.markdown-body.code-theme-github .hljs-comment, .markdown-body.code-theme-github .hljs-quote { color: #6e7781; }
.markdown-body.code-theme-github .hljs-keyword, .markdown-body.code-theme-github .hljs-selector-tag, .markdown-body.code-theme-github .hljs-literal { color: #cf222e; }
.markdown-body.code-theme-github .hljs-string, .markdown-body.code-theme-github .hljs-attr, .markdown-body.code-theme-github .hljs-addition { color: #0a3069; }
.markdown-body.code-theme-github .hljs-title, .markdown-body.code-theme-github .hljs-section, .markdown-body.code-theme-github .hljs-name, .markdown-body.code-theme-github .hljs-type { color: #8250df; }
.markdown-body.code-theme-github .hljs-number, .markdown-body.code-theme-github .hljs-symbol, .markdown-body.code-theme-github .hljs-bullet { color: #0550ae; }
.markdown-body.code-theme-github .hljs-built_in, .markdown-body.code-theme-github .hljs-meta { color: #953800; }
.markdown-body.code-theme-github .hljs-variable, .markdown-body.code-theme-github .hljs-template-variable, .markdown-body.code-theme-github .hljs-params { color: #116329; }

.markdown-body.code-theme-nord { --code-bg: #2e3440; --code-text: #d8dee9; --code-border: #434c5e; --code-button-bg: rgba(59,66,82,.94); --code-button-text: #d8dee9; --code-button-border: #4c566a; --code-button-hover-bg: #434c5e; --code-button-hover-text: #eceff4; --code-button-hover-border: #66728a; }
.markdown-body.code-theme-nord .hljs-comment, .markdown-body.code-theme-nord .hljs-quote { color: #616e88; font-style: italic; }
.markdown-body.code-theme-nord .hljs-keyword, .markdown-body.code-theme-nord .hljs-selector-tag, .markdown-body.code-theme-nord .hljs-literal { color: #81a1c1; }
.markdown-body.code-theme-nord .hljs-string, .markdown-body.code-theme-nord .hljs-attr, .markdown-body.code-theme-nord .hljs-addition { color: #a3be8c; }
.markdown-body.code-theme-nord .hljs-title, .markdown-body.code-theme-nord .hljs-section, .markdown-body.code-theme-nord .hljs-name, .markdown-body.code-theme-nord .hljs-type { color: #88c0d0; }
.markdown-body.code-theme-nord .hljs-number, .markdown-body.code-theme-nord .hljs-symbol, .markdown-body.code-theme-nord .hljs-bullet { color: #b48ead; }
.markdown-body.code-theme-nord .hljs-built_in, .markdown-body.code-theme-nord .hljs-meta { color: #ebcb8b; }
.markdown-body.code-theme-nord .hljs-variable, .markdown-body.code-theme-nord .hljs-template-variable, .markdown-body.code-theme-nord .hljs-params { color: #d08770; }
.markdown-body a { color: var(--accent); text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
.markdown-body .preview-image-frame { position: relative; display: block; width: var(--preview-image-width, fit-content); max-width: 100%; margin-top: 20px; margin-bottom: 20px; padding: 4px; overflow: visible; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-subtle); box-shadow: 0 2px 8px color-mix(in srgb, var(--text-strong) 7%, transparent); cursor: default; line-height: 0; transition: width 180ms ease, margin 180ms ease, border-color 140ms ease, box-shadow 140ms ease; }
.markdown-body .preview-image-frame.image-align-left { margin-right: auto; margin-left: 0; }
.markdown-body .preview-image-frame.image-align-center { margin-right: auto; margin-left: auto; }
.markdown-body .preview-image-frame.image-align-right { margin-right: 0; margin-left: auto; }
.markdown-body .preview-image-frame:hover { border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); box-shadow: 0 4px 13px color-mix(in srgb, var(--text-strong) 10%, transparent), 0 0 0 2px color-mix(in srgb, var(--accent) 8%, transparent); }
.markdown-body .preview-image { display: block; max-width: 100%; height: auto; border-radius: 4px; background: var(--bg-panel); }
.markdown-body .preview-image-frame:not([data-image-width="0"]) .preview-image { width: 100%; }
.markdown-body .preview-image-tools { position: absolute; z-index: 4; top: 8px; right: 8px; height: 29px; display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--bg-panel) 94%, transparent); box-shadow: 0 3px 10px color-mix(in srgb, var(--text-strong) 14%, transparent); opacity: 0; pointer-events: none; backdrop-filter: blur(9px); transform: translateY(-3px); transition: opacity 140ms ease, transform 140ms ease; }
.markdown-body .preview-image-frame:hover .preview-image-tools, .markdown-body .preview-image-tools:focus-within { opacity: 1; pointer-events: auto; transform: translateY(0); }
.markdown-body .preview-image-tools button { min-width: 24px; height: 23px; display: grid; place-items: center; padding: 0 5px; border: 0; border-radius: 4px; background: transparent; color: var(--text-tertiary); cursor: pointer; font-size: 12px; line-height: 1; }
.markdown-body .preview-image-tools button:hover { background: var(--bg-hover); color: var(--text-primary); }
.markdown-body .preview-image-tools button.active { background: var(--accent-soft); color: var(--accent); }
.markdown-body .preview-image-align-tools { display: flex; align-items: center; gap: 1px; }
.markdown-body .preview-image-tool-divider { width: 1px; height: 15px; margin: 0 2px; background: var(--border); }
.markdown-body .preview-image-width-label { min-width: 38px !important; color: var(--text-secondary) !important; font-size: 9px !important; font-variant-numeric: tabular-nums; }
.markdown-body .preview-image-resize-handle { position: absolute; z-index: 5; right: -6px; bottom: -6px; width: 16px; height: 16px; display: none; cursor: nwse-resize; touch-action: none; }
.markdown-body .preview-image-resize-handle::after { position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px; border-right: 3px solid var(--accent); border-bottom: 3px solid var(--accent); border-radius: 0 0 3px; filter: drop-shadow(0 0 1px var(--bg-panel)); content: ''; }
.markdown-body .preview-image-frame:hover .preview-image-resize-handle,
.markdown-body .preview-image-frame.resizing .preview-image-resize-handle { display: block; }
.markdown-body .preview-image-frame.resizing { transition: none; user-select: none; }
.markdown-body .align-glyph { width: 12px; height: 10px; display: block; background: linear-gradient(var(--text-tertiary), var(--text-tertiary)) 0 0 / 12px 1px no-repeat, linear-gradient(var(--text-tertiary), var(--text-tertiary)) 0 4px / 8px 1px no-repeat, linear-gradient(var(--text-tertiary), var(--text-tertiary)) 0 8px / 10px 1px no-repeat; }
.markdown-body button:hover .align-glyph, .markdown-body button.active .align-glyph { background-image: linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor); }
.markdown-body .align-glyph.center { background-position: 0 0, 2px 4px, 1px 8px; }
.markdown-body .align-glyph.right { background-position: 0 0, 4px 4px, 2px 8px; }
.markdown-body .preview-image-action { position: absolute; z-index: 3; top: 8px; left: 8px; height: 25px; display: flex; align-items: center; padding: 0 8px; border: 1px solid color-mix(in srgb, var(--border-strong) 65%, transparent); border-radius: 5px; background: color-mix(in srgb, var(--bg-panel) 92%, transparent); color: var(--text-secondary); box-shadow: 0 2px 7px color-mix(in srgb, var(--text-strong) 12%, transparent); cursor: pointer; font-size: 10px; font-weight: 600; line-height: 1; opacity: 0; pointer-events: none; backdrop-filter: blur(8px); transform: translateY(-3px); transition: opacity 140ms ease, transform 140ms ease, background 140ms ease, color 140ms ease; }
.markdown-body .preview-image-frame:hover .preview-image-action, .markdown-body .preview-image-action:focus-visible { opacity: 1; pointer-events: auto; transform: translateY(0); }
.markdown-body .preview-image-action:hover { background: var(--bg-panel); color: var(--accent); }
.markdown-body .preview-image-frame.image-load-error { width: min(100%, 480px); min-height: 76px; display: grid; place-items: stretch; padding: 14px 16px; border-style: dashed; background: color-mix(in srgb, var(--bg-subtle) 72%, var(--bg-preview)); box-shadow: none; cursor: default; }
.markdown-body .preview-image-frame.image-load-error:hover { border-color: var(--border-strong); box-shadow: none; }
.markdown-body .preview-image-frame.image-load-error .preview-image { display: none !important; }
.markdown-body .preview-image-frame.image-load-error .preview-image-action, .markdown-body .preview-image-frame.image-load-error .preview-image-tools { display: none; }
.markdown-body .preview-image-missing { min-width: 0; width: 100%; display: grid; grid-template-columns: 32px minmax(0, 1fr); grid-template-rows: auto auto; align-content: center; align-items: center; column-gap: 12px; row-gap: 3px; color: var(--text-tertiary); line-height: 1.4; text-align: left; }
.markdown-body .preview-image-missing::before { width: 30px; height: 25px; display: block; grid-row: 1 / 3; border: 1.5px solid var(--border-strong); border-radius: 4px; background: linear-gradient(145deg, transparent 53%, var(--border-strong) 54% 58%, transparent 59%), linear-gradient(35deg, transparent 54%, var(--border-strong) 55% 59%, transparent 60%); content: ''; opacity: .75; }
.markdown-body .preview-image-missing strong { min-width: 0; color: var(--text-secondary); font-size: 11px; font-weight: 650; }
.markdown-body .preview-image-missing small { min-width: 0; color: var(--text-tertiary); font-size: 10px; overflow-wrap: anywhere; white-space: normal; }
.image-lightbox { position: fixed; z-index: 10000; inset: 0; display: grid; place-items: center; padding: 22px; background: rgba(10, 15, 24, .42); color: var(--text-primary); backdrop-filter: blur(3px); }
.image-lightbox-card { width: min(760px, 72vw); height: min(540px, 68vh); min-height: 300px; display: grid; grid-template-rows: 48px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-panel); box-shadow: var(--shadow); }
.image-lightbox-toolbar { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--border); background: var(--bg-toolbar); }
.image-lightbox-title { min-width: 0; display: flex; align-items: center; gap: 8px; overflow: hidden; color: var(--text-primary); font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.image-lightbox-title svg { flex: none; color: var(--accent); }
.image-lightbox-controls { display: flex; align-items: center; gap: 4px; }
.image-lightbox-controls button { min-width: 30px; height: 30px; display: grid; place-items: center; padding: 0 7px; border: 0; border-radius: 6px; background: transparent; color: var(--text-tertiary); cursor: pointer; font: inherit; transition: background 130ms ease, color 130ms ease; }
.image-lightbox-controls button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.image-lightbox-controls button:disabled { opacity: .32; cursor: default; }
.image-lightbox-controls .image-lightbox-percent { min-width: 48px; color: var(--text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; }
.image-lightbox-controls .image-lightbox-reset { width: auto; display: flex; grid-template-columns: none; align-items: center; gap: 6px; padding: 0 9px; color: var(--text-secondary); font-size: 10px; }
.image-lightbox-divider { width: 1px; height: 18px; margin: 0 4px; background: var(--border); }
.image-lightbox-stage { min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 22px; background: var(--bg-subtle); touch-action: none; user-select: none; }
.image-lightbox-stage img { display: block; flex: none; width: auto; max-width: 100%; max-height: 100%; height: auto; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-panel); box-shadow: 0 6px 22px color-mix(in srgb, var(--text-strong) 15%, transparent); cursor: grab; transform-origin: center; will-change: transform; user-select: none; }
.image-lightbox-stage.dragging img { cursor: grabbing; }
.image-lightbox-enter-active, .image-lightbox-leave-active { transition: opacity 170ms ease; }
.image-lightbox-enter-active .image-lightbox-stage img, .image-lightbox-leave-active .image-lightbox-stage img { transition: transform 190ms ease, opacity 170ms ease; }
.image-lightbox-enter-from, .image-lightbox-leave-to { opacity: 0; }
.image-lightbox-enter-from .image-lightbox-stage img, .image-lightbox-leave-to .image-lightbox-stage img { opacity: 0; transform: scale(.975); }
body:has(.desktop-shell:not(.window-maximized)) .image-lightbox { inset: 8px; border-radius: 10px; }
.markdown-body .preview-jump-highlight { position: relative; z-index: 0; border-radius: 0; isolation: isolate; }
.markdown-body .preview-jump-highlight::before {
  position: absolute;
  z-index: -1;
  inset: -4px -10px;
  border-left: 3px solid var(--accent);
  border-radius: 0;
  background: color-mix(in srgb, var(--accent) 22%, var(--bg-preview));
  pointer-events: none;
  content: '';
  animation: preview-target-highlight 1.2s ease-out;
}
@keyframes preview-target-highlight {
  0%, 28% { opacity: 1; }
  100% { opacity: 0; }
}
@media (max-width: 900px) { .markdown-body { padding: 28px 28px 80px; } .image-lightbox { padding: 12px; } .image-lightbox-card { width: min(94vw, 760px); height: min(72vh, 580px); } .image-lightbox-stage { padding: 14px; } .image-lightbox-title { max-width: 32vw; } }
</style>
