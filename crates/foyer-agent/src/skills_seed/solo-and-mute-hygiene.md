enabled: true

# Solo / mute hygiene

The single most common "I did what you said but I can't hear it"
cause is solo state. Read this before adding tracks or expecting
the user to hear new content.

## The rule

Ardour (and Foyer) is solo-in-place: when ANY track in the session
has `solo: true`, every non-soloed track is silently muted.

## Before adding a track or making something playable

1. `tracks.list` → check the `solo` field on every track.
2. If anything is soloed:
   - Either solo the new track too (so it's audible alongside the
     existing solo group), OR
   - Tell the user "track.X is currently soloed; your new
     <whatever> will be muted by default until you clear solo
     elsewhere".

## When the user says "play it"

After hitting `transport.play`:
- If they immediately say "I can't hear anything", check solo
  FIRST, then mute, then track gain, then plugin bypass / wet
  level, then master fader.
- The error is almost never the plugin chain on the first pass.

## Mute is per-track and explicit

Mute on a non-soloed track is straightforward — that track is
silent. Mute on a soloed track does NOTHING (solo wins) — Ardour
keeps the mute state but solo bypasses it.

## Reading the meter

`tracks.describe` returns `peak_meter` ids. `mixer.get` returns
gain/mute/solo/pan but NOT the live peak — for live audio activity
the user should look at the mixer viz. If they're asking "is this
track making sound", correlate `solo` state with `mute` state
before claiming the plugin chain is bad.

## Restoring a deleted-and-recreated track

If you remove a track and add a new one in its place, the new
track's solo state defaults to false. If the user was running with
solo on the old one, they'll lose audibility on the new one.
Restore the solo state explicitly.
