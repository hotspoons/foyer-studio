// SPDX-License-Identifier: GPL-2.0-or-later
/*
 * Foyer Studio — Ardour shim: session UUID persistence + registry file.
 */
#include "session_uuid.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <random>
#include <sstream>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include "ardour/session.h"
#include "pbd/error.h"
#include "pbd/xml++.h"

namespace {

// UUID v4 generator. We only need a single-process-lifetime generator
// so a thread_local random_device + mt19937 is plenty; cryptographic
// strength isn't required — this is just an identity tag, not a
// security token.
std::string generate_uuid_v4 ()
{
	thread_local std::random_device rd;
	thread_local std::mt19937_64 rng (rd ());
	std::uint64_t hi = rng ();
	std::uint64_t lo = rng ();
	// Set the UUID v4 version + variant bits per RFC 4122.
	hi = (hi & 0xffffffffffff0fffULL) | 0x0000000000004000ULL; // version 4
	lo = (lo & 0x3fffffffffffffffULL) | 0x8000000000000000ULL; // variant 10xx
	char buf[37];
	std::snprintf (buf, sizeof (buf),
	               "%08x-%04x-%04x-%04x-%012llx",
	               static_cast<unsigned> (hi >> 32),
	               static_cast<unsigned> ((hi >> 16) & 0xffff),
	               static_cast<unsigned> (hi & 0xffff),
	               static_cast<unsigned> ((lo >> 48) & 0xffff),
	               static_cast<unsigned long long> (lo & 0x0000ffffffffffffULL));
	return std::string (buf);
}

std::string iso8601_now ()
{
	using namespace std::chrono;
	const auto now = system_clock::now ();
	const auto secs = time_point_cast<seconds> (now);
	const std::time_t t = system_clock::to_time_t (secs);
	std::tm tm_utc{};
	gmtime_r (&t, &tm_utc);
	char buf[32];
	std::strftime (buf, sizeof (buf), "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
	return std::string (buf);
}

std::string registry_dir ()
{
	// Matches the sidecar's `dirs::data_dir()` resolution:
	//   XDG_DATA_HOME || $HOME/.local/share
	if (const char* xdg = std::getenv ("XDG_DATA_HOME"); xdg && *xdg) {
		return std::string (xdg) + "/foyer/sessions";
	}
	if (const char* home = std::getenv ("HOME"); home && *home) {
		return std::string (home) + "/.local/share/foyer/sessions";
	}
	return "/tmp/foyer/sessions";
}

void ensure_dir (const std::string& path)
{
	// mkdir -p equivalent, fresh each segment. Quiet no-op on EEXIST.
	std::string acc;
	for (std::size_t i = 0; i <= path.size (); ++i) {
		if (i == path.size () || path[i] == '/') {
			if (!acc.empty () && acc != "/") {
				::mkdir (acc.c_str (), 0755);
			}
			if (i < path.size ()) acc.push_back (path[i]);
		} else {
			acc.push_back (path[i]);
		}
	}
}

std::string json_escape (const std::string& s)
{
	std::string out;
	out.reserve (s.size () + 4);
	for (char c : s) {
		switch (c) {
			case '"':  out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n";  break;
			case '\r': out += "\\r";  break;
			case '\t': out += "\\t";  break;
			default:
				if (static_cast<unsigned char> (c) < 0x20) {
					char buf[8];
					std::snprintf (buf, sizeof (buf), "\\u%04x", c);
					out += buf;
				} else {
					out.push_back (c);
				}
		}
	}
	return out;
}

} // namespace

namespace ArdourSurface::session_uuid {

std::string
ensure_uuid (ARDOUR::Session& session)
{
	// Session inherits PBD::Stateful via SessionObject → Stateful;
	// `extra_xml("Foyer", add_if_missing=true)` will create the
	// <Foyer> wrapper if it's not there yet. We then look for
	// (or create) a <Session> child with an "id" property.
	XMLNode* foyer = session.extra_xml ("Foyer", true /* add_if_missing */);
	if (!foyer) {
		// Allocation failure or a hosting runtime that doesn't have
		// a Stateful impl — fall back to a throwaway UUID so the
		// registry entry still works.
		PBD::warning << "foyer_shim: session_uuid: extra_xml('Foyer') returned null; "
		             << "session id will not persist across save/load"
		             << endmsg;
		return generate_uuid_v4 ();
	}
	XMLNode* sess = foyer->child ("Session");
	if (!sess) {
		sess = foyer->add_child ("Session");
		// Mark dirty so the next Save persists the new UUID.
		session.set_dirty ();
	}
	std::string id;
	if (!sess->get_property ("id", id) || id.empty ()) {
		id = generate_uuid_v4 ();
		sess->set_property ("id", id);
		session.set_dirty ();
		PBD::info << "foyer_shim: assigned session id " << id << endmsg;
	}
	return id;
}

void
write_registry_entry (const std::string& session_uuid,
                      const std::string& project_path,
                      const std::string& project_name,
                      const std::string& socket_path,
                      const std::string& backend_id)
{
	if (session_uuid.empty ()) return;
	const std::string dir = registry_dir ();
	ensure_dir (dir);
	const std::string path = dir + "/" + session_uuid + ".json";
	// Write to a tmpfile and rename — avoids racing readers that
	// might scan mid-write. Best-effort; log on failure.
	const std::string tmp = path + ".tmp";
	{
		std::ofstream out (tmp);
		if (!out) {
			PBD::warning << "foyer_shim: session_uuid: couldn't open " << tmp
			             << " for writing (registry entry skipped)" << endmsg;
			return;
		}
		const auto now = std::chrono::duration_cast<std::chrono::seconds> (
		    std::chrono::system_clock::now ().time_since_epoch ()).count ();
		out << "{\n"
		    << "  \"session_id\":   \"" << json_escape (session_uuid) << "\",\n"
		    << "  \"backend_id\":   \"" << json_escape (backend_id)   << "\",\n"
		    << "  \"project_path\": \"" << json_escape (project_path) << "\",\n"
		    << "  \"project_name\": \"" << json_escape (project_name) << "\",\n"
		    << "  \"socket_path\":  \"" << json_escape (socket_path)  << "\",\n"
		    << "  \"pid\":          " << ::getpid () << ",\n"
		    << "  \"started_at\":   " << now << ",\n"
		    << "  \"last_updated\": " << now << "\n"
		    << "}\n";
	}
	if (std::rename (tmp.c_str (), path.c_str ()) != 0) {
		PBD::warning << "foyer_shim: session_uuid: rename " << tmp
		             << " -> " << path << " failed: "
		             << std::strerror (errno) << endmsg;
		::unlink (tmp.c_str ());
	}
}

void
remove_registry_entry (const std::string& session_uuid)
{
	if (session_uuid.empty ()) return;
	const std::string path = registry_dir () + "/" + session_uuid + ".json";
	::unlink (path.c_str ());
}

} // namespace ArdourSurface::session_uuid
