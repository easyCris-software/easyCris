// Tauri command handlers (modular)
//
// Command modules:
// - statistics: Generic dispatcher for all 26 statistical tests (Phase 4 Fix)
// - parametric: Legacy T-tests, ANOVA (kept for backwards compatibility)
// - data_import: CSV/TSV/Excel import (Phase 3C)
// - data_export: Excel/CSV/HTML export (Phase 4)
// - arrow_commands: Arrow IPC file operations (Phase 4 Milestone 2B)
// - cache_commands: Dataset cache operations (Phase 4 Milestone 3)
// - project_commands: Project save/load operations (Phase 4 Milestone 4)
// - undo_commands: Undo/redo operations (Phase 4 Milestone 5)
// - plot_commands: Plot computations (trendlines, etc.)

pub mod arrow_commands;
pub mod cache_commands;
pub mod data_export;
pub mod data_import;
pub mod parametric;
pub mod plot_commands;
pub mod project_commands;
pub mod python_commands;
pub mod rnaseq_commands;
pub mod sample_datasets;
pub mod statistics;
pub mod undo_commands;

// Re-export all command functions for easy registration
pub use arrow_commands::*;
pub use cache_commands::*;
pub use data_export::*;
pub use data_import::*;
pub use parametric::*;
pub use plot_commands::*;
pub use project_commands::*;
pub use python_commands::*;
pub use rnaseq_commands::*;
pub use sample_datasets::*;
pub use statistics::*;
pub use undo_commands::*;
