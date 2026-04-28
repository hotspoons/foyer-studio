-- Create a demo Foyer session populated with a small band's worth of
-- audio tracks. This REPLACES /tmp/foyer-session. Run via:
--
--   just populate-demo-session
--
-- Must NOT be running while hardour has the session open.

local SESSION_DIR  = "/tmp/foyer-session"
local SESSION_NAME = "foyer-smoke"

-- Wipe anything stale.
os.execute("rm -rf " .. SESSION_DIR)

-- Boot the dummy audio engine.
local backend = AudioEngine:set_backend("None (Dummy)", "", "")
assert(backend, "couldn't set None (Dummy) backend")
backend:set_device_name("Silence (8ch)")

local s = create_session(SESSION_DIR, SESSION_NAME, 48000)
assert(s, "create_session failed")

local function add_track(name, color)
  local tl = s:new_audio_track(1, 2, nil, 1, name,
                               ARDOUR.PresentationInfo.max_order,
                               ARDOUR.TrackMode.Normal, true)
  for tr in tl:iter() do
    if color then tr:presentation_info_ptr():set_color(color) end
  end
end

-- Colors are 0xRRGGBBAA.
add_track("Kick",    0xc04040ff)
add_track("Snare",   0xc08040ff)
add_track("Hats",    0xc0c040ff)
add_track("Bass",    0x40c080ff)
add_track("Guitar",  0x4080c0ff)
add_track("Keys",    0x8060c0ff)
add_track("Vox",     0xc060a0ff)
add_track("Reverb",  0x808080ff)

s:save_state("")
print(("Created %s/%s.ardour with 8 tracks"):format(SESSION_DIR, SESSION_NAME))
