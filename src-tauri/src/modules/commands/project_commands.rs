// Project Commands - Phase 4 Milestone 4
//
// Tauri commands for .ecp project file save/load operations.
// Provides project persistence with auto-save and recovery support.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::command;
use uuid::Uuid;

/// Project file format version
const PROJECT_VERSION: &str = "1.0.0";

/// Maximum recent projects to track (matches frontend display limit)
const MAX_RECENT_PROJECTS: usize = 5;

/// Generate a new project ID (for backwards compatibility with old .ecp files)
fn generate_project_id() -> String {
    Uuid::new_v4().to_string()
}

/// Column metadata structure for project serialization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectColumnMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
    pub width: Option<f64>,
}

/// Dataset structure for project serialization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDataset {
    pub id: String,
    pub name: String,
    #[serde(rename = "rowCount")]
    pub row_count: usize,
    #[serde(rename = "dataRowCount", skip_serializing_if = "Option::is_none")]
    pub data_row_count: Option<usize>,
    #[serde(rename = "columnCount")]
    pub column_count: usize,
    pub columns: Vec<ProjectColumnMeta>,
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
    /// DuckDB file path (for large datasets >= 1M rows)
    #[serde(rename = "duckdbPath", skip_serializing_if = "Option::is_none")]
    pub duckdb_path: Option<String>,
    #[serde(rename = "familyId", skip_serializing_if = "Option::is_none")]
    pub family_id: Option<String>,
    #[serde(rename = "highlights", skip_serializing_if = "Option::is_none")]
    pub highlights: Option<HashMap<String, String>>,
    #[serde(rename = "importedAt")]
    pub imported_at: String,
    #[serde(rename = "modifiedAt")]
    pub modified_at: String,
}

/// Test result structure (matches frontend TestResult)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub id: String,
    #[serde(rename = "testId")]
    pub test_id: String,
    #[serde(rename = "testName")]
    pub test_name: String,
    pub family: String,
    /// Statistics family ID for per-family result isolation
    #[serde(rename = "statisticsFamilyId", skip_serializing_if = "Option::is_none")]
    pub statistics_family_id: Option<String>,
    #[serde(rename = "executedAt")]
    pub executed_at: String,
    pub parameters: Value,
    pub statistics: Value,
    pub assumptions: Option<Value>,
    pub tables: Option<Vec<Value>>,
    /// Summary can be a string or an object - using Value for flexibility
    pub summary: Option<Value>,
    #[serde(rename = "rawResult")]
    pub raw_result: Option<Value>,
}

/// Project file metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMetadata {
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "modifiedAt")]
    pub modified_at: String,
    pub author: Option<String>,
}

/// Statistics family metadata for per-family dataset isolation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFamily {
    pub id: String,
    pub name: String,
    #[serde(rename = "datasetId", skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
    #[serde(rename = "hasData")]
    pub has_data: bool,
    #[serde(rename = "hasResults")]
    pub has_results: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Project file structure (.ecp format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    pub version: String,
    pub name: String,
    /// Stable project identifier (UUID) for cache namespacing
    /// Auto-generated for old .ecp files without projectId
    #[serde(rename = "projectId", default = "generate_project_id")]
    pub project_id: String,
    /// Set to true when projectId was missing and generated during load.
    /// Not persisted on save (cleared before serialization).
    #[serde(
        rename = "projectIdGenerated",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub project_id_generated: Option<bool>,
    pub datasets: Vec<ProjectDataset>,
    #[serde(rename = "analysisHistory")]
    pub analysis_history: Vec<Value>,
    #[serde(rename = "savedResults")]
    pub saved_results: Vec<TestResult>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub families: Option<Vec<ProjectFamily>>,
    #[serde(
        rename = "activeFamilyId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub active_family_id: Option<String>,
    pub metadata: ProjectMetadata,
    // All-DuckDB: dataCache removed - all datasets stored in .ecpdb files
    /// Formula persistence (Phase 7 - Formula Engine)
    /// Format: { datasetId: { cellKey: formulaString } }
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub formulas: Option<Value>,
    /// Plot persistence (OLE Copy/Paste - Phase 1)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub plots: Option<Vec<Value>>,
    #[serde(
        rename = "activePlotId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub active_plot_id: Option<String>,
    #[serde(
        rename = "activeStatisticsFamilyId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub active_statistics_family_id: Option<String>,
    #[serde(
        rename = "rnaseqState",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub rnaseq_state: Option<Value>,
    #[serde(
        rename = "rnaseqResults",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub rnaseq_results: Option<Value>,
}

