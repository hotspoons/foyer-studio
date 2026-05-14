// Resolve the path `include_dir!` bakes into the binary at the
// `BUNDLED_WEB` static.
//
// Precedence at release / opt-in time:
//   1. `FOYER_BUNDLED_WEB` env var (absolute or relative — treated
//      as literal). Someone shipping a derived `foyer` binary points
//      this at their staged tree at build time.
//   2. `$CARGO_MANIFEST_DIR/../../web` — the main repo's shipping
//      UI, which every untouched release build wants.
//
// Debug builds use an EMPTY STUB directory under `OUT_DIR` instead.
// Why: `include_dir!` expands to a tree of `include_bytes!` calls,
// and `include_bytes!` is a compiler builtin that auto-tracks every
// file it reads as a cargo build input. That tracking happens INSIDE
// the proc-macro expansion, *bypassing* whatever rerun-if-changed
// instructions this build.rs emits. Result: editing any JS file
// makes cargo think foyer-cli is dirty and triggers a 20+ second
// rebuild — not what you want during `just run`-and-reload-browser
// loops. We sidestep it by pointing `include_dir!` at an empty dir
// in debug. Dev runs use `--web-root web` anyway (the embedded
// bundle is never read), so the stub costs nothing.
//
// Opt back in for debug: `FOYER_BUNDLE_WATCH_DEBUG=1` makes debug
// behave like release (real `web/`, real per-file tracking). Set
// this when testing the extract-on-first-run code path.

use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let env_override = std::env::var("FOYER_BUNDLED_WEB")
        .ok()
        .filter(|s| !s.is_empty());
    let force_watch = std::env::var("FOYER_BUNDLE_WATCH_DEBUG")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false);
    let want_real_bundle = profile != "debug" || force_watch || env_override.is_some();

    let resolved = if want_real_bundle {
        env_override.unwrap_or_else(|| format!("{manifest_dir}/../../web"))
    } else {
        // Materialize an empty stub once per OUT_DIR. The presence of
        // a single sentinel file is fine for include_dir; what matters
        // is that none of the real web/ files end up tracked.
        let stub = PathBuf::from(&out_dir).join("foyer-web-stub");
        std::fs::create_dir_all(&stub).expect("create stub dir");
        let sentinel = stub.join(".gitkeep");
        if !sentinel.exists() {
            std::fs::write(&sentinel, b"").expect("write stub sentinel");
        }
        stub.to_string_lossy().into_owned()
    };

    // Hash the bundle contents so the runtime can detect when the
    // binary's embedded UI is newer than whatever's already been
    // extracted to `$XDG_DATA_HOME/foyer/web/`. Without this stamp,
    // upgrading the binary leaves users on the old extracted tree
    // (Rich's bug, 2026-04-28: `--latest-ci` install on macOS still
    // served yesterday's UI). Hash is FNV-1a 64-bit over (relative
    // path + content) for every file in the bundle, walked in sorted
    // order so it's stable across hosts. Cheap to compute, no extra
    // build deps.
    let stamp = if want_real_bundle {
        hash_bundle(Path::new(&resolved))
    } else {
        // Stub bundle is empty by design; pin a constant so the
        // runtime sees "no real bundle, never re-extract".
        0
    };
    println!("cargo:rustc-env=FOYER_BUNDLED_WEB={resolved}");
    println!("cargo:rustc-env=FOYER_BUNDLED_WEB_STAMP={stamp:016x}");
    println!("cargo:rerun-if-env-changed=FOYER_BUNDLED_WEB");
    println!("cargo:rerun-if-env-changed=FOYER_BUNDLE_WATCH_DEBUG");
    // Belt-and-braces: ask cargo to re-run this script on web/ tree
    // changes for release builds so the embedded bundle is accurate.
    // Debug + stub doesn't need the watcher — the stub never changes.
    if want_real_bundle {
        println!("cargo:rerun-if-changed={resolved}");
    }

    // Hard-coded Ardour version that the embedded shim was built
    // against. Override via `FOYER_ARDOUR_VERSION=9.3` at build time
    // when the shim is rebuilt for a new Ardour. The runtime checks
    // this against the installed Ardour's reported version and
    // warns on mismatch (the surfaces ABI is version-sensitive).
    // Resolved before the shim block so the default install path
    // can derive the major-version folder name (`ardour9/`, etc.).
    let ardour_version = std::env::var("FOYER_ARDOUR_VERSION").unwrap_or_else(|_| "9.2".into());
    let ardour_major = ardour_version
        .split('.')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("9")
        .to_string();
    println!("cargo:rustc-env=FOYER_ARDOUR_VERSION={ardour_version}");
    println!("cargo:rerun-if-env-changed=FOYER_ARDOUR_VERSION");

    // ── Ardour shim embed ───────────────────────────────────────────
    // The shim is a `.so` (or `.dylib` on macOS) built out-of-band by
    // `shims/ardour`'s CMake; this build script only reads the
    // resulting blob and bakes it into the binary so a single-file
    // release can self-install into Ardour's surfaces dir.
    //
    // Source resolution:
    //   1. `FOYER_BUNDLED_SHIM` env var — release pipelines / CI /
    //      custom builds point at an artifact wherever it lives.
    //   2. The user's Ardour surfaces dir — same path Ardour itself
    //      reads from at runtime, and where `scripts/dev/shim.sh
    //      install` puts the file. The dev loop is "build shim →
    //      install into surfaces → cargo embeds the just-installed
    //      copy → runtime re-installs from the embed (no-op when
    //      the stamps match)." One canonical location, no
    //      dev-tree-layout assumptions.
    //   3. Otherwise → empty stub. The runtime preflight refuses
    //      `--backend ardour` and tells the user how to fix it.
    //      CI matrices that build the sidecar without the C++ shim
    //      hit this path, as does anyone running `--backend stub`.
    //
    // The explicit-env-var path warns on a missing file (the user
    // asked for a specific blob and we couldn't honor it). The
    // default path is quiet — "no installed shim, building a stub"
    // is the normal state for sidecar-only contributors.
    let shim_env_override = std::env::var("FOYER_BUNDLED_SHIM")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let shim_default = default_shim_install_path(&ardour_major);
    let (shim_input_path, shim_input_explicit) = match &shim_env_override {
        Some(p) => (Some(p.clone()), true),
        None => (shim_default, false),
    };

    let shim_blob_path: PathBuf;
    let shim_present: bool;
    let shim_stamp: u64;
    if let Some(shim_input_path) = shim_input_path.as_ref().filter(|p| p.is_file()) {
        // Real shim — copy into OUT_DIR so include_bytes! has a
        // stable path even if the source moves between rebuilds.
        let dst = PathBuf::from(&out_dir).join("libfoyer_shim.blob");
        let bytes = std::fs::read(shim_input_path).expect("read shim");
        std::fs::write(&dst, &bytes).expect("write shim blob");
        shim_stamp = hash_bytes(&bytes);
        shim_blob_path = dst;
        shim_present = true;
        println!("cargo:rerun-if-changed={}", shim_input_path.display());
    } else {
        if let (true, Some(missing)) = (shim_input_explicit, shim_input_path.as_ref()) {
            // User explicitly pointed at a file that doesn't exist —
            // surface it instead of silently building a stub. The
            // default-path miss is normal (sidecar dev without a
            // built shim) so stays quiet.
            println!(
                "cargo:warning=FOYER_BUNDLED_SHIM points at {}, which is not a file — building a stub (preflight will refuse --backend ardour)",
                missing.display()
            );
        }
        // Stub: zero-byte file so include_bytes! still compiles, and
        // the runtime treats `shim_present == false` as "no embedded
        // shim, refuse to start with backend=ardour and tell user
        // where to put one."
        let stub = PathBuf::from(&out_dir).join("libfoyer_shim.empty");
        if !stub.exists() {
            std::fs::write(&stub, b"").expect("write empty shim stub");
        }
        shim_blob_path = stub;
        shim_present = false;
        shim_stamp = 0;
    }
    println!(
        "cargo:rustc-env=FOYER_BUNDLED_SHIM_PATH={}",
        shim_blob_path.display()
    );
    println!(
        "cargo:rustc-env=FOYER_BUNDLED_SHIM_PRESENT={}",
        if shim_present { "1" } else { "0" },
    );
    println!("cargo:rustc-env=FOYER_BUNDLED_SHIM_STAMP={shim_stamp:016x}");
    println!("cargo:rerun-if-env-changed=FOYER_BUNDLED_SHIM");
    // The default install location depends on $HOME / $XDG_CONFIG_HOME;
    // ask cargo to rebuild when those change so the embedded blob
    // refreshes if the user moves their Ardour config dir.
    println!("cargo:rerun-if-env-changed=HOME");
    println!("cargo:rerun-if-env-changed=XDG_CONFIG_HOME");
}

