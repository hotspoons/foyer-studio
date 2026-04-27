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