/// Recent project entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    #[serde(rename = "modifiedAt")]
    pub modified_at: String,
}

/// Save project to .ecp file
///
/// # Arguments
/// * `file_path` - Destination file path (should end with .ecp)
/// * `project` - Project data to save
#[command]
pub async fn save_project(file_path: String, project: ProjectFile) -> Result<(), String> {
    // Validate file extension
    if !file_path.to_lowercase().ends_with(".ecp") {
        return Err("Project file must have .ecp extension".to_string());
    }

    // Validate path (no traversal)
    if file_path.contains("..") {
        return Err("Invalid file path: directory traversal not allowed".to_string());
    }

    // Create project with current version
    let mut project_to_save = project;
    project_to_save.version = PROJECT_VERSION.to_string();
    // Ensure transient load-only fields are not persisted
    project_to_save.project_id_generated = None;

    // Update modified timestamp
    project_to_save.metadata.modified_at = chrono::Utc::now().to_rfc3339();

    // Serialize to JSON with pretty printing
    let json = serde_json::to_string_pretty(&project_to_save)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;

    // Write to file
    fs::write(&file_path, json).map_err(|e| format!("Failed to write project file: {}", e))?;

    // Update recent projects
    if let Err(e) = add_to_recent_projects(&file_path, &project_to_save.name) {
        log::warn!("Failed to update recent projects: {}", e);
    }

    log::info!("Saved project to: {}", file_path);
    Ok(())
}

/// Load project from .ecp file
///
/// # Arguments
/// * `file_path` - Path to .ecp file
#[command]
pub async fn load_project(file_path: String) -> Result<ProjectFile, String> {
    // Validate file extension
    if !file_path.to_lowercase().ends_with(".ecp") {
        return Err("Project file must have .ecp extension".to_string());
    }

    // Validate path
    if file_path.contains("..") {
        return Err("Invalid file path: directory traversal not allowed".to_string());
    }

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("Project file not found: {}", file_path));
    }

    // Read file
    let json = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read project file: {}", e))?;

    // Parse JSON (Value first so we can detect legacy files missing projectId)
    let value: Value =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse project file: {}", e))?;
    let project_id_missing = match value.get("projectId").and_then(|v| v.as_str()) {
        Some(raw) => raw.trim().is_empty(),
        None => true,
    };

    let mut project: ProjectFile = serde_json::from_value(value)
        .map_err(|e| format!("Failed to parse project file: {}", e))?;
    if project_id_missing {
        project.project_id_generated = Some(true);
    } else {
        project.project_id_generated = None;
    }

    // Version check (for future migrations)
    if project.version != PROJECT_VERSION {
        log::warn!(
            "Project version mismatch: file={}, current={}",
            project.version,
            PROJECT_VERSION
        );
        // For now, we accept older versions
    }

    // Note: Recent projects are updated by frontend after successful restoration
    // This prevents adding to recents when user cancels relink dialog or load fails

    log::info!("Loaded project from: {}", file_path);
    Ok(project)
}

/// Get list of recent projects
#[command]
pub async fn get_recent_projects() -> Result<Vec<RecentProject>, String> {
    let recent_path = get_recent_projects_path()?;

    if !recent_path.exists() {
        return Ok(vec![]);
    }

    let json = fs::read_to_string(&recent_path)
        .map_err(|e| format!("Failed to read recent projects: {}", e))?;

    let projects: Vec<RecentProject> = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse recent projects: {}", e))?;

    // Filter out projects that no longer exist
    // Note: Skip UNC paths to avoid blocking on offline network shares.
    let valid_projects: Vec<RecentProject> = projects
        .into_iter()
        .filter(|p| {
            // Skip network paths that might block (UNC paths start with \\)
            if p.path.starts_with("\\\\") || p.path.starts_with("//") {
                // For network paths, include them but let frontend handle missing file errors
                return true;
            }
            Path::new(&p.path).exists()
        })
        .collect();

    Ok(valid_projects)
}

/// Add a project to recent projects list (called by frontend after successful load)
#[command]
pub async fn add_recent_project(file_path: String, name: String) -> Result<(), String> {
    add_to_recent_projects(&file_path, &name)
}

