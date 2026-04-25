// Resolve the path `include_dir!` bakes into the binary at the
// `BUNDLED_WEB` static. Precedence:
//
//   1. `FOYER_BUNDLED_WEB` env var (absolute or relative — treated
//      as literal). Someone shipping a derived `foyer` binary points
//      this at their staged tree at build time.
//   2. `$CARGO_MANIFEST_DIR/../../web` — the main repo's shipping
//      UI, which every untouched build wants.
//
// We emit the resolved path back out as a rustc env so the
// `include_dir!("$FOYER_BUNDLED_WEB")` call in main.rs picks it up.
// `rerun-if-env-changed` means flipping the env var forces a
// rebuild; `rerun-if-changed` on the resolved directory catches
// asset edits that aren't touched by a cargo source change.

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let resolved = match std::env::var("FOYER_BUNDLED_WEB") {
        Ok(path) if !path.is_empty() => path,
        _ => format!("{manifest_dir}/../../web"),
    };
    println!("cargo:rustc-env=FOYER_BUNDLED_WEB={resolved}");
    println!("cargo:rerun-if-env-changed=FOYER_BUNDLED_WEB");
    // Watching the entire web/ tree forces a relink on every JS edit.
    // That matters for `cargo build --release` (the bundle has to be
    // accurate to ship), but for dev runs we serve `--web-root web`
    // straight off disk and the bundled copy is never read. Skip the
    // watcher in debug to keep `just run` cheap. Set
    // FOYER_BUNDLE_WATCH_DEBUG=1 to opt back in if you're testing the
    // bundle path locally.
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let force_watch = std::env::var("FOYER_BUNDLE_WATCH_DEBUG")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false);
    if profile != "debug" || force_watch {
        println!("cargo:rerun-if-changed={resolved}");
    }
    println!("cargo:rerun-if-env-changed=FOYER_BUNDLE_WATCH_DEBUG");
}
