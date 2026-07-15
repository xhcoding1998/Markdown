use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::RwLock,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use walkdir::{DirEntry, WalkDir};

#[derive(Default)]
struct AppState {
    workspace: RwLock<Option<PathBuf>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    relative_path: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    path: String,
    relative_path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageAsset {
    path: String,
    reference: String,
    alt: String,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageData {
    mime: String,
    data_base64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashItem {
    id: String,
    name: String,
    original_relative_path: String,
    kind: String,
    deleted_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    related_assets_original_relative_path: Option<String>,
}

type CommandResult<T> = Result<T, String>;

#[tauri::command]
fn open_workspace(path: String, state: State<'_, AppState>) -> CommandResult<Vec<FileNode>> {
    let root = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("无法打开目录：{error}"))?;
    if !root.is_dir() {
        return Err("选择的路径不是文件夹。".into());
    }

    *state.workspace.write().map_err(|_| "目录状态不可用。")? = Some(root.clone());
    build_tree(&root, &root)
}

#[tauri::command]
fn open_files(paths: Vec<String>, state: State<'_, AppState>) -> CommandResult<Vec<FileNode>> {
    if paths.is_empty() {
        return Err("没有选择文件。".into());
    }

    let mut files = Vec::with_capacity(paths.len());
    let mut root: Option<PathBuf> = None;
    for path in paths {
        let file = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("无法打开文件：{error}"))?;
        if !file.is_file() || !is_markdown(&file) {
            return Err("只能打开 .md 或 .markdown 文件。".into());
        }
        let parent = file.parent().ok_or("文件没有有效的父目录。")?.to_path_buf();
        if let Some(expected) = &root {
            if parent != *expected {
                return Err("一次选择的文件需要位于同一个文件夹中。".into());
            }
        } else {
            root = Some(parent);
        }
        files.push(file);
    }

    let root = root.ok_or("无法确定文件所在目录。")?;
    *state.workspace.write().map_err(|_| "目录状态不可用。")? = Some(root.clone());
    files
        .iter()
        .map(|file| node_from_path(&root, file))
        .collect()
}

#[tauri::command]
fn read_text_file(relative_path: String, state: State<'_, AppState>) -> CommandResult<String> {
    let path = resolve_workspace_path(&state, &relative_path)?;
    fs::read_to_string(path).map_err(|error| format!("无法读取文件：{error}"))
}

#[tauri::command]
fn write_text_file(
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let target = resolve_workspace_path(&state, &relative_path)?;
    let parent = target.parent().ok_or("目标文件没有有效的父目录。")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;

    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("文件名无效。")?;
    let temporary = parent.join(format!(".{file_name}.markdown-studio.tmp"));
    {
        let mut file =
            fs::File::create(&temporary).map_err(|error| format!("无法创建临时文件：{error}"))?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("无法写入文件：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法将内容同步到磁盘：{error}"))?;
    }

    if target.exists() {
        #[cfg(target_os = "windows")]
        fs::remove_file(&target).map_err(|error| format!("无法替换原文件：{error}"))?;
    }
    fs::rename(&temporary, &target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("无法保存文件：{error}")
    })
}

