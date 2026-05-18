// SPDX-License-Identifier: Apache-2.0
//! Sections — a single primitive that subsumes markers, ranges,
//! auto-loop, and auto-punch.
//!
//! Traditional DAWs expose four distinct primitives for what is
//! fundamentally one concept ("a named span of time you do something
//! to"):
//! - cue marker (0-length, named, navigation only)
//! - range marker (span, named, navigation only)
//! - auto-loop range (hidden range the transport loops over)
//! - auto-punch range (hidden range record-arm engages within)
//!
//! Foyer collapses these into ONE [`Section`] with role flags. The
//! cognitive load drops; the underlying Ardour mapping at the shim is
//! mechanical:
//! - `is_loop_target=true` ↔ Ardour's auto-loop location
//! - `is_punch_target=true` ↔ Ardour's auto-punch location
//! - `end_samples=None` ↔ Ardour `markers_add` (cue)
//! - `end_samples=Some` ↔ Ardour `markers_add_range_*`
//!
//! `is_loop_target` / `is_punch_target` are mutually exclusive
//! across sections: only one section at a time can be each
//! transport target. The Foyer server enforces this in
//! `update_section`; the Ardour shim's auto-loop / auto-punch slots
//! are themselves mutually exclusive so the round-trip stays
//! consistent.

use serde::{Deserialize, Serialize};

use crate::EntityId;

/// Role flags carried per-section. Each is independently toggleable
/// — a single section can be navigation-visible, the active loop
/// target, AND the active punch target all at once (rare but
/// representable; recall scenarios use this when the same range is
/// both the "loop me" and "record me" target).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SectionFlags {
    /// When true and the transport's loop control is on, the
    /// transport's loop range IS this section. Mutually exclusive
    /// across sections.
    #[serde(default)]
    pub is_loop_target: bool,
    /// When true and the transport's record control is engaged,
    /// punch-in / punch-out happen at this section's boundaries.
    /// Mutually exclusive across sections.
    #[serde(default)]
    pub is_punch_target: bool,
    /// When true, the section appears in the navigation strip and
    /// the arrow-key seek cycle. Defaults to true; turn off to hide
    /// utility sections without deleting them.
    #[serde(default = "yes")]
    pub is_navigation: bool,
}

fn yes() -> bool {
    true
}

impl SectionFlags {
    pub fn navigation_only() -> Self {
        Self {
            is_loop_target: false,
            is_punch_target: false,
            is_navigation: true,
        }
    }
}

/// One Foyer section. `end_samples=None` represents a 0-length cue
/// (Ardour's `Location::is_mark`); `end_samples=Some(_)` is a range
/// (Ardour's `Location::is_range`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub id: EntityId,
    pub name: String,
    /// Section start, in audio samples at the session sample rate.
    /// Signed: like regions, sections can extend before the
    /// timeline's 0 mark.
    pub start_samples: i64,
    /// Section end. `None` = cue marker (zero-length nav point).
    /// `Some(end)` = range; the host enforces `end >= start_samples`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_samples: Option<i64>,
    /// UI swatch (hex `#RRGGBB`). `None` = backend / theme default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub flags: SectionFlags,
}

impl Section {
    pub fn is_cue(&self) -> bool {
        self.end_samples.is_none()
    }

    pub fn length_samples(&self) -> Option<i64> {
        self.end_samples
            .map(|e| e.saturating_sub(self.start_samples))
    }
}

/// Patch type for `update_section`. None-valued fields are left as-is.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_samples: Option<i64>,
    /// `Some(Some(e))` sets the end; `Some(None)` collapses to a cue;
    /// `None` leaves the end alone. Use the Option-of-Option to
    /// distinguish "skip" from "explicitly clear".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_samples: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<SectionFlags>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_round_trips() {
        let s = Section {
            id: EntityId::new("section.verse1"),
            name: "Verse 1".into(),
            start_samples: 96_000,
            end_samples: None,
            color: Some("#ff8000".into()),
            flags: SectionFlags::navigation_only(),
        };
        let j = serde_json::to_string(&s).unwrap();
        let back: Section = serde_json::from_str(&j).unwrap();
        assert_eq!(s, back);
        assert!(back.is_cue());
    }

    #[test]
    fn range_loop_target_round_trips() {
        let s = Section {
            id: EntityId::new("section.chorus"),
            name: "Chorus".into(),
            start_samples: 192_000,
            end_samples: Some(384_000),
            color: None,
            flags: SectionFlags {
                is_loop_target: true,
                is_punch_target: false,
                is_navigation: true,
            },
        };
        let j = serde_json::to_string(&s).unwrap();
        let back: Section = serde_json::from_str(&j).unwrap();
        assert_eq!(s, back);
        assert_eq!(back.length_samples(), Some(192_000));
        assert!(back.flags.is_loop_target);
    }
}
