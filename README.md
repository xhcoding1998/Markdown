# 码档

码档是一款本地优先的 Markdown 编辑器，同时提供 Web 版与桌面客户端。它使用 Vue 3、TypeScript、CodeMirror 6 和 Tauri 2 构建，面向需要快速写作、实时预览、本地文件管理与多格式导出的用户。

文档默认保存在用户选择的位置或浏览器本地空间中，不依赖账号、云端数据库或在线服务。

## 主要功能

- Markdown 实时编辑与预览
- 双栏、仅编辑、仅预览三种视图
- CodeMirror 6 语法高亮与常用格式工具栏
- 标题大纲、锚点定位和全文搜索
- 字数、字符数、行数、阅读时间与文件时间统计
- 本地文件、目录和拖拽导入
- 文件排序、重命名、移动、删除与桌面端回收站
- 浅色、深色和跟随系统主题
- Markdown、HTML、PDF、PNG 导出
- 代码块一键复制
- 桌面端在文件资源管理器中定位文件
- 设置、视图模式与侧边栏宽度持久化

## Web 版与桌面版的差异

| 能力 | Web 版 | 桌面客户端 |
| --- | --- | --- |
| 打开单个或多个文件 | 支持 | 支持 |
| 打开本地目录 | 支持；能力取决于浏览器 | 支持 |
| 直接写回真实目录 | Chrome/Edge 等支持 File System Access API 的浏览器 | 支持 |
| 浏览器兼容目录导入 | 保存为浏览器本地副本 | 不需要 |
| 文件资源管理器定位 | 浏览器不允许 | 支持 |
| 应用回收站与恢复 | 暂不支持 | 支持 |
| 数据存储 | IndexedDB 或已授权目录 | 本地文件系统 |

Web 版在浏览器不支持目录句柄时，会使用“选择文件夹”兼容模式读取 Markdown 文件并保留目录结构。此时编辑的是浏览器本地副本，无法自动覆盖原目录。

## 技术栈

- Vue 3 + TypeScript
- Vite 7
- Pinia
- CodeMirror 6
- markdown-it + highlight.js + DOMPurify
- html2canvas + jsPDF
- Tauri 2 + Rust
- Tauri Dialog、Opener、Clipboard Manager 插件

## 项目结构

```text
Markdown/
├─ public/                    Web 静态资源、站点图标和 SEO 文件
├─ src/
│  ├─ components/            编辑器、预览器、文件树和 UI 组件
│  ├─ services/              桌面端与 Web 端文件服务
│  ├─ stores/                Pinia 状态与业务流程
│  ├─ App.vue                应用主界面
│  └─ styles.css             全局主题与布局
├─ src-tauri/
│  ├─ capabilities/          Tauri 权限声明
│  ├─ icons/                 桌面客户端图标
│  ├─ src/                   Rust 文件系统命令
│  ├─ Cargo.toml             Rust 包配置
│  └─ tauri.conf.json        客户端窗口与安装包配置
├─ index.html                Web 入口与 SEO 元信息
├─ package.json              前端依赖和脚本
├─ vite.config.ts            Vite 构建配置
├─ PRD.md                    产品需求文档
└─ DESIGN.md                 技术与界面设计文档
```

## 环境要求

所有开发方式都需要：

- Node.js LTS
- npm

