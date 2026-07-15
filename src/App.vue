<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  AlertTriangle, ArchiveRestore, ArrowUpDown, Bold, Braces, Check, ChevronDown, Code2, Columns2, Copy, Download, Eye, FilePlus2,
  FileText, FolderOpen, FolderPlus, HardDrive, Hash, Image as ImageIcon, ImagePlus, Italic, List, ListChecks, Pencil,
  Minus, PanelLeftClose, PanelLeftOpen, Quote, Search, Settings, Square,
  Strikethrough, Trash2, Upload, X,
} from '@lucide/vue'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { writeImage } from '@tauri-apps/plugin-clipboard-manager'
import { useStudioStore } from './stores/studio'
import FileTree from './components/FileTree.vue'
import MarkdownEditor from './components/MarkdownEditor.vue'
import MarkdownPreview from './components/MarkdownPreview.vue'
import UiButton from './components/ui/UiButton.vue'
import UiModal from './components/ui/UiModal.vue'
import UiNumberStepper from './components/ui/UiNumberStepper.vue'
import UiPopover from './components/ui/UiPopover.vue'
import UiSelect from './components/ui/UiSelect.vue'
import { exportBinary, isTauri, quitApplication } from './services/desktop'
import { loadBackground, removeBackground, saveBackground } from './services/appearance'
import {
  chooseBackupFile, createWorkspaceBackup, deleteUnusedAssets, inspectWorkspaceBackup, storageSnapshot,
  type WebBackupSummary, type WebStorageSnapshot,
} from './services/webWorkspace'
import type { FileNode, Heading, TrashItem } from './types'

const store = useStudioStore()
const {
  workspaceName, workspaceMode, tree, activePath, activeName, content, saveStatus, viewMode,
  settings, searchResults, isSearching, errorMessage, isDemo,
  trashItems,
} = storeToRefs(store)

const storedPanelState = (() => {
  try { return JSON.parse(localStorage.getItem('md-lai-le-panel-state') || '{}') as { rightOpen?: boolean; activeRightTab?: 'outline' | 'inspect' | 'stats' } } catch { return {} }
})()
const rightOpen = ref(storedPanelState.rightOpen !== false)
const activeRightTab = ref<'outline' | 'inspect'>(storedPanelState.activeRightTab === 'inspect' || storedPanelState.activeRightTab === 'stats' ? 'inspect' : 'outline')
const searchQuery = ref('')
const searchOpen = ref(false)
const searchRoot = ref<HTMLElement>()
const newFileOpen = ref(false)
const newFileName = ref('')
const newFolderOpen = ref(false)
const newFolderName = ref('')
const newMenuOpen = ref(false)
const fileSortOpen = ref(false)
const settingsOpen = ref(false)
const settingsSection = ref<'appearance' | 'editor' | 'code'>('appearance')
const backgroundInput = ref<HTMLInputElement>()
const backgroundUrl = ref('')
const backgroundName = ref('')
const storageOpen = ref(false)
const storageCleanupOpen = ref(false)
const storageLoading = ref(false)
const storageInfo = ref<WebStorageSnapshot | null>(null)
const backupImportOpen = ref(false)
const backupBusy = ref(false)
const backupFile = ref<File | null>(null)
const backupSummary = ref<WebBackupSummary | null>(null)
const exportOpen = ref(false)
const exportingKind = ref<ExportKind | null>(null)
const exportPreviewOpen = ref(false)
const preparedExport = ref<PreparedExport | null>(null)
const exportAction = ref<'download' | 'copy' | null>(null)
const copiedImage = ref(false)
const deleteTarget = ref<FileNode | null>(null)
const trashOpen = ref(false)
const trashDeleteTarget = ref<TrashItem | null>(null)
const renameTarget = ref<FileNode | null>(null)
const renameName = ref('')
const workspaceRenameOpen = ref(false)
const workspaceRenameName = ref('')
const workspaceRemoveOpen = ref(false)
const closeConfirmOpen = ref(false)
const exitInProgress = ref(false)
const windowMaximized = ref(false)
const compactLayout = ref(false)
const viewportWidth = ref(window.innerWidth)
const formatState = ref<Record<string, boolean>>({})
const editorStage = ref<HTMLElement>()
const leftSidebar = ref<HTMLElement>()
const rightSidebar = ref<HTMLElement>()
const dropActive = ref(false)
const imageDropActive = ref(false)
let dragDepth = 0
let unlistenFileDrop: (() => void) | undefined
let unlistenWindowResize: (() => void) | undefined
let unlistenCloseRequested: (() => void) | undefined
let compactMedia: MediaQueryList | undefined
let syncCompactLayout: (() => void) | undefined
const syncViewportWidth = () => { viewportWidth.value = window.innerWidth }
let searchTimer: number | undefined

type ExportKind = 'markdown' | 'html' | 'pdf' | 'png'
type FileSortMode = 'name-asc' | 'name-desc' | 'created-desc' | 'created-asc' | 'modified-desc'
type DocumentIssue = { line: number; title: string; detail: string }
type DocumentTask = { line: number; text: string; completed: boolean }
type PreparedExport = {
  kind: ExportKind
  label: string
  name: string
  mime: string
  bytes: Uint8Array
  clipboardImageBytes: Uint8Array
  filter: { name: string; extensions: string[] }
  previewUrl: string
}

const themeOptions = [
  { label: '浅色', value: 'light', description: '清爽明亮' },
  { label: '深色', value: 'dark', description: '柔和护眼' },
  { label: '自动', value: 'system', description: '跟随系统' },
]
const codeBlockModeOptions = [
  { label: '限制高度', value: 'limited', description: '长代码块内部滚动' },
  { label: '全部展开', value: 'expanded', description: '显示完整代码内容' },
]
const codeThemeOptions = [
  { label: 'VS Code', value: 'vscode', description: '清晰均衡的深色主题' },
  { label: 'JetBrains', value: 'jetbrains', description: 'Darcula 高对比配色' },
  { label: 'GitHub Light', value: 'github', description: '适合浅色界面的代码主题' },
  { label: 'Nord', value: 'nord', description: '柔和低对比的极地配色' },
]
const codeWrapOptions = [
  { label: '横向滚动', value: 'scroll', description: '保留代码原始行结构' },
  { label: '自动换行', value: 'wrap', description: '长代码适应预览宽度' },
]
const colorThemes = [
  { value: 'ocean', label: '海岸蓝', colors: ['#2563eb', '#dce9ff', '#f6f9ff'] },
  { value: 'forest', label: '松林绿', colors: ['#17845d', '#dcefe7', '#f5faf7'] },
  { value: 'violet', label: '鸢尾紫', colors: ['#7656c9', '#e9e1fa', '#faf8fd'] },
  { value: 'clay', label: '陶土棕', colors: ['#b45f3d', '#f2e3dc', '#fcf8f5'] },
  { value: 'graphite', label: '石墨灰', colors: ['#536273', '#e2e6ea', '#f7f8f9'] },
] as const
const tabOptions = [
  { label: '2 个空格', value: 2, description: '适合前端与 Markdown' },
  { label: '4 个空格', value: 4, description: '更宽的代码缩进' },
]
const fileSortOptions: Array<{ value: FileSortMode; label: string }> = [
  { value: 'name-asc', label: '名称 A–Z' },
  { value: 'name-desc', label: '名称 Z–A' },
  { value: 'created-desc', label: '创建时间（最新）' },
  { value: 'created-asc', label: '创建时间（最早）' },
  { value: 'modified-desc', label: '修改时间（最新）' },
]
const storedFileSort = localStorage.getItem('md-lai-le-file-sort') as FileSortMode | null
const fileSortMode = ref<FileSortMode>(fileSortOptions.some((option) => option.value === storedFileSort) ? storedFileSort! : 'name-asc')

