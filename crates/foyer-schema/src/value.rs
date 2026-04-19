//! Control-parameter value model.
//!
//! A `Parameter` is Foyer's neutral description of something a user or automation can
//! read and write. Every fader, knob, plugin parameter, mute switch, and tempo box is a
//! `Parameter` in the schema — they differ only in `kind`, range metadata, and display
//! hints.

use serde::{Deserialize, Serialize};

/// What kind of control this parameter exposes to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlKind {
    /// A continuous float, mapped by `range` and `scale`.
    Continuous,
    /// Integer steps within `range` (rounded).
    Discrete,
    /// One-of-N with `enum_labels`.
    Enum,
    /// Momentary/toggle; value is 0.0 or 1.0.
    Trigger,
    /// Read-only continuous (meters, peak LEDs).
    Meter,
    /// Free-form text (track name, marker label).
    Text,
    /// Falls through to a native-GUI channel (phase-2 pixel forwarding).
    CustomGui,
}

/// How to display/interpolate a `Continuous` parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScaleCurve {
    #[default]
    Linear,
    Logarithmic,
    /// dB, displayed as logarithmic amplitude.
    Decibels,
    /// Frequency in Hz, displayed logarithmically.
    Hertz,
}

/// The live value of a parameter. Serialized to the narrowest type that fits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl ControlValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Self::Int(i) => Some(*i as f64),
            Self::Float(f) => Some(*f),
            Self::Text(_) => None,
        }
    }
}

/// Static + dynamic description of a parameter. Shipped in snapshots; the dynamic
/// `value` also appears in `control.update` messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Parameter {
    /// Foyer stable ID, e.g. `track.<uuid>.gain`.
    pub id: crate::EntityId,
    pub kind: ControlKind,
    pub label: String,
    /// Inclusive range as `[min, max]`. `None` for `Enum`, `Trigger`, `Text`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub range: Option<[f64; 2]>,
    /// Interpolation hint for UI rendering.
    #[serde(default)]
    pub scale: ScaleCurve,
    /// Unit string, e.g. "dB", "Hz", "%". Free-form.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub unit: Option<String>,
    /// Ordered labels for `Enum`; empty otherwise.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub enum_labels: Vec<String>,
    /// Optional grouping key (LV2 port group, VST3 category) — layout hint only.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<String>,
    pub value: ControlValue,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EntityId;

    #[test]
    fn continuous_fader_round_trip() {
        let p = Parameter {
            id: EntityId::new("track.abc.gain"),
            kind: ControlKind::Continuous,
            label: "Gain".into(),
            range: Some([-60.0, 6.0]),
            scale: ScaleCurve::Decibels,
            unit: Some("dB".into()),
            enum_labels: vec![],
            group: None,
            value: ControlValue::Float(-3.0),
        };
        let j = serde_json::to_string(&p).unwrap();
        let back: Parameter = serde_json::from_str(&j).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn enum_param_omits_range() {
        let p = Parameter {
            id: EntityId::new("plugin.abc.param.3"),
            kind: ControlKind::Enum,
            label: "Mode".into(),
            range: None,
            scale: ScaleCurve::Linear,
            unit: None,
            enum_labels: vec!["Off".into(), "Low".into(), "High".into()],
            group: None,
            value: ControlValue::Int(1),
        };
        let j = serde_json::to_string(&p).unwrap();
        assert!(!j.contains("range"));
        let back: Parameter = serde_json::from_str(&j).unwrap();
        assert_eq!(p, back);
    }
}
