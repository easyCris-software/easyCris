// Modular backend structure for easyCris Tauri
//
// Each module has a single responsibility:
// - python_backend: Spawn and communicate with Python statistics engine
// - security: Validate paths, prevent directory traversal
// - commands: Tauri command handlers (one per test family)
// - arrow_handler: Apache Arrow IPC file operations (Phase 4)
// - cache_manager: In-memory dataset cache for real-time sync (Phase 4)
// - hybrid_cache_manager: DuckDB-backed cache for large datasets (Phase 5)
// - undo_manager: Undo/redo stack for editing operations (Phase 4)
// - formula_backend: DuckDB-backed formula evaluation with Formualizer (Phase 6)
// - remote_session: Host-approved LAN remote-control spike
// - errors: Structured error envelope for command boundaries

pub mod arrow_handler;
pub mod cache_manager;
pub mod commands;
pub mod errors;
pub mod formula_backend;
pub mod hybrid_cache_manager;
pub mod python_backend;
pub mod remote_session;
pub mod security;
pub mod undo_manager;
