//! Stable string IDs used everywhere in the schema.
//!
//! IDs are opaque to anything above the shim — their internal structure is convention
//! (`track.<uuid>.gain`, `plugin.<uuid>.param.<index>`, `transport.tempo`) but the
//! sidecar and browser must treat them as opaque strings. The shim assigns them and
//! owns the mapping back to host-native identifiers.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntityId(pub String);

impl EntityId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for EntityId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for EntityId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for EntityId {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_json() {
        let id = EntityId::new("track.abc.gain");
        let j = serde_json::to_string(&id).unwrap();
        assert_eq!(j, r#""track.abc.gain""#);
        let back: EntityId = serde_json::from_str(&j).unwrap();
        assert_eq!(back, id);
    }
}
