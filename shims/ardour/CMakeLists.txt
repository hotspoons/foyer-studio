# Out-of-tree build for `libfoyer_shim.so`.
#
# The Ardour-canonical way to build a control surface today is to drop
# the source directory under `libs/surfaces/<name>/` in Ardour's own
# source tree and let its `waf` pick it up. That forces every
# third-party surface author to:
#   1. Fork or patch Ardour's source tree (the `libs/surfaces/wscript`
#      children list),
#   2. Rebuild the whole DAW to land the surface,
#   3. Ship either a modified Ardour binary OR rely on the end user to
#      recompile Ardour themselves.
#
# That's operationally painful for us and (crucially) bad for Ardour's
# own commercial model — a pre-built patched Ardour fork bypasses the
# demo-timer on paid distributions.
#
# This CMake file builds the shim *alongside* a standard Ardour install
# without touching a single file in Ardour's source tree. The resulting
# `libfoyer_shim.so` drops into any directory on `ARDOUR_SURFACES_PATH`
# and gets `dlopen`'d at startup exactly like Mackie / OSC / Generic
# MIDI. See docs/PROPOSAL-surface-auto-discovery.md for the upstream
# proposal that makes this story first-class.
#
# License note: the resulting `.so` links `libardour` / `libpbd` etc.
# and is GPLv2+ per Ardour's license. That's by design and contained
# to this directory — everything else in Foyer Studio
# (crates/**, web/**) sits above a documented IPC boundary and ships
# under non-GPL terms.
#
# ── Build requirements ─────────────────────────────────────────
#
#   * C++17 compiler (g++ 11+ or clang 15+).
#   * A built Ardour source tree — for now, headers come from
#     <source>/libs/*/ and built libraries come from <source>/build/
#     libs/*/. Once Ardour ships `ardour-surface.pc` upstream (see
#     the proposal), switch `FOYER_ARDOUR_SOURCE` to `find_package
#     (Ardour REQUIRED)` and go on your way.
#   * `pkg-config` for glibmm / sigc++ / libxml2.
#
# ── Configure ──────────────────────────────────────────────────
#
#   cmake -S shims/ardour -B shims/ardour/build \
#         -DFOYER_ARDOUR_SOURCE=/path/to/ardour \
#         -DCMAKE_BUILD_TYPE=RelWithDebInfo
#
# If you omit `-DFOYER_ARDOUR_SOURCE` the build uses the
# `$FOYER_ARDOUR_BUILD_ROOT` environment variable (default:
# /workspaces/ardour).
#
# ── Install ────────────────────────────────────────────────────
#
# `cmake --install shims/ardour/build --prefix=~/.config/ardour9`
# drops the library at `~/.config/ardour9/surfaces/libfoyer_shim.so`,
# which Ardour scans via `ARDOUR_SURFACES_PATH`. Or set the env var
# yourself:
#
#   ARDOUR_SURFACES_PATH=shims/ardour/build:$ARDOUR_SURFACES_PATH ardour