#[tauri::command]
fn create_file(relative_path: String, state: State<'_, AppState>) -> CommandResult<FileNode> {
    let normalized = if relative_path.to_lowercase().ends_with(".md") {
        relative_path
    } else {
        format!("{relative_path}.md")
    };
    let target = resolve_workspace_path(&state, &normalized)?;
    if target.exists() {
        return Err("同名文件已经存在。".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    fs::write(&target, "").map_err(|error| format!("无法创建文件：{error}"))?;
    node_from_path(&workspace_root(&state)?, &target)
}

#[tauri::command]
fn create_directory(relative_path: String, state: State<'_, AppState>) -> CommandResult<FileNode> {
    let target = resolve_workspace_path(&state, &relative_path)?;
    if target.exists() {
        return Err("同名目录已经存在。".into());
    }
    fs::create_dir_all(&target).map_err(|error| format!("无法创建目录：{error}"))?;
    node_from_path(&workspace_root(&state)?, &target)
}

#[tauri::command]
fn rename_entry(
    relative_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') {
        return Err("新名称包含无效字符。".into());
    }
    let source = resolve_workspace_path(&state, &relative_path)?;
    let target = source.parent().ok_or("源路径无效。")?.join(new_name);
    ensure_inside_workspace(&state, &target)?;
    if target.exists() {
        return Err("目标名称已经存在。".into());
    }
    let related_assets = if source.is_file() && is_markdown(&source) {
        let from = assets_directory_for_document(&source)?;
        let to = assets_directory_for_document(&target)?;
        if from.exists() { Some((from, to)) } else { None }
    } else { None };
    if let Some((_, asset_target)) = &related_assets {
        if asset_target.exists() { return Err("目标文档的图片目录已经存在。".into()); }
    }
    fs::rename(&source, &target).map_err(|error| format!("无法重命名：{error}"))?;
    if let Some((asset_source, asset_target)) = &related_assets {
        if let Err(error) = fs::rename(asset_source, asset_target) {
            let _ = fs::rename(&target, &source);
            return Err(format!("无法同步重命名文档图片目录：{error}"));
        }
        update_asset_directory_reference(&target, asset_source, asset_target)?;
    }
    Ok(())
}

#[tauri::command]
fn move_entry(
    relative_path: String,
    target_directory: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let source = resolve_workspace_path(&state, &relative_path)?;
    let destination_directory = if target_directory.trim().is_empty() {
        workspace_root(&state)?
    } else {
        resolve_workspace_path(&state, &target_directory)?
    };
    if !destination_directory.is_dir() {
        return Err("目标位置不是文件夹。".into());
    }
    let file_name = source.file_name().ok_or("源文件名称无效。")?;
    let target = destination_directory.join(file_name);
    if source == target {
        return Ok(());
    }
    if source.is_dir() && target.starts_with(&source) {
        return Err("不能将文件夹移动到它自身或其子文件夹中。".into());
    }
    ensure_inside_workspace(&state, &target)?;
    if target.exists() {
        return Err("目标文件夹中已经存在同名项目。".into());
    }
    let related_assets = if source.is_file() && is_markdown(&source) {
        let from = assets_directory_for_document(&source)?;
        let to = assets_directory_for_document(&target)?;
        if from.exists() { Some((from, to)) } else { None }
    } else { None };
    if let Some((_, asset_target)) = &related_assets {
        if asset_target.exists() { return Err("目标位置已经存在文档图片目录。".into()); }
    }
    fs::rename(&source, &target).map_err(|error| format!("无法移动项目：{error}"))?;
    if let Some((asset_source, asset_target)) = &related_assets {
        if let Err(error) = fs::rename(asset_source, asset_target) {
            let _ = fs::rename(&target, &source);
            return Err(format!("无法同步移动文档图片目录：{error}"));
        }
    }
    Ok(())
}

#[tauri::command]
fn import_files(
    source_paths: Vec<String>,
    target_directory: String,
    state: State<'_, AppState>,
) -> CommandResult<usize> {
    let destination_directory = if target_directory.trim().is_empty() {
        workspace_root(&state)?
    } else {
        resolve_workspace_path(&state, &target_directory)?
    };
    if !destination_directory.is_dir() {
        return Err("目标位置不是文件夹。".into());
    }

    let mut imported = 0;
    for source_path in source_paths {
        let source = PathBuf::from(source_path);
        if !source.is_file() || !is_markdown(&source) {
            continue;
        }
        let file_name = source.file_name().ok_or("导入文件名称无效。")?;
        let target = destination_directory.join(file_name);
        ensure_inside_workspace(&state, &target)?;
        if target.exists() {
            return Err(format!(
                "{} 已经存在于目标文件夹中。",
                file_name.to_string_lossy()
            ));
        }
        fs::copy(&source, &target)
            .map_err(|error| format!("无法导入 {}：{error}", file_name.to_string_lossy()))?;
        imported += 1;
    }
    if imported == 0 {
        return Err("请拖入 .md 或 .markdown 文件。".into());
    }
    Ok(imported)
}

#[tauri::command]
fn trash_entry(relative_path: String, state: State<'_, AppState>) -> CommandResult<()> {
    let target = resolve_workspace_path(&state, &relative_path)?;
    if !target.exists() {
        return Err("要删除的项目不存在。".into());
    }
    let root = workspace_root(&state)?;
    let trash_root = root.join(".md-lai-le-trash");
    fs::create_dir_all(&trash_root).map_err(|error| format!("无法创建应用回收站：{error}"))?;
    let deleted_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut id = deleted_at.to_string();
    let mut suffix = 0_u32;
    while trash_root.join(&id).exists() {
        suffix += 1;
        id = format!("{deleted_at}-{suffix}");
    }
    let item_dir = trash_root.join(&id);
    fs::create_dir(&item_dir).map_err(|error| format!("无法创建回收站项目：{error}"))?;
    let payload = item_dir.join("content");
    let related_assets = if target.is_file() && is_markdown(&target) {
        let path = assets_directory_for_document(&target)?;
        if path.exists() { Some(path) } else { None }
    } else { None };
    fs::rename(&target, &payload).map_err(|error| {
        let _ = fs::remove_dir_all(&item_dir);
        format!("无法移动到应用回收站：{error}")
    })?;
    if let Some(assets) = &related_assets {
        if let Err(error) = fs::rename(assets, item_dir.join("related-assets")) {
            let _ = fs::rename(&payload, &target);
            let _ = fs::remove_dir_all(&item_dir);
            return Err(format!("无法将文档图片移入应用回收站：{error}"));
        }
    }
    let item = TrashItem {
        id,
        name: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("未命名项目")
            .to_string(),
        original_relative_path: relative_path.replace('\\', "/"),
        kind: if payload.is_dir() {
            "directory".into()
        } else {
            "file".into()
        },
        deleted_at,
        related_assets_original_relative_path: related_assets.as_ref().and_then(|path| {
            path.strip_prefix(&root).ok().map(|value| value.to_string_lossy().replace('\\', "/"))
        }),
    };
    let metadata =
        serde_json::to_vec_pretty(&item).map_err(|error| format!("无法创建回收站记录：{error}"))?;
    if let Err(error) = fs::write(item_dir.join("metadata.json"), metadata) {
        if let Some(assets) = &related_assets {
            let _ = fs::rename(item_dir.join("related-assets"), assets);
        }
        let _ = fs::rename(&payload, &target);
        let _ = fs::remove_dir_all(&item_dir);
        return Err(format!("无法保存回收站记录：{error}"));
    }
    Ok(())
}

#[tauri::command]
fn list_trash(state: State<'_, AppState>) -> CommandResult<Vec<TrashItem>> {
    let trash_root = workspace_root(&state)?.join(".md-lai-le-trash");
    if !trash_root.exists() {
        return Ok(Vec::new());
    }
    let mut items = fs::read_dir(trash_root)
        .map_err(|error| format!("无法读取应用回收站：{error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| fs::read(entry.path().join("metadata.json")).ok())
        .filter_map(|bytes| serde_json::from_slice::<TrashItem>(&bytes).ok())
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

#[tauri::command]
fn restore_trash(id: String, state: State<'_, AppState>) -> CommandResult<TrashItem> {
    validate_trash_id(&id)?;
    let item_dir = workspace_root(&state)?.join(".md-lai-le-trash").join(&id);
    let item: TrashItem = serde_json::from_slice(
        &fs::read(item_dir.join("metadata.json"))
            .map_err(|error| format!("无法读取回收站记录：{error}"))?,
    )
    .map_err(|error| format!("回收站记录无效：{error}"))?;
    let target = resolve_workspace_path(&state, &item.original_relative_path)?;
    if target.exists() {
        return Err(format!(
            "原位置已存在同名项目：{}",
            item.original_relative_path
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建原目录：{error}"))?;
    }
    fs::rename(item_dir.join("content"), &target)
        .map_err(|error| format!("无法恢复项目：{error}"))?;
    if let Some(relative_assets) = &item.related_assets_original_relative_path {
        let asset_target = resolve_workspace_path(&state, relative_assets)?;
        if asset_target.exists() {
            let _ = fs::rename(&target, item_dir.join("content"));
            return Err("原位置已经存在同名图片目录。".into());
        }
        if let Some(parent) = asset_target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建图片目录位置：{error}"))?;
        }
        if let Err(error) = fs::rename(item_dir.join("related-assets"), &asset_target) {
            let _ = fs::rename(&target, item_dir.join("content"));
            return Err(format!("无法恢复文档图片：{error}"));
        }
    }
    fs::remove_dir_all(&item_dir)
        .map_err(|error| format!("项目已恢复，但无法清理回收站记录：{error}"))?;
    Ok(item)
}

#[tauri::command]
fn delete_trash(id: String, state: State<'_, AppState>) -> CommandResult<()> {
    validate_trash_id(&id)?;
    let item_dir = workspace_root(&state)?.join(".md-lai-le-trash").join(id);
    if !item_dir.exists() {
        return Err("回收站项目不存在。".into());
    }
    fs::remove_dir_all(item_dir).map_err(|error| format!("无法永久删除项目：{error}"))
}

fn validate_trash_id(id: &str) -> CommandResult<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_digit() || character == '-')
    {
        return Err("回收站项目标识无效。".into());
    }
    Ok(())
}

#[tauri::command]
fn search_workspace(
    query: String,
    limit: usize,
    state: State<'_, AppState>,
) -> CommandResult<Vec<SearchResult>> {
    let root = workspace_root(&state)?;
    let needle = query.to_lowercase();
    if needle.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(visible_entry)
        .filter_map(Result::ok)
    {
        if results.len() >= limit {
            break;
        }
        if !entry.file_type().is_file() || !is_markdown(entry.path()) {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let relative = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        let name_match = entry
            .file_name()
            .to_string_lossy()
            .to_lowercase()
            .contains(&needle);
        if name_match {
            results.push(SearchResult {
                path: entry.path().to_string_lossy().into_owned(),
                relative_path: relative.clone(),
                line: 1,
                column: 1,
                preview: "文件名匹配".into(),
            });
        }
        for (index, line) in text.lines().enumerate() {
            if results.len() >= limit {
                break;
            }
            if let Some(column) = line.to_lowercase().find(&needle) {
                results.push(SearchResult {
                    path: entry.path().to_string_lossy().into_owned(),
                    relative_path: relative.clone(),
                    line: index + 1,
                    column: line[..column].chars().count() + 1,
                    preview: truncate_preview(line, 100),
                });
            }
        }
    }
    Ok(results)
}

#[tauri::command]
fn export_html(target_path: String, html: String) -> CommandResult<()> {
    let target = PathBuf::from(target_path);
    if target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("html"))
        != Some(true)
    {
        return Err("导出文件必须使用 .html 扩展名。".into());
    }
    fs::write(target, html).map_err(|error| format!("无法导出 HTML：{error}"))
}

#[tauri::command]
fn export_text(target_path: String, text: String) -> CommandResult<()> {
    fs::write(target_path, text).map_err(|error| format!("无法导出文件：{error}"))
}

#[tauri::command]
fn export_binary(target_path: String, data_base64: String) -> CommandResult<()> {
    let bytes = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("导出数据无效：{error}"))?;
    fs::write(target_path, bytes).map_err(|error| format!("无法导出文件：{error}"))
}

#[tauri::command]
fn save_image_data(
    relative_document_path: String,
    file_name: String,
    data_base64: String,
    state: State<'_, AppState>,
) -> CommandResult<ImageAsset> {
    if !is_image(Path::new(&file_name)) || Path::new(&file_name).components().count() != 1 {
        return Err("只支持 PNG、JPEG、GIF、WebP、SVG 或 AVIF 图片。".into());
    }
    let bytes = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("图片数据无效：{error}"))?;
    let root = workspace_root(&state)?;
    let assets = document_assets_directory(&state, &relative_document_path)?;
    fs::create_dir_all(&assets).map_err(|error| format!("无法创建 assets 目录：{error}"))?;
    let target = unique_asset_path(&assets, &sanitize_asset_name(&file_name));
    fs::write(&target, &bytes).map_err(|error| format!("无法保存图片：{error}"))?;
    image_asset(&root, &relative_document_path, &target, bytes.len() as u64)
}

#[tauri::command]
fn import_image_files(
    source_paths: Vec<String>,
    relative_document_path: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ImageAsset>> {
    let root = workspace_root(&state)?;
    let assets = document_assets_directory(&state, &relative_document_path)?;
    fs::create_dir_all(&assets).map_err(|error| format!("无法创建 assets 目录：{error}"))?;
    let mut imported = Vec::new();
    for source_path in source_paths {
        let source = PathBuf::from(source_path)
            .canonicalize()
            .map_err(|error| format!("无法读取拖入图片：{error}"))?;
        if !source.is_file() || !is_image(&source) {
            continue;
        }
        let original_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("图片文件名无效。")?;
        let target = unique_asset_path(&assets, &sanitize_asset_name(original_name));
        let size = fs::copy(&source, &target).map_err(|error| format!("无法复制图片：{error}"))?;
        imported.push(image_asset(&root, &relative_document_path, &target, size)?);
    }
    if imported.is_empty() {
        return Err("没有找到可导入的图片。".into());
    }
    Ok(imported)
}

#[tauri::command]
fn read_image_data(
    relative_document_path: String,
    reference: String,
    state: State<'_, AppState>,
) -> CommandResult<ImageData> {
    let target = resolve_document_reference(&state, &relative_document_path, &reference)?;
    if !target.is_file() || !is_image(&target) {
        return Err("图片不存在或格式不受支持。".into());
    }
    let bytes = fs::read(&target).map_err(|error| format!("无法读取图片：{error}"))?;
    Ok(ImageData {
        mime: image_mime(&target).to_string(),
        data_base64: general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    app.exit(0);
}

fn workspace_root(state: &State<'_, AppState>) -> CommandResult<PathBuf> {
    state
        .workspace
        .read()
        .map_err(|_| "目录状态不可用。".to_string())?
        .clone()
        .ok_or_else(|| "尚未打开目录。".into())
}

fn resolve_workspace_path(state: &State<'_, AppState>, relative: &str) -> CommandResult<PathBuf> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("路径超出了当前目录。".into());
    }
    let target = workspace_root(state)?.join(relative_path);
    ensure_inside_workspace(state, &target)?;
    Ok(target)
}

fn resolve_document_reference(
    state: &State<'_, AppState>,
    relative_document_path: &str,
    reference: &str,
) -> CommandResult<PathBuf> {
    let document = Path::new(relative_document_path);
    if document.is_absolute()
        || document.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("文档路径无效。".into());
    }
    let reference = reference
        .split(['?', '#'])
        .next()
        .unwrap_or(reference)
        .replace('\\', "/");
    let mut normalized = PathBuf::new();
    if let Some(parent) = document.parent() {
        for part in parent.components() {
            if let Component::Normal(value) = part {
                normalized.push(value);
            }
        }
    }
    for part in Path::new(&reference).components() {
        match part {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err("图片路径超出了当前目录。".into());
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("图片路径超出了当前目录。".into())
            }
        }
    }
    let root = workspace_root(state)?;
    let target = root
        .join(normalized)
        .canonicalize()
        .map_err(|_| "图片不存在。".to_string())?;
    if !target.starts_with(&root) {
        return Err("图片路径超出了当前目录。".into());
    }
    Ok(target)
}

fn ensure_inside_workspace(state: &State<'_, AppState>, target: &Path) -> CommandResult<()> {
    let root = workspace_root(state)?;
    let normalized_parent = target
        .parent()
        .unwrap_or(target)
        .canonicalize()
        .unwrap_or_else(|_| target.parent().unwrap_or(target).to_path_buf());
    if !normalized_parent.starts_with(&root) {
        return Err("路径超出了当前目录。".into());
    }
    Ok(())
}

fn build_tree(root: &Path, directory: &Path) -> CommandResult<Vec<FileNode>> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("无法读取目录：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| visible_name(&entry.file_name().to_string_lossy()))
        .filter(|entry| entry.path().is_dir() || is_markdown(&entry.path()))
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| {
        let a_dir = a.path().is_dir();
        let b_dir = b.path().is_dir();
        b_dir.cmp(&a_dir).then_with(|| {
            a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase())
        })
    });
    entries
        .into_iter()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                let children = build_tree(root, &path)?;
                let mut node = node_from_path(root, &path)?;
                node.children = Some(children);
                Ok(node)
            } else {
                node_from_path(root, &path)
            }
        })
        .collect()
}