const dark = computed(() => settings.value.theme === 'dark' || (settings.value.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches))
const appAppearanceStyle = computed(() => ({
  '--app-background-image': backgroundUrl.value ? `url("${backgroundUrl.value}")` : 'none',
  '--background-panel-opacity': `${settings.value.backgroundPanelOpacity}%`,
}))
const headings = computed<Heading[]>(() => {
  const result: Heading[] = []
  content.value.split('\n').forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) result.push({ level: match[1].length, text: match[2].replace(/[*_`~]/g, ''), line: index + 1, id: `heading-${index + 1}` })
  })
  return result
})

const statistics = computed(() => {
  const plain = content.value
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`~\[\]()|!-]/g, ' ')
  const chinese = plain.match(/[\u3400-\u9fff]/g)?.length || 0
  const english = plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length || 0
  const words = chinese + english
  const chars = content.value.length
  const lines = content.value ? content.value.split('\n').length : 0
  const readingMinutes = Math.max(1, Math.ceil(chinese / 300 + english / 200))
  return { words, chars, lines, readingMinutes }
})

const documentInspection = computed(() => {
  const issues: DocumentIssue[] = []
  const tasks: DocumentTask[] = []
  const seenHeadings = new Map<string, number>()
  let previousHeadingLevel = 0
  let hasPrimaryHeading = false

  content.value.split('\n').forEach((line, index) => {
    const lineNumber = index + 1
    const markdownHeading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    const htmlHeading = /^\s*<h([1-6])(?:\s[^>]*)?>(.*?)<\/h\1>\s*$/i.exec(line)
    const headingLevel = markdownHeading?.[1].length || Number(htmlHeading?.[1] || 0)
    const headingText = (markdownHeading?.[2] || htmlHeading?.[2] || '').replace(/<[^>]+>|[*_`~]/g, '').trim()
    if (headingLevel) {
      if (headingLevel === 1) hasPrimaryHeading = true
      if (previousHeadingLevel && headingLevel > previousHeadingLevel + 1) {
        issues.push({ line: lineNumber, title: `标题层级从 H${previousHeadingLevel} 跳到 H${headingLevel}`, detail: '建议按顺序递进标题层级' })
      }
      const normalized = headingText.toLocaleLowerCase()
      const firstLine = seenHeadings.get(normalized)
      if (normalized && firstLine) issues.push({ line: lineNumber, title: `重复标题“${headingText}”`, detail: `首次出现在第 ${firstLine} 行` })
      else if (normalized) seenHeadings.set(normalized, lineNumber)
      previousHeadingLevel = headingLevel
    }

    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line)
    if (task) tasks.push({ line: lineNumber, text: task[2], completed: task[1].toLowerCase() === 'x' })
    if (/!\[[^\]]*\]\(\s*\)/.test(line)) issues.push({ line: lineNumber, title: '图片地址为空', detail: '请补充本地路径或图片地址' })
    else if (/\[[^\]]*\]\(\s*\)/.test(line.replace(/!\[[^\]]*\]\([^)]*\)/g, ''))) issues.push({ line: lineNumber, title: '链接地址为空', detail: '请补充链接目标' })
  })

  if (content.value.trim() && !hasPrimaryHeading) issues.unshift({ line: 1, title: '缺少一级标题', detail: '建议使用一个 H1 作为文档主标题' })

  const links = (content.value.replace(/!\[[^\]]*\]\([^)]*\)/g, '').match(/\[[^\]]*\]\([^)]*\)/g) || []).length + (content.value.match(/<a\s/gi) || []).length
  const images = (content.value.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length + (content.value.match(/<img\s/gi) || []).length
  const codeBlocks = Math.floor((content.value.match(/^\s*(```|~~~)/gm) || []).length / 2)
  return {
    issues,
    tasks,
    pendingTasks: tasks.filter((task) => !task.completed),
    links,
    images,
    codeBlocks,
    size: new Blob([content.value]).size,
  }
})

const workspaceFileCount = computed(() => {
  const countFiles = (nodes: FileNode[]): number => nodes.reduce(
    (total, node) => total + (node.kind === 'file' ? 1 : countFiles(node.children || [])),
    0,
  )
  return countFiles(tree.value)
})
const sortedTree = computed(() => sortFileNodes(tree.value, fileSortMode.value))
const activeFile = computed(() => findFileNode(tree.value, activePath.value))

watch(fileSortMode, (value) => localStorage.setItem('md-lai-le-file-sort', value))

const saveLabel = computed(() => ({
  saved: '已保存', dirty: '未保存', saving: '保存中…', error: '保存失败',
}[saveStatus.value]))

const splitStyle = computed(() => viewMode.value === 'split'
  ? { gridTemplateColumns: `${settings.value.splitRatio * 100}% 6px minmax(0, 1fr)` }
  : undefined)
const effectiveLeftSidebarWidth = computed(() => {
  if (viewportWidth.value <= 760) return 64
  if (viewportWidth.value <= 940) return Math.min(settings.value.leftSidebarWidth, 210)
  return settings.value.leftSidebarWidth
})
const sidebarMode = computed(() => effectiveLeftSidebarWidth.value <= 140 ? 'icon' : 'full')

watch(searchQuery, (query) => {
  window.clearTimeout(searchTimer)
  searchOpen.value = !!query
  searchTimer = window.setTimeout(() => store.performSearch(query), 220)
})

watch(() => settings.value.theme, () => requestAnimationFrame(() => window.dispatchEvent(new Event('studio:theme-changed'))))
watch(() => settings.value.colorTheme, (value) => {
  document.documentElement.setAttribute('data-palette', value || 'ocean')
  requestAnimationFrame(() => window.dispatchEvent(new Event('studio:theme-changed')))
}, { immediate: true })
watch([rightOpen, activeRightTab], ([open, tab]) => {
  localStorage.setItem('md-lai-le-panel-state', JSON.stringify({ rightOpen: open, activeRightTab: tab }))
}, { flush: 'sync' })

function goToHeading(heading: Heading) {
  window.dispatchEvent(new CustomEvent('studio:goto-line', { detail: heading.line }))
}

function goToInspectionLine(line: number) {
  window.dispatchEvent(new CustomEvent('studio:goto-line', { detail: line }))
}

function followEditorCursor(line: number) {
  window.dispatchEvent(new CustomEvent('studio:cursor-line', { detail: line }))
}

function selectViewMode(mode: 'editor' | 'split' | 'preview') {
  if (!activePath.value) return
  viewMode.value = mode
}

function selectFileSort(mode: FileSortMode) {
  fileSortMode.value = mode
  fileSortOpen.value = false
}

function formatFileTime(value?: number) {
  if (!value) return '无法获取'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function findFileNode(nodes: FileNode[], relativePath: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.relativePath === relativePath) return node
    const nested = node.children && findFileNode(node.children, relativePath)
    if (nested) return nested
  }
  return undefined
}

function sortFileNodes(nodes: FileNode[], mode: FileSortMode): FileNode[] {
  const compareName = (left: FileNode, right: FileNode) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  const compare = (left: FileNode, right: FileNode) => {
    const kindOrder = Number(right.kind === 'directory') - Number(left.kind === 'directory')
    if (kindOrder) return kindOrder
    if (mode === 'name-asc') return compareName(left, right)
    if (mode === 'name-desc') return -compareName(left, right)
    const leftTime = mode.startsWith('created') ? (left.createdAt ?? left.modifiedAt ?? 0) : (left.modifiedAt ?? left.createdAt ?? 0)
    const rightTime = mode.startsWith('created') ? (right.createdAt ?? right.modifiedAt ?? 0) : (right.modifiedAt ?? right.createdAt ?? 0)
    const timeOrder = mode === 'created-asc' ? leftTime - rightTime : rightTime - leftTime
    return timeOrder || compareName(left, right)
  }
  return [...nodes].sort(compare).map((node) => ({
    ...node,
    children: node.children ? sortFileNodes(node.children, mode) : undefined,
  }))
}

async function minimizeWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().minimize()
}

async function toggleMaximizeWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const currentWindow = getCurrentWindow()
  await currentWindow.toggleMaximize()
  windowMaximized.value = await currentWindow.isMaximized()
}

function requestWindowClose() {
  closeConfirmOpen.value = true
}

async function minimizeFromCloseDialog() {
  closeConfirmOpen.value = false
  await minimizeWindow()
}

async function exitApplication() {
  if (exitInProgress.value) return
  exitInProgress.value = true
  await store.save()
  closeConfirmOpen.value = false
  const forceClose = async () => {
    unlistenCloseRequested?.()
    unlistenCloseRequested = undefined
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().destroy()
  }
  window.setTimeout(() => { void forceClose() }, 800)
  void quitApplication().catch(() => forceClose())
}

function format(type: string) {
  window.dispatchEvent(new CustomEvent('studio:format', { detail: type }))
}

async function createFile() {
  if (!newFileName.value.trim()) return
  await store.newDocument(newFileName.value)
  newFileName.value = ''
  newFileOpen.value = false
}

async function createFolder() {
  if (!newFolderName.value.trim()) return
  await store.newFolder(newFolderName.value)
  newFolderName.value = ''
  newFolderOpen.value = false
}

async function openMarkdownFiles() {
  newMenuOpen.value = false
  await store.selectFiles()
}

async function openLocalDirectory() {
  newMenuOpen.value = false
  await store.selectWorkspace()
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  await store.deleteEntry(deleteTarget.value)
  deleteTarget.value = null
}

function setDeleteOpen(value: boolean) {
  if (!value) deleteTarget.value = null
}

