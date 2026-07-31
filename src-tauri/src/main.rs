// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // tmux re-invokes this same binary as the target of `pipe-pane` to capture
    // a hosted app's output (see `tmux::pipe_to_filter`). That process must
    // never build a window, so the branch happens before any Tauri setup.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some(porta_lib::process_manager::LOG_FILTER_FLAG) {
        if let Some(app_id) = args.next() {
            porta_lib::process_manager::run_log_filter(&app_id);
        }
        return;
    }
    porta_lib::run()
}
