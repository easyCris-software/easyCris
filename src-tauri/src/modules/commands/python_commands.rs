// Python script execution command
//
// Provides a controlled way to run short Python snippets with a JSON context.
// Used by the frontend for auxiliary tooling (e.g., PPTX export).

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

/// Maximum execution time (5 minutes)
const TIMEOUT_SECS: u64 = 300;

#[derive(Serialize)]
pub struct ScriptExecutionResult {
    pub output: String,
    pub error: Option<String>,
}

fn get_python_base_dir() -> PathBuf {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let resources_dir = exe_dir.join("resources");
            let python_dir = resources_dir.join("python_embedded");
            if python_dir.exists() {
                return resources_dir;
            }

            let python_dir = exe_dir.join("python_embedded");
            if python_dir.exists() {
                return exe_dir.to_path_buf();
            }

            let mut current = exe_dir.to_path_buf();
            for _ in 0..5 {
                let python_dir = current.join("python_embedded");
                if python_dir.exists() {
                    return current;
                }
                if let Some(parent) = current.parent() {
                    current = parent.to_path_buf();
                } else {
                    break;
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let python_dir = cwd.join("python_embedded");
        if python_dir.exists() {
            return cwd;
        }

        if let Some(parent) = cwd.parent() {
            let python_dir = parent.join("python_embedded");
            if python_dir.exists() {
                return parent.to_path_buf();
            }
        }
    }

    PathBuf::from(".")
}

/// Execute a short Python snippet with a JSON context injected as `context`.
#[tauri::command]
pub async fn execute_python_script(
    script: String,
    context: Option<Value>,
) -> Result<ScriptExecutionResult, String> {
    let base_dir = get_python_base_dir();
    let python_exe = base_dir.join("python_embedded").join("python.exe");

    if !python_exe.exists() {
        return Err(format!("Python executable not found at: {:?}", python_exe));
    }

    let wrapper = format!(
        "import json,sys\ncontext=json.loads(sys.stdin.read() or \"{}\")\n{}\n",
        "{}", script
    );

    let mut child = Command::new(&python_exe)
        .arg("-c")
        .arg(wrapper)
        .current_dir(&base_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let payload = context.unwrap_or_else(|| Value::Object(Default::default()));
    let input = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to Python stdin: {e}"))?;
    }

    let stdout_task = {
        let stdout = child.stdout.take();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut out) = stdout {
                out.read_to_end(&mut buf).await?;
            }
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
    };

    let stderr_task = {
        let stderr = child.stderr.take();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut err) = stderr {
                err.read_to_end(&mut buf).await?;
            }
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
    };

    let status = match timeout(Duration::from_secs(TIMEOUT_SECS), child.wait()).await {
        Ok(result) => result.map_err(|e| format!("Python execution failed: {e}"))?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!(
                "Python script timed out after {} seconds",
                TIMEOUT_SECS
            ));
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|e| format!("Failed to read Python stdout: {e}"))?
        .map_err(|e| format!("Failed to read Python stdout: {e}"))?;
    let stderr = stderr_task
        .await
        .map_err(|e| format!("Failed to read Python stderr: {e}"))?
        .map_err(|e| format!("Failed to read Python stderr: {e}"))?;

    let stdout = String::from_utf8_lossy(&stdout).to_string();
    let stderr = String::from_utf8_lossy(&stderr).to_string();

    if status.success() {
        Ok(ScriptExecutionResult {
            output: stdout,
            error: None,
        })
    } else {
        let error = if stderr.trim().is_empty() {
            "Python script failed".to_string()
        } else {
            stderr
        };
        Ok(ScriptExecutionResult {
            output: stdout,
            error: Some(error),
        })
    }
}