function formatDeletedAt(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

async function openTrash() {
  await store.loadTrash()
  trashOpen.value = true
}

async function restoreTrash(item: TrashItem) {
  await store.restoreTrashItem(item)
  if (!trashItems.value.length) trashOpen.value = false
}

async function confirmPermanentDelete() {
  if (!trashDeleteTarget.value) return
  await store.permanentlyDeleteTrashItem(trashDeleteTarget.value)
  trashDeleteTarget.value = null
}

function openRename(node: FileNode) {
  renameTarget.value = node
  renameName.value = node.name
}

async function confirmRename() {
  if (!renameTarget.value || !renameName.value.trim()) return
  await store.renameEntry(renameTarget.value, renameName.value)
  renameTarget.value = null
  renameName.value = ''
}

function openWorkspaceRename() {
  workspaceRenameName.value = workspaceName.value
  workspaceRenameOpen.value = true
}

function confirmWorkspaceRename() {
  store.renameWorkspace(workspaceRenameName.value)
  workspaceRenameOpen.value = false
}

async function confirmWorkspaceRemove() {
  await store.removeWorkspace()
  searchQuery.value = ''
  searchOpen.value = false
  workspaceRemoveOpen.value = false
}

function startSplitResize(event: PointerEvent) {
  event.preventDefault()
  window.addEventListener('pointermove', resizeSplit)
  window.addEventListener('pointerup', stopSplitResize, { once: true })
  document.body.classList.add('is-resizing-split')
}

function resizeSplit(event: PointerEvent) {
  if (!editorStage.value) return
  const bounds = editorStage.value.getBoundingClientRect()
  settings.value.splitRatio = Math.min(.75, Math.max(.25, (event.clientX - bounds.left) / bounds.width))
}

function stopSplitResize() {
  window.removeEventListener('pointermove', resizeSplit)
  document.body.classList.remove('is-resizing-split')
  store.persistSettings()
}

function startSidebarResize(event: PointerEvent) {
  event.preventDefault()
  window.addEventListener('pointermove', resizeSidebar)
  window.addEventListener('pointerup', stopSidebarResize, { once: true })
  document.body.classList.add('is-resizing-sidebar')
}

function resizeSidebar(event: PointerEvent) {
  if (!leftSidebar.value) return
  const left = leftSidebar.value.getBoundingClientRect().left
  settings.value.leftSidebarWidth = Math.min(420, Math.max(64, event.clientX - left))
}

function stopSidebarResize() {
  window.removeEventListener('pointermove', resizeSidebar)
  document.body.classList.remove('is-resizing-sidebar')
  store.persistSettings()
}

function startRightSidebarResize(event: PointerEvent) {
  event.preventDefault()
  window.addEventListener('pointermove', resizeRightSidebar)
  window.addEventListener('pointerup', stopRightSidebarResize, { once: true })
  document.body.classList.add('is-resizing-right-sidebar')
}

function resizeRightSidebar(event: PointerEvent) {
  if (!rightSidebar.value) return
  const left = rightSidebar.value.getBoundingClientRect().left
  settings.value.rightSidebarWidth = Math.min(400, Math.max(180, event.clientX - left))
}

function stopRightSidebarResize() {
  window.removeEventListener('pointermove', resizeRightSidebar)
  document.body.classList.remove('is-resizing-right-sidebar')
  store.persistSettings()
}

function exportedBaseName() {
  return (activeName.value || '未命名文档').replace(/\.(?:md|markdown)$/i, '')
}

function buildExportHtml() {
  const md = new MarkdownIt({ html: false, linkify: true })
  const body = DOMPurify.sanitize(md.render(content.value))
  const pageBackground = dark.value ? '#17191d' : '#ffffff'
  const textColor = dark.value ? '#e7e9ee' : '#20242c'
  const secondaryColor = dark.value ? '#a7acb7' : '#667085'
  const borderColor = dark.value ? '#343842' : '#d9dde5'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${activeName.value}</title><style>html{background:${pageBackground}}body{max-width:860px;margin:40px auto;padding:0 32px 80px;background:${pageBackground};color:${textColor};font:15px/1.78 "JetBrains Mono","Microsoft YaHei UI",monospace}h1,h2,h3,h4{line-height:1.3}h1{font-size:32px}h2{margin-top:34px;font-size:23px}pre{padding:20px;background:#18202d;color:#dbe5f5;border-radius:9px;overflow:auto}code{font-family:"JetBrains Mono","Microsoft YaHei UI",monospace}table{border-collapse:collapse;width:100%}th,td{border:1px solid ${borderColor};padding:9px 12px;text-align:left}blockquote{border-left:3px solid ${borderColor};padding-left:18px;color:${secondaryColor}}img{max-width:100%}a{color:#1769e0}</style></head><body>${body}</body></html>`
}

async function createPreviewCanvas() {
  const { default: html2canvas } = await import('html2canvas')
  if (!activePath.value) throw new Error('当前没有可导出的预览内容。')
  const background = dark.value ? '#17191d' : '#ffffff'
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:960px;height:1px;border:0;pointer-events:none;'
  document.body.appendChild(frame)
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true })
      frame.addEventListener('error', () => reject(new Error('无法创建导出页面。')), { once: true })
    })
    frame.srcdoc = buildExportHtml()
    await loaded
    const frameDocument = frame.contentDocument
    const frameBody = frameDocument?.body
    if (!frameDocument || !frameBody) throw new Error('无法读取导出页面。')
    await frameDocument.fonts.ready
    const height = Math.max(frameBody.scrollHeight, frameDocument.documentElement.scrollHeight, 200)
    frame.style.height = `${height}px`
    return await html2canvas(frameBody, {
      backgroundColor: background,
      scale: 2,
      useCORS: true,
      logging: false,
      width: 960,
      height,
      windowWidth: 960,
      windowHeight: height,
    })
  } finally {
    frame.remove()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('无法生成导出图片。')),
    type,
    quality,
  ))
}

async function createPdfBytes(canvas: HTMLCanvasElement) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
  const margin = 12
  const pageWidth = 210
  const pageHeight = 297
  const contentWidth = pageWidth - margin * 2
  const contentHeight = pageHeight - margin * 2
  const pixelsPerPage = Math.floor(canvas.width * contentHeight / contentWidth)
  let offset = 0
  let page = 0
  while (offset < canvas.height) {
    const sliceHeight = Math.min(pixelsPerPage, canvas.height - offset)
    const slice = document.createElement('canvas')
    slice.width = canvas.width
    slice.height = sliceHeight
    const context = slice.getContext('2d')
    if (!context) throw new Error('无法创建 PDF 页面。')
    context.drawImage(canvas, 0, offset, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)
    if (page > 0) pdf.addPage()
    pdf.addImage(slice.toDataURL('image/jpeg', 0.94), 'JPEG', margin, margin, contentWidth, sliceHeight * contentWidth / canvas.width, undefined, 'FAST')
    offset += sliceHeight
    page += 1
  }
  return new Uint8Array(pdf.output('arraybuffer'))
}

async function doExport(kind: ExportKind) {
  if (exportingKind.value || !activePath.value) return
  exportingKind.value = kind
  errorMessage.value = ''
  const baseName = exportedBaseName()
  let previewUrl = ''
  try {
    const canvas = await createPreviewCanvas()
    const previewBlob = await canvasToBlob(canvas, 'image/png')
    const clipboardImageBytes = new Uint8Array(await previewBlob.arrayBuffer())
    previewUrl = URL.createObjectURL(previewBlob)
    let prepared: PreparedExport
    if (kind === 'markdown') {
      prepared = {
        kind, label: 'Markdown', name: `${baseName}.md`, mime: 'text/markdown',
        bytes: new TextEncoder().encode(content.value), clipboardImageBytes,
        filter: { name: 'Markdown', extensions: ['md'] }, previewUrl,
      }
    } else if (kind === 'html') {
      const html = buildExportHtml()
      prepared = {
        kind, label: 'HTML 网页', name: `${baseName}.html`, mime: 'text/html',
        bytes: new TextEncoder().encode(html), clipboardImageBytes,
        filter: { name: 'HTML', extensions: ['html'] }, previewUrl,
      }
    } else if (kind === 'png') {
      prepared = {
        kind, label: 'PNG 长图', name: `${baseName}.png`, mime: 'image/png',
        bytes: clipboardImageBytes, clipboardImageBytes,
        filter: { name: 'PNG 图片', extensions: ['png'] }, previewUrl,
      }
    } else {
      prepared = {
        kind, label: 'PDF 文档', name: `${baseName}.pdf`, mime: 'application/pdf',
        bytes: await createPdfBytes(canvas), clipboardImageBytes,
        filter: { name: 'PDF 文档', extensions: ['pdf'] }, previewUrl,
      }
    }
    if (preparedExport.value?.previewUrl) URL.revokeObjectURL(preparedExport.value.previewUrl)
    preparedExport.value = prepared
    copiedImage.value = false
    exportOpen.value = false
    exportPreviewOpen.value = true
  } catch (error) {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    exportingKind.value = null
  }
}

function formatExportSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function openStorageManager() {
  settingsOpen.value = false
  storageOpen.value = true
  storageLoading.value = true
  try {
    await store.save()
    storageInfo.value = await storageSnapshot()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    storageLoading.value = false
  }
}

async function cleanUnusedAssets() {
  if (!storageInfo.value?.unreferencedAssets.length) return
  storageLoading.value = true
  try {
    await deleteUnusedAssets(storageInfo.value.unreferencedAssets.map((asset) => asset.path))
    storageInfo.value = await storageSnapshot()
    storageCleanupOpen.value = false
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    storageLoading.value = false
  }
}

async function downloadWorkspaceBackup() {
  if (backupBusy.value) return
  backupBusy.value = true
  try {
    await store.save()
    const backup = await createWorkspaceBackup()
    const url = URL.createObjectURL(backup.blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = backup.name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    exportOpen.value = false
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    backupBusy.value = false
  }
}

async function selectWorkspaceBackup() {
  if (backupBusy.value) return
  const file = await chooseBackupFile()
  if (!file) return
  backupBusy.value = true
  try {
    const summary = await inspectWorkspaceBackup(file)
    backupFile.value = file
    backupSummary.value = summary
    settingsOpen.value = false
    storageOpen.value = false
    backupImportOpen.value = true
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    backupBusy.value = false
  }
}

function setBackupImportOpen(value: boolean) {
  backupImportOpen.value = value
  if (!value) {
    backupFile.value = null
    backupSummary.value = null
  }
}

async function confirmWorkspaceBackupImport() {
  if (!backupFile.value || backupBusy.value) return
  backupBusy.value = true
  const restored = await store.restoreWebBackup(backupFile.value)
  backupBusy.value = false
  if (restored) setBackupImportOpen(false)
}

function setExportPreviewOpen(value: boolean) {
  exportPreviewOpen.value = value
  if (value) return
  if (preparedExport.value?.previewUrl) URL.revokeObjectURL(preparedExport.value.previewUrl)
  preparedExport.value = null
  copiedImage.value = false
  exportAction.value = null
}

async function downloadPreparedExport() {
  if (!preparedExport.value || exportAction.value) return
  exportAction.value = 'download'
  errorMessage.value = ''
  try {
    await exportBinary(preparedExport.value.name, preparedExport.value.bytes, preparedExport.value.filter, preparedExport.value.mime)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    exportAction.value = null
  }
}

async function copyPreparedImage() {
  if (!preparedExport.value || exportAction.value) return
  exportAction.value = 'copy'
  errorMessage.value = ''
  try {
    const blob = new Blob([preparedExport.value.clipboardImageBytes as BlobPart], { type: 'image/png' })
    if (isTauri()) {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建剪贴板图片。')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
      const { Image } = await import('@tauri-apps/api/image')
      const image = await Image.new(new Uint8Array(rgba.buffer), canvas.width, canvas.height)
      try {
        await writeImage(image)
      } finally {
        await image.close()
      }
    } else if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } else {
      throw new Error('当前环境不支持复制图片。')
    }
    copiedImage.value = true
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    exportAction.value = null
  }
}

function keyboardShortcuts(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    store.save()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    newFileOpen.value = true
  }
}

function dismissSearch(event: PointerEvent) {
  if (searchRoot.value && !searchRoot.value.contains(event.target as Node)) searchOpen.value = false
}

function hasExternalFiles(event: DragEvent) {
  return event.dataTransfer?.types.includes('Files') || false
}

function enterExternalDrag(event: DragEvent) {
  if (!hasExternalFiles(event)) return
  event.preventDefault()
  imageDropActive.value = isDemo.value && !!activePath.value && [...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file' && item.type.startsWith('image/'))
  dragDepth += 1
  dropActive.value = true
}

function overExternalDrag(event: DragEvent) {
  if (!hasExternalFiles(event) || !event.dataTransfer) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

function leaveExternalDrag(event: DragEvent) {
  if (!hasExternalFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) {
    dropActive.value = false
    imageDropActive.value = false
  }
}

function dropExternalFiles(event: DragEvent) {
  if (!event.dataTransfer?.files.length) return
  event.preventDefault()
  dragDepth = 0
  dropActive.value = false
  const images = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'))
  imageDropActive.value = false
  if (isDemo.value && activePath.value && images.length) {
    void store.importImages(images)
    return
  }
  void store.importDroppedFiles(event.dataTransfer.files)
}

function importIntoFolder(files: FileList, targetDirectory: string) {
  dragDepth = 0
  dropActive.value = false
  void store.importDroppedFiles(files, targetDirectory)
}

function importIntoEditor(files: FileList) {
  importIntoFolder(files, '')
}

function overTreeRoot(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('application/x-markdown-studio-path')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

function dropOnTreeRoot(event: DragEvent) {
  const sourcePath = event.dataTransfer?.getData('application/x-markdown-studio-path')
  if (!sourcePath) return
  event.preventDefault()
  void store.moveEntry(sourcePath, '')
}

function setBackgroundPreview(blob: Blob, name: string) {
  if (backgroundUrl.value) URL.revokeObjectURL(backgroundUrl.value)
  backgroundUrl.value = URL.createObjectURL(blob)
  backgroundName.value = name
  document.documentElement.dataset.hasBackground = 'true'
}

async function selectAppBackground(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    errorMessage.value = '请选择 PNG、JPG、WebP 等图片文件。'
    return
  }
  if (file.size > 15 * 1024 * 1024) {
    errorMessage.value = '背景图片不能超过 15 MB。'
    return
  }
  try {
    await saveBackground(file)
    setBackgroundPreview(file, file.name)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '背景图片保存失败。'
  }
}

async function clearAppBackground() {
  try {
    await removeBackground()
    if (backgroundUrl.value) URL.revokeObjectURL(backgroundUrl.value)
    backgroundUrl.value = ''
    backgroundName.value = ''
    delete document.documentElement.dataset.hasBackground
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '背景图片移除失败。'
  }
}

onMounted(async () => {
  try {
    const storedBackground = await loadBackground()
    if (storedBackground) setBackgroundPreview(storedBackground.blob, storedBackground.name)
  } catch {
    // 外观资源读取失败时保持默认背景，不影响文档编辑。
  }
  compactMedia = window.matchMedia('(max-width: 940px)')
  syncCompactLayout = () => { compactLayout.value = !!compactMedia?.matches }
  syncCompactLayout()
  compactMedia.addEventListener('change', syncCompactLayout)
  window.addEventListener('resize', syncViewportWidth)
  window.addEventListener('keydown', keyboardShortcuts)
  document.addEventListener('pointerdown', dismissSearch)
  if (!isDemo.value) {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const currentWindow = getCurrentWindow()
    windowMaximized.value = await currentWindow.isMaximized()
    unlistenWindowResize = await currentWindow.onResized(async () => {
      windowMaximized.value = await currentWindow.isMaximized()
    })
    unlistenCloseRequested = await currentWindow.onCloseRequested((event) => {
      if (exitInProgress.value) return
      event.preventDefault()
      closeConfirmOpen.value = true
    })
    unlistenFileDrop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === 'enter') {
        dropActive.value = true
        imageDropActive.value = !!activePath.value && event.payload.paths.length > 0 && event.payload.paths.every((path) => /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(path))
      }
      if (event.payload.type === 'over') dropActive.value = true
      if (event.payload.type === 'leave') {
        dropActive.value = false
        imageDropActive.value = false
      }
      if (event.payload.type === 'drop') {
        dropActive.value = false
        const imagePaths = event.payload.paths.filter((path) => /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(path))
        if (activePath.value && imagePaths.length === event.payload.paths.length) {
          imageDropActive.value = false
          void store.importPathImages(imagePaths)
          return
        }
        imageDropActive.value = false
        const scale = window.devicePixelRatio || 1
        const element = document.elementFromPoint(event.payload.position.x / scale, event.payload.position.y / scale) as HTMLElement | null
        const folder = element?.closest<HTMLElement>('.tree-row[data-directory="true"]')
        void store.importPathFiles(event.payload.paths, folder?.dataset.path || '')
      }
    })
  }
})
onBeforeUnmount(() => {
  if (backgroundUrl.value) URL.revokeObjectURL(backgroundUrl.value)
  if (preparedExport.value?.previewUrl) URL.revokeObjectURL(preparedExport.value.previewUrl)
  window.removeEventListener('keydown', keyboardShortcuts)
  document.removeEventListener('pointerdown', dismissSearch)
  stopSplitResize()
  stopSidebarResize()
  stopRightSidebarResize()
  unlistenFileDrop?.()
  unlistenWindowResize?.()
  unlistenCloseRequested?.()
  if (syncCompactLayout) compactMedia?.removeEventListener('change', syncCompactLayout)
  window.removeEventListener('resize', syncViewportWidth)
})
</script>

