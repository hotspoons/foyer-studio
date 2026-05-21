// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: version-skew helpers.
 *
 * Ardour evolves its libardour ABI across minor releases. The shim
 * targets the WHOLE 9.x line (the matrix is intentional: users who
 * already have Ardour 9.2 installed shouldn't be forced onto 9.5
 * just to load our surface). To keep both buildable, we wrap the
 * known API drift behind compile-time guards keyed on the active
 * Ardour MAJOR.MINOR.
 *
 * `FOYER_ARDOUR_VERSION_MAJOR` and `_MINOR` are defined by CMake
 * (see shims/ardour/CMakeLists.txt — they're parsed from
 * `git describe` inside FOYER_ARDOUR_SOURCE, or passed explicitly
 * via `-DFOYER_ARDOUR_VERSION_MAJOR=…`). A missing define is a
 * configure error, not a silent default — wrong codegen is much
 * worse than a "version unknown" message at build time.
 *
 * Known drift points the shim has to handle:
 *
 *   * **9.3** — `IO::connect(port, name)` lost its third
 *     `void* src` arg. The `src` transaction-handle parameter that
 *     existed in 9.2 is now tracked implicitly inside libardour.
 *     Use `FOYER_ARDOUR_VERSION_GE(9, 3)` to pick the right
 *     overload.
 *
 *   * **9.3** — `AutomationList::lock()` (and a handful of sibling
 *     locks across libardour) returns `PBD::RWLock&` rather than
 *     `Glib::Threads::RWLock&`. `PBD::RWLock::ReaderLock` is the
 *     replacement RAII guard. Same `FOYER_ARDOUR_VERSION_GE(9, 3)`
 *     toggle.
 *
 * Add new ifdef gates here as new minor versions land; keep the
 * call-site #ifdefs short by hoisting common forwarders into static
 * inline helpers in this header when an API change shows up in
 * more than two places.
 */
#ifndef foyer_shim_ardour_version_h
#define foyer_shim_ardour_version_h

#if !defined(FOYER_ARDOUR_VERSION_MAJOR) || !defined(FOYER_ARDOUR_VERSION_MINOR)
#error "FOYER_ARDOUR_VERSION_MAJOR/MINOR must be defined by the build system."
#endif

/* True when the active Ardour build is >= the given minor of the
 * given major. Use as e.g.:
 *
 *   #if FOYER_ARDOUR_VERSION_GE(9, 3)
 *       io->connect (port, name);          // 9.3 dropped the third arg
 *   #else
 *       io->connect (port, name, nullptr); // legacy 9.2 form
 *   #endif
 */
#define FOYER_ARDOUR_VERSION_GE(maj, min)             \
    ((FOYER_ARDOUR_VERSION_MAJOR > (maj)) ||          \
     (FOYER_ARDOUR_VERSION_MAJOR == (maj) &&          \
      FOYER_ARDOUR_VERSION_MINOR >= (min)))

#endif /* foyer_shim_ardour_version_h */
