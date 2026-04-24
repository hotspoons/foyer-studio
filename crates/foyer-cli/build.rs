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
    println!("cargo:rerun-if-changed={resolved}");
}