/// Remove a project from recent projects list
#[command]
pub async fn remove_recent_project(file_path: String) -> Result<(), String> {
    let recent_path = get_recent_projects_path()?;

    if !recent_path.exists() {
        return Ok(());
    }

    let json = fs::read_to_string(&recent_path)
        .map_err(|e| format!("Failed to read recent projects: {}", e))?;

    let mut projects: Vec<RecentProject> = serde_json::from_str(&json).unwrap_or_default();

    // Fix #7: Remove entry using normalized path comparison
    // This handles both case differences and slash direction on Windows
    let normalized_path = normalize_path_for_comparison(&file_path);
    projects.retain(|p| normalize_path_for_comparison(&p.path) != normalized_path);

    // Fix #4: Use atomic write to prevent corruption
    let json = serde_json::to_string_pretty(&projects)
        .map_err(|e| format!("Failed to serialize recent projects: {}", e))?;

    atomic_write_json(&recent_path, &json)?;

    Ok(())
}

/// Check if a project file exists (for pre-click validation)
#[command]
pub async fn check_project_file_exists(file_path: String) -> Result<bool, String> {
    // Skip UNC paths to avoid blocking on offline network shares.
    if file_path.starts_with("\\\\") || file_path.starts_with("//") {
        return Ok(true);
    }
    Ok(Path::new(&file_path).exists())
}

/// Create new empty project
#[command]
pub async fn create_new_project(name: String) -> Result<ProjectFile, String> {
    let now = chrono::Utc::now().to_rfc3339();

    Ok(ProjectFile {
        version: PROJECT_VERSION.to_string(),
        name,
        project_id: Uuid::new_v4().to_string(),
        project_id_generated: None,
        datasets: vec![],
        analysis_history: vec![],
        saved_results: vec![],
        families: None,
        active_family_id: None,
        metadata: ProjectMetadata {
            created_at: now.clone(),
            modified_at: now,
            author: None,
        },
        // All-DuckDB: dataCache removed
        formulas: None,
        plots: None,
        active_plot_id: None,
        active_statistics_family_id: None,
        rnaseq_state: None,
        rnaseq_results: None,
    })
}

/// Check if project has unsaved changes
/// (Compares file on disk with provided project data)
#[command]
pub async fn has_unsaved_changes(
    file_path: String,
    current_project: ProjectFile,
) -> Result<bool, String> {
    if !Path::new(&file_path).exists() {
        // New project, not yet saved
        return Ok(true);
    }

    let saved_project = load_project(file_path).await?;

    // Compare relevant fields (ignore metadata.modifiedAt)
    let has_changes = saved_project.name != current_project.name
        || saved_project.datasets.len() != current_project.datasets.len()
        || saved_project.saved_results.len() != current_project.saved_results.len()
        || saved_project.rnaseq_state != current_project.rnaseq_state
        || saved_project.rnaseq_results != current_project.rnaseq_results;

    Ok(has_changes)
}

/// Get auto-save file path for a project
#[command]
pub async fn get_autosave_path(project_path: Option<String>) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let filename = match project_path {
        Some(path) => {
            // Use hash of original path for uniqueness
            let hash = simple_hash(&path);
            format!("easycris_autosave_{}.ecp", hash)
        }
        None => "easycris_autosave_untitled.ecp".to_string(),
    };

    Ok(temp_dir.join(filename).to_string_lossy().to_string())
}

/// Delete auto-save file (call after successful manual save)
#[command]
pub async fn clear_autosave(project_path: Option<String>) -> Result<(), String> {
    let autosave_path = get_autosave_path(project_path).await?;

    if Path::new(&autosave_path).exists() {
        fs::remove_file(&autosave_path).map_err(|e| format!("Failed to delete autosave: {}", e))?;
        log::info!("Cleared autosave file");
    }

    Ok(())
}

/// Check for recovery file on startup
#[command]
pub async fn check_recovery_file() -> Result<Option<String>, String> {
    let temp_dir = std::env::temp_dir();

    // Look for any autosave files
    let entries = fs::read_dir(&temp_dir).map_err(|e| format!("Failed to read temp dir: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("easycris_autosave_") && name.ends_with(".ecp") {
                return Ok(Some(path.to_string_lossy().to_string()));
            }
        }
    }

    Ok(None)
}

