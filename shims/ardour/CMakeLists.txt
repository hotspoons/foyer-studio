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
# and built libraries (under build/libs/*/). Allow override via:
#   - `-DFOYER_ARDOUR_SOURCE=/abs/path/to/ardour`
#   - `$FOYER_ARDOUR_BUILD_ROOT` env var
#   - default `/workspaces/ardour` (matches the dev container).
if(NOT DEFINED FOYER_ARDOUR_SOURCE)
  if(DEFINED ENV{FOYER_ARDOUR_BUILD_ROOT})
    set(FOYER_ARDOUR_SOURCE "$ENV{FOYER_ARDOUR_BUILD_ROOT}")
  else()
    set(FOYER_ARDOUR_SOURCE "/workspaces/ardour")
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
)

# ── System dependencies ────────────────────────────────────────
find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIBMM  REQUIRED IMPORTED_TARGET glibmm-2.4)
pkg_check_modules(SIGCPP  REQUIRED IMPORTED_TARGET sigc++-2.0)
pkg_check_modules(LIBXML2 REQUIRED IMPORTED_TARGET libxml-2.0)

# ── Ardour library search ──────────────────────────────────────
#
# Find each shared library the shim links against. The locations come
# from Ardour 9.2's waf layout (`build/libs/<project>/lib<name>.so`).
# If the layout changes upstream, update the HINTS below.
function(foyer_find_ardour_lib var libname reldir)
  find_library(${var}
    NAMES ${libname}
    HINTS "${ARDOUR_BUILD_DIR}/libs/${reldir}"
    NO_DEFAULT_PATH
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

target_include_directories(foyer_shim PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${ARDOUR_INCLUDES}
)

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

# ── Install ────────────────────────────────────────────────────
#
# Install prefix convention: ${CMAKE_INSTALL_PREFIX}/surfaces/.
# Users typically point Ardour at `~/.config/ardour9` so passing
# `--prefix=$HOME/.config/ardour9` lands the shim at
# `~/.config/ardour9/surfaces/libfoyer_shim.so` — scanned by Ardour's
# default `ARDOUR_SURFACES_PATH`.
install(TARGETS foyer_shim
  LIBRARY DESTINATION surfaces)

message(STATUS "")
message(STATUS "Foyer shim build configured.")
message(STATUS "  Source:  ${CMAKE_CURRENT_SOURCE_DIR}/src")
message(STATUS "  Output:  ${CMAKE_BINARY_DIR}/libfoyer_shim.so")
message(STATUS "  Ardour:  ${FOYER_ARDOUR_SOURCE}")
message(STATUS "")
message(STATUS "After building, point Ardour at the shim:")
message(STATUS "  ARDOUR_SURFACES_PATH=${CMAKE_BINARY_DIR}:\$ARDOUR_SURFACES_PATH ardour")
message(STATUS "")
