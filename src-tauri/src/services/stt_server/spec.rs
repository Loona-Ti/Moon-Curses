//! Builds the launch recipe (`Spec`) for each speech engine. Std only, unit tested.

use super::manager::{Spec, Step};
use std::path::Path;

pub const ENGINES: [&str; 5] = ["whisper", "parakeet", "nemotron", "vosk", "moonshine"];

fn clean(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

pub fn build_spec(
    data_dir: &Path,
    script: &'static str,
    engine: &str,
    model: &str,
    language: &str,
    port: u16,
    parent_pid: u32,
) -> Result<Spec, String> {
    if !ENGINES.contains(&engine) {
        return Err(format!("Unknown speech engine: {}", engine));
    }
    if port < 1024 {
        return Err("The port must be 1024 or higher.".into());
    }
    if !model.is_empty() && !clean(model) {
        return Err("Invalid model name.".into());
    }
    if !language.is_empty() && !clean(language) {
        return Err("Invalid language.".into());
    }

    let mut steps = vec![Step::new(&["install", "--upgrade", "pip"])];
    fn pkgs(steps: &mut Vec<Step>, list: &[&str]) {
        let mut a = vec!["install"];
        a.extend_from_slice(list);
        a.extend_from_slice(&["numpy", "websockets"]);
        steps.push(Step::new(&a));
    }
    match engine {
        "whisper" => pkgs(&mut steps, &["faster-whisper", "nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"]),
        "parakeet" => pkgs(&mut steps, &["onnx-asr[cpu,hub]"]),
        "vosk" => pkgs(&mut steps, &["vosk"]),
        "moonshine" => pkgs(&mut steps, &["moonshine-voice"]),
        "nemotron" => {
            steps.push(
                Step::new(&["install", "torch", "--index-url", "https://download.pytorch.org/whl/cu128"])
                    .with_fallback(&["install", "torch"]),
            );
            pkgs(&mut steps, &["transformers>=5.13.0", "accelerate"]);
        }
        _ => unreachable!(),
    }

    let mut server_args: Vec<String> = vec![
        "--engine".into(), engine.into(),
        "--port".into(), port.to_string(),
        "--parent-pid".into(), parent_pid.to_string(),
    ];
    if engine == "whisper" && !model.is_empty() {
        server_args.extend(["--model".into(), model.into()]);
    }
    if (engine == "vosk" || engine == "moonshine") && !language.is_empty() {
        server_args.extend(["--language".into(), language.into()]);
    }

    let key = if engine == "whisper" {
        format!("{}|{}|{}", engine, model, port)
    } else if engine == "vosk" || engine == "moonshine" {
        format!("{}|{}|{}", engine, language, port)
    } else {
        format!("{}|{}", engine, port)
    };

    Ok(Spec {
        key,
        data_dir: data_dir.to_path_buf(),
        env_name: engine.to_string(),
        script_source: script,
        steps,
        server_args,
        python_override: std::env::var("MOON_CURSES_PYTHON").ok().filter(|s| !s.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn builds_and_validates() {
        let d = PathBuf::from("/x");
        let s = build_spec(&d, "", "whisper", "small", "auto", 8765, 42).unwrap();
        assert!(s.server_args.join(" ").contains("--model small"));
        assert!(s.key.starts_with("whisper|small"));
        assert!(build_spec(&d, "", "evil; rm", "", "", 8765, 1).is_err());
        assert!(build_spec(&d, "", "whisper", "a b", "", 8765, 1).is_err());
        assert!(build_spec(&d, "", "vosk", "", "../x", 8765, 1).is_err());
        assert!(build_spec(&d, "", "vosk", "", "en-us", 80, 1).is_err());
        let n = build_spec(&d, "", "nemotron", "", "", 8765, 1).unwrap();
        assert_eq!(n.steps.len(), 3);
        assert!(n.steps[1].fallback.is_some());
        let v = build_spec(&d, "", "vosk", "", "fr", 8765, 1).unwrap();
        assert!(v.server_args.join(" ").contains("--language fr"));
        assert_ne!(v.key, build_spec(&d, "", "vosk", "", "en-us", 8765, 1).unwrap().key);
    }
}