// ==================== Helper Functions ====================

/// Get path to recent projects file
fn get_recent_projects_path() -> Result<std::path::PathBuf, String> {
    let data_dir =
        dirs::data_local_dir().ok_or_else(|| "Failed to get local data directory".to_string())?;

    let app_dir = data_dir.join("easycris");
    fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    Ok(app_dir.join("recent_projects.json"))
}

/// Fix #7: Normalize file path for consistent comparison
/// On Windows: converts forward slashes to backslashes and lowercases
/// On other platforms: returns as-is
fn normalize_path_for_comparison(path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        // Normalize slashes and case for Windows
        path.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string()
    }
}

/// Fix #4: Atomic file write using temp file + rename pattern
/// This prevents corruption from concurrent writes or crashes mid-write
fn atomic_write_json(path: &std::path::Path, content: &str) -> Result<(), String> {
    use std::io::Write;

    // Write to temp file first
    let temp_path = path.with_extension("json.tmp");

    let mut file =
        fs::File::create(&temp_path).map_err(|e| format!("Failed to create temp file: {}", e))?;

    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write to temp file: {}", e))?;

    file.sync_all()
        .map_err(|e| format!("Failed to sync temp file: {}", e))?;

    drop(file); // Explicitly close before rename

    // Atomic rename (on most filesystems)
    fs::rename(&temp_path, path).map_err(|e| format!("Failed to rename temp file: {}", e))?;

    Ok(())
}

/// Add project to recent projects list
fn add_to_recent_projects(file_path: &str, name: &str) -> Result<(), String> {
    let recent_path = get_recent_projects_path()?;

    let mut projects: Vec<RecentProject> = if recent_path.exists() {
        let json = fs::read_to_string(&recent_path)
            .map_err(|e| format!("Failed to read recent projects: {}", e))?;
        serde_json::from_str(&json).unwrap_or_default()
    } else {
        vec![]
    };

    // Fix #7: Remove existing entry using normalized path comparison
    // This handles both case differences and slash direction on Windows
    let normalized_new_path = normalize_path_for_comparison(file_path);
    projects.retain(|p| normalize_path_for_comparison(&p.path) != normalized_new_path);

    // Add new entry at the beginning
    projects.insert(
        0,
        RecentProject {
            path: file_path.to_string(),
            name: name.to_string(),
            modified_at: chrono::Utc::now().to_rfc3339(),
        },
    );

    // Limit to MAX_RECENT_PROJECTS
    projects.truncate(MAX_RECENT_PROJECTS);

    // Fix #4: Use atomic write to prevent corruption from concurrent writes
    let json = serde_json::to_string_pretty(&projects)
        .map_err(|e| format!("Failed to serialize recent projects: {}", e))?;

    atomic_write_json(&recent_path, &json)?;

    Ok(())
}

/// Simple hash function for autosave filenames
fn simple_hash(s: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn test_create_new_project() {
        let project = create_new_project("Test Project".to_string())
            .await
            .unwrap();

        assert_eq!(project.name, "Test Project");
        assert_eq!(project.version, PROJECT_VERSION);
        assert!(project.datasets.is_empty());
        assert!(project.saved_results.is_empty());
    }

    #[tokio::test]
    async fn test_save_and_load_project() {
        let temp_dir = std::env::temp_dir();
        let test_path = temp_dir.join("test_project.ecp");

        let project = create_new_project("Test Save/Load".to_string())
            .await
            .unwrap();

        // Save
        let save_result =
            save_project(test_path.to_string_lossy().to_string(), project.clone()).await;
        assert!(save_result.is_ok());

        // Load
        let loaded = load_project(test_path.to_string_lossy().to_string()).await;
        assert!(loaded.is_ok());

        let loaded_project = loaded.unwrap();
        assert_eq!(loaded_project.name, "Test Save/Load");

        // Cleanup
        fs::remove_file(test_path).ok();
    }

    #[tokio::test]
    async fn test_invalid_extension_rejected() {
        let result = save_project(
            "/tmp/test.txt".to_string(),
            create_new_project("Test".to_string()).await.unwrap(),
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".ecp"));
    }

    #[tokio::test]
    async fn test_path_traversal_rejected() {
        let result = save_project(
            "../../../etc/passwd.ecp".to_string(),
            create_new_project("Test".to_string()).await.unwrap(),
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("traversal"));
    }
}
