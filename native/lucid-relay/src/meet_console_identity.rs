// AC-1 (contract 4.9, 12): the Admin Console's `GET /console/api/meet/identity` (ID-1 organization sign-in views).
// This build carries no ID-1 views, so the page shows that the section is not available here; the ID-1 `rust` slice
// fills this file when it merges. Display only: nothing here is ever verified by the relay (7.4).

use serde_json::{json, Value};

/// `{ok, available: false}` until the build carries the ID-1 views.
pub fn view() -> Value {
    json!({"ok": true, "available": false})
}

#[cfg(test)]
mod tests {
    #[test]
    fn identity_is_not_available_on_this_build() {
        assert_eq!(super::view(), serde_json::json!({"ok": true, "available": false}));
    }
}