cmake_minimum_required(VERSION 3.22)
project(foyer_shim CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Locate the Ardour source tree. We need BOTH headers (under libs/*/)
# and built libraries (under build/libs/*/). Resolution order:
#   1. `-DFOYER_ARDOUR_SOURCE=/abs/path/to/ardour` — explicit CMake override.
#   2. `$FOYER_ARDOUR_BUILD_ROOT` — env var, same semantics.
#   3. `<repo>/ext/ardour`                — in-repo convention (gitignored).
#   4. `/workspaces/ardour`               — legacy sibling-workspace layout.
#
# The in-repo `ext/ardour` is the documented location; the legacy
# path stays as a fallback so existing workstations (Rich's colima
# checkout, CI images that bind-mount ardour) keep working until
# they migrate.
if(NOT DEFINED FOYER_ARDOUR_SOURCE)
  if(DEFINED ENV{FOYER_ARDOUR_BUILD_ROOT})
    set(FOYER_ARDOUR_SOURCE "$ENV{FOYER_ARDOUR_BUILD_ROOT}")
  else()
    set(_foyer_repo_ardour "${CMAKE_CURRENT_SOURCE_DIR}/../../ext/ardour")
    if(IS_DIRECTORY "${_foyer_repo_ardour}")
      set(FOYER_ARDOUR_SOURCE "${_foyer_repo_ardour}")
    else()
      set(FOYER_ARDOUR_SOURCE "/workspaces/ardour")
    endif()
  endif()
endif()
if(NOT IS_DIRECTORY "${FOYER_ARDOUR_SOURCE}")
  message(FATAL_ERROR
    "Ardour source tree not found at '${FOYER_ARDOUR_SOURCE}'. "
    "Pass -DFOYER_ARDOUR_SOURCE=/path/to/ardour or set "
    "FOYER_ARDOUR_BUILD_ROOT in the environment.")
endif()

set(ARDOUR_BUILD_DIR "${FOYER_ARDOUR_SOURCE}/build")
if(NOT IS_DIRECTORY "${ARDOUR_BUILD_DIR}")
  message(FATAL_ERROR
    "Ardour hasn't been built yet — '${ARDOUR_BUILD_DIR}' missing. "
    "Run `cd ${FOYER_ARDOUR_SOURCE} && python3 waf configure --optimize && python3 waf build` first.")
endif()

message(STATUS "Foyer shim: building against Ardour source at ${FOYER_ARDOUR_SOURCE}")

# ── Ardour include tree ────────────────────────────────────────
#
# Keep these matching the `#include` statements actually used in the
# shim source. Anything missing here shows up as "fatal error: no
# such file or directory" at compile time.
set(ARDOUR_INCLUDES
  "${FOYER_ARDOUR_SOURCE}/libs/ardour"
  "${FOYER_ARDOUR_SOURCE}/libs/pbd"
  "${FOYER_ARDOUR_SOURCE}/libs/temporal"
  "${FOYER_ARDOUR_SOURCE}/libs/evoral"
  "${FOYER_ARDOUR_SOURCE}/libs/ctrl-interface/control_protocol"
  "${FOYER_ARDOUR_SOURCE}/libs/lua"
  "${FOYER_ARDOUR_SOURCE}/libs/ptformat"
  "${FOYER_ARDOUR_SOURCE}/libs/midi++2"
  "${FOYER_ARDOUR_SOURCE}/libs/audiographer"
  "${FOYER_ARDOUR_SOURCE}/libs/vamp-sdk"
  # ltc.h lives in libs/libltc/ltc/ but is included as `<ltc.h>` by
  # ardour/session.h, so we need the inner `ltc/` dir too.
  "${FOYER_ARDOUR_SOURCE}/libs/libltc/ltc"
  "${FOYER_ARDOUR_SOURCE}/libs/libltc"
  "${FOYER_ARDOUR_SOURCE}/libs/fst"
  # zita-resampler/vmresampler.h is included by ardour/audio_port.h
  "${FOYER_ARDOUR_SOURCE}/libs/zita-resampler"
)

# ── System dependencies ────────────────────────────────────────
find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIBMM  REQUIRED IMPORTED_TARGET glibmm-2.4)
pkg_check_modules(SIGCPP  REQUIRED IMPORTED_TARGET sigc++-2.0)
pkg_check_modules(LIBXML2 REQUIRED IMPORTED_TARGET libxml-2.0)
pkg_check_modules(SNDFILE REQUIRED IMPORTED_TARGET sndfile)