<template>
  <div class="app-shell" :class="{ 'desktop-shell': !isDemo, 'window-maximized': !isDemo && windowMaximized, 'has-custom-background': !!backgroundUrl }" :style="appAppearanceStyle" @dragenter="enterExternalDrag" @dragover="overExternalDrag" @dragleave="leaveExternalDrag" @drop="dropExternalFiles">
    <header class="topbar" data-tauri-drag-region @dblclick.self="!isDemo && toggleMaximizeWindow()">
      <div class="brand-area" data-tauri-drag-region>
        <div class="brand-mark">M</div>
        <div class="brand-name">码档</div>
      </div>

      <div ref="searchRoot" class="global-search" :class="{ focused: searchOpen, disabled: !workspaceName }">
        <Search :size="16" />
        <input v-model="searchQuery" :disabled="!workspaceName" :placeholder="workspaceName ? '搜索当前范围…' : '请先打开文件或目录'" @focus="searchOpen = !!searchQuery" @keydown.escape="searchOpen = false" />
        <Transition name="ui-dropdown">
        <div v-if="searchOpen" class="search-results">
          <div class="search-heading">搜索结果 <span v-if="isSearching">正在查找…</span></div>
          <button v-for="result in searchResults" :key="`${result.relativePath}:${result.line}`" @click="store.openSearchResult(result); searchOpen = false">
            <span class="result-icon"><Hash :size="14" /></span>
            <span><strong>{{ result.relativePath }}</strong><small>{{ result.preview }} · 第 {{ result.line }} 行</small></span>
          </button>
          <div v-if="!isSearching && !searchResults.length" class="search-empty">没有找到匹配内容</div>
        </div>
        </Transition>
      </div>

      <div class="document-title" data-tauri-drag-region :class="{ empty: !activePath }" :title="activePath">
        <strong v-if="activePath">{{ activeName }}</strong>
        <span v-if="activePath" class="save-state" :class="saveStatus"><Check v-if="saveStatus === 'saved'" :size="14" />{{ saveLabel }}</span>
      </div>

      <div class="top-actions">
        <div class="view-switcher" :class="[`mode-${viewMode}`, { disabled: !activePath }]">
          <button :disabled="!activePath" :class="{ active: viewMode === 'split' }" :title="compactLayout ? '当前窗口较窄，双栏会优先显示编辑区' : '同时显示编辑和预览'" @click="selectViewMode('split')"><Columns2 :size="15" /><span>双栏</span></button>
          <button :disabled="!activePath" :class="{ active: viewMode === 'editor' }" title="仅显示编辑区" @click="selectViewMode('editor')"><Code2 :size="15" /><span>编辑</span></button>
          <button :disabled="!activePath" :class="{ active: viewMode === 'preview' }" title="仅显示预览区" @click="selectViewMode('preview')"><Eye :size="15" /><span>预览</span></button>
        </div>
        <span class="topbar-divider" />
        <UiPopover v-model="exportOpen" width="230px">
          <template #trigger><button class="toolbar-button export-trigger" :disabled="!activePath" title="导出" @click="activePath && (exportOpen = !exportOpen)"><Download :size="17" /><span>导出</span><ChevronDown class="export-chevron" :size="13" /></button></template>
          <button class="popover-action" :disabled="!!exportingKind" @click="doExport('markdown')"><FileText :size="15" /><span><strong>{{ exportingKind === 'markdown' ? '正在导出…' : 'Markdown 副本' }}</strong><small>保留原始文本与语法</small></span></button>
          <button class="popover-action" :disabled="!!exportingKind" @click="doExport('html')"><Code2 :size="15" /><span><strong>{{ exportingKind === 'html' ? '正在导出…' : 'HTML 网页' }}</strong><small>可在浏览器独立打开</small></span></button>
          <button class="popover-action" :disabled="!!exportingKind" @click="doExport('pdf')"><Download :size="15" /><span><strong>{{ exportingKind === 'pdf' ? '正在生成 PDF…' : 'PDF 文档' }}</strong><small>A4 页面自动分页</small></span></button>
          <button class="popover-action" :disabled="!!exportingKind" @click="doExport('png')"><Eye :size="15" /><span><strong>{{ exportingKind === 'png' ? '正在生成图片…' : 'PNG 长图' }}</strong><small>完整预览高清图片</small></span></button>
          <button v-if="isDemo" class="popover-action" :disabled="backupBusy" @click="downloadWorkspaceBackup"><ArchiveRestore :size="15" /><span><strong>{{ backupBusy ? '正在打包…' : '完整文档包 ZIP' }}</strong><small>包含全部 Markdown 与 assets 图片</small></span></button>
        </UiPopover>
        <UiPopover v-model="settingsOpen" width="380px">
          <template #trigger><button class="toolbar-button settings-trigger" title="设置" @click="settingsOpen = !settingsOpen"><Settings :size="17" /><span>设置</span></button></template>
          <div class="settings-panel">
            <div class="popover-title">设置</div>
            <div class="settings-tabs" role="tablist" aria-label="设置分类">
              <button type="button" :class="{ active: settingsSection === 'appearance' }" @click="settingsSection = 'appearance'">外观</button>
              <button type="button" :class="{ active: settingsSection === 'editor' }" @click="settingsSection = 'editor'">编辑</button>
              <button type="button" :class="{ active: settingsSection === 'code' }" @click="settingsSection = 'code'">代码块</button>
            </div>
            <div v-if="settingsSection === 'appearance'" class="settings-section">
              <div class="setting-row"><span><strong>明暗外观</strong><small>调整界面亮度</small></span><UiSelect v-model="settings.theme" :options="themeOptions" aria-label="选择明暗外观" /></div>
              <div class="theme-setting-section">
                <span><strong>主题配色</strong><small>应用于按钮、选中状态和界面层次</small></span>
                <div class="theme-palette-grid">
                  <button v-for="item in colorThemes" :key="item.value" type="button" :class="{ active: settings.colorTheme === item.value }" @click="settings.colorTheme = item.value">
                    <i><b v-for="color in item.colors" :key="color" :style="{ background: color }" /></i><em>{{ item.label }}</em><Check v-if="settings.colorTheme === item.value" :size="13" />
                  </button>
                </div>
              </div>
              <div class="background-setting-section">
                <span><strong>程序背景</strong><small>桌面端与 Web 端都会保存在当前设备</small></span>
                <input ref="backgroundInput" class="background-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" @change="selectAppBackground">
                <div v-if="backgroundUrl" class="background-preview" :style="{ backgroundImage: `url(${backgroundUrl})` }">
                  <span>{{ backgroundName }}</span>
                  <div><button type="button" @click="backgroundInput?.click()">更换</button><button type="button" class="danger" @click="clearAppBackground">移除</button></div>
                </div>
                <button v-else type="button" class="background-picker" @click="backgroundInput?.click()"><ImagePlus :size="18" /><span><strong>选择背景图片</strong><small>建议使用宽幅、低对比度图片</small></span></button>
                <div v-if="backgroundUrl" class="setting-row compact"><span><strong>面板清晰度</strong><small>数值越高，文字区域越清晰</small></span><UiNumberStepper v-model="settings.backgroundPanelOpacity" :min="70" :max="98" suffix="%" /></div>
              </div>
            </div>
            <div v-else-if="settingsSection === 'editor'" class="settings-section">
              <div class="setting-row"><span><strong>界面与文档字体</strong><small>JetBrains Mono，中文使用系统字体回退</small></span><span class="font-setting-badge">JetBrains Mono</span></div>
              <div class="setting-row"><span><strong>文档字号</strong><small>同步调整编辑与预览，12 至 22 像素</small></span><UiNumberStepper v-model="settings.fontSize" :min="12" :max="22" suffix=" px" /></div>
              <div class="setting-row"><span><strong>Tab 宽度</strong><small>插入空格数量</small></span><UiSelect v-model="settings.tabSize" :options="tabOptions" aria-label="选择 Tab 宽度" /></div>
              <button v-if="isDemo" class="storage-setting-entry" @click="openStorageManager"><span><HardDrive :size="16" /><i><strong>存储管理</strong><small>查看文档、图片与浏览器占用</small></i></span><ChevronDown :size="14" /></button>
            </div>
            <div v-else class="settings-section">
              <div class="setting-row"><span><strong>显示方式</strong><small>控制较长代码块的展示高度</small></span><UiSelect v-model="settings.codeBlockMode" :options="codeBlockModeOptions" aria-label="选择代码块显示方式" /></div>
              <div v-if="settings.codeBlockMode === 'limited'" class="setting-row"><span><strong>最大高度</strong><small>超出后可在代码块内滚动</small></span><UiNumberStepper v-model="settings.codeBlockMaxHeight" :min="200" :max="800" :step="20" suffix=" px" /></div>
              <div class="setting-row"><span><strong>高亮主题</strong><small>只影响预览区域中的代码块</small></span><UiSelect v-model="settings.codeTheme" :options="codeThemeOptions" aria-label="选择代码高亮主题" /></div>
              <div class="setting-row"><span><strong>长行显示</strong><small>控制超过代码块宽度的内容</small></span><UiSelect v-model="settings.codeWrapMode" :options="codeWrapOptions" aria-label="选择代码长行显示方式" /></div>
            </div>
          </div>
        </UiPopover>
        <span v-if="!isDemo" class="topbar-divider window-divider" />
        <div v-if="!isDemo" class="window-controls">
          <button title="最小化" @click="minimizeWindow"><Minus :size="16" /></button>
          <button :title="windowMaximized ? '还原窗口' : '最大化'" @click="toggleMaximizeWindow"><Copy v-if="windowMaximized" :size="13" /><Square v-else :size="13" /></button>
          <button class="window-close" title="关闭" @click="requestWindowClose"><X :size="17" /></button>
        </div>
      </div>
    </header>

    <main v-if="workspaceName" class="workspace">
      <aside ref="leftSidebar" class="left-sidebar" :class="`sidebar-${sidebarMode}`" :style="{ width: `${effectiveLeftSidebarWidth}px` }">
        <div class="sidebar-resize-handle" title="拖动调整侧边栏宽度" @pointerdown="startSidebarResize"><span /></div>
        <UiPopover v-model="newMenuOpen" align="center" width="218px">
          <template #trigger>
            <div class="new-row">
              <button class="new-file" title="新建 Markdown 文件" @click="newMenuOpen = false; newFileOpen = true"><FilePlus2 :size="17" /><span class="new-file-label">新建文件</span></button>
              <button class="new-menu" aria-label="更多新建选项" :aria-expanded="newMenuOpen" @click="newMenuOpen = !newMenuOpen"><ChevronDown :size="14" /></button>
            </div>
          </template>
          <div class="new-create-menu">
            <button type="button" @click="openMarkdownFiles"><span class="create-icon"><FileText :size="16" /></span><span><strong>打开本地文件</strong><small>选择一个或多个 Markdown 文档</small></span></button>
            <button type="button" @click="openLocalDirectory"><span class="create-icon"><FolderOpen :size="16" /></span><span><strong>打开本地目录</strong><small>读取目录中的 Markdown 文档</small></span></button>
            <button v-if="isDemo" type="button" @click="newMenuOpen = false; selectWorkspaceBackup()"><span class="create-icon"><ArchiveRestore :size="16" /></span><span><strong>导入码档备份</strong><small>恢复 ZIP 中的文档与图片</small></span></button>
          </div>
        </UiPopover>
        <div class="workspace-heading">
          <span>{{ workspaceName || '选择本地目录' }}</span>
          <div class="workspace-controls">
            <span class="workspace-actions">
              <button v-if="workspaceMode === 'directory'" title="新建文件夹" @click="newFolderOpen = true"><FolderPlus :size="13" /></button>
              <button v-if="workspaceMode === 'directory'" title="重命名目录显示名称" @click="openWorkspaceRename"><Pencil :size="13" /></button>
              <button :title="workspaceMode === 'files' ? '关闭已打开文件' : '移除目录'" :class="{ danger: workspaceMode !== 'files' }" @click="workspaceRemoveOpen = true"><X v-if="workspaceMode === 'files'" :size="13" /><Trash2 v-else :size="13" /></button>
            </span>
            <UiPopover v-model="fileSortOpen" align="right" width="194px">
              <template #trigger><button class="workspace-sort-button" title="文件排序" :aria-expanded="fileSortOpen" @click="fileSortOpen = !fileSortOpen"><ArrowUpDown :size="13" /></button></template>
              <div class="sort-menu">
                <div class="sort-menu-title">文件排序</div>
                <button v-for="option in fileSortOptions" :key="option.value" :class="{ active: fileSortMode === option.value }" @click="selectFileSort(option.value)"><span>{{ option.label }}</span><Check v-if="fileSortMode === option.value" :size="14" /></button>
              </div>
            </UiPopover>
          </div>
        </div>
        <div class="file-tree-scroll" @dragover="overTreeRoot" @drop="dropOnTreeRoot">
          <FileTree
            :nodes="sortedTree"
            :active-path="activePath"
            @open="store.openFile"
            @rename="openRename"
            @delete="deleteTarget = $event"
            @reveal="store.revealEntry"
            @move="store.moveEntry"
            @import="importIntoFolder"
          />
        </div>
        <button v-if="!isDemo" class="trash-entry-button" title="查看可恢复的已删除项目" @click="openTrash">
          <ArchiveRestore :size="15" />
          <span class="trash-entry-label">回收站</span>
          <span v-if="trashItems.length" class="trash-count">{{ trashItems.length }}</span>
        </button>
        <div class="local-badge" :title="`${workspaceFileCount} 个 Markdown 文档${activePath ? `，当前文档 ${statistics.words} 字，${saveLabel}` : ''}`">
          <FileText :size="15" />
          <span class="local-label"><strong>{{ workspaceFileCount }}</strong> 个文档 <i /> <span v-if="activePath">{{ statistics.words }} 字 <i /> {{ saveLabel }}</span><span v-else>未选择文档</span></span>
        </div>
      </aside>

      <Transition name="sidebar-slide">
      <aside v-if="rightOpen && activePath" ref="rightSidebar" class="right-sidebar-shell" :style="{ '--right-sidebar-width': `${settings.rightSidebarWidth}px` }">
        <div class="right-sidebar-resize-handle" title="拖动调整大纲区域宽度" @pointerdown="startRightSidebarResize"><span /></div>
        <div class="right-sidebar">
        <div class="right-tabs">
          <button :class="{ active: activeRightTab === 'outline' }" @click="activeRightTab = 'outline'">大纲</button>
          <button :class="{ active: activeRightTab === 'inspect' }" @click="activeRightTab = 'inspect'">检查</button>
          <button class="right-collapse" title="收起文档导航" @click="rightOpen = false"><PanelLeftClose :size="16" /></button>
        </div>
        <div v-if="activeRightTab === 'outline'" class="outline-list">
          <button v-for="heading in headings" :key="heading.id" :class="{ 'outline-major': heading.level <= 2 }" :style="{ paddingLeft: `${9 + (heading.level - 1) * 11}px` }" @click="goToHeading(heading)">
            <span>{{ heading.text }}</span>
          </button>
          <div v-if="!headings.length" class="panel-empty">添加标题后将在这里生成大纲</div>
        </div>
        <div v-else class="inspection-panel">
          <section class="inspection-section">
            <div class="inspection-heading"><strong>文档检查</strong><span :class="{ clear: !documentInspection.issues.length }">{{ documentInspection.issues.length ? `${documentInspection.issues.length} 个问题` : '未发现问题' }}</span></div>
            <div v-if="!documentInspection.issues.length" class="inspection-clear"><Check :size="15" />文档结构看起来不错</div>
            <button v-for="issue in documentInspection.issues" :key="`${issue.line}-${issue.title}`" class="inspection-item issue" @click="goToInspectionLine(issue.line)">
              <AlertTriangle :size="14" />
              <span><strong>{{ issue.title }}</strong><small>{{ issue.detail }}</small></span>
              <em>{{ issue.line }}</em>
            </button>
          </section>
          <section class="inspection-section">
            <div class="inspection-heading"><strong>待办事项</strong><span>{{ documentInspection.pendingTasks.length }} 项未完成</span></div>
            <div v-if="!documentInspection.tasks.length" class="inspection-empty">文档中暂无任务列表</div>
            <button v-for="task in documentInspection.tasks" :key="`${task.line}-${task.text}`" class="inspection-item task" :class="{ completed: task.completed }" @click="goToInspectionLine(task.line)">
              <i><Check v-if="task.completed" :size="10" /></i>
              <span><strong>{{ task.text }}</strong><small>第 {{ task.line }} 行</small></span>
            </button>
          </section>
          <section class="inspection-section document-details">
            <div class="inspection-heading"><strong>文档信息</strong></div>
            <dl><div><dt>位置</dt><dd :title="activePath">{{ activePath }}</dd></div><div><dt>大小</dt><dd>{{ documentInspection.size < 1024 ? `${documentInspection.size} B` : `${(documentInspection.size / 1024).toFixed(1)} KB` }}</dd></div><div><dt>创建</dt><dd>{{ formatFileTime(activeFile?.createdAt) }}</dd></div><div><dt>修改</dt><dd>{{ formatFileTime(activeFile?.modifiedAt) }}</dd></div></dl>
          </section>
          <section class="inspection-overview">
            <span><strong>{{ headings.length }}</strong>标题</span><span><strong>{{ documentInspection.images }}</strong>图片</span><span><strong>{{ documentInspection.links }}</strong>链接</span><span><strong>{{ documentInspection.codeBlocks }}</strong>代码块</span>
            <p>{{ statistics.words }} 字 · 阅读约 {{ statistics.readingMinutes }} 分钟</p>
          </section>
        </div>
        <div v-if="activeRightTab === 'outline'" class="right-bottom-stats">
          <div class="panel-title">文档摘要</div>
          <div class="stat-grid"><span><strong>{{ statistics.words }}</strong>字词</span><span><strong>{{ statistics.chars }}</strong>字符</span><span><strong>{{ statistics.lines }}</strong>行</span></div>
          <p>阅读时间：{{ statistics.readingMinutes }} 分钟</p>
          <div class="document-time-list"><span><small>创建时间</small><strong>{{ formatFileTime(activeFile?.createdAt) }}</strong></span><span><small>修改时间</small><strong>{{ formatFileTime(activeFile?.modifiedAt) }}</strong></span></div>
        </div>
        </div>
      </aside>
      </Transition>

      <section v-if="activePath" class="content-column">
        <div class="format-toolbar">
          <button v-if="!rightOpen" class="outline-open-button" title="打开大纲与检查" @click="rightOpen = true"><PanelLeftOpen :size="17" /></button>
          <span v-if="!rightOpen" class="tool-divider" />
          <button title="标题" :class="{ active: formatState.heading }" @click="format('heading')"><span class="format-letter">H</span></button>
          <button title="粗体" :class="{ active: formatState.bold }" @click="format('bold')"><Bold :size="16" /></button>
          <button title="斜体" :class="{ active: formatState.italic }" @click="format('italic')"><Italic :size="16" /></button>
          <button title="删除线" :class="{ active: formatState.strike }" @click="format('strike')"><Strikethrough :size="16" /></button>
          <span class="tool-divider" />
          <button title="无序列表" :class="{ active: formatState.list }" @click="format('list')"><List :size="17" /></button>
          <button title="任务列表" :class="{ active: formatState.task }" @click="format('task')"><ListChecks :size="17" /></button>
          <button title="引用" :class="{ active: formatState.quote }" @click="format('quote')"><Quote :size="16" /></button>
          <button title="代码块" :class="{ active: formatState.code }" @click="format('code')"><Braces :size="17" /></button>
          <span class="tool-spacer" />
        </div>

        <div ref="editorStage" class="editor-stage" :class="`mode-${viewMode}`" :style="splitStyle">
          <div v-show="viewMode !== 'preview'" class="editor-pane">
            <MarkdownEditor v-model="content" :dark="dark" :font-size="settings.fontSize" :tab-size="settings.tabSize" @format-state="formatState = $event" @cursor-line="followEditorCursor" @drop-files="importIntoEditor" @insert-images="store.importImages" />
          </div>
          <div v-if="viewMode === 'split'" class="split-handle" title="拖动调整编辑和预览宽度" @pointerdown="startSplitResize"><span /></div>
          <div v-show="viewMode !== 'editor'" class="preview-pane"><MarkdownPreview :content="content" :font-size="settings.fontSize" :document-path="activePath" :code-block-mode="settings.codeBlockMode" :code-block-max-height="settings.codeBlockMaxHeight" :code-theme="settings.codeTheme" :code-wrap-mode="settings.codeWrapMode" @update:content="content = $event" /></div>
        </div>
        <footer class="statusbar">
          <span>{{ statistics.lines }} 行</span><span>{{ statistics.words }} 字</span><span>{{ statistics.chars }} 字符</span>
          <span class="status-spacer" /><span>Markdown</span><span>空格: {{ settings.tabSize }}</span><span><i class="status-dot" />自动保存：开启</span>
        </footer>
      </section>

      <section v-else class="content-column document-empty-shell">
        <div class="document-empty-state">
          <span><FilePlus2 :size="23" /></span>
          <strong>没有打开的文档</strong>
          <small>从左侧选择一个 Markdown 文件，或者新建文档开始编辑。</small>
          <UiButton variant="primary" @click="newFileOpen = true"><FilePlus2 :size="15" />新建 Markdown 文件</UiButton>
        </div>
      </section>

    </main>

    <main v-else class="workspace-empty">
      <div class="empty-workspace-card">
        <span class="empty-workspace-icon"><FolderPlus :size="26" /></span>
        <div class="empty-workspace-copy">
          <strong>打开文件或目录</strong>
          <span>直接打开一个本地文件，或浏览目录中的 Markdown 文档。</span>
        </div>
        <div class="empty-workspace-actions">
          <UiButton variant="primary" @click="openMarkdownFiles"><FileText :size="16" />打开本地文件</UiButton>
          <UiButton variant="secondary" @click="openLocalDirectory"><FolderOpen :size="16" />打开本地目录</UiButton>
          <UiButton v-if="isDemo" variant="secondary" @click="selectWorkspaceBackup"><ArchiveRestore :size="16" />导入备份</UiButton>
        </div>
      </div>
    </main>

    <UiModal v-model="newFileOpen" title="新建 Markdown 文件">
      <form class="ui-form" @submit.prevent="createFile">
        <label>文件名<input v-model="newFileName" autofocus placeholder="例如：项目计划.md" /></label>
        <small>文件将创建在当前目录根位置。</small>
        <div class="ui-form-actions"><UiButton variant="secondary" @click="newFileOpen = false">取消</UiButton><UiButton type="submit" variant="primary">创建文件</UiButton></div>
      </form>
    </UiModal>

    <UiModal v-model="storageOpen" title="存储管理" width="760px">
      <div v-if="storageLoading && !storageInfo" class="storage-loading">正在统计本地数据…</div>
      <div v-else-if="storageInfo" class="storage-manager">
        <div class="storage-manager-actions"><UiButton variant="secondary" :disabled="backupBusy" @click="selectWorkspaceBackup"><Upload :size="15" />导入备份</UiButton><UiButton variant="primary" :disabled="backupBusy || !storageInfo.documents.length" @click="downloadWorkspaceBackup"><Download :size="15" />{{ backupBusy ? '正在处理…' : '导出全部数据' }}</UiButton></div>
        <section class="storage-summary">
          <div><span><small>码档数据</small><strong>{{ formatExportSize(storageInfo.totalSize) }}</strong></span><HardDrive :size="22" /></div>
          <div class="storage-breakdown"><span><i class="document" />文档 {{ formatExportSize(storageInfo.documentBytes) }}</span><span><i class="asset" />图片 {{ formatExportSize(storageInfo.assetBytes) }}</span><span v-if="storageInfo.quota">浏览器可用上限约 {{ formatExportSize(storageInfo.quota) }}</span></div>
        </section>
        <section class="storage-section">
          <div class="storage-section-heading"><span><strong>文档占用</strong><small>{{ storageInfo.documents.length }} 个浏览器本地文档</small></span></div>
          <div v-if="storageInfo.documents.length" class="storage-list">
            <div v-for="document in storageInfo.documents" :key="document.path" class="storage-list-item">
              <span class="storage-type-icon"><FileText :size="16" /></span>
              <span class="storage-item-copy"><strong :title="document.path">{{ document.path }}</strong><small>正文 {{ formatExportSize(document.size) }} · {{ document.assetCount }} 张图片 {{ formatExportSize(document.assetSize) }}</small></span>
              <b>{{ formatExportSize(document.totalSize) }}</b>
            </div>
          </div>
          <div v-else class="storage-empty-row">暂无浏览器本地文档</div>
        </section>
        <section class="storage-section">
          <div class="storage-section-heading"><span><strong>图片资源</strong><small>{{ storageInfo.assets.length }} 张，共 {{ formatExportSize(storageInfo.assetBytes) }}</small></span><UiButton v-if="storageInfo.unreferencedAssets.length" size="sm" variant="danger" @click="storageCleanupOpen = true">清理未使用</UiButton></div>
          <div v-if="storageInfo.assets.length" class="storage-list asset-list">
            <div v-for="asset in storageInfo.assets" :key="asset.path" class="storage-list-item">
              <span class="storage-type-icon image"><ImageIcon :size="16" /></span>
              <span class="storage-item-copy"><strong :title="asset.name">{{ asset.name }}</strong><small>{{ asset.references.length ? `被 ${asset.references.length} 篇文档引用` : '未被任何文档引用' }}</small></span>
              <b>{{ formatExportSize(asset.size) }}</b>
            </div>
          </div>
          <div v-else class="storage-empty-row">粘贴或拖入图片后会显示在这里</div>
        </section>
      </div>
    </UiModal>

    <UiModal :model-value="backupImportOpen" title="恢复码档备份" @update:model-value="setBackupImportOpen">
      <div v-if="backupSummary" class="backup-import-summary">
        <span class="backup-import-icon"><ArchiveRestore :size="24" /></span>
        <strong>{{ backupSummary.name }}</strong>
        <small>{{ backupSummary.documentCount }} 个文档 · {{ backupSummary.assetCount }} 张图片 · {{ formatExportSize(backupSummary.totalSize) }}</small>
        <p>恢复后将替换当前浏览器中的文档集合。当前真实磁盘目录和客户端文件不会受到影响。</p>
      </div>
      <div class="ui-form-actions"><UiButton variant="secondary" :disabled="backupBusy" @click="setBackupImportOpen(false)">取消</UiButton><UiButton variant="primary" :disabled="backupBusy" @click="confirmWorkspaceBackupImport">{{ backupBusy ? '正在恢复…' : '确认恢复' }}</UiButton></div>
    </UiModal>

    <UiModal v-model="storageCleanupOpen" title="清理未使用图片">
      <div class="delete-copy"><strong>{{ storageInfo?.unreferencedAssets.length || 0 }} 张图片</strong><p>这里只包含由码档创建且已不被任何 Markdown 文档引用的图片；用户原有的图片不会被纳入清理。</p></div>
      <div class="ui-form-actions"><UiButton variant="secondary" @click="storageCleanupOpen = false">取消</UiButton><UiButton variant="danger" :disabled="storageLoading" @click="cleanUnusedAssets">{{ storageLoading ? '正在清理…' : '确认清理' }}</UiButton></div>
    </UiModal>

    <UiModal v-model="newFolderOpen" title="新建文件夹">
      <form class="ui-form" @submit.prevent="createFolder">
        <label>文件夹名称<input v-model="newFolderName" autofocus placeholder="例如：项目资料" /></label>
        <small>文件夹将创建在当前目录根位置。</small>
        <div class="ui-form-actions"><UiButton variant="secondary" @click="newFolderOpen = false">取消</UiButton><UiButton type="submit" variant="primary">创建文件夹</UiButton></div>
      </form>
    </UiModal>

    <UiModal :model-value="!!renameTarget" :title="renameTarget?.kind === 'directory' ? '重命名文件夹' : '重命名文件'" @update:model-value="value => { if (!value) renameTarget = null }">
      <form class="ui-form" @submit.prevent="confirmRename">
        <label>新名称<input v-model="renameName" autofocus /></label>
        <small v-if="renameTarget?.kind === 'file'">请保留 Markdown 文件扩展名。</small>
        <div class="ui-form-actions"><UiButton variant="secondary" @click="renameTarget = null">取消</UiButton><UiButton type="submit" variant="primary">保存名称</UiButton></div>
      </form>
    </UiModal>

    <UiModal v-model="workspaceRenameOpen" title="重命名目录显示名称">
      <form class="ui-form" @submit.prevent="confirmWorkspaceRename">
        <label>目录显示名称<input v-model="workspaceRenameName" autofocus /></label>
        <small>只修改应用内显示名称，不会重命名磁盘上的根目录。</small>
        <div class="ui-form-actions"><UiButton variant="secondary" @click="workspaceRenameOpen = false">取消</UiButton><UiButton type="submit" variant="primary">保存名称</UiButton></div>
      </form>
    </UiModal>

    <UiModal
      :model-value="exportPreviewOpen"
      :title="preparedExport ? `导出预览 · ${preparedExport.label}` : '导出预览'"
      width="780px"
      @update:model-value="setExportPreviewOpen"
    >
      <div v-if="preparedExport" class="export-preview-dialog">
        <div class="export-preview-meta">
          <span><strong>{{ preparedExport.name }}</strong><small>{{ preparedExport.label }} · {{ formatExportSize(preparedExport.bytes.length) }}</small></span>
          <span class="clipboard-image-size">剪贴板图片 · {{ formatExportSize(preparedExport.clipboardImageBytes.length) }}</span>
        </div>
        <div class="export-preview-frame preview-image">
          <img :src="preparedExport.previewUrl" :alt="`${preparedExport.label} 导出预览`" />
        </div>
      </div>
      <template #footer>
        <UiButton variant="secondary" :disabled="!!exportAction" @click="downloadPreparedExport"><Download :size="15" />{{ exportAction === 'download' ? '正在下载…' : '下载文件' }}</UiButton>
        <UiButton variant="primary" :disabled="!!exportAction" @click="copyPreparedImage"><Copy :size="15" />{{ exportAction === 'copy' ? '正在复制…' : copiedImage ? '已复制图片' : '复制图片' }}</UiButton>
      </template>
    </UiModal>

    <UiModal v-model="workspaceRemoveOpen" :title="workspaceMode === 'files' ? '关闭文件' : '移除目录'">
      <div class="delete-copy"><strong>{{ workspaceName }}</strong><p>{{ workspaceMode === 'files' ? '已打开文件将从当前窗口关闭，不会删除磁盘上的原文件。' : '目录将从当前窗口移除，但不会删除磁盘上的目录或任何 Markdown 文件。' }}</p></div>
      <div class="ui-form-actions"><UiButton variant="secondary" @click="workspaceRemoveOpen = false">取消</UiButton><UiButton variant="danger" @click="confirmWorkspaceRemove">{{ workspaceMode === 'files' ? '关闭文件' : '移除目录' }}</UiButton></div>
    </UiModal>

    <UiModal v-model="trashOpen" title="回收站" width="620px">
      <div v-if="trashItems.length" class="trash-list">
        <div v-for="item in trashItems" :key="item.id" class="trash-item">
          <span class="trash-item-icon"><FolderOpen v-if="item.kind === 'directory'" :size="17" /><FileText v-else :size="17" /></span>
          <span class="trash-item-copy"><strong>{{ item.name }}</strong><small>{{ item.originalRelativePath }} · {{ formatDeletedAt(item.deletedAt) }}</small></span>
          <UiButton variant="secondary" size="sm" @click="restoreTrash(item)">恢复</UiButton>
          <button class="trash-permanent-button" title="永久删除" @click="trashDeleteTarget = item"><Trash2 :size="15" /></button>
        </div>
      </div>
      <div v-else class="trash-empty"><ArchiveRestore :size="26" /><strong>回收站是空的</strong><span>从文件列表删除的内容会暂存在这里。</span></div>
    </UiModal>

    <UiModal :model-value="!!trashDeleteTarget" title="永久删除" @update:model-value="value => { if (!value) trashDeleteTarget = null }">
      <div class="delete-copy"><strong>{{ trashDeleteTarget?.name }}</strong><p>此操作无法撤销，文件将从应用回收站中永久删除。</p></div>
      <div class="ui-form-actions"><UiButton variant="secondary" @click="trashDeleteTarget = null">取消</UiButton><UiButton variant="danger" @click="confirmPermanentDelete">永久删除</UiButton></div>
    </UiModal>

    <UiModal v-model="closeConfirmOpen" title="关闭码档">
      <div class="close-confirm-copy"><strong>要最小化窗口还是退出程序？</strong><p>选择退出前，当前文档会先完成自动保存。</p></div>
      <div class="ui-form-actions close-confirm-actions">
        <UiButton variant="secondary" :disabled="exitInProgress" @click="minimizeFromCloseDialog">最小化</UiButton>
        <UiButton variant="danger" :disabled="exitInProgress" @click="exitApplication">{{ exitInProgress ? '正在退出…' : '退出程序' }}</UiButton>
      </div>
    </UiModal>

    <UiModal :model-value="!!deleteTarget" :title="deleteTarget?.kind === 'directory' ? '删除文件夹' : '删除文件'" @update:model-value="setDeleteOpen">
      <div class="delete-copy"><strong>{{ deleteTarget?.name }}</strong><p>{{ deleteTarget?.kind === 'directory' ? '文件夹及其中所有内容' : '文件' }}{{ isDemo ? '将从当前文件列表中永久删除。' : '将移动到应用回收站，之后可以恢复。' }}</p></div>
      <div class="ui-form-actions"><UiButton variant="secondary" @click="deleteTarget = null">取消</UiButton><UiButton variant="danger" @click="confirmDelete">确认删除</UiButton></div>
    </UiModal>

    <Transition name="drop-overlay">
      <div v-if="dropActive" class="workspace-drop-overlay">
        <div><span class="drop-icon"><ImageIcon v-if="imageDropActive" :size="24" /><Upload v-else :size="24" /></span><strong>{{ imageDropActive ? '松开以插入图片' : workspaceName ? '松开以导入 Markdown 文件' : '松开以打开本地文件' }}</strong><small>{{ imageDropActive ? '图片将保存到浏览器本地 assets，并插入当前文档' : workspaceName ? '支持 .md 和 .markdown，可直接拖到左侧文件夹中' : '只打开本次拖入的 Markdown 文档，不扫描父目录' }}</small></div>
      </div>
    </Transition>
    <div v-if="errorMessage" class="error-toast"><span>{{ errorMessage }}</span><button @click="store.dismissError"><X :size="15" /></button></div>
  </div>
</template>
