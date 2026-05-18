// SPDX-License-Identifier: Apache-2.0
//! Automation-lane `Command` handlers — `SetAutomationMode`,
//! `AddAutomationPoint`, `UpdateAutomationPoint`,
//! `DeleteAutomationPoint`, `ReplaceAutomationLane`. Each emits a
//! targeted `Event::Error` toast on failure so the lane editor
//! shows a banner instead of silently swallowing the click.

use std::sync::Arc;

use foyer_schema::value::{AutomationMode, AutomationPoint};
use foyer_schema::{EntityId, Event};

use super::broadcast_event;
use crate::AppState;

pub(super) async fn set_mode(state: &Arc<AppState>, lane_id: EntityId, mode: AutomationMode) {
    if let Err(e) = state
        .backend()
        .await
        .set_automation_mode(lane_id, mode)
        .await
    {
        broadcast_event(
            state,
            Event::Error {
                code: "set_automation_mode_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn add_point(state: &Arc<AppState>, lane_id: EntityId, point: AutomationPoint) {
    if let Err(e) = state
        .backend()
        .await
        .add_automation_point(lane_id, point)
        .await
    {
        broadcast_event(
            state,
            Event::Error {
                code: "add_automation_point_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn update_point(
    state: &Arc<AppState>,
    lane_id: EntityId,
    original_time_samples: u64,
    new_time_samples: u64,
    value: f64,
) {
    if let Err(e) = state
        .backend()
        .await
        .update_automation_point(lane_id, original_time_samples, new_time_samples, value)
        .await
    {
        broadcast_event(
            state,
            Event::Error {
                code: "update_automation_point_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn delete_point(state: &Arc<AppState>, lane_id: EntityId, time_samples: u64) {
    if let Err(e) = state
        .backend()
        .await
        .delete_automation_point(lane_id, time_samples)
        .await
    {
        broadcast_event(
            state,
            Event::Error {
                code: "delete_automation_point_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}

pub(super) async fn replace_lane(
    state: &Arc<AppState>,
    lane_id: EntityId,
    points: Vec<AutomationPoint>,
) {
    if let Err(e) = state
        .backend()
        .await
        .replace_automation_lane(lane_id, points)
        .await
    {
        broadcast_event(
            state,
            Event::Error {
                code: "replace_automation_lane_failed".into(),
                message: e.to_string(),
                target_peer_id: None,
                localized: None,
            },
        )
        .await;
    }
}
