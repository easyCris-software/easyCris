use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SampleDatasetManifest {
    #[allow(dead_code)]
    version: String,
    datasets: Vec<SampleDatasetEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SampleDatasetEntry {
    id: String,
    name: String,
    description: String,
    file: String,
    group: String,
    #[serde(default)]
    rows: Option<usize>,
    #[serde(default)]
    columns: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SampleDataset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub file: String,
    pub group: String,
    pub path: String,
    pub rows: Option<usize>,
    pub columns: Option<usize>,
}

fn resolve_datasets_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(base_dir) = app.path().resource_dir() {
        candidates.push(base_dir.join("datasets"));
        candidates.push(base_dir.join("resources").join("datasets"));
        candidates.push(base_dir.join("_up_").join("resources").join("datasets"));
        candidates.push(base_dir.join("_up_").join("datasets"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("resources").join("datasets"));
        candidates.push(cwd.join("resources").join("datasets"));
        candidates.push(cwd.join("datasets"));
    }

    for candidate in candidates {
        if candidate.join("manifest.json").exists() {
            return Some(candidate);
        }
    }

    None
}

fn load_manifest(datasets_dir: &std::path::Path) -> Result<SampleDatasetManifest, String> {
    let manifest_path = datasets_dir.join("manifest.json");
    let content = std::fs::read_to_string(&manifest_path).map_err(|e| {
        format!(
            "Failed to read sample dataset manifest at {}: {}",
            manifest_path.to_string_lossy(),
            e
        )
    })?;
    serde_json::from_str::<SampleDatasetManifest>(&content)
        .map_err(|e| format!("Failed to parse sample dataset manifest: {}", e))
}

fn resolve_dataset_file_path(app: &AppHandle, file: &str) -> Result<std::path::PathBuf, String> {
    let datasets_dir = resolve_datasets_dir(app)
        .ok_or_else(|| "Sample datasets directory not found".to_string())?;

    let relative = std::path::Path::new(file);
    if relative.is_absolute() {
        return Err("Sample dataset file must be a relative path".to_string());
    }
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Sample dataset file cannot contain '..' segments".to_string());
    }

    let path = datasets_dir.join(relative);
    if !path.exists() {
        return Err(format!(
            "Sample dataset file not found: {}",
            path.to_string_lossy()
        ));
    }

    Ok(path)
}

#[command]
pub fn get_sample_datasets(app: AppHandle) -> Result<Vec<SampleDataset>, String> {
    let datasets_dir = resolve_datasets_dir(&app)
        .ok_or_else(|| "Sample datasets directory not found".to_string())?;
    let manifest = load_manifest(&datasets_dir)?;

    let datasets = manifest
        .datasets
        .into_iter()
        .map(|entry| {
            let path = datasets_dir.join(&entry.file);
            SampleDataset {
                id: entry.id,
                name: entry.name,
                description: entry.description,
                file: entry.file,
                group: entry.group,
                path: path.to_string_lossy().to_string(),
                rows: entry.rows,
                columns: entry.columns,
            }
        })
        .collect();

    Ok(datasets)
}

#[command]
pub fn read_sample_dataset_preview(
    app: AppHandle,
    file: String,
    max_lines: Option<usize>,
) -> Result<String, String> {
    let path = resolve_dataset_file_path(&app, &file)?;
    let content = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "Failed to read dataset file {}: {}",
            path.to_string_lossy(),
            e
        )
    })?;
    let limit = max_lines.unwrap_or(6);
    let preview = content.lines().take(limit).collect::<Vec<_>>().join("\n");
    Ok(preview)
}

#[command]
pub fn resolve_sample_dataset_path(app: AppHandle, file: String) -> Result<String, String> {
    let path = resolve_dataset_file_path(&app, &file)?;
    Ok(path.to_string_lossy().to_string())
}