# ── Homebrew prefix on macOS ───────────────────────────────────
#
# Ardour's headers `#include <boost/...>` and other system libs that
# Apple's clang doesn't auto-add to the include path (unlike Linux,
# where apt's `libboost-dev` writes headers under /usr/include/).
# Surface Homebrew's prefix explicitly so headers like
# `boost/bind/protect.hpp` resolve against `/opt/homebrew/include/`
# (Apple Silicon) or `/usr/local/include/` (Intel).
if(APPLE)
  execute_process(
    COMMAND brew --prefix
    OUTPUT_VARIABLE FOYER_BREW_PREFIX
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE FOYER_BREW_RESULT)
  if(FOYER_BREW_RESULT EQUAL 0 AND IS_DIRECTORY "${FOYER_BREW_PREFIX}/include")
    message(STATUS "Foyer shim: Homebrew include dir → ${FOYER_BREW_PREFIX}/include")
    list(APPEND FOYER_BREW_INCLUDES "${FOYER_BREW_PREFIX}/include")
  endif()

  # Keg-only formulas don't symlink into ${FOYER_BREW_PREFIX}/include —
  # their headers stay under each formula's own prefix. The shim
  # transitively includes Ardour's libpbd/file_archive.h, which does
  # `#include <archive.h>` — that header lives at
  # `$(brew --prefix libarchive)/include/archive.h`. Without this
  # explicit lookup, the shim build fails on macOS with
  # "fatal error: 'archive.h' file not found" even when libarchive is
  # installed. Add additional formulas to KEG_ONLY_FORMULAS as we hit
  # them.
  set(KEG_ONLY_FORMULAS libarchive)
  foreach(formula IN LISTS KEG_ONLY_FORMULAS)
    execute_process(
      COMMAND brew --prefix ${formula}
      OUTPUT_VARIABLE _formula_prefix
      OUTPUT_STRIP_TRAILING_WHITESPACE
      RESULT_VARIABLE _formula_result
      ERROR_QUIET)
    if(_formula_result EQUAL 0 AND IS_DIRECTORY "${_formula_prefix}/include")
      message(STATUS "Foyer shim: keg-only ${formula} include → ${_formula_prefix}/include")
      list(APPEND FOYER_BREW_INCLUDES "${_formula_prefix}/include")
    endif()
  endforeach()
endif()

# ── Ardour library search ──────────────────────────────────────
#
# We link against Ardour's shared libraries WITHOUT requiring a full
# Ardour source build. Two locations are checked, in order:
#
#   1. `<source>/build/libs/<reldir>/lib<name>.so` — the in-tree
#      build path. Used when the user has run `python3 waf build` in
#      the Ardour source tree (the historic dev workflow).
#   2. System install paths under `/usr/lib/ardour9/` and
#      `/usr/lib/<arch>/ardour9/` — used when Ardour was apt-installed
#      from Debian (sid's `ardour` package, version 9.2.0+ds, lays its
#      private libs out at `/usr/lib/ardour9/lib<name>.so.X.Y.Z` with
#      SONAME-style symlinks). This is what the runtime image uses
#      now: ~30s `waf configure` for headers, no full Ardour build.
#
# The `<source>/build/libs/<reldir>/lib<name>.so.0` SONAME files are
# preferred when present so an in-tree build always wins (you may have
# made local changes). Apt fallback kicks in for the dev-container's
# minimum-build path and the runtime image build.
function(foyer_find_ardour_lib var libname reldir)
  find_library(${var}
    NAMES ${libname}
    HINTS
      "${ARDOUR_BUILD_DIR}/libs/${reldir}"
      "/usr/lib/ardour9"
    PATH_SUFFIXES ardour9
    REQUIRED)
  message(STATUS "Foyer shim: ${libname} → ${${var}}")
endfunction()

foyer_find_ardour_lib(ARDOUR_LIB     ardour    ardour)
foyer_find_ardour_lib(ARDOURCP_LIB   ardourcp  ctrl-interface/control_protocol)
foyer_find_ardour_lib(PBD_LIB        pbd       pbd)
foyer_find_ardour_lib(TEMPORAL_LIB   temporal  temporal)
foyer_find_ardour_lib(EVORAL_LIB     evoral    evoral)
foyer_find_ardour_lib(MIDIPP_LIB     midipp    midi++2)

# ── The shim itself ────────────────────────────────────────────
add_library(foyer_shim SHARED
  src/interface.cc
  src/surface.cc
  src/signal_bridge.cc
  src/ipc.cc
  src/dispatch.cc
  src/schema_map.cc
  src/msgpack_out.cc
  src/master_tap.cc
  src/ingress_tick.cc
  src/shim_input_port.cc
  src/shim_midi_input_port.cc
  src/session_uuid.cc
  src/crash_dialog_handler.cc
)

