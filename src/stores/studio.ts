import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AppSettings, FileNode, SaveStatus, SearchResult, ThemeMode, TrashItem, ViewMode } from '../types'
import * as desktop from '../services/desktop'
import * as web from '../services/webWorkspace'

const defaultSettings: AppSettings = {
  theme: 'light',
  fontSize: 15,
  tabSize: 2,
  autoSaveDelay: 800,
  splitRatio: 0.5,
  leftSidebarWidth: 250,
  rightSidebarWidth: 224,
}

const desktopSessionKey = 'md-lai-le-desktop-session'
const webSessionKey = 'md-lai-le-web-session'
const settingsKey = 'md-lai-le-settings'
const legacySettingsKey = 'markdown-studio-settings'
const viewModeKey = 'md-lai-le-view-mode'

export const useStudioStore = defineStore('studio', () => {
  const workspacePath = ref('')
  const workspaceName = ref('')
  const workspaceMode = ref<'files' | 'directory'>('directory')
  const tree = ref<FileNode[]>([])
  const activePath = ref('')
  const content = ref('')
  const savedContent = ref('')
  const saveStatus = ref<SaveStatus>('saved')
  const storedViewMode = localStorage.getItem(viewModeKey)
  const viewMode = ref<ViewMode>(storedViewMode === 'editor' || storedViewMode === 'preview' || storedViewMode === 'split' ? storedViewMode : 'split')
  const settings = ref<AppSettings>({ ...defaultSettings })
  const searchResults = ref<SearchResult[]>([])
  const isSearching = ref(false)
  const errorMessage = ref('')
  const loading = ref(false)
  const trashItems = ref<TrashItem[]>([])

  const activeName = computed(() => activePath.value.split(/[\\/]/).pop() || '未命名文档')
  const isDemo = computed(() => !desktop.isTauri())

  let saveTimer: number | undefined
  let suppressWatch = false
  const standalonePaths = new Set<string>()

  function persistDesktopSession() {
    const sessionKey = desktop.isTauri() ? desktopSessionKey : webSessionKey
    if (!workspacePath.value) {
      localStorage.removeItem(sessionKey)
      return
    }
    localStorage.setItem(sessionKey, JSON.stringify({
      workspacePath: workspacePath.value,
      workspaceName: workspaceName.value,
      workspaceMode: workspaceMode.value,
      standalonePaths: [...standalonePaths],
      activePath: activePath.value,
    }))
  }

  async function loadTrash() {
    trashItems.value = desktop.isTauri() && workspacePath.value ? await desktop.listTrash() : []
  }

  function scopedTree(nodes: FileNode[]): FileNode[] {
    return workspaceMode.value === 'files' ? filterTree(nodes, standalonePaths) : nodes
  }

  function applyTheme(theme: ThemeMode) {
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }

  function loadSettings() {
    try {
      const stored = localStorage.getItem(settingsKey) || localStorage.getItem(legacySettingsKey)
      if (stored) settings.value = { ...defaultSettings, ...JSON.parse(stored) }
    } catch {
      settings.value = { ...defaultSettings }
    }
    applyTheme(settings.value.theme)
  }

  function persistSettings() {
    localStorage.setItem(settingsKey, JSON.stringify(settings.value))
  }

  watch(settings, (value) => {
    localStorage.setItem(settingsKey, JSON.stringify(value))
    applyTheme(value.theme)
  }, { deep: true, flush: 'sync' })

  watch(viewMode, (value) => localStorage.setItem(viewModeKey, value), { flush: 'sync' })

  watch(content, () => {
    if (suppressWatch || !activePath.value) return
    saveStatus.value = 'dirty'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(save, settings.value.autoSaveDelay)
  })

  async function initializeWorkspace() {
    if (desktop.isTauri()) {
      const stored = localStorage.getItem(desktopSessionKey)
      if (!stored) return
      try {
        const session = JSON.parse(stored) as {
          workspacePath: string
          workspaceName: string
          workspaceMode: 'files' | 'directory'
          standalonePaths: string[]
          activePath: string
        }
        workspaceMode.value = session.workspaceMode === 'files' ? 'files' : 'directory'
        workspacePath.value = session.workspacePath
        workspaceName.value = session.workspaceName || (session.workspaceMode === 'files' ? '默认文件' : session.workspacePath.split(/[\\/]/).pop() || session.workspacePath)
        standalonePaths.clear()
        session.standalonePaths?.forEach((path) => standalonePaths.add(path))
        tree.value = scopedTree(await desktop.openWorkspace(session.workspacePath))
        await loadTrash()
        const active = findNode(tree.value, session.activePath) || findFirstFile(tree.value)
        if (active) await openFile(active)
        else persistDesktopSession()
      } catch {
        localStorage.removeItem(desktopSessionKey)
        workspacePath.value = ''
        workspaceName.value = ''
        tree.value = []
        activePath.value = ''
        trashItems.value = []
      }
      return
    }
    loading.value = true
    try {
      const result = await web.initialize()
      let restoredActivePath = ''
      try {
        const stored = localStorage.getItem(webSessionKey)
        const session = stored ? JSON.parse(stored) as { workspacePath?: string; activePath?: string } : null
        if (session?.workspacePath === result.name) restoredActivePath = session.activePath || ''
      } catch {
        localStorage.removeItem(webSessionKey)
      }
      workspacePath.value = result.name
      workspaceName.value = result.name
      workspaceMode.value = result.mode
      standalonePaths.clear()
      if (result.mode === 'files') flattenFiles(result.tree).forEach((node) => standalonePaths.add(node.relativePath))
      tree.value = scopedTree(result.tree)
      const active = findNode(tree.value, restoredActivePath) || findFirstFile(tree.value)
      if (active) await openFile(active)
      else persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    } finally {
      loading.value = false
    }
  }

  async function selectWorkspace() {
    errorMessage.value = ''
    loading.value = true
    try {
      if (desktop.isTauri()) {
        const selected = await desktop.chooseWorkspace()
        if (!selected) return false
        standalonePaths.clear()
        workspaceMode.value = 'directory'
        workspacePath.value = selected
        workspaceName.value = selected.split(/[\\/]/).pop() || selected
        tree.value = await desktop.openWorkspace(selected)
        await loadTrash()
      } else {
        const result = await web.chooseDirectory()
        if (!result) return false
        standalonePaths.clear()
        workspaceMode.value = 'directory'
        workspacePath.value = result.name
        workspaceName.value = result.name
        tree.value = result.tree
      }
      const first = findFirstFile(tree.value)
      if (first) await openFile(first)
      else persistDesktopSession()
      return true
    } catch (error) {
      errorMessage.value = readableError(error)
      return false
    } finally {
      loading.value = false
    }
  }

  async function selectFiles() {
    const selected = desktop.isTauri() ? await desktop.chooseMarkdownFiles() : await web.chooseMarkdownFiles()
    if (!selected?.length) return false

    await save()
    suppressWatch = true
    workspacePath.value = ''
    workspaceName.value = ''
    workspaceMode.value = 'files'
    tree.value = []
    activePath.value = ''
    content.value = ''
    savedContent.value = ''
    saveStatus.value = 'saved'
    standalonePaths.clear()
    queueMicrotask(() => { suppressWatch = false })

    if (desktop.isTauri()) {
      await importPathFiles(selected as string[])
    } else {
      const result = await web.openMarkdownFiles(selected as File[])
      workspacePath.value = result.name
      workspaceName.value = result.name
      tree.value = result.tree
      result.tree.filter((node) => node.kind === 'file').forEach((node) => standalonePaths.add(node.relativePath))
      const first = findFirstFile(tree.value)
      if (first) await openFile(first)
    }
    return !!activePath.value
  }

  async function refreshWorkspace() {
    if (!workspacePath.value) return
    try {
      const nextTree = desktop.isTauri() ? await desktop.openWorkspace(workspacePath.value) : await web.refresh()
      tree.value = scopedTree(nextTree)
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function openFile(node: FileNode, targetLine?: number) {
    if (node.kind !== 'file') return
    if (saveStatus.value === 'dirty') await save()
    loading.value = true
    try {
      const next = desktop.isTauri() ? await desktop.readDocument(node.relativePath) : await web.readDocument(node.relativePath)
      suppressWatch = true
      activePath.value = node.relativePath
      content.value = next
      savedContent.value = next
      saveStatus.value = 'saved'
      queueMicrotask(() => { suppressWatch = false })
      if (targetLine) window.setTimeout(() => window.dispatchEvent(new CustomEvent('studio:goto-line', { detail: targetLine })), 0)
      persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    } finally {
      loading.value = false
    }
  }

  async function save() {
    window.clearTimeout(saveTimer)
    if (!activePath.value || content.value === savedContent.value) {
      saveStatus.value = 'saved'
      return
    }
    saveStatus.value = 'saving'
    try {
      if (desktop.isTauri()) await desktop.writeDocument(activePath.value, content.value)
      else await web.writeDocument(activePath.value, content.value)
      savedContent.value = content.value
      saveStatus.value = 'saved'
    } catch (error) {
      saveStatus.value = 'error'
      errorMessage.value = readableError(error)
    }
  }

  async function newDocument(name: string) {
    const normalized = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`
    if (!normalized || normalized === '.md') return
    try {
      const node = desktop.isTauri() ? await desktop.createDocument(normalized) : await web.createDocument(normalized)
      if (workspaceMode.value === 'files') standalonePaths.add(normalized)
      await refreshWorkspace()
      await openFile(node)
      content.value = `# ${normalized.replace(/\.md$/, '')}\n\n`
      await save()
      persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function newFolder(name: string) {
    const normalized = name.trim()
    if (!normalized) return
    try {
      if (desktop.isTauri()) await desktop.createFolder(normalized)
      else await web.createFolder(normalized)
      if (workspaceMode.value === 'files') standalonePaths.add(normalized)
      await refreshWorkspace()
      persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function deleteEntry(node: FileNode) {
    try {
      if (desktop.isTauri()) {
        await desktop.trashEntry(node.relativePath)
      } else {
        await web.deleteEntry(node.relativePath)
      }
      if (workspaceMode.value === 'files') {
        for (const path of [...standalonePaths]) {
          if (path === node.relativePath || path.startsWith(`${node.relativePath}/`)) standalonePaths.delete(path)
        }
      }
      await refreshWorkspace()
      await loadTrash()

      if (activePath.value === node.relativePath || activePath.value.startsWith(`${node.relativePath}/`)) {
        const next = findFirstFile(tree.value)
        if (next) await openFile(next)
        else {
          suppressWatch = true
          activePath.value = ''
          content.value = ''
          savedContent.value = ''
          saveStatus.value = 'saved'
          queueMicrotask(() => { suppressWatch = false })
        }
      }
      persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function restoreTrashItem(item: TrashItem) {
    if (!desktop.isTauri()) return
    try {
      const restored = await desktop.restoreTrash(item.id)
      if (workspaceMode.value === 'files') standalonePaths.add(restored.originalRelativePath)
      await refreshWorkspace()
      await loadTrash()
      persistDesktopSession()
      const node = findNode(tree.value, restored.originalRelativePath)
      if (node?.kind === 'file') await openFile(node)
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function permanentlyDeleteTrashItem(item: TrashItem) {
    if (!desktop.isTauri()) return
    try {
      await desktop.permanentlyDeleteTrash(item.id)
      await loadTrash()
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function renameEntry(node: FileNode, newName: string) {
    let normalized = newName.trim()
    if (node.kind === 'file' && !/\.md(?:own)?$/i.test(normalized)) normalized += '.md'
    if (!normalized || normalized === node.name) return
    try {
      const parent = node.relativePath.includes('/') ? node.relativePath.slice(0, node.relativePath.lastIndexOf('/') + 1) : ''
      const nextPath = `${parent}${normalized}`
      if (desktop.isTauri()) {
        await desktop.renameEntry(node.relativePath, normalized)
      } else {
        await web.renameEntry(node.relativePath, normalized)
      }
      if (workspaceMode.value === 'files') replaceScopedPath(standalonePaths, node.relativePath, nextPath)
      await refreshWorkspace()
      if (activePath.value === node.relativePath || activePath.value.startsWith(`${node.relativePath}/`)) {
        activePath.value = `${nextPath}${activePath.value.slice(node.relativePath.length)}`
      }
      persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  function renameWorkspace(name: string) {
    const normalized = name.trim()
    if (normalized) {
      workspaceName.value = normalized
      persistDesktopSession()
    }
  }

  async function removeWorkspace() {
    if (!desktop.isTauri()) await web.detachWorkspace()
    suppressWatch = true
    workspacePath.value = ''
    workspaceName.value = ''
    workspaceMode.value = 'directory'
    standalonePaths.clear()
    trashItems.value = []
    tree.value = []
    activePath.value = ''
    content.value = ''
    savedContent.value = ''
    saveStatus.value = 'saved'
    queueMicrotask(() => { suppressWatch = false })
    localStorage.removeItem(desktopSessionKey)
    localStorage.removeItem(webSessionKey)
  }

  async function performSearch(query: string) {
    const clean = query.trim()
    if (!clean) {
      searchResults.value = []
      return
    }
    isSearching.value = true
    try {
      const results = desktop.isTauri() ? await desktop.searchWorkspace(clean) : await web.search(clean)
      searchResults.value = workspaceMode.value === 'files'
        ? results.filter((result) => standalonePaths.has(result.relativePath))
        : results
    } catch (error) {
      errorMessage.value = readableError(error)
    } finally {
      isSearching.value = false
    }
  }

  async function openSearchResult(result: SearchResult) {
    const node = flattenFiles(tree.value).find((entry) => entry.relativePath === result.relativePath)
    if (node) await openFile(node, result.line)
  }

  async function revealEntry(node: FileNode) {
    if (!desktop.isTauri()) return
    try {
      await desktop.revealInFileManager(node.path)
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  function dismissError() {
    errorMessage.value = ''
  }

  async function moveEntry(sourcePath: string, targetDirectory: string) {
    const source = findNode(tree.value, sourcePath)
    if (!source) return
    const nextPath = targetDirectory ? `${targetDirectory}/${source.name}` : source.name
    if (nextPath === sourcePath) return
    if (source.kind === 'directory' && (targetDirectory === sourcePath || targetDirectory.startsWith(`${sourcePath}/`))) {
      errorMessage.value = '不能将文件夹移动到它自身或其子文件夹中。'
      return
    }
    if (findNode(tree.value, nextPath)) {
      errorMessage.value = '目标文件夹中已经存在同名项目。'
      return
    }
    try {
      if (activePath.value === sourcePath || activePath.value.startsWith(`${sourcePath}/`)) await save()
      if (desktop.isTauri()) {
        await desktop.moveEntry(sourcePath, targetDirectory)
      } else {
        await web.moveEntry(sourcePath, targetDirectory)
      }
      if (workspaceMode.value === 'files') replaceScopedPath(standalonePaths, sourcePath, nextPath)
      await refreshWorkspace()
      if (activePath.value === sourcePath || activePath.value.startsWith(`${sourcePath}/`)) {
        activePath.value = `${nextPath}${activePath.value.slice(sourcePath.length)}`
      }
      persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function importDroppedFiles(files: FileList, targetDirectory = '') {
    const markdownFiles = [...files].filter((file) => /\.md(?:own)?$/i.test(file.name))
    if (!markdownFiles.length) {
      errorMessage.value = '请拖入 .md 或 .markdown 文件。'
      return
    }
    try {
      if (!workspacePath.value) {
        const result = await web.openMarkdownFiles(markdownFiles)
        workspacePath.value = result.name
        workspaceName.value = result.name
        workspaceMode.value = 'files'
        standalonePaths.clear()
        result.tree.filter((node) => node.kind === 'file').forEach((node) => standalonePaths.add(node.relativePath))
        tree.value = result.tree
        const first = findFirstFile(tree.value)
        if (first) await openFile(first)
        return
      }
      const candidatePaths = markdownFiles.map((file) => targetDirectory ? `${targetDirectory}/${file.name}` : file.name)
      const newFiles = markdownFiles.filter((_, index) => !findNode(tree.value, candidatePaths[index]))
      if (newFiles.length) await web.importFiles(newFiles, targetDirectory)
      if (workspaceMode.value === 'files') candidatePaths.forEach((path) => standalonePaths.add(path))
      await refreshWorkspace()
      const firstImported = findNode(tree.value, candidatePaths[0])
      if (firstImported) await openFile(firstImported)
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  async function importPathFiles(paths: string[], targetDirectory = '') {
    if (!desktop.isTauri() || !paths.length) return
    const markdownPaths = paths.filter((path) => /\.md(?:own)?$/i.test(path))
    if (!markdownPaths.length) {
      errorMessage.value = '请拖入 .md 或 .markdown 文件。'
      return
    }
    try {
      errorMessage.value = ''

      if (!workspacePath.value) {
        const firstPath = markdownPaths[0]
        const directory = parentDirectory(firstPath)
        if (!directory) throw new Error('无法识别拖入文件所在的文件夹。')

        workspacePath.value = directory
        workspaceName.value = '默认文件'
        workspaceMode.value = 'files'
        standalonePaths.clear()
        const relativePath = relativePathWithin(firstPath, directory)
        if (!relativePath) throw new Error('无法识别拖入文件的相对路径。')
        standalonePaths.add(relativePath)
        markdownPaths.slice(1).forEach((path) => {
          const relative = relativePathWithin(path, directory)
          if (relative) standalonePaths.add(relative)
        })
        const selectedFiles = await desktop.openMarkdownFiles(markdownPaths)
        tree.value = scopedTree(selectedFiles)
        await loadTrash()
        const dropped = findNode(tree.value, relativePath)
        if (dropped) await openFile(dropped)
        else {
          const first = findFirstFile(tree.value)
          if (first) await openFile(first)
        }
        persistDesktopSession()
        return
      }

      if (workspaceMode.value === 'files' && !targetDirectory) {
        const pathsInsideCurrentFolder = markdownPaths
          .map((path) => ({ source: path, relative: relativePathWithin(path, workspacePath.value) }))
        const externalPaths = pathsInsideCurrentFolder.filter((item) => !item.relative).map((item) => item.source)
        if (externalPaths.length) await desktop.importFiles(externalPaths, '')
        pathsInsideCurrentFolder.forEach(({ source, relative }) => {
          const name = source.split(/[\\/]/).pop() || ''
          if (relative) standalonePaths.add(relative)
          else if (name) standalonePaths.add(name)
        })
      } else {
        await desktop.importFiles(markdownPaths, targetDirectory)
        if (workspaceMode.value === 'files') {
          markdownPaths.forEach((path) => {
            const name = path.split(/[\\/]/).pop() || ''
            if (name) standalonePaths.add(targetDirectory ? `${targetDirectory}/${name}` : name)
          })
        }
      }
      await refreshWorkspace()
      const importedName = markdownPaths[0].split(/[\\/]/).pop() || ''
      const importedPath = workspaceMode.value === 'files' && !targetDirectory
        ? relativePathWithin(markdownPaths[0], workspacePath.value) || importedName
        : targetDirectory ? `${targetDirectory}/${importedName}` : importedName
      const imported = findNode(tree.value, importedPath)
      if (imported) await openFile(imported)
      persistDesktopSession()
    } catch (error) {
      errorMessage.value = readableError(error)
    }
  }

  loadSettings()

  return {
    workspacePath, workspaceName, workspaceMode, tree, activePath, activeName, content, saveStatus, trashItems,
    viewMode, settings, searchResults, isSearching, errorMessage, loading, isDemo,
    initializeWorkspace, selectWorkspace, selectFiles, refreshWorkspace, openFile, save, newDocument, newFolder, deleteEntry, renameEntry,
    moveEntry, importDroppedFiles, importPathFiles, loadTrash, restoreTrashItem, permanentlyDeleteTrashItem,
    renameWorkspace, removeWorkspace, performSearch,
    openSearchResult, revealEntry, dismissError, persistSettings,
  }
})

function findFirstFile(nodes: FileNode[]): FileNode | undefined {
  for (const node of nodes) {
    if (node.kind === 'file') return node
    const nested = node.children && findFirstFile(node.children)
    if (nested) return nested
  }
  return undefined
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => node.kind === 'file' ? [node] : flattenFiles(node.children || []))
}

function findNode(nodes: FileNode[], relativePath: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.relativePath === relativePath) return node
    const nested = node.children && findNode(node.children, relativePath)
    if (nested) return nested
  }
  return undefined
}

function filterTree(nodes: FileNode[], allowedPaths: Set<string>): FileNode[] {
  const result: FileNode[] = []
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (allowedPaths.has(node.relativePath)) result.push(node)
      continue
    }
    const children = filterTree(node.children || [], allowedPaths)
    if (allowedPaths.has(node.relativePath) || children.length) result.push({ ...node, children })
  }
  return result
}

function replaceScopedPath(paths: Set<string>, previousPath: string, nextPath: string) {
  const replacements = [...paths]
    .filter((path) => path === previousPath || path.startsWith(`${previousPath}/`))
    .map((path) => [path, `${nextPath}${path.slice(previousPath.length)}`] as const)
  replacements.forEach(([previous]) => paths.delete(previous))
  replacements.forEach(([, next]) => paths.add(next))
}

function parentDirectory(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const separator = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'))
  return separator > 0 ? clean.slice(0, separator) : ''
}

function relativePathWithin(path: string, directory: string): string | undefined {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedDirectory = directory.replace(/\\/g, '/').replace(/\/$/, '')
  const prefix = `${normalizedDirectory}/`
  if (!normalizedPath.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return undefined
  return normalizedPath.slice(prefix.length)
}

function readableError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '操作未完成，请稍后重试。'
}
