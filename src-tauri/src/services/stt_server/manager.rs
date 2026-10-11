//! Starts, supervises and stops the local speech server (stt_server.py).
//!
//! Standard library only, so it can be unit tested on its own.
//!
//! First start for an engine: finds a suitable system Python, creates a private
//! virtual environment, installs the engine's packages (progress goes to
//! setup.log). Every start: writes the embedded server script to disk and runs
//! it with the environment's Python (output goes to server.log).

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// One `pip` invocation (arguments after `-m pip`). If it fails and a fallback
/// is given, the fallback is tried instead.
#[derive(Clone, Debug)]
pub struct Step {
    pub args: Vec<String>,
    pub fallback: Option<Vec<String>>,
}

impl Step {
    pub fn new(args: &[&str]) -> Self {
        Step { args: args.iter().map(|s| s.to_string()).collect(), fallback: None }
    }
    pub fn with_fallback(mut self, args: &[&str]) -> Self {
        self.fallback = Some(args.iter().map(|s| s.to_string()).collect());
        self
    }
}

#[derive(Clone, Debug)]
pub struct Spec {
    /// Identifies what is being run. Starting the same key twice is a no-op.
    pub key: String,
    /// Folder for the script, environments and logs.
    pub data_dir: PathBuf,
    /// Sub folder name of the environment (one per engine).
    pub env_name: String,
    pub script_source: &'static str,
    pub steps: Vec<Step>,
    /// Arguments passed to the script.
    pub server_args: Vec<String>,
    /// Use this Python instead of searching (also settable by the user).
    pub python_override: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Idle,
    Preparing,
    Running,
    Failed,
}

struct Inner {
    child: Option<Child>,
    setup_child: Option<Child>,
    key: Option<String>,
    phase: Phase,
    message: String,
    generation: u64,
    data_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct Status {
    /// "idle", "preparing", "running" or "failed"
    pub phase: &'static str,
    pub message: String,
    /// Last lines of the relevant log file.
    pub log: String,
}

#[derive(Clone)]
pub struct SttServerManager {
    inner: Arc<Mutex<Inner>>,
}

impl Default for SttServerManager {
    fn default() -> Self {
        SttServerManager {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                setup_child: None,
                key: None,
                phase: Phase::Idle,
                message: String::new(),
                generation: 0,
                data_dir: None,
            })),
        }
    }
}

impl SttServerManager {
    /// Begins starting the server in the background and returns immediately.
    /// Poll `status()` to follow progress.
    pub fn start(&self, spec: Spec) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        refresh_exit(&mut g);

        if g.key.as_deref() == Some(spec.key.as_str())
            && (g.phase == Phase::Preparing || g.phase == Phase::Running)
        {
            return Ok(()); // already on its way, or running
        }

        stop_locked(&mut g);
        g.generation += 1;
        let generation = g.generation;
        g.key = Some(spec.key.clone());
        g.phase = Phase::Preparing;
        g.message = "Preparing the speech server...".into();
        g.data_dir = Some(spec.data_dir.clone());
        drop(g);

        let inner = Arc::clone(&self.inner);
        thread::spawn(move || {
            if let Err(message) = prepare_and_spawn(&inner, &spec, generation) {
                let mut g = inner.lock().unwrap();
                if g.generation == generation {
                    g.phase = Phase::Failed;
                    g.message = message;
                }
            }
        });
        Ok(())
    }

    pub fn stop(&self) {
        let mut g = self.inner.lock().unwrap();
        stop_locked(&mut g);
    }

    pub fn status(&self) -> Status {
        let mut g = self.inner.lock().unwrap();
        refresh_exit(&mut g);
        let phase = match g.phase {
            Phase::Idle => "idle",
            Phase::Preparing => "preparing",
            Phase::Running => "running",
            Phase::Failed => "failed",
        };
        let log = match (&g.data_dir, g.phase) {
            (Some(dir), Phase::Preparing) => tail(&dir.join("setup.log"), 1500),
            (Some(dir), _) => tail(&dir.join("server.log"), 1500),
            _ => String::new(),
        };
        Status { phase, message: g.message.clone(), log }
    }
}

/// Notices when the server process died by itself.
fn refresh_exit(g: &mut Inner) {
    if let Some(child) = g.child.as_mut() {
        if let Ok(Some(code)) = child.try_wait() {
            g.child = None;
            g.phase = Phase::Failed;
            g.message = match code.code() {
                Some(c) => format!("The speech server stopped unexpectedly (exit code {}).", c),
                None => "The speech server stopped unexpectedly.".into(),
            };
        }
    }
}

