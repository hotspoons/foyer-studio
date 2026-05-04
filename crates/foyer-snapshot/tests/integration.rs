//! End-to-end snapshot integration tests.
//!
//! Two suites:
//!
//!   * Always-on: run `foyer_snapshot::plan(...)` against the
//!     `sessions/asdf` fixture and assert the resulting Dockerfile
//!     bakes in the env vars + layer ordering Ardour needs to boot
//!     headless. No Docker daemon required.
//!
//!   * Opt-in (`FOYER_SNAPSHOT_DOCKER_TEST=1`): run the same plan,
//!     hand the build context to `docker buildx`, and assert the
//!     image builds and `--version` runs inside it. Requires a
//!     working Docker daemon and an `--daw-exec` that points at a
//!     real Ardour install — so it's not on by default in CI.

use std::path::PathBuf;
use std::process::Command;

use foyer_snapshot::{oci, plan};

fn workspace_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .ancestors()
        .nth(2)
        .expect("workspace root above CARGO_MANIFEST_DIR")
        .to_path_buf()
}

fn asdf_fixture() -> PathBuf {
    workspace_root().join("sessions/asdf")
}

fn ardour_on_path() -> Option<PathBuf> {
    let out = Command::new("which").arg("ardour").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

#[tokio::test]
async fn dockerfile_carries_the_env_vars_ardour_needs_to_boot_headless() {
    // Skip when there's no Ardour to trace — devcontainer + CI both
    // ship one, but a fresh checkout on a developer's bare laptop
    // might not.
    let Some(daw) = ardour_on_path() else {
        eprintln!("[skip] no ardour on PATH; skipping integration test");
        return;
    };
    if !asdf_fixture().exists() {
        eprintln!(
            "[skip] {} missing; skipping integration test",
            asdf_fixture().display(),
        );
        return;
    }

    let plan = plan(&asdf_fixture(), Some(&daw))
        .await
        .expect("plan() against sessions/asdf fixture");

    // Layer ordering: wrapper → bin → syslibs → data → config →
    // user-config → plugins → project. Without this, the LD_LIBRARY_PATH
    // / ARDOUR_BACKEND_PATH env vars won't resolve at runtime.
    let layer_ids: Vec<&str> = plan.layers.iter().map(|l| l.id.as_str()).collect();
    let names_set: std::collections::HashSet<&&str> = layer_ids.iter().collect();
    assert!(
        names_set.contains(&"daw-bin"),
        "missing daw-bin layer: {layer_ids:?}"
    );
    assert!(
        names_set.contains(&"daw-data"),
        "missing daw-data layer: {layer_ids:?}",
    );
    assert!(
        names_set.contains(&"daw-config"),
        "missing daw-config layer: {layer_ids:?}",
    );

    // Headless boot env vars (set in lib.rs::plan and trace_daw).
    let runtime_keys: std::collections::HashSet<&str> =
        plan.runtime_env.iter().map(|(k, _)| k.as_str()).collect();
    assert!(
        runtime_keys.contains("ARDOUR_LOVES_STUPID_TINY_SCREENS"),
        "ARDOUR_LOVES_STUPID_TINY_SCREENS missing from runtime_env — Ardour will hang on its 'screen too small' modal in xvfb",
    );

    // Dockerfile generation.
    let tmp = tempfile::tempdir().expect("tempdir");
    let dockerfile = oci::emit_dockerfile(&plan, tmp.path()).expect("emit_dockerfile");
    let body = std::fs::read_to_string(&dockerfile).expect("read Dockerfile");

    // The base apt-install carries every package needed for GUI Ardour
    // to come up under xvfb — fontconfig, binutils (libbfd for nm),
    // xvfb itself, xauth (xvfb-run dep), GTK icon themes, gsettings
    // schemas, dbus-x11, shared-mime-info.
    for pkg in &[
        "fontconfig",
        "binutils",
        "xvfb",
        "xauth",
        "adwaita-icon-theme",
        "hicolor-icon-theme",
        "gsettings-desktop-schemas",
    ] {
        assert!(
            body.contains(pkg),
            "Dockerfile is missing apt package `{pkg}` — header excerpt:\n{}",
            &body[..body.len().min(800)],
        );
    }

    // Entrypoint must be xvfb-wrapped with a wide-enough virtual screen
    // so the "stupid tiny screens" gate stays silent.
    assert!(
        body.contains("xvfb-run") && body.contains("1920x1080"),
        "Dockerfile entrypoint is not xvfb-wrapped at 1920x1080: {body}",
    );

    // Headless-boot env vars baked in.
    assert!(
        body.contains("ARDOUR_LOVES_STUPID_TINY_SCREENS"),
        "Dockerfile missing ARDOUR_LOVES_STUPID_TINY_SCREENS env",
    );
    assert!(
        body.contains("ARDOUR_BACKEND_PATH"),
        "Dockerfile missing ARDOUR_BACKEND_PATH env",
    );
}

#[tokio::test]
async fn opt_in_docker_build_smoke() {
    if std::env::var("FOYER_SNAPSHOT_DOCKER_TEST").as_deref() != Ok("1") {
        eprintln!("[skip] FOYER_SNAPSHOT_DOCKER_TEST != 1; skipping docker build smoke");
        return;
    }
    let Some(daw) = ardour_on_path() else {
        panic!("FOYER_SNAPSHOT_DOCKER_TEST=1 but no ardour on PATH");
    };

    let plan = plan(&asdf_fixture(), Some(&daw)).await.expect("plan");

    let tmp = tempfile::tempdir().expect("tempdir");
    oci::emit_dockerfile(&plan, tmp.path()).expect("emit_dockerfile");

    // Use `FOYER_DOCKER` for the same reason production CI does:
    // dev-container Docker socket commonly requires `sudo`.
    let cmd_str = std::env::var("FOYER_DOCKER").unwrap_or_else(|_| "docker".to_string());
    let mut parts = cmd_str.split_whitespace();
    let bin = parts.next().expect("FOYER_DOCKER non-empty");
    let mut cmd = Command::new(bin);
    for arg in parts {
        cmd.arg(arg);
    }
    let status = cmd
        .args(["buildx", "build", "--tag", "foyer-snapshot-itest:latest"])
        .arg(tmp.path())
        .status()
        .expect("spawn docker buildx build");
    assert!(status.success(), "docker buildx build failed");

    // Run --version inside the image. Anything else (loading the
    // session, opening the GUI under xvfb) is too sensitive to host
    // GTK quirks to assert in a bare smoke; the unit-shaped test
    // above covers the env+entrypoint contract instead.
    let mut cmd = Command::new(bin);
    for arg in cmd_str.split_whitespace().skip(1) {
        cmd.arg(arg);
    }
    let out = cmd
        .args(["run", "--rm", "foyer-snapshot-itest:latest", "--version"])
        .output()
        .expect("spawn docker run");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success(),
        "docker run --version failed: stdout={stdout} stderr={stderr}",
    );
    assert!(
        stdout.contains("Ardour") || stderr.contains("Ardour"),
        "Ardour banner missing from --version output: stdout={stdout} stderr={stderr}",
    );
}
