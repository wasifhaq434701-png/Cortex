// Cortex IDE — Tauri shell.
// On startup it launches the PyInstaller-bundled backend as a sidecar process
// (with CORTEX_NO_BROWSER so it doesn't open a browser tab), then the webview's
// loading page (_tauri_loading.html) polls 127.0.0.1:8077 and hands over to the
// live app once the engine is ready. Zero terminal interaction for the user.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const PORT: &str = "8077";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Resolve and spawn the bundled `cortex-backend` sidecar.
            let sidecar = app
                .shell()
                .sidecar("cortex-backend")
                .expect("cortex-backend sidecar is missing from the bundle")
                .env("CORTEX_NO_BROWSER", "1")
                .env("CORTEX_PORT", PORT);

            let (mut rx, _child) = sidecar.spawn().expect("failed to start cortex-backend");

            // Drain sidecar output to the Tauri log (handy during dev).
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[backend] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[backend] terminated: {:?}", payload);
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Cortex IDE shell");
}
