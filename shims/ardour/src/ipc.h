/*
 * Foyer Studio — Ardour shim: foyer-ipc server over a Unix domain socket.
 *
 * Framing matches the Rust `foyer_ipc::codec`:
 *
 *   [kind: u8][len: u32 BE][payload]
 *
 * Two kinds:
 *   0x01 — MessagePack-encoded Envelope<Control>  (control plane)
 *   0x02 — [stream_id: u32 LE][interleaved f32 LE...]  (audio plane)
 */
#ifndef foyer_shim_ipc_h
#define foyer_shim_ipc_h

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ArdourSurface {

class FoyerShim;

/// Framing constants mirrored from the Rust side.
namespace foyer_ipc {
	enum class FrameKind : std::uint8_t {
		Control = 0x01,
		Audio   = 0x02,
	};
	static constexpr std::uint32_t MaxPayload = 16u * 1024u * 1024u;
} // namespace foyer_ipc

/// Callback invoked on each decoded frame (on the IO thread — the callback must
/// be cheap and thread-safe; expensive work should bounce onto the shim's
/// AbstractUI request queue).
using IpcFrameHandler = std::function<void(foyer_ipc::FrameKind, const std::vector<std::uint8_t>&)>;

/// Single-connection UDS server. Listens on `_socket_path`, accepts exactly one
/// sidecar at a time (re-accepts if the current client disconnects).
class IpcServer
{
public:
	explicit IpcServer (FoyerShim&);
	~IpcServer ();

	void start ();
	void stop ();

	/// Override the socket path. Must be called before `start()`.
	void set_socket_path (const std::string& p) { _socket_path = p; }

	/// Register the frame handler. Overwrites any existing handler.
	void on_frame (IpcFrameHandler h) { _handler = std::move (h); }

	/// Send a framed payload to the connected sidecar. No-op if not connected.
	/// Thread-safe; serializes writes internally.
	void send (foyer_ipc::FrameKind kind, const std::uint8_t* data, std::size_t len);

	/// Convenience: send with a vector.
	void send (foyer_ipc::FrameKind kind, const std::vector<std::uint8_t>& data)
	{
		send (kind, data.data (), data.size ());
	}

	bool is_connected () const { return _fd_client.load () >= 0; }

private:
	FoyerShim& _shim;
	std::string _socket_path { "/tmp/foyer.sock" };

	std::atomic<bool> _running { false };
	std::atomic<int>  _fd_listen { -1 };
	std::atomic<int>  _fd_client { -1 };

	std::thread _io_thread;
	std::mutex  _write_mu;

	IpcFrameHandler _handler;

	void io_loop ();
	bool read_exact (int fd, void* buf, std::size_t len);
};

} // namespace ArdourSurface

#endif
