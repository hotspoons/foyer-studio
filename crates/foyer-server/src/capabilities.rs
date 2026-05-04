//! HTTP surface for the canonical engine capability registry (`foyer-capabilities`).
//!
//! - `GET /capabilities` — static manifest + live merged feature map (same keys as
//!   `ClientGreeting.features`).
//! - `POST /capabilities/diff` — compare a client's known id list (+ optional
//!   registry version) to the server for upgrade / drift diagnostics.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use foyer_capabilities::{
    diff_against_client, CapabilitiesSnapshot, CapabilityDiffReport, CapabilityDiffRequest,
};

use crate::AppState;

/// `GET /capabilities`
pub(crate) async fn get_capabilities(
    State(state): State<Arc<AppState>>,
) -> Json<CapabilitiesSnapshot> {
    Json(CapabilitiesSnapshot::build(
        state.merged_feature_map().await,
    ))
}

/// `POST /capabilities/diff`
pub(crate) async fn post_capabilities_diff(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CapabilityDiffRequest>,
) -> Json<CapabilityDiffReport> {
    Json(diff_against_client(state.merged_feature_map().await, &req))
}