# Match the wscript: PACKAGE macro + DLL-export define for portability
# across MSVC / mingw. Harmless on Linux.
#
# WAF_BUILD is LOAD-BEARING. Ardour's headers (session.h line 34, and
# many others) guard `#include "libardour-config.h"` behind
# `#ifdef WAF_BUILD`. Without this define, config.h is NOT pulled in,
# so flags like USE_TLSF, LV2_SUPPORT, VST3_SUPPORT, etc. stay
# undefined when we compile. The headers themselves have
# `#ifdef USE_TLSF` blocks that pick different types / member layouts
# — without the flag, OUR Session struct has different offsets than
# the one libardour.so was built with. Reads of members like `routes`
# actually dereference garbage memory → SIGSEGV in `RCUManager::reader`
# (you see `managed_object == nullptr` because you're reading from
# the wrong struct offset entirely). Every "RCU crash" we chased for
# the past six hours traces back here. Define WAF_BUILD to force the
# config header include; match flags to what Ardour itself was built
# with.
target_compile_definitions(foyer_shim PRIVATE
  PACKAGE="foyer_shim"
  ARDOURSURFACE_DLL_EXPORTS
  WAF_BUILD
)

# Match Ardour's own build: silence the GLib-2.62-deprecated noise
# (`GTimeVal`, etc.) that Ardour's vendored ydk/ytk/ydkmm headers
# emit on every Ardour-header include. Ardour upstream lives with
# this; we don't fix it — just don't drown the build log in it.
target_compile_options(foyer_shim PRIVATE -Wno-deprecated-declarations)

target_include_directories(foyer_shim PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${ARDOUR_INCLUDES}
)

# macOS only: surface the Homebrew include dir so boost (and any
# other brew-installed system headers Ardour pulls in transitively)
# resolves. No-op on Linux where /usr/include is on the default
# system path.
if(FOYER_BREW_INCLUDES)
  target_include_directories(foyer_shim PRIVATE ${FOYER_BREW_INCLUDES})
endif()

# Ardour's build-tree configurator writes generated headers (e.g.
# ardour/debug.h macro expansions) into the build dir. Pick those up
# so our compile matches Ardour's own.
target_include_directories(foyer_shim PRIVATE
  "${ARDOUR_BUILD_DIR}/libs/ardour"
  "${ARDOUR_BUILD_DIR}/libs/pbd"
)

target_link_libraries(foyer_shim PRIVATE
  ${ARDOUR_LIB}
  ${ARDOURCP_LIB}
  ${PBD_LIB}
  ${TEMPORAL_LIB}
  ${EVORAL_LIB}
  ${MIDIPP_LIB}
  PkgConfig::GLIBMM
  PkgConfig::SIGCPP
  PkgConfig::LIBXML2
  PkgConfig::SNDFILE
)

# Output a clean `libfoyer_shim.so` with no lib prefix nested extra
# directory — Ardour's path scan takes the file as-is.
set_target_properties(foyer_shim PROPERTIES
  OUTPUT_NAME foyer_shim
  PREFIX "lib"
  # rpath so the produced .so can find the sibling-tree's Ardour libs
  # at runtime without the user setting LD_LIBRARY_PATH. When Ardour
  # itself loads the .so the host's own libs already resolve; this is
  # belt-and-braces for direct dlopen testing.
  INSTALL_RPATH "${ARDOUR_BUILD_DIR}/libs/ardour;${ARDOUR_BUILD_DIR}/libs/pbd;${ARDOUR_BUILD_DIR}/libs/temporal;${ARDOUR_BUILD_DIR}/libs/evoral;${ARDOUR_BUILD_DIR}/libs/ctrl-interface/control_protocol;${ARDOUR_BUILD_DIR}/libs/midi++2"
  BUILD_WITH_INSTALL_RPATH TRUE
)