桌面客户端还需要 Rust stable 和当前操作系统对应的 Tauri 系统依赖。建议先阅读 [Tauri 2 环境准备](https://v2.tauri.app/start/prerequisites/)。

## 安装依赖

首次克隆项目后执行：

```bash
npm install
```

CI 和正式构建建议使用锁文件安装：

```bash
npm ci
```

## 开发 Web 版

启动 Vite 开发服务器：

```bash
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:1420/
```

生成正式 Web 产物：

```bash
npm run build
```

构建结果位于：

```text
dist/
```

本地预览正式产物：

```bash
npm run preview
```

## 部署 Web 版

### 使用 GitHub + Vercel

项目可以将 Web 与 Tauri 客户端代码放在同一个 GitHub 仓库中。Vercel 只执行前端构建，不会编译 `src-tauri`。

如果目录还没有 Git 仓库：

```bash
git init
git add .
git commit -m "Initial release of 码档"
git branch -M main
git remote add origin https://github.com/你的用户名/ma-dang.git
git push -u origin main
```

然后在 Vercel 中导入该仓库，并确认：

| Vercel 设置 | 值 |
| --- | --- |
| Framework Preset | Vite |
| Root Directory | `./` |
| Install Command | `npm install` 或默认值 |
| Build Command | `npm run build` |
| Output Directory | `dist` |

部署完成后：

- 推送到 `main` 分支会更新生产环境。
- 其他分支和 Pull Request 会生成预览地址。
- Vercel 默认提供 HTTPS，有利于剪贴板和本地目录等浏览器安全 API 正常工作。

参考：[Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite) 与 [Vercel GitHub 集成](https://vercel.com/docs/git/vercel-for-github)。

### 部署到其他静态服务

执行 `npm run build` 后，将整个 `dist` 目录部署到任意静态托管服务即可，例如：

- Cloudflare Pages
- Netlify
- GitHub Pages
- Nginx
- 对象存储静态网站

当前项目使用相对资源路径，可部署在域名根目录或子目录。

## 开发桌面客户端

安装当前系统所需依赖后运行：

```bash
npm run tauri dev
```

该命令会启动 Vite 开发服务器和 Tauri 窗口，并支持前端热更新。

## 只生成客户端可执行文件

如果只想测试正式客户端，不需要安装包：

```bash
npx tauri build --no-bundle
```

Windows 输出示例：

```text
src-tauri/target/release/ma-dang.exe
```

Linux/macOS 输出文件没有 `.exe` 后缀。

## 打包 Windows 客户端

### Windows 准备工作

需要安装：

1. Rust stable MSVC 工具链。
2. Microsoft C++ Build Tools，并勾选 `Desktop development with C++`。
3. Microsoft Edge WebView2 Runtime。Windows 10/11 通常已经安装。

安装 Rust：

```powershell
winget install --id Rustlang.Rustup
rustup default stable-msvc
```

详细要求见 [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)。

### NSIS 安装程序

推荐普通用户下载的格式，生成一个常见的 `setup.exe`：

```powershell
npx tauri build --bundles nsis
```

输出目录：

```text
src-tauri/target/release/bundle/nsis/
```

### MSI 安装包

适合企业部署、组策略或需要 Windows Installer 的场景：

```powershell
npx tauri build --bundles msi
```

输出目录：

```text
src-tauri/target/release/bundle/msi/
```

如果出现 `failed to run light.exe`，请在 Windows 的“可选功能/更多 Windows 功能”中启用 **VBSCRIPT**，重启后再打包。该要求只影响 MSI，NSIS 不依赖它。详见 [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)。

### 同时生成全部 Windows 格式

```powershell
npx tauri build
```

当前 `tauri.conf.json` 中 `bundle.targets` 为 `all`，因此会尝试生成 NSIS 和 MSI。某一种格式环境不完整时，建议使用 `--bundles` 单独生成。

## 打包 macOS 客户端

macOS 客户端建议在 macOS 机器或 GitHub Actions 的 macOS runner 上构建。

安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

### 当前 Mac 架构

```bash
npx tauri build --bundles dmg
```

通常会生成 `.app` 和/或 `.dmg`，具体以当前 Tauri 配置和平台支持为准。产物位于 `src-tauri/target/release/bundle/` 下。

### Apple Silicon

```bash
rustup target add aarch64-apple-darwin
npx tauri build --target aarch64-apple-darwin --bundles dmg
```

### Intel Mac

```bash
rustup target add x86_64-apple-darwin
npx tauri build --target x86_64-apple-darwin --bundles dmg
```

### macOS 通用包

同时支持 Apple Silicon 和 Intel：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin --bundles dmg
```

对外分发时还需要考虑 Apple Developer 证书、代码签名与公证，否则 macOS Gatekeeper 可能阻止运行。参考 [Tauri DMG](https://v2.tauri.app/distribute/dmg/) 与 [macOS 签名](https://v2.tauri.app/distribute/sign/macos/)。

## 打包 Linux 客户端

Linux 安装包应在目标 Linux 发行版或兼容的 CI runner 上构建。

Ubuntu/Debian 常用依赖：

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

### Debian/Ubuntu 的 `.deb`

```bash
npx tauri build --bundles deb
```

### 通用 AppImage

```bash
npx tauri build --bundles appimage
```

### Fedora/RHEL 的 `.rpm`

```bash
npx tauri build --bundles rpm
```

产物位于：

```text
src-tauri/target/release/bundle/
```

参考：[Tauri Debian](https://v2.tauri.app/distribute/debian/)、[Tauri AppImage](https://v2.tauri.app/distribute/appimage/) 和 [Tauri RPM](https://v2.tauri.app/distribute/rpm/)。

## 如何一次构建不同系统客户端

不建议在一台 Windows 电脑上直接交叉打包所有桌面系统。安装包通常依赖目标系统的 WebView、链接器、签名工具和打包工具。

推荐方案：

- Windows runner 构建 Windows 安装包。
- macOS runner 构建 Intel、Apple Silicon 或 Universal DMG。
- Ubuntu runner 构建 `.deb`、`.rpm` 和 AppImage。

最省事的自动化方式是使用 GitHub Actions 与 `tauri-apps/tauri-action`。官方示例可以同时创建 Windows、macOS 和 Linux 构建并上传到 GitHub Release：

- [Tauri GitHub Actions 发布指南](https://v2.tauri.app/distribute/pipelines/github/)
- [tauri-action](https://github.com/tauri-apps/tauri-action)

建议使用版本标签触发正式发布：

```bash
git tag app-v0.1.0
git push origin app-v0.1.0
```

## 修改版本号

发布前请同步修改以下三个文件中的版本号：

1. `package.json` 的 `version`
2. `src-tauri/tauri.conf.json` 的 `version`
3. `src-tauri/Cargo.toml` 的 `version`

例如从 `0.1.0` 升级为 `0.2.0` 后，再执行正式构建。

不要随意修改：

```text
com.madang.markdown
```

这是桌面应用标识符。正式发布后更改它，操作系统可能把新版本识别为另一款应用。

## 修改应用名称、描述和图标

桌面产品名称和描述位于：

```text
src-tauri/tauri.conf.json
```

主要字段：

```json
{
  "productName": "码档",
  "version": "0.1.0",
  "identifier": "com.madang.markdown"
}
```

图标文件位于：

```text
src-tauri/icons/
```

如果准备了一张高分辨率正方形 PNG，可以使用 Tauri CLI 重新生成各平台图标：

```bash
npx tauri icon path/to/icon.png
```

Web 端站点图标和清单位于：

```text
public/favicon.svg
public/site.webmanifest
```

## 发布前检查清单

- [ ] `npm ci` 成功
- [ ] `npm run build` 成功
- [ ] 浅色与深色主题正常
- [ ] 打开文件、打开目录和拖拽导入正常
- [ ] 新建、重命名、移动、删除与恢复正常
- [ ] 自动保存和重新启动恢复正常
- [ ] Markdown、HTML、PDF、PNG 导出正常
- [ ] Web 版在 HTTPS 域名测试
- [ ] 三处版本号保持一致
- [ ] Windows/macOS 正式分发包完成签名
- [ ] 在干净系统或虚拟机中验证安装与卸载

## 常见问题

### Vercel 部署后目录选择不可用

确认使用支持 File System Access API 的浏览器，例如新版 Chrome 或 Edge。其他浏览器会进入兼容目录导入模式，编辑的是浏览器本地副本。

### Web 版清除浏览器数据后文件消失

浏览器副本保存在当前域名的 IndexedDB 中。清除站点数据会删除这些副本。由浏览器直接授权打开的真实目录不会因此被删除。

### Windows MSI 报 `light.exe` 错误

启用 Windows VBSCRIPT 可选功能，或改用：

```powershell
npx tauri build --bundles nsis
```

### 打包时提示 Rust 或 C++ 链接器不存在

确认安装 Rust stable、目标平台编译工具和 Tauri 系统依赖，并重新打开终端。

### macOS 提示应用已损坏或无法验证开发者

公开分发需要正确的代码签名和公证。开发测试可以使用本机构建，但不要把未签名包当作正式发行版。

## 相关文档

- [产品需求文档](./PRD.md)
- [技术与界面设计](./DESIGN.md)
- [Tauri 2 官方文档](https://v2.tauri.app/)
- [Vite 官方文档](https://vite.dev/)
- [Vercel Vite 部署文档](https://vercel.com/docs/frameworks/frontend/vite)