fn node_from_path(root: &Path, path: &Path) -> CommandResult<FileNode> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("文件名不是有效的 UTF-8。")?
        .to_string();
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "路径超出了当前目录。")?
        .to_string_lossy()
        .replace('\\', "/");
    let metadata = fs::metadata(path).ok();
    Ok(FileNode {
        name,
        path: path.to_string_lossy().into_owned(),
        relative_path: relative,
        kind: if path.is_dir() { "directory" } else { "file" },
        children: if path.is_dir() {
            Some(Vec::new())
        } else {
            None
        },
        created_at: metadata
            .as_ref()
            .and_then(|value| value.created().ok())
            .and_then(system_time_millis),
        modified_at: metadata
            .as_ref()
            .and_then(|value| value.modified().ok())
            .and_then(system_time_millis),
    })
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn visible_entry(entry: &DirEntry) -> bool {
    entry.depth() == 0 || visible_name(&entry.file_name().to_string_lossy())
}

fn visible_name(name: &str) -> bool {
    !name.starts_with('.')
        && !name.to_lowercase().ends_with(".assets")
        && !matches!(name, "node_modules" | "target" | "dist")
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| matches!(extension.to_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            matches!(
                extension.to_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif"
            )
        })
        .unwrap_or(false)
}

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn unique_asset_path(directory: &Path, original_name: &str) -> PathBuf {
    let direct = directory.join(original_name);
    if !direct.exists() {
        return direct;
    }
    let path = Path::new(original_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    for suffix in 0..1000 {
        let candidate = directory.join(format!("{stem}-{stamp}-{suffix}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("image-{stamp}.{extension}"))
}

fn sanitize_asset_name(original_name: &str) -> String {
    let path = Path::new(original_name);
    let raw_stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mut stem = String::new();
    let mut separator = false;
    for character in raw_stem.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_') {
            stem.push(character);
            separator = false;
        } else if !separator && !stem.is_empty() {
            stem.push('-');
            separator = true;
        }
    }
    let stem = stem.trim_matches('-');
    format!(
        "{}.{}",
        if stem.is_empty() { "image" } else { stem },
        extension
    )
}

fn document_assets_directory(
    state: &State<'_, AppState>,
    relative_document_path: &str,
) -> CommandResult<PathBuf> {
    let document = resolve_workspace_path(state, relative_document_path)?;
    let assets = assets_directory_for_document(&document)?;
    ensure_inside_workspace(state, &assets)?;
    Ok(assets)
}

fn assets_directory_for_document(document: &Path) -> CommandResult<PathBuf> {
    let parent = document.parent().ok_or("The document has no parent directory.")?;
    let stem = document
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("document");
    let assets = parent.join(format!("{stem}.assets"));
    Ok(assets)
}

fn update_asset_directory_reference(
    document: &Path,
    old_assets: &Path,
    new_assets: &Path,
) -> CommandResult<()> {
    let old_name = old_assets.file_name().and_then(|value| value.to_str()).unwrap_or("");
    let new_name = new_assets.file_name().and_then(|value| value.to_str()).unwrap_or("");
    if old_name.is_empty() || old_name == new_name { return Ok(()); }
    let content = fs::read_to_string(document).map_err(|error| format!("无法更新图片引用：{error}"))?;
    let updated = content.replace(&format!("{old_name}/"), &format!("{new_name}/"));
    if updated != content {
        fs::write(document, updated).map_err(|error| format!("无法更新图片引用：{error}"))?;
    }
    Ok(())
}

fn image_asset(
    root: &Path,
    relative_document_path: &str,
    target: &Path,
    size: u64,
) -> CommandResult<ImageAsset> {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("图片文件名无效。")?;
    let path = target
        .strip_prefix(root)
        .map_err(|_| "Image path is outside the opened directory.")?
        .to_string_lossy()
        .replace('\\', "/");
    let document_parent = Path::new(relative_document_path).parent().unwrap_or(Path::new(""));
    let target_relative = Path::new(&path);
    let from = document_parent
        .components()
        .filter_map(|part| match part { Component::Normal(value) => Some(value), _ => None })
        .collect::<Vec<_>>();
    let to = target_relative
        .components()
        .filter_map(|part| match part { Component::Normal(value) => Some(value), _ => None })
        .collect::<Vec<_>>();
    let mut common = 0;
    while common < from.len() && common < to.len() && from[common] == to[common] {
        common += 1;
    }
    let mut reference_parts = vec!["..".to_string(); from.len() - common];
    reference_parts.extend(to[common..].iter().map(|part| part.to_string_lossy().into_owned()));
    let reference = reference_parts.join("/");
    let alt = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("图片")
        .to_string();
    Ok(ImageAsset {
        path,
        reference,
        alt,
        size,
    })
}

fn truncate_preview(line: &str, limit: usize) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(limit).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_references_are_relative_to_the_document() {
        let root = Path::new("workspace");
        let root_asset = image_asset(root, "README.md", Path::new("workspace/README.assets/cover.png"), 12).unwrap();
        let nested_asset = image_asset(
            root,
            "docs/design/spec.md",
            Path::new("workspace/docs/design/spec.assets/cover.png"),
            12,
        ).unwrap();
        assert_eq!(root_asset.reference, "README.assets/cover.png");
        assert_eq!(nested_asset.reference, "spec.assets/cover.png");
    }

    #[test]
    fn image_names_are_safe_for_markdown_links() {
        assert_eq!(sanitize_asset_name("产品 截图 (1).PNG"), "产品-截图-1.png");
        assert_eq!(sanitize_asset_name("!!!.jpeg"), "image.jpeg");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            open_files,
            read_text_file,
            write_text_file,
            create_file,
            create_directory,
            rename_entry,
            move_entry,
            import_files,
            trash_entry,
            list_trash,
            restore_trash,
            delete_trash,
            search_workspace,
            export_html,
            export_text,
            export_binary,
            save_image_data,
            import_image_files,
            read_image_data,
            exit_application,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 码档");
}
