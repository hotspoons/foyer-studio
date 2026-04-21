//! Bounded ring of recent envelopes for `?since=` resync.
//!
//! We store in insertion order; since `seq` is monotonic we can binary-search on
//! the slice as long as we treat the oldest-entry boundary specially (a client asking
//! for a `since` older than anything in the ring must get a full snapshot instead).

use foyer_schema::{Envelope, Event};
use std::collections::VecDeque;

pub struct DeltaRing {
    cap: usize,
    buf: VecDeque<Envelope<Event>>,
}

impl DeltaRing {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            buf: VecDeque::with_capacity(cap),
        }
    }

    pub fn push(&mut self, env: Envelope<Event>) {
        if self.buf.len() == self.cap {
            self.buf.pop_front();
        }
        self.buf.push_back(env);
    }

    /// Return all envelopes with `seq > since`, or `None` if `since` is older than
    /// anything we still have (caller should fall back to a snapshot).
    pub fn since(&self, since: u64) -> Option<Vec<Envelope<Event>>> {
        let oldest = self.buf.front()?.seq;
        if since + 1 < oldest {
            return None;
        }
        Some(self.buf.iter().filter(|e| e.seq > since).cloned().collect())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use foyer_schema::{ControlUpdate, ControlValue, EntityId, SCHEMA_VERSION};

    fn env(seq: u64) -> Envelope<Event> {
        Envelope {
            schema: SCHEMA_VERSION,
            seq,
            origin: None,
            session_id: None,
            body: Event::ControlUpdate {
                update: ControlUpdate {
                    id: EntityId::new("x"),
                    value: ControlValue::Float(0.0),
                },
            },
        }
    }

    #[test]
    fn push_and_filter_by_seq() {
        let mut r = DeltaRing::new(10);
        for seq in 1..=5 {
            r.push(env(seq));
        }
        assert_eq!(r.len(), 5);
        let got = r.since(2).unwrap();
        let seqs: Vec<u64> = got.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
    }

    #[test]
    fn capacity_is_enforced() {
        let mut r = DeltaRing::new(3);
        for seq in 1..=5 {
            r.push(env(seq));
        }
        assert_eq!(r.len(), 3);
        // since=1 is too old: the client last saw seq 1, but seq 2 was evicted.
        // We can't prove continuity from 1→3, so force a snapshot.
        assert!(r.since(1).is_none());
        // since=2 is the boundary: client saw through 2, oldest retained is 3 → adjacent.
        let got = r.since(2).unwrap();
        let seqs: Vec<u64> = got.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
    }

    #[test]
    fn too_old_returns_none() {
        let mut r = DeltaRing::new(3);
        for seq in 10..=12 {
            r.push(env(seq));
        }
        // 'since=5' is older than the oldest (seq=10) → resync required.
        assert!(r.since(5).is_none());
        // 'since=9' is exactly adjacent → ok; means "give me everything from 10 up".
        let got = r.since(9).unwrap();
        assert_eq!(got.len(), 3);
    }
}