# ── The Foyer Dummy audio backend ──────────────────────────────
#
# A vendored fork of Ardour's `None (Dummy)` backend with the
# absolute-time-sleep timing fix baked in (search
# `_target_cycle_us` in backends/dummy/dummy_audiobackend.cc for
# the rationale). Lives here so Foyer can run against an
# UNMODIFIED Ardour 9.x build — Debian package, AppImage, official
# .deb — instead of needing the upstream source patched.
#
# Ardour discovers it the same way it discovers stock backends:
# scans `ARDOUR_BACKEND_PATH` for `lib*_audiobackend.so`, calls
# `descriptor()` on each, registers the AudioBackendInfo with
# AudioEngine. The runtime entrypoint prepends Foyer's install
# dir to `ARDOUR_BACKEND_PATH` so Ardour finds OUR backend
# alongside the stock ones; the seeded AMS state asks for
# "Foyer Dummy" by name so the autostart picks it.
add_library(foyer_audiobackend SHARED
  backends/dummy/dummy_audiobackend.cc
)
target_compile_definitions(foyer_audiobackend PRIVATE
  PACKAGE="foyer_audiobackend"
  ARDOURBACKEND_DLL_EXPORTS
  WAF_BUILD
)
target_compile_options(foyer_audiobackend PRIVATE -Wno-deprecated-declarations)
target_include_directories(foyer_audiobackend PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/backends/dummy
  ${ARDOUR_INCLUDES}
  "${ARDOUR_BUILD_DIR}/libs/ardour"
  "${ARDOUR_BUILD_DIR}/libs/pbd"
)
if(FOYER_BREW_INCLUDES)
  target_include_directories(foyer_audiobackend PRIVATE ${FOYER_BREW_INCLUDES})
endif()
# libltc: prefer apt's `libltc-dev` (libltc.so on system path) when
# present; fall back to the in-tree static archive `liblibltc.a` from
# a full Ardour source build. The Dummy backend uses libltc for the
# LTC timecode test-tone generator option.
find_library(LTC_LIB
  NAMES ltc libltc
  HINTS
    "${ARDOUR_BUILD_DIR}/libs/libltc"
    /usr/lib /usr/lib/x86_64-linux-gnu /usr/lib/aarch64-linux-gnu)
if(NOT LTC_LIB)
  message(FATAL_ERROR
    "libltc not found. Either run a full Ardour source build, or "
    "`apt install libltc-dev` for the system-installed version.")
endif()
message(STATUS "Foyer shim: libltc → ${LTC_LIB}")
target_link_libraries(foyer_audiobackend PRIVATE
  ${ARDOUR_LIB}
  ${PBD_LIB}
  ${TEMPORAL_LIB}
  ${EVORAL_LIB}
  ${LTC_LIB}
  PkgConfig::GLIBMM
  PkgConfig::SIGCPP
  PkgConfig::LIBXML2
)
set_target_properties(foyer_audiobackend PROPERTIES
  OUTPUT_NAME foyer_audiobackend
  PREFIX "lib"
  INSTALL_RPATH "${ARDOUR_BUILD_DIR}/libs/ardour;${ARDOUR_BUILD_DIR}/libs/pbd;${ARDOUR_BUILD_DIR}/libs/temporal;${ARDOUR_BUILD_DIR}/libs/evoral;${ARDOUR_BUILD_DIR}/libs/libltc"
  BUILD_WITH_INSTALL_RPATH TRUE
)

# ── Install ────────────────────────────────────────────────────
#
# Install prefix convention: ${CMAKE_INSTALL_PREFIX}/surfaces/ for
# the shim, ${CMAKE_INSTALL_PREFIX}/backends/ for the audio
# backend. Users typically point Ardour at `~/.config/ardour9` so
# passing `--prefix=$HOME/.config/ardour9` lands files at the
# right places under that root — scanned by Ardour's default
# `ARDOUR_SURFACES_PATH` / `ARDOUR_BACKEND_PATH`.
install(TARGETS foyer_shim
  LIBRARY DESTINATION surfaces)
install(TARGETS foyer_audiobackend
  LIBRARY DESTINATION backends)

message(STATUS "")
message(STATUS "Foyer shim + backend build configured.")
message(STATUS "  Source:  ${CMAKE_CURRENT_SOURCE_DIR}/src + ${CMAKE_CURRENT_SOURCE_DIR}/backends")
message(STATUS "  Outputs: ${CMAKE_BINARY_DIR}/libfoyer_shim.so")
message(STATUS "           ${CMAKE_BINARY_DIR}/libfoyer_audiobackend.so")
message(STATUS "  Ardour:  ${FOYER_ARDOUR_SOURCE}")
message(STATUS "")
message(STATUS "After building, point Ardour at both:")
message(STATUS "  ARDOUR_SURFACES_PATH=${CMAKE_BINARY_DIR}:\$ARDOUR_SURFACES_PATH \\")
message(STATUS "  ARDOUR_BACKEND_PATH=${CMAKE_BINARY_DIR}:\$ARDOUR_BACKEND_PATH ardour")
message(STATUS "")
