/*
 * Foyer Studio — Ardour shim: IPC server implementation.
 */
#include "ipc.h"

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#include "pbd/error.h"

#include "surface.h"

namespace ArdourSurface {

IpcServer::IpcServer (FoyerShim& s)
    : _shim (s)
{
}

IpcServer::~IpcServer ()
{
	stop ();
}

void
IpcServer::start ()
{
	if (_running.exchange (true)) {
		return;
	}

	// Remove any stale socket file.
	::unlink (_socket_path.c_str ());

	int fd = ::socket (AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0) {
		PBD::error << "foyer_shim: socket() failed: " << strerror (errno) << endmsg;
		_running = false;
		return;
	}

	sockaddr_un addr {};
	addr.sun_family = AF_UNIX;
	std::strncpy (addr.sun_path, _socket_path.c_str (), sizeof (addr.sun_path) - 1);

	if (::bind (fd, reinterpret_cast<sockaddr*> (&addr), sizeof (addr)) < 0) {
		PBD::error << "foyer_shim: bind(" << _socket_path << "): " << strerror (errno) << endmsg;
		::close (fd);
		_running = false;
		return;
	}
	if (::listen (fd, 1) < 0) {
		PBD::error << "foyer_shim: listen(): " << strerror (errno) << endmsg;
		::close (fd);
		_running = false;
		return;
	}
	_fd_listen = fd;
	_io_thread = std::thread ([this] { io_loop (); });
}

void
IpcServer::stop ()
{
	if (!_running.exchange (false)) {
		return;
	}
	int l = _fd_listen.exchange (-1);
	int c = _fd_client.exchange (-1);
	if (l >= 0) ::close (l);
	if (c >= 0) ::close (c);
	if (_io_thread.joinable ()) {
		_io_thread.join ();
	}
	::unlink (_socket_path.c_str ());
}

bool
IpcServer::read_exact (int fd, void* buf, std::size_t len)
{
	auto* p = static_cast<std::uint8_t*> (buf);
	while (len > 0) {
		ssize_t n = ::read (fd, p, len);
		if (n == 0) return false;
		if (n < 0) {
			if (errno == EINTR) continue;
			return false;
		}
		p += n;
		len -= static_cast<std::size_t> (n);
	}
	return true;
}

void
IpcServer::io_loop ()
{
	while (_running.load ()) {
		int lfd = _fd_listen.load ();
		if (lfd < 0) break;

		int cfd = ::accept (lfd, nullptr, nullptr);
		if (cfd < 0) {
			if (!_running.load ()) break;
			if (errno == EINTR) continue;
			PBD::error << "foyer_shim: accept(): " << strerror (errno) << endmsg;
			break;
		}
		_fd_client = cfd;

		while (_running.load ()) {
			std::uint8_t header[5];
			if (!read_exact (cfd, header, sizeof (header))) break;

			auto kind_byte = header[0];
			std::uint32_t len =
			    (static_cast<std::uint32_t> (header[1]) << 24)
			  | (static_cast<std::uint32_t> (header[2]) << 16)
			  | (static_cast<std::uint32_t> (header[3]) << 8)
			  |  static_cast<std::uint32_t> (header[4]);
			if (len > foyer_ipc::MaxPayload) break;

			std::vector<std::uint8_t> payload (len);
			if (len > 0 && !read_exact (cfd, payload.data (), len)) break;

			foyer_ipc::FrameKind k;
			if (kind_byte == 0x01) k = foyer_ipc::FrameKind::Control;
			else if (kind_byte == 0x02) k = foyer_ipc::FrameKind::Audio;
			else break;

			if (_handler) _handler (k, payload);
		}

		int prev = _fd_client.exchange (-1);
		if (prev >= 0) ::close (prev);
	}
}

void
IpcServer::send (foyer_ipc::FrameKind kind, const std::uint8_t* data, std::size_t len)
{
	int cfd = _fd_client.load ();
	if (cfd < 0 || len > foyer_ipc::MaxPayload) return;

	std::uint32_t n = static_cast<std::uint32_t> (len);
	std::uint8_t header[5];
	header[0] = static_cast<std::uint8_t> (kind);
	header[1] = static_cast<std::uint8_t> ((n >> 24) & 0xff);
	header[2] = static_cast<std::uint8_t> ((n >> 16) & 0xff);
	header[3] = static_cast<std::uint8_t> ((n >> 8) & 0xff);
	header[4] = static_cast<std::uint8_t> (n & 0xff);

	std::lock_guard<std::mutex> lock (_write_mu);
	if (::write (cfd, header, sizeof (header)) != ssize_t (sizeof (header))) return;
	if (len > 0 && ::write (cfd, data, len) != ssize_t (len)) return;
}

} // namespace ArdourSurface