fn stop_locked(g: &mut Inner) {
    g.generation += 1; // cancels a start that is still preparing
    if let Some(mut c) = g.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    if let Some(mut c) = g.setup_child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    g.key = None;
    g.phase = Phase::Idle;
    g.message.clear();
}

fn is_current(inner: &Arc<Mutex<Inner>>, generation: u64) -> bool {
    inner.lock().unwrap().generation == generation
}

fn set_message(inner: &Arc<Mutex<Inner>>, generation: u64, msg: &str) {
    let mut g = inner.lock().unwrap();
    if g.generation == generation {
        g.message = msg.to_string();
    }
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn env_python(env_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        env_dir.join("Scripts").join("python.exe")
    } else {
        env_dir.join("bin").join("python")
    }
}

/// Small stable hash, used so changing an engine's package list reinstalls it.
fn fnv1a(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn steps_fingerprint(steps: &[Step]) -> String {
    let mut text = String::new();
    for s in steps {
        text.push_str(&s.args.join("\u{1}"));
        text.push('\u{2}');
        if let Some(f) = &s.fallback {
            text.push_str(&f.join("\u{1}"));
        }
        text.push('\u{3}');
    }
    format!("{:016x}", fnv1a(&text))
}

struct PyCmd {
    program: String,
    prefix: Vec<String>,
}

/// Python 3.10 to 3.12: newer versions are missing prebuilt packages for the speech engines.
fn find_python(override_: &Option<String>) -> Result<PyCmd, String> {
    if let Some(p) = override_ {
        if !p.trim().is_empty() {
            return Ok(PyCmd { program: p.clone(), prefix: vec![] });
        }
    }
    let candidates: Vec<(&str, Vec<&str>)> = if cfg!(windows) {
        vec![
            ("py", vec!["-3.11"]),
            ("py", vec!["-3.12"]),
            ("py", vec!["-3.10"]),
            ("python", vec![]),
            ("python3", vec![]),
        ]
    } else {
        vec![
            ("python3.11", vec![]),
            ("python3.12", vec![]),
            ("python3.10", vec![]),
            ("python3", vec![]),
            ("python", vec![]),
        ]
    };
    for (program, prefix) in candidates {
        let mut cmd = Command::new(program);
        cmd.args(&prefix).arg("--version").stdin(Stdio::null());
        hide_window(&mut cmd);
        let Ok(out) = cmd.output() else { continue };
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if let Some(minor) = parse_python_minor(&text) {
            if (10..=12).contains(&minor) {
                return Ok(PyCmd {
                    program: program.to_string(),
                    prefix: prefix.iter().map(|s| s.to_string()).collect(),
                });
            }
        }
    }
    Err("Python 3.10, 3.11 or 3.12 was not found. Install Python 3.11 from \
         https://www.python.org/downloads/ (tick \"Add python.exe to PATH\"), then try again."
        .into())
}

fn parse_python_minor(text: &str) -> Option<u32> {
    let rest = text.split("Python 3.").nth(1)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn append_log(path: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// Runs a program to completion, logging its output, and stops early when cancelled.
fn run_logged<S: AsRef<OsStr>>(
    inner: &Arc<Mutex<Inner>>,
    generation: u64,
    program: &str,
    args: &[S],
    log_path: &Path,
) -> Result<(), String> {
    let shown: Vec<String> = args.iter().map(|a| a.as_ref().to_string_lossy().into_owned()).collect();
    append_log(log_path, &format!("\n> {} {}", program, shown.join(" ")));

    let log = OpenOptions::new().create(true).append(true).open(log_path).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .env("PYTHONUNBUFFERED", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1");
    hide_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Could not run {}: {}", program, e))?;

    {
        let mut g = inner.lock().unwrap();
        if g.generation != generation {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        g.setup_child = Some(child);
    }

    loop {
        thread::sleep(Duration::from_millis(200));
        let mut g = inner.lock().unwrap();
        if g.generation != generation {
            return Err("cancelled".into()); // stop_locked already killed it
        }
        let Some(child) = g.setup_child.as_mut() else {
            return Err("cancelled".into());
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                g.setup_child = None;
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "A setup step failed (exit code {}). See the log for details.",
                        status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
                    ))
                };
            }
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn prepare_and_spawn(inner: &Arc<Mutex<Inner>>, spec: &Spec, generation: u64) -> Result<(), String> {
    fs::create_dir_all(&spec.data_dir).map_err(|e| format!("Cannot create {}: {}", spec.data_dir.display(), e))?;

    // the script is embedded in the app, write it out every time so it is always current
    let script_path = spec.data_dir.join("stt_server.py");
    let current = fs::read_to_string(&script_path).unwrap_or_default();
    if current != spec.script_source {
        fs::write(&script_path, spec.script_source).map_err(|e| format!("Cannot write the server script: {}", e))?;
    }

    let env_dir = spec.data_dir.join("envs").join(&spec.env_name);
    let py = env_python(&env_dir);
    let marker = env_dir.join(format!(".installed-{}", steps_fingerprint(&spec.steps)));
    let setup_log = spec.data_dir.join("setup.log");

    if !marker.exists() {
        let _ = fs::remove_file(&setup_log);
        set_message(inner, generation, "Setting up the speech engine (first time only, this can take several minutes)...");

        if !py.exists() {
            let sys_py = find_python(&spec.python_override)?;
            let mut args: Vec<String> = sys_py.prefix.clone();
            args.extend(["-m".into(), "venv".into(), env_dir.to_string_lossy().into_owned()]);
            run_logged(inner, generation, &sys_py.program, &args, &setup_log)?;
        }

        let py_str = py.to_string_lossy().into_owned();
        let total = spec.steps.len();
        for (i, step) in spec.steps.iter().enumerate() {
            set_message(inner, generation, &format!("Installing packages, step {} of {} (first time only)...", i + 1, total));
            let mut args: Vec<&str> = vec!["-m", "pip"];
            args.extend(step.args.iter().map(|s| s.as_str()));
            if let Err(e) = run_logged(inner, generation, &py_str, &args, &setup_log) {
                match (&step.fallback, e.as_str()) {
                    (Some(fallback), msg) if msg != "cancelled" => {
                        let mut args: Vec<&str> = vec!["-m", "pip"];
                        args.extend(fallback.iter().map(|s| s.as_str()));
                        run_logged(inner, generation, &py_str, &args, &setup_log)?;
                    }
                    _ => return Err(e),
                }
            }
        }
        fs::write(&marker, "ok").map_err(|e| e.to_string())?;
    }

    if !is_current(inner, generation) {
        return Err("cancelled".into());
    }

    set_message(inner, generation, "Starting the speech server...");
    let server_log_path = spec.data_dir.join("server.log");
    let log = File::create(&server_log_path).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&py);
    cmd.arg(&script_path)
        .args(&spec.server_args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1");
    hide_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Could not start the speech server: {}", e))?;

    let mut g = inner.lock().unwrap();
    if g.generation != generation {
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
        return Err("cancelled".into());
    }
    g.child = Some(child);
    g.phase = Phase::Running;
    g.message = "The speech server is starting...".into();
    Ok(())
}

/// Last `max_bytes` of a text file.
fn tail(path: &Path, max_bytes: usize) -> String {
    let Ok(bytes) = fs::read(path) else { return String::new() };
    let start = bytes.len().saturating_sub(max_bytes);
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    // drop a possibly cut first line
    if start > 0 {
        if let Some(i) = text.find('\n') {
            return text[i + 1..].to_string();
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stt_manager_test_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn wait_for<F: Fn() -> bool>(secs: u64, f: F) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(secs) {
            if f() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
    }

    fn spec(dir: &Path, key: &str, script: &'static str, steps: Vec<Step>) -> Spec {
        Spec {
            key: key.into(),
            data_dir: dir.to_path_buf(),
            env_name: "test".into(),
            script_source: script,
            steps,
            server_args: vec!["--hello".into(), "world".into()],
            python_override: std::env::var("TEST_PYTHON").ok().or(Some("python3".into())),
        }
    }

    const SERVER: &str = "import sys, time\nprint('ARGS', sys.argv[1:], flush=True)\ntime.sleep(60)\n";
    const CRASH: &str = "import sys\nprint('about to fail', flush=True)\nsys.exit(3)\n";

    #[test]
    fn parses_python_versions() {
        assert_eq!(parse_python_minor("Python 3.11.9\n"), Some(11));
        assert_eq!(parse_python_minor("Python 3.9.0"), Some(9));
        assert_eq!(parse_python_minor("Python 3.13.1"), Some(13));
        assert_eq!(parse_python_minor("nonsense"), None);
    }

    #[test]
    fn fingerprint_changes_with_steps() {
        let a = steps_fingerprint(&[Step::new(&["install", "x"])]);
        let b = steps_fingerprint(&[Step::new(&["install", "y"])]);
        let c = steps_fingerprint(&[Step::new(&["install", "x"]).with_fallback(&["install", "z"])]);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, steps_fingerprint(&[Step::new(&["install", "x"])]));
    }

    #[test]
    fn full_lifecycle() {
        let dir = temp_dir("life");
        let m = SttServerManager::default();
        assert_eq!(m.status().phase, "idle");

        // first start: creates the environment (no packages), then runs the script
        m.start(spec(&dir, "a", SERVER, vec![])).unwrap();
        assert_eq!(m.status().phase, "preparing");
        assert!(wait_for(60, || m.status().phase == "running"), "never reached running: {:?}", m.status());
        assert!(wait_for(10, || m.status().log.contains("ARGS ['--hello', 'world']")), "{:?}", m.status());

        // same key again is a no-op, a different key restarts
        m.start(spec(&dir, "a", SERVER, vec![])).unwrap();
        assert_eq!(m.status().phase, "running");
        let log_before = fs::read_to_string(dir.join("server.log")).unwrap();
        m.start(spec(&dir, "b", SERVER, vec![])).unwrap();
        assert!(wait_for(30, || m.status().phase == "running"));
        assert!(wait_for(10, || !m.status().log.is_empty()));
        let _ = log_before;

        m.stop();
        assert_eq!(m.status().phase, "idle");
        assert!(dir.join("stt_server.py").exists());
    }

    #[test]
    fn reports_crash_with_exit_code() {
        let dir = temp_dir("crash");
        let m = SttServerManager::default();
        m.start(spec(&dir, "c", CRASH, vec![])).unwrap();
        assert!(wait_for(60, || m.status().phase == "failed"), "{:?}", m.status());
        let s = m.status();
        assert!(s.message.contains("exit code 3"), "{:?}", s);
        assert!(s.log.contains("about to fail"), "{:?}", s);
    }

    #[test]
    fn failing_step_uses_fallback_and_reports_errors() {
        let dir = temp_dir("steps");
        let m = SttServerManager::default();
        // "pip" with an invalid command fails; the fallback (pip --version) succeeds
        let steps = vec![Step::new(&["nonexistent-subcommand"]).with_fallback(&["--version"])];
        m.start(spec(&dir, "d", SERVER, steps)).unwrap();
        assert!(wait_for(90, || m.status().phase == "running"), "{:?}", m.status());
        m.stop();

        let dir2 = temp_dir("steps_fail");
        let steps = vec![Step::new(&["nonexistent-subcommand"])];
        m.start(spec(&dir2, "e", SERVER, steps)).unwrap();
        assert!(wait_for(90, || m.status().phase == "failed"), "{:?}", m.status());
        assert!(m.status().message.contains("setup step failed"), "{:?}", m.status());
        assert!(!dir2.join("envs").join("test").join(format!(".installed-{}", steps_fingerprint(&[Step::new(&["nonexistent-subcommand"])]))).exists());
    }

    #[test]
    fn stop_cancels_a_slow_setup() {
        let dir = temp_dir("cancel");
        let wrapper = dir.join("slowpy.sh");
        fs::write(&wrapper, "#!/bin/sh\nsleep 30\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let m = SttServerManager::default();
        let mut s = spec(&dir, "f", SERVER, vec![]);
        s.python_override = Some(wrapper.to_string_lossy().into_owned());
        m.start(s).unwrap();
        thread::sleep(Duration::from_millis(800));
        assert_eq!(m.status().phase, "preparing");
        let t = Instant::now();
        m.stop();
        assert_eq!(m.status().phase, "idle");
        thread::sleep(Duration::from_millis(800));
        assert_eq!(m.status().phase, "idle", "a cancelled start must not come back to life");
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn missing_python_gives_a_helpful_message() {
        let dir = temp_dir("nopy");
        let m = SttServerManager::default();
        let mut s = spec(&dir, "g", SERVER, vec![]);
        s.python_override = Some("/definitely/not/python".into());
        m.start(s).unwrap();
        assert!(wait_for(20, || m.status().phase == "failed"), "{:?}", m.status());
        assert!(m.status().message.contains("Could not run"), "{:?}", m.status());
    }
}