/// Mirrors `shim_install::ardour_surfaces_dir`'s logic at build time
/// so the build script reads the same `.so` the runtime would
/// reinstall. Returns `None` if `$HOME` is unset (cross-compilation
/// sandboxes, hermetic CI, etc.) — caller falls through to the empty
/// stub.
fn default_shim_install_path(ardour_major: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let surfaces_dir = if cfg!(target_os = "macos") {
        home.join("Library/Preferences")
            .join(format!("Ardour{ardour_major}"))
            .join("surfaces")
    } else {
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        xdg.join(format!("ardour{ardour_major}")).join("surfaces")
    };
    let ext = if cfg!(target_os = "macos") {
        "dylib"
    } else {
        "so"
    };
    Some(surfaces_dir.join(format!("libfoyer_shim.{ext}")))
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// FNV-1a 64-bit over the bundle's contents. Walks the tree in sorted
/// order so the output is reproducible between builds on different
/// machines as long as the source tree matches.
fn hash_bundle(root: &Path) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut entries: Vec<PathBuf> = Vec::new();
    collect_files(root, root, &mut entries);
    entries.sort();
    for rel in &entries {
        let abs = root.join(rel);
        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Mix in the relative path so a rename changes the hash.
        for b in rel.to_string_lossy().as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x100000001b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x100000001b3);
        for b in &bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        let p = entry.path();
        // Skip Tailwind's build output — it's a regen artifact, not
        // part of the source-of-truth bundle, and on dev machines its
        // mtime constantly churns.
        if p.file_name()
            .is_some_and(|n| n == "node_modules" || n == ".DS_Store")
        {
            continue;
        }
        if p.is_dir() {
            collect_files(root, &p, out);
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
}
