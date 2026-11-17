// Two-admin approvals and requests to the signing side (contract AC-1 sections 3.7 and 3.8), and the Admins routes of
// 4.3 that make them: who is an eligible approver, the sole-admin path and its four conditions (H1, N1), the re-checks
// at approval, cancellation by the relay, uniqueness by parameter hash; the requests store, marked done only by what
// the relay observes itself.

use crate::codec::{sha256_hex, str_of};
use crate::console::{AdminRule, ApiError, Approved, Console, Done, Out};
use crate::console_audit::{canonical_json, Record};
use crate::console_auth::{email_of, random_bytes, Bind, reason_of, Book, KeyState, Person, PersonRole, PersonState, Who};
use crate::console_limits::{Limit, DAY};
use crate::log::{Fields, Level};
use serde_json::{json, Map, Value};

pub const APPROVAL_MS: i64 = DAY;
pub const APPROVALS_KEPT_MS: i64 = 90 * DAY;
pub const APPROVALS_PER_REQUESTER: usize = 5;
pub const APPROVALS_MAX: usize = 20;
pub const REQUEST_MS: i64 = 14 * DAY;
pub const REQUESTS_WAITING_MAX: usize = 200;
const SEVEN_DAYS: i64 = 7 * DAY;

fn hex_id(prefix: &str) -> Result<String, ApiError> {
    let b = random_bytes(8)?;
    Ok(format!("{prefix}{}", crate::codec::hex(&b)))
}

fn s<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str {
    m.get(k).and_then(Value::as_str).unwrap_or("")
}

fn waiting(m: &Map<String, Value>) -> bool {
    s(m, "state") == "waiting"
}

/// The relay ends an approval (cancelled or expired).
fn end(a: &mut Map<String, Value>, state: &str, why: &str, t: i64) {
    a.insert("state".into(), Value::from(state));
    a.insert("decided_by".into(), Value::from("relay"));
    a.insert("decided_at".into(), Value::from(t));
    a.insert("decision_reason".into(), Value::from(why));
}

/// Cancel the waiting approvals a person asked for or that are about them (they left the book). The ids.
pub fn cancel_for(book: &mut Book, email: &str, t: i64) -> Vec<String> {
    let mut out = Vec::new();
    for a in book.approvals.iter_mut().filter(|a| waiting(a)) {
        if s(a, "requested_by") == email || s(a, "target") == email {
            end(a, "cancelled", "the requester or the target left", t);
            out.push(s(a, "id").to_owned());
        }
    }
    out
}

/// Cancel the waiting approvals a person asked for (suspended, removed or demoted). The ids.
pub fn cancel_requested_by(book: &mut Book, email: &str, t: i64) -> Vec<String> {
    let mut out = Vec::new();
    for a in book.approvals.iter_mut().filter(|a| waiting(a) && s(a, "requested_by") == email) {
        end(a, "cancelled", "the requester was suspended, removed or demoted", t);
        out.push(s(a, "id").to_owned());
    }
    out
}

/// Expire approvals past 24 hours and requests past 14 days; drop decided approvals after 90 days. The ids expired.
pub fn sweep(book: &mut Book, t: i64) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for a in book.approvals.iter_mut().filter(|a| waiting(a)) {
        if a.get("expires_at").and_then(Value::as_i64).is_some_and(|e| e <= t) {
            a.insert("state".into(), Value::from("expired"));
            a.insert("decided_at".into(), Value::from(t));
            out.push((s(a, "id").to_owned(), s(a, "action").to_owned()));
        }
    }
    book.approvals.retain(|a| waiting(a) || a.get("requested_at").and_then(Value::as_i64).is_some_and(|r| t - r < APPROVALS_KEPT_MS));
    for r in book.requests.iter_mut().filter(|r| waiting(r)) {
        if r.get("expires_at").and_then(Value::as_i64).is_some_and(|e| e <= t) {
            r.insert("state".into(), Value::from("expired"));
            out.push((s(r, "id").to_owned(), s(r, "kind").to_owned()));
        }
    }
    book.requests.retain(|r| waiting(r) || r.get("requested_at").and_then(Value::as_i64).is_some_and(|q| t - q < APPROVALS_KEPT_MS));
    out
}

/// The sole-admin path (3.7): all four conditions.
pub fn sole_admin_ok(book: &Book, requester: &str, target: &str, removal_of_other_admin: bool, t: i64) -> bool {
    let others = book.people.iter().any(|(e, p)| p.admin_role() && e != requester && e != target);
    let suspended = book.people.values().any(|p| p.admin_role() && p.state == PersonState::Suspended);
    let recent = book.removed_at.iter().any(|at| t - *at < SEVEN_DAYS);
    let about_me = book.approvals.iter().any(|a| waiting(a) && s(a, "target") == requester);
    !others && !suspended && !recent && !about_me && !(removal_of_other_admin && book.ever_two_admins)
}

/// Whether anyone could approve: an active admin who is neither the requester nor the target.
pub fn approver_exists(book: &Book, requester: &str, target: &str) -> bool {
    book.people.iter().any(|(e, p)| p.active_admin() && e != requester && e != target)
}

/// The 8.2 sentence of an action (the dialog title without its question mark).
fn summary(action: &str, target: &str, params: &Value) -> String {
    let role = str_of(params.get("role")).unwrap_or("");
    match action {
        "admins.invite" => format!("Invite {target} as an admin"),
        "admins.role" if role == "admin" => format!("Make {target} an admin"),
        "admins.role" if role == "user-manager" => format!("Make {target} a user manager"),
        "admins.role" => format!("Make {target} a viewer"),
        "admins.remove" => format!("Remove {target} as an admin"),
        "admins.suspend" => format!("Suspend {target}"),
        "admins.reset-sign-in" => format!("Reset the sign-in of {target}"),
        "settings.profile" => "Switch this console to the Standard profile".to_owned(),
        "settings.two-person" => "Stop requiring a second admin".to_owned(),
        "settings.sign-in" => "Change sign-in settings".to_owned(),
        "settings.aaguids" => "Change the approved security keys".to_owned(),
        "settings.email" => "Turn email off".to_owned(),
        "license.install" => format!("Install the license {target}"),
        "spokes.block" | "meet.block" => format!("Block {target} on this relay for {} hours", params.get("hours").and_then(Value::as_i64).unwrap_or(0)),
        "spokes.unblock" | "meet.unblock" => format!("Unblock {target}"),
        "meet.org.set" => format!("Change the organization of {target}"),
        "meet.bridge.set" => format!("Change bridges for {target}"),
        "meet.holds.place" => "Place a legal hold".to_owned(),
        "meet.holds.release" => format!("Release the hold {target}"),
        "meet.release.set" => format!("Publish Lucid Meeting Hub {target}"),
        _ => format!("{action} {target}"),
    }
}

/// An approval as the page shows it: the stored object plus `summary` and every parameter as a field.
fn approval_view(a: &Map<String, Value>) -> Value {
    let params = a.get("params").cloned().unwrap_or(Value::Null);
    let mut v = a.clone();
    v.remove("requested_role_internal");
    v.insert("summary".into(), Value::from(summary(s(a, "action"), s(a, "target"), &params)));
    let fields: Vec<Value> = params.as_object().map(|o| o.iter().map(|(k, v)| json!({ "name": k, "value": v })).collect()).unwrap_or_default();
    v.insert("fields".into(), Value::Array(fields));
    Value::Object(v)
}

/// What `second` decided.
pub enum Second {
    /// The two-person setting is off (R4-7): run now on the requester's step-up, flagged `single-admin-setting`.
    Single,
    /// The sole-admin path: run now, flagged.
    Sole,
    /// An approval was made (the object).
    Wait(Value),
}

impl Console {
    /// A second-admin action asked by `who`: with the two-person setting off, at once (`single-admin-setting`); with it
    /// on, the sole-admin path, or an approval (unique by parameter hash, capped), or `no-approver`. `always` (turning
    /// the setting off) needs a second admin in either case and never takes the sole-admin path (3.7).
    pub(crate) fn second(&self, who: &Who, action: &str, target: &str, params: &Value, always: bool, t: i64) -> Result<Second, ApiError> {
        let removal = action == "admins.remove" || (action == "admins.role" && str_of(params.get("role")) != Some("admin"));
        let mut inner = self.inner.lock();
        sweep(&mut inner.book, t);
        if !always && !inner.book.settings.two_person {
            return Ok(Second::Single);
        }
        // Condition 4 concerns another admin: a removal or demotion of an admin-role person who is not the requester.
        let of_other_admin = removal && target != who.email && inner.book.people.get(target).is_some_and(Person::admin_role);
        if !always && sole_admin_ok(&inner.book, &who.email, target, of_other_admin, t) {
            return Ok(Second::Sole);
        }
        if !approver_exists(&inner.book, &who.email, target) {
            let words = if removal {
                "Another admin must approve this. With no other admin, the person who runs this relay can do it with the relay stopped."
            } else {
                "Another admin must approve this. Unsuspend or add an admin first."
            };
            return Err(ApiError::with("no-approver", words));
        }
        let hash = sha256_hex(&canonical_json(params).map_err(|e| ApiError::with("invalid", e))?);
        if let Some(existing) = inner.book.approvals.iter().find(|a| waiting(a) && s(a, "action") == action && s(a, "target") == target && s(a, "params_sha256") == hash) {
            let e = ApiError::of("approval-exists");
            let view = approval_view(existing);
            drop(inner);
            return Err(self.with_extra(e, "approval", view));
        }
        let mine = inner.book.approvals.iter().filter(|a| waiting(a) && s(a, "requested_by") == who.email).count();
        let all = inner.book.approvals.iter().filter(|a| waiting(a)).count();
        if mine >= APPROVALS_PER_REQUESTER || all >= APPROVALS_MAX {
            let mut e = ApiError::rate(3600);
            e.message = "Too many changes are waiting for approval. Try again in 60 minutes.".into();
            return Err(e);
        }
        let id = hex_id("ap_")?;
        let mut a = Map::new();
        for (k, v) in [
            ("id", Value::from(id.as_str())),
            ("action", Value::from(action)),
            ("target", Value::from(target)),
            ("params", params.clone()),
            ("params_sha256", Value::from(hash)),
            ("requested_by", Value::from(who.email.as_str())),
            ("requested_role", Value::from(who.role.as_str())),
            ("requested_at", Value::from(t)),
            ("expires_at", Value::from(t + APPROVAL_MS)),
            ("state", Value::from("waiting")),
            ("decided_by", Value::Null),
            ("decided_at", Value::Null),
            ("decision_reason", Value::Null),
            ("result", Value::Null),
        ] {
            a.insert(k.into(), v);
        }
        let view = approval_view(&a);
        inner.book.approvals.push(a);
        self.save_book(&mut inner)?;
        Ok(Second::Wait(view))
    }

    /// Ask for a second admin and run at once on the sole-admin path. `run` carries the action out.
    pub(crate) fn second_or_run(&self, who: &Who, action: &str, target: &str, params: &Value, t: i64, run: impl FnOnce() -> Result<Value, ApiError>) -> Result<Done, ApiError> {
        match self.second(who, action, target, params, false, t)? {
            Second::Single => {
                let answer = run()?;
                Ok(Done { out: Out::ok(answer), target: Some(target.to_owned()), result: "ok", approval: Some("single-admin-setting".into()), detail: params_detail(params) })
            }
            Second::Sole => {
                let answer = run()?;
                Ok(Done { out: Out::ok(answer), target: Some(target.to_owned()), result: "ok", approval: Some("sole-admin".into()), detail: params_detail(params) })
            }
            Second::Wait(approval) => {
                let id = approval["id"].as_str().map(str::to_owned);
                Ok(Done { out: Out::ok(json!({ "ok": true, "approval": approval })), target: Some(target.to_owned()), result: "waiting", approval: id, detail: params_detail(params) })
            }
        }
    }

    /// The one "always" row (turning two-person control off, 3.7): an approval whatever the setting, never the
    /// sole-admin path; `no-approver` when nobody could approve.
    pub(crate) fn second_always(&self, who: &Who, action: &str, target: &str, params: &Value, t: i64) -> Result<Done, ApiError> {
        match self.second(who, action, target, params, true, t)? {
            Second::Wait(approval) => {
                let id = approval["id"].as_str().map(str::to_owned);
                Ok(Done { out: Out::ok(json!({ "ok": true, "approval": approval })), target: Some(target.to_owned()), result: "waiting", approval: id, detail: params_detail(params) })
            }
            Second::Single | Second::Sole => Err(ApiError::of("no-approver")),
        }
    }

    /// Carry out an approved action (or a sole-admin or single-admin-setting one) as its requester.
    pub(crate) fn execute(&self, action: &str, target: &str, params: &Value, requester: &str, approver: Option<&str>, t: i64) -> Result<Value, ApiError> {
        match action {
            "admins.invite" => self.run_admin_invite(target, requester, t),
            "admins.role" => self.run_role(target, params, t),
            "admins.remove" => self.run_remove(target, requester, t).map(|(v, _)| v),
            "admins.suspend" => self.run_suspend(target, requester, params, false, t),
            "admins.reset-sign-in" => self.run_reset_sign_in(target, requester, t),
            "settings.profile" => match str_of(params.get("profile")).and_then(crate::console_settings::Profile::parse) {
                Some(p) => self.run_profile(p, t),
                None => Err(ApiError::with("stale", "Nothing was changed: no profile.")),
            },
            "settings.two-person" => self.run_two_person(params),
            "settings.sign-in" => self.run_sign_in(params),
            "settings.aaguids" => self.run_aaguids(params),
            "settings.email" => {
                self.set_mail(crate::console_mail::MailConfig::off(), t)?;
                Ok(json!({ "ok": true }))
            }
            "license.install" => {
                let section = self.section().ok_or_else(|| ApiError::with("license-needed", "This relay has no product section."))?;
                let token = str_of(params.get("license")).unwrap_or("");
                let c = section.license_candidate(token, t)?;
                if c.id() != target {
                    return Err(ApiError::with("stale", "Nothing was changed: the license is not the one asked for."));
                }
                if c.ended {
                    return Err(ApiError::of("license-ended"));
                }
                let v = section.license_install(token, t)?;
                Ok(json!({ "ok": true, "license": v }))
            }
            _ => {
                let section = self.section().ok_or_else(|| ApiError::with("not-found", "There is no such action."))?;
                section.execute(&Approved { action, target, params, requested_by: requester, approved_by: approver, t })
            }
        }
    }

    // ── The approvals routes ────────────────────────────────────────────────────────────────────────────────

    /// GET approvals?state=waiting|all.
    pub(crate) fn approvals_list(&self, who: &Who, state: &str, t: i64) -> Result<Out, ApiError> {
        let mut inner = self.inner.lock();
        if !sweep(&mut inner.book, t).is_empty() {
            let _ = self.save_book(&mut inner);
        }
        let all = state == "all";
        let mut list: Vec<Value> = inner
            .book
            .approvals
            .iter()
            .rev()
            .filter(|a| all || waiting(a))
            .map(|a| {
                let mut v = approval_view(a);
                // A Remote Spokes admin invite, approved: the link goes to its requester (shown, never stored).
                if s(a, "requested_by") == who.email {
                    if let Some((link, _, expires)) = inner.approved_links.get(s(a, "id")) {
                        v["link"] = Value::from(link.as_str());
                        v["linkExpires"] = Value::from(*expires);
                    }
                }
                v
            })
            .collect();
        let total = list.len();
        list.truncate(500);
        Ok(Out::ok(json!({ "ok": true, "approvals": list, "total": total })))
    }

    /// The waiting approval `id`, the caller checked as an eligible approver: (action, target, params, requester).
    pub(crate) fn approval_for_approver(&self, who: &Who, id: &str, t: i64) -> Result<(String, String, Value, String), ApiError> {
        let mut inner = self.inner.lock();
        sweep(&mut inner.book, t);
        let a = inner.book.approvals.iter().find(|a| s(a, "id") == id && waiting(a)).cloned().ok_or_else(|| ApiError::of("gone"))?;
        let (requester, target) = (s(&a, "requested_by").to_owned(), s(&a, "target").to_owned());
        if !who.admin || who.email == requester || who.email == target {
            return Err(ApiError::of("not-eligible"));
        }
        Ok((s(&a, "action").to_owned(), target, a.get("params").cloned().unwrap_or(Value::Null), requester))
    }

    /// POST approvals/approve {id, stepup}: the step-up is bound to `approvals.approve`, the approval id and the
    /// approval's own params; the requester is re-checked; the action runs as the requester.
    pub(crate) fn approve(&self, who: &Who, body: &Value, origin: &str, t: i64) -> Result<Done, ApiError> {
        let id = str_of(body.get("id")).unwrap_or("").to_owned();
        let (action, target, params, requester) = self.approval_for_approver(who, &id, t)?;
        if let Some(section) = self.section() {
            if !section.may_approve(&action, &params, &who.email) {
                return Err(ApiError::of("not-eligible"));
            }
        }
        self.verify_stepup(who, body.get("stepup"), Bind { action: "approvals.approve", target: &id, params: &params }, origin, t)?;
        {
            let mut inner = self.inner.lock();
            if !inner.running.insert(id.clone()) {
                return Err(ApiError::of("gone"));
            }
            let requested_role = inner.book.approvals.iter().find(|a| s(a, "id") == id).map(|a| s(a, "requested_role").to_owned()).unwrap_or_default();
            let still = inner.book.people.get(&requester).is_some_and(|p| p.active_admin() && p.role.as_str() == requested_role);
            if !still {
                inner.running.remove(&id);
                if let Some(a) = inner.book.approvals.iter_mut().find(|a| s(a, "id") == id) {
                    a.insert("state".into(), Value::from("failed"));
                    a.insert("decided_by".into(), Value::from(who.email.as_str()));
                    a.insert("decided_at".into(), Value::from(t));
                    a.insert("result".into(), json!({ "code": "stale" }));
                }
                let _ = self.save_book(&mut inner);
                return Err(ApiError::with("stale", "Nothing was changed: the person who asked is no longer an admin with the same role."));
            }
        }
        let ran = self.execute(&action, &target, &params, &requester, Some(&who.email), t);
        let mut inner = self.inner.lock();
        inner.running.remove(&id);
        let mut view = Value::Null;
        if let Some(a) = inner.book.approvals.iter_mut().find(|a| s(a, "id") == id) {
            a.insert("decided_by".into(), Value::from(who.email.as_str()));
            a.insert("decided_at".into(), Value::from(t));
            match &ran {
                Ok(_) => {
                    a.insert("state".into(), Value::from("done"));
                    a.insert("result".into(), json!({ "ok": true }));
                }
                Err(e) => {
                    a.insert("state".into(), Value::from("failed"));
                    a.insert("result".into(), json!({ "code": e.code, "error": e.message }));
                }
            }
            view = approval_view(a);
        }
        if ran.is_ok() {
            // Other parameters for the same (action, target) no longer apply.
            for a in inner.book.approvals.iter_mut().filter(|a| waiting(a) && s(a, "action") == action && s(a, "target") == target) {
                end(a, "cancelled", "stale", t);
            }
            if action == "admins.invite" {
                if let Ok(v) = &ran {
                    if let (Some(link), Some(expires)) = (v.get("link").and_then(Value::as_str), v.get("expires").and_then(Value::as_i64)) {
                        inner.approved_links.insert(id.clone(), (link.to_owned(), requester.clone(), expires));
                    }
                }
            }
        }
        self.save_book(&mut inner)?;
        drop(inner);
        // The action's own entry, run as the requester with this approval.
        let mut r = Record::new(&requester, &action, if ran.is_ok() { "ok" } else { "failed" });
        r.target = Some(target.clone());
        r.approval = Some(id.clone());
        r.detail = json!({ "approved_by": who.email, "params": params_detail(&params) });
        if let Err(e) = &ran {
            r.detail["code"] = Value::from(e.code);
        }
        self.record(r, t);
        match ran {
            Err(e) => Err(e),
            Ok(_) => Ok(Done { out: Out::ok(json!({ "ok": true, "approval": view })), target: Some(id.clone()), result: "ok", approval: Some(id), detail: json!({ "action": action }) }),
        }
    }

    /// POST approvals/refuse {id, reason, stepup}.
    pub(crate) fn refuse(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(body.get("id")).unwrap_or("").to_owned();
        let reason = reason_of(body.get("reason"))?;
        self.approval_for_approver(who, &id, t)?;
        let mut inner = self.inner.lock();
        let a = inner.book.approvals.iter_mut().find(|a| s(a, "id") == id && waiting(a)).ok_or_else(|| ApiError::of("gone"))?;
        a.insert("state".into(), Value::from("refused"));
        a.insert("decided_by".into(), Value::from(who.email.as_str()));
        a.insert("decided_at".into(), Value::from(t));
        a.insert("decision_reason".into(), Value::from(reason.as_str()));
        let view = approval_view(a);
        self.save_book(&mut inner)?;
        Ok(Done { out: Out::ok(json!({ "ok": true, "approval": view })), target: Some(id.clone()), result: "ok", approval: Some(id), detail: json!({ "reason": reason }) })
    }

    /// POST approvals/cancel {id}: the requester only.
    pub(crate) fn cancel_approval(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(body.get("id")).unwrap_or("").to_owned();
        let mut inner = self.inner.lock();
        sweep(&mut inner.book, t);
        let a = inner.book.approvals.iter_mut().find(|a| s(a, "id") == id && waiting(a)).ok_or_else(|| ApiError::of("gone"))?;
        if s(a, "requested_by") != who.email {
            return Err(ApiError::of("not-eligible"));
        }
        a.insert("state".into(), Value::from("cancelled"));
        a.insert("decided_by".into(), Value::from(who.email.as_str()));
        a.insert("decided_at".into(), Value::from(t));
        let view = approval_view(a);
        self.save_book(&mut inner)?;
        Ok(Done { out: Out::ok(json!({ "ok": true, "approval": view })), target: Some(id.clone()), result: "ok", approval: Some(id), detail: Value::Null })
    }

    // ── Admins (4.3) ────────────────────────────────────────────────────────────────────────────────────────

    /// GET admins (4.3): user managers get no anchors, `invitedBy`, `revokedAt` or `verifiedByHub`.
    pub(crate) fn admins_view(&self, who: &Who, t: i64) -> Out {
        let full = who.admin;
        let inner = self.inner.lock();
        let list = inner.book.settings.aaguid_list();
        let high = inner.book.settings.high();
        let people: Vec<Value> = inner
            .book
            .people
            .iter()
            .filter(|(_, p)| p.state != PersonState::Waiting)
            .map(|(e, p)| {
                let verified = p.passkeys.iter().any(|k| k.works() && k.anchor != crate::console_auth::CONSOLE_ANCHOR && k.anchor != crate::console_auth::OPERATOR_ANCHOR);
                let mut v = json!({
                    "email": e, "role": p.role.as_str(), "state": p.state_str(), "methods": Book::methods_view(p, &list, full, &|k| self.approved_key(k, &list, high)),
                    "lastSignInAt": p.last_sign_in, "invitedAt": p.invited_at, "suspendedBy": p.suspended_by,
                    "suspendReason": p.suspend_reason, "unproven": p.unproven, "breakGlass": p.break_glass,
                });
                if full {
                    v["invitedBy"] = json!(p.invited_by);
                    v["verifiedByHub"] = Value::Bool(verified);
                }
                v
            })
            .collect();
        let waiting_people: Vec<Value> = inner
            .book
            .people
            .iter()
            .filter(|(_, p)| p.state == PersonState::Waiting)
            .map(|(e, p)| json!({ "email": e, "joinedFrom": p.joined_from, "at": p.created, "expires": p.created + crate::console_auth::WAITING_MS }))
            .collect();
        let invites: Vec<Value> = inner
            .book
            .invites
            .values()
            .filter(|i| i.expires > t && i.kind == crate::console_auth::InviteKind::Join && i.source != crate::console_auth::InviteSource::Operator)
            .map(|i| json!({ "email": i.email, "role": i.role.as_str(), "expires": i.expires, "by": i.from_label(), "mailed": i.mailed }))
            .collect();
        Out::ok(json!({ "ok": true, "people": people, "waiting": waiting_people, "invites": invites }))
    }

    fn person(&self, email: &str) -> Option<Person> {
        self.inner.lock().book.people.get(email).cloned()
    }

    fn not_found_person() -> ApiError {
        ApiError::with("not-found", "There is no such person.")
    }

    /// A user manager acts only on viewers and user managers (4.3, `not-manageable`).
    fn manageable(who: &Who, role: PersonRole) -> Result<(), ApiError> {
        if !who.admin && role == PersonRole::Admin {
            return Err(ApiError::of("not-manageable"));
        }
        Ok(())
    }

    /// A viewer or user manager invite: the link shown once; a viewer invite is also mailed when mail is on (user
    /// manager and admin links never are, decision 36).
    fn mint_people_invite(&self, email: &str, role: PersonRole, by: &str, t: i64) -> Result<(String, i64, bool), ApiError> {
        let mail_on = self.mailer.config().mode != crate::console_mail::Mode::Off;
        let mailed = role == PersonRole::Viewer && mail_on;
        let (link, expires) = self.mint_console_token(email, role, by, crate::console_auth::InviteKind::Join, mailed, t)?;
        if mailed {
            let args = [("inviter", by.to_owned()), ("time", crate::codec::iso_time(expires)), ("link", link.clone())];
            self.mailer.enqueue("mail.invite", email, &args);
        }
        Ok((link, expires, mailed))
    }

    /// POST admins/invite {email, role, stepup}: viewers and user managers by an admin or a user manager (one
    /// step-up); admins by an admin only (Remote Spokes a second-admin action, Meeting Hub a request).
    pub(crate) fn admins_invite(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).ok_or_else(|| ApiError::with("invalid", "Give the person's email."))?;
        let role = str_of(body.get("role")).and_then(PersonRole::parse).ok_or_else(|| ApiError::with("invalid", "role is viewer, user-manager or admin."))?;
        if role == PersonRole::Admin && !who.admin {
            return Err(ApiError::of("invite-role"));
        }
        {
            let mut inner = self.inner.lock();
            if inner.book.people.contains_key(&email) {
                return Err(ApiError::with("exists", format!("{email} already has access to this console.")));
            }
            if let Err(o) = inner.limits.hit(Limit::Invites, &who.email, t) {
                let mut e = ApiError::of("invite-limit");
                e.retry_after = Some(o.retry_secs.max(1));
                return Err(e);
            }
        }
        let detail = json!({ "role": role.as_str() });
        if role != PersonRole::Admin {
            let (link, expires, mailed) = self.mint_people_invite(&email, role, &who.email, t)?;
            return Ok(Done { out: Out::ok(json!({ "ok": true, "link": link, "expires": expires, "mailed": mailed })), target: Some(email), result: "ok", approval: None, detail: json!({ "role": role.as_str(), "mailed": mailed }) });
        }
        if self.is_meet() {
            // No console-minted Meeting Hub admin invites: a request to that principal (3.2, M6).
            if self.admin_rule(&email, "") == AdminRule::NotRelayAdmin {
                return Err(ApiError::with("not-relay-admin", format!("On a Meeting Hub relay, admins must be relay admins (relay.json admins). Add {email} there first, or invite them as a viewer.")));
            }
            let request = self.new_request(&who.email, "meet.console-invite", json!({ "principal": email }), "Asked to join the Admin Console as an admin", t)?;
            return Ok(Done { out: Out::ok(json!({ "ok": true, "request": request })), target: Some(email), result: "ok", approval: None, detail });
        }
        let params = json!({ "email": email, "role": "admin" });
        let requester = who.email.clone();
        let target = email.clone();
        self.second_or_run(who, "admins.invite", &email, &params, t, || self.run_admin_invite(&target, &requester, t))
    }

    fn run_admin_invite(&self, email: &str, requester: &str, t: i64) -> Result<Value, ApiError> {
        if self.person(email).is_some() {
            return Err(ApiError::with("stale", format!("Nothing was changed: {email} already has access to this console.")));
        }
        let (link, expires) = self.mint_console_token(email, PersonRole::Admin, requester, crate::console_auth::InviteKind::Join, false, t)?;
        Ok(json!({ "ok": true, "link": link, "expires": expires, "mailed": false }))
    }

    /// POST invites/resend {email, stepup}: a new link replaces the open one (the old token deleted at once), 24 h,
    /// once; mailed again only for a viewer invite.
    pub(crate) fn invites_resend(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let role = {
            let mut inner = self.inner.lock();
            let open = inner.book.invites.values().find(|i| i.email == email && i.expires > t && i.kind == crate::console_auth::InviteKind::Join && i.source == crate::console_auth::InviteSource::Console).map(|i| i.role);
            let role = open.ok_or_else(|| ApiError::with("not-found", "There is no such invite."))?;
            Self::manageable(who, role)?;
            if let Err(o) = inner.limits.hit(Limit::Invites, &who.email, t) {
                let mut e = ApiError::of("invite-limit");
                e.retry_after = Some(o.retry_secs.max(1));
                return Err(e);
            }
            role
        };
        let (link, expires, mailed) = if role == PersonRole::Admin {
            let (l, e) = self.mint_console_token(&email, role, &who.email, crate::console_auth::InviteKind::Join, false, t)?;
            (l, e, false)
        } else {
            self.mint_people_invite(&email, role, &who.email, t)?
        };
        Ok(Done { out: Out::ok(json!({ "ok": true, "link": link, "expires": expires, "mailed": mailed })), target: Some(email), result: "ok", approval: None, detail: json!({ "role": role.as_str(), "mailed": mailed }) })
    }

    /// POST admins/reset-sign-in {email, reason, stepup} (3.3 "Recovery", R3-L2): a viewer's at once; an admin's or user
    /// manager's a second-admin action (two-person on), never one's own. The link is shown, never mailed.
    pub(crate) fn admins_reset_sign_in(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let reason = reason_of(body.get("reason"))?;
        let p = self.person(&email).filter(|p| p.state != PersonState::Waiting).ok_or_else(Self::not_found_person)?;
        let params = json!({ "email": email, "reason": reason });
        if p.role == PersonRole::Viewer {
            let v = self.run_reset_sign_in(&email, &who.email, t)?;
            return Ok(Done { out: Out::ok(v), target: Some(email), result: "ok", approval: None, detail: json!({ "reason": reason, "role": "viewer" }) });
        }
        if email == who.email {
            return Err(ApiError::with("invalid", "You cannot reset your own sign-in."));
        }
        if p.active_admin() && self.inner.lock().book.active_admins() <= 1 {
            return Err(ApiError::of("last-admin"));
        }
        let target = email.clone();
        let requester = who.email.clone();
        let mut d = self.second_or_run(who, "admins.reset-sign-in", &email, &params, t, || self.run_reset_sign_in(&target, &requester, t))?;
        d.detail = json!({ "reason": reason, "role": p.role.as_str() });
        Ok(d)
    }

    /// POST admins/approve-join {email, stepup}: a waiting joiner becomes an active viewer.
    pub(crate) fn approve_join(&self, who: &Who, body: &Value) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let mut inner = self.inner.lock();
        let p = inner.book.people.get_mut(&email).filter(|p| p.state == PersonState::Waiting && email != who.email).ok_or_else(|| ApiError::with("not-waiting", format!("{email} is not waiting for approval.")))?;
        p.state = PersonState::Active;
        p.role = PersonRole::Viewer;
        for k in p.passkeys.iter_mut().filter(|k| k.revoked_at.is_none()) {
            k.state = KeyState::Working;
        }
        let from = p.joined_from.clone();
        self.save_book(&mut inner)?;
        Ok(Done { out: Out::ok(json!({ "ok": true })), target: Some(email), result: "ok", approval: None, detail: json!({ "joinedFrom": from }) })
    }

    /// POST admins/approve-passkey {email, hint, stepup}: an eligible approver (an active admin other than the person)
    /// makes their waiting passkey working; its anchor stays the invite's (N2).
    pub(crate) fn approve_passkey(&self, who: &Who, body: &Value) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let hint = str_of(body.get("hint")).unwrap_or("");
        if email == who.email {
            return Err(ApiError::of("not-eligible"));
        }
        let mut inner = self.inner.lock();
        let not_waiting = || ApiError::with("not-waiting", format!("{email} is not waiting for approval."));
        let p = inner.book.people.get_mut(&email).filter(|p| p.state != PersonState::Waiting).ok_or_else(not_waiting)?;
        let k = p.passkeys.iter_mut().find(|k| crate::console_auth::hint_of(&k.id) == hint && k.state == KeyState::Waiting && k.revoked_at.is_none()).ok_or_else(not_waiting)?;
        k.state = KeyState::Working;
        let anchor = k.anchor.clone();
        self.save_book(&mut inner)?;
        Ok(Done { out: Out::ok(json!({ "ok": true })), target: Some(email), result: "ok", approval: None, detail: json!({ "credential_hint": hint, "anchor": anchor }) })
    }

    /// POST admins/role {email, role, reason, stepup}: between viewer and user manager one admin; to admin, or an admin
    /// to a lower role, a second admin (two-person on); demotion never on the sole-admin path once the console has had
    /// two admins.
    pub(crate) fn admins_role(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let role = str_of(body.get("role")).and_then(PersonRole::parse).ok_or_else(|| ApiError::with("invalid", "role is viewer, user-manager or admin."))?;
        let reason = reason_of(body.get("reason"))?;
        let p = self.person(&email).filter(|p| p.state != PersonState::Waiting).ok_or_else(Self::not_found_person)?;
        if p.role == role {
            return Err(ApiError::with("stale", format!("Nothing was changed: {email} is already {} {}.", if role == PersonRole::Admin { "an" } else { "a" }, role.as_str())));
        }
        if role == PersonRole::Admin {
            self.check_can_be_admin(&email, &p)?;
        } else if p.active_admin() && self.inner.lock().book.active_admins() <= 1 {
            return Err(ApiError::of("last-admin"));
        }
        let params = json!({ "email": email, "role": role.as_str(), "reason": reason });
        let target = email.clone();
        if role != PersonRole::Admin && p.role != PersonRole::Admin {
            let v = self.run_role(&target, &params, t)?;
            return Ok(Done { out: Out::ok(v), target: Some(email), result: "ok", approval: None, detail: params_detail(&params) });
        }
        self.second_or_run(who, "admins.role", &email, &params, t, || self.run_role(&target, &params, t))
    }

    /// Meeting Hub: a relay admin with a working passkey anchored to one of their own devices (2.3, 3.2).
    fn check_can_be_admin(&self, email: &str, p: &Person) -> Result<(), ApiError> {
        if !self.is_meet() || p.break_glass {
            return Ok(());
        }
        if self.admin_rule(email, "") == AdminRule::NotRelayAdmin {
            return Err(ApiError::with("not-relay-admin", format!("On a Meeting Hub relay, admins must be relay admins (relay.json admins). Add {email} there first, or invite them as a viewer.")));
        }
        if !p.passkeys.iter().filter(|k| k.works()).any(|k| self.admin_rule(email, &k.anchor) == AdminRule::Admin) {
            return Err(ApiError::with("not-device-anchored", format!("{email} must first join from their own device in the Meeting Hub app.")));
        }
        Ok(())
    }

    fn run_role(&self, email: &str, params: &Value, t: i64) -> Result<Value, ApiError> {
        let role = str_of(params.get("role")).and_then(PersonRole::parse).ok_or_else(|| ApiError::with("stale", "Nothing was changed: no role."))?;
        let p = self.person(email).filter(|p| p.state != PersonState::Waiting).ok_or_else(|| ApiError::with("stale", format!("Nothing was changed: {email} is no longer in the book.")))?;
        if p.role == role {
            return Err(ApiError::with("stale", format!("Nothing was changed: {email} already has that role.")));
        }
        if role == PersonRole::Admin {
            self.check_can_be_admin(email, &p).map_err(|e| ApiError::with("stale", format!("Nothing was changed: {}", e.message)))?;
        }
        let demoted = p.role == PersonRole::Admin && role != PersonRole::Admin;
        {
            let mut inner = self.inner.lock();
            if demoted && p.active_admin() && inner.book.active_admins() <= 1 {
                return Err(ApiError::with("stale", "Nothing was changed: this would leave the console with no active admin."));
            }
            if let Some(p) = inner.book.people.get_mut(email) {
                p.role = role;
            }
            if demoted {
                inner.book.removed_at.push(t);
                crate::console_approvals::cancel_requested_by(&mut inner.book, email, t);
            }
            inner.end_sessions(email, None);
            self.save_book(&mut inner)?;
        }
        if let Some(s) = self.section() {
            s.people_changed(t);
        }
        Ok(json!({ "ok": true }))
    }

    /// POST admins/remove {email, reason, stepup} or, for a waiting joiner, {email} alone.
    pub(crate) fn admins_remove(&self, who: &Who, body: &Value, origin: &str, t: i64) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let p = self.person(&email).ok_or_else(Self::not_found_person)?;
        if p.state == PersonState::Waiting {
            // Discarding a waiting joiner: at once, no step-up (R2-L5).
            let mut inner = self.inner.lock();
            inner.book.remove_person(&email);
            cancel_for(&mut inner.book, &email, t);
            self.save_book(&mut inner)?;
            return Ok(Done { out: Out::ok(json!({ "ok": true, "removed": email })), target: Some(email), result: "ok", approval: None, detail: json!({ "waiting": true }) });
        }
        let reason = reason_of(body.get("reason"))?;
        let mut params = body.clone();
        if let Some(o) = params.as_object_mut() {
            o.remove("stepup");
        }
        self.verify_stepup(who, body.get("stepup"), Bind { action: "admins.remove", target: str_of(body.get("email")).unwrap_or(""), params: &params }, origin, t)?;
        let params = json!({ "email": email, "reason": reason });
        if !p.admin_role() {
            // A viewer approves nothing: one admin with step-up.
            let (v, cookie) = self.run_remove(&email, &who.email, t)?;
            let mut out = Out::ok(v);
            out.cookie = cookie;
            return Ok(Done { out, target: Some(email), result: "ok", approval: None, detail: params_detail(&params) });
        }
        if p.active_admin() && self.inner.lock().book.active_admins() <= 1 {
            return Err(ApiError::of("last-admin"));
        }
        let target = email.clone();
        let requester = who.email.clone();
        let mut cookie = None;
        let mut done = self.second_or_run(who, "admins.remove", &email, &params, t, || {
            let (v, c) = self.run_remove(&target, &requester, t)?;
            cookie = c;
            Ok(v)
        })?;
        done.out.cookie = cookie;
        Ok(done)
    }

    /// Remove a person: passkeys, sessions, open invites; their approvals cancelled. The answer and, when the remover
    /// removed themselves, the cookie that clears theirs.
    fn run_remove(&self, email: &str, by: &str, t: i64) -> Result<(Value, Option<String>), ApiError> {
        let mut inner = self.inner.lock();
        let Some(p) = inner.book.people.get(email).cloned() else {
            return Err(ApiError::with("stale", format!("Nothing was changed: {email} was already removed.")));
        };
        if p.active_admin() && inner.book.active_admins() <= 1 {
            return Err(ApiError::with("stale", "Nothing was changed: this would leave the console with no active admin."));
        }
        let (passkeys, invites) = inner.book.remove_person(email);
        if p.admin_role() {
            inner.book.removed_at.push(t);
        }
        cancel_for(&mut inner.book, email, t);
        let ended = inner.end_sessions(email, None);
        self.save_book(&mut inner)?;
        drop(inner);
        if let Some(s) = self.section() {
            s.people_changed(t);
        }
        let f = Fields::new().with("email", email).with("by", by).with("methods", passkeys).with("invites", invites).with("sessionsEnded", ended);
        self.logger.security("console.admin-removed", &f, Level::Info);
        let cookie = (email == by).then(|| self.clear_cookie());
        Ok((json!({ "ok": true, "removed": email }), cookie))
    }

    /// POST admins/suspend {email, reason, stepup}: one admin while 2 active admins remain (the requester included),
    /// once a day per requester, not someone unsuspended within 7 days; otherwise a second admin.
    pub(crate) fn admins_suspend(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let reason = reason_of(body.get("reason"))?;
        if email == who.email {
            return Err(ApiError::with("invalid", "You cannot suspend yourself."));
        }
        let p = self.person(&email).filter(|p| p.state != PersonState::Waiting).ok_or_else(Self::not_found_person)?;
        Self::manageable(who, p.role)?;
        if p.state == PersonState::Suspended {
            return Err(ApiError::with("stale", format!("Nothing was changed: {email} is already suspended.")));
        }
        let params = json!({ "email": email, "reason": reason });
        if p.role != PersonRole::Admin {
            // Viewers and user managers approve nothing: one admin or user manager.
            let v = self.run_suspend(&email, &who.email, &params, false, t)?;
            return Ok(Done { out: Out::ok(v), target: Some(email), result: "ok", approval: None, detail: params_detail(&params) });
        }
        if !self.two_person_on() {
            // Two-person off (R4-7): the single-admin limits do not apply; the last-admin rule does.
            if p.active_admin() && self.inner.lock().book.active_admins() <= 1 {
                return Err(ApiError::of("last-admin"));
            }
            let v = self.run_suspend(&email, &who.email, &params, false, t)?;
            return Ok(Done { out: Out::ok(v), target: Some(email), result: "ok", approval: Some("single-admin-setting".into()), detail: params_detail(&params) });
        }
        let (single, used_today) = {
            let inner = self.inner.lock();
            let book = &inner.book;
            let after = book.active_admins() - usize::from(p.active_admin());
            if p.active_admin() && after == 0 {
                return Err(ApiError::of("last-admin"));
            }
            let recent_unsuspend = p.unsuspended_at.is_some_and(|at| t - at < SEVEN_DAYS);
            let used = book.single_suspensions.get(&who.email).is_some_and(|v| v.iter().any(|at| t - *at < DAY));
            (after >= 2 && !recent_unsuspend, used)
        };
        if single {
            if used_today {
                return Err(ApiError::rate(DAY / 1000));
            }
            let v = self.run_suspend(&email, &who.email, &params, true, t)?;
            return Ok(Done { out: Out::ok(v), target: Some(email), result: "ok", approval: None, detail: params_detail(&params) });
        }
        let target = email.clone();
        let requester = who.email.clone();
        self.second_or_run(who, "admins.suspend", &email, &params, t, || self.run_suspend(&target, &requester, &params, false, t))
    }

    fn run_suspend(&self, email: &str, by: &str, params: &Value, single: bool, t: i64) -> Result<Value, ApiError> {
        let mut inner = self.inner.lock();
        let active_admins = inner.book.active_admins();
        let Some(p) = inner.book.people.get_mut(email).filter(|p| p.state == PersonState::Active) else {
            return Err(ApiError::with("stale", format!("Nothing was changed: {email} is not active.")));
        };
        if p.active_admin() && active_admins <= 1 {
            return Err(ApiError::with("stale", "Nothing was changed: this would leave the console with no active admin."));
        }
        p.state = PersonState::Suspended;
        p.suspended_by = Some(by.to_owned());
        p.suspend_reason = str_of(params.get("reason")).map(str::to_owned);
        p.suspended_at = Some(t);
        if single {
            inner.book.single_suspensions.entry(by.to_owned()).or_default().push(t);
        }
        cancel_requested_by(&mut inner.book, email, t);
        inner.end_sessions(email, None);
        self.save_book(&mut inner)?;
        Ok(json!({ "ok": true }))
    }

    /// POST admins/unsuspend {email, stepup}: never by the suspended person.
    pub(crate) fn admins_unsuspend(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        if email == who.email {
            return Err(ApiError::of("not-eligible"));
        }
        {
            let mut inner = self.inner.lock();
            let p = inner.book.people.get_mut(&email).ok_or_else(Self::not_found_person)?;
            Self::manageable(who, p.role)?;
            if p.state != PersonState::Suspended {
                return Err(ApiError::with("stale", format!("Nothing was changed: {email} is not suspended.")));
            }
            p.state = PersonState::Active;
            p.unsuspended_at = Some(t);
            self.save_book(&mut inner)?;
        }
        // A protected person always holds a seat (R3-M6): the product reseats an unsuspended admin at once.
        if let Some(s) = self.section() {
            s.people_changed(t);
        }
        Ok(Done { out: Out::ok(json!({ "ok": true })), target: Some(email), result: "ok", approval: None, detail: Value::Null })
    }

    /// POST invites/revoke {email}: every open join invite for that email (user managers: viewer and user manager
    /// invites only).
    pub(crate) fn invites_revoke(&self, who: &Who, body: &Value) -> Result<Done, ApiError> {
        let email = email_of(str_of(body.get("email"))).unwrap_or_default();
        let mut inner = self.inner.lock();
        let join = |i: &crate::console_auth::Invite| i.email == email && i.kind == crate::console_auth::InviteKind::Join && i.source != crate::console_auth::InviteSource::Operator;
        if !who.admin && inner.book.invites.values().any(|i| join(i) && i.role == PersonRole::Admin) {
            return Err(ApiError::of("not-manageable"));
        }
        let before = inner.book.invites.len();
        inner.book.invites.retain(|_, i| !join(i));
        let n = before - inner.book.invites.len();
        if n == 0 {
            return Err(ApiError::with("not-found", "There is no such invite."));
        }
        self.save_book(&mut inner)?;
        Ok(Done { out: Out::ok(json!({ "ok": true })), target: Some(email), result: "ok", approval: None, detail: json!({ "invites": n }) })
    }

    // ── Requests (3.8) ──────────────────────────────────────────────────────────────────────────────────────

    /// A new request; one waiting per (kind, target), 200 waiting per console, 30 an hour per admin.
    pub(crate) fn new_request(&self, by: &str, kind: &str, target: Value, reason: &str, t: i64) -> Result<Value, ApiError> {
        self.new_request_in(by, kind, target, reason, None, t)
    }

    /// `new_request` for one row of a fleet CSV import (AC-2a 11.3): the requests of one `import` id by one person
    /// count once toward the hourly cap (each still toward the 200 waiting); the id is kept on the request.
    pub(crate) fn new_request_in(&self, by: &str, kind: &str, target: Value, reason: &str, import: Option<&str>, t: i64) -> Result<Value, ApiError> {
        let key = canonical_json(&target).map_err(|e| ApiError::with("invalid", e))?;
        let mut inner = self.inner.lock();
        sweep(&mut inner.book, t);
        if let Some(r) = inner.book.requests.iter().find(|r| waiting(r) && s(r, "kind") == kind && r.get("target").and_then(|v| canonical_json(v).ok()).as_deref() == Some(key.as_slice())) {
            let e = ApiError::of("request-exists");
            let v = Value::Object(r.clone());
            drop(inner);
            return Err(self.with_extra(e, "request", v));
        }
        if inner.book.requests.iter().filter(|r| waiting(r)).count() >= REQUESTS_WAITING_MAX {
            let mut e = ApiError::rate(3600);
            e.message = "Too many requests are waiting. Try again in 60 minutes.".into();
            return Err(e);
        }
        let counted = import.is_some_and(|i| inner.book.requests.iter().any(|r| s(r, "requested_by") == by && s(r, "import") == i && r.get("requested_at").and_then(Value::as_i64).is_some_and(|at| t - at < 3_600_000)));
        if !counted {
            if let Err(o) = inner.limits.hit(Limit::Requests, by, t) {
                return Err(ApiError::rate(o.retry_secs));
            }
        }
        let id = hex_id("rq_")?;
        let mut r = Map::new();
        for (k, v) in [
            ("id", Value::from(id.as_str())),
            ("kind", Value::from(kind)),
            ("target", target),
            ("reason", Value::from(reason)),
            ("requested_by", Value::from(by)),
            ("requested_at", Value::from(t)),
            ("expires_at", Value::from(t + REQUEST_MS)),
            ("state", Value::from("waiting")),
            ("done_at", Value::Null),
            ("observed", Value::Null),
        ] {
            r.insert(k.into(), v);
        }
        if let Some(i) = import {
            r.insert("import".into(), Value::from(i));
        }
        let v = Value::Object(r.clone());
        inner.book.requests.push(r);
        self.save_book(&mut inner)?;
        Ok(v)
    }

    /// POST requests/new {kind, target, reason}.
    pub(crate) fn requests_new(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        self.requests_new_with(who, body, None, t)
    }

    /// AC-2a 11.2 (decision 11): POST requests/new from a fleet call (fleet_exec). An admin as `requests_new`; a user
    /// manager roster entry only for kind `meet.invite` (the one widening of AC-1 4.4; the relay's own sessions keep
    /// the dispatcher's Admin row). An optional `importId` (11.3) makes the rows of one import count once toward the
    /// hourly cap.
    pub fn requests_new_fleet(&self, who: &Who, body: &Value, t: i64) -> Result<Done, ApiError> {
        let kind = str_of(body.get("kind")).unwrap_or("");
        if !who.admin && !(who.manager && kind == "meet.invite") {
            return Err(ApiError::of("role"));
        }
        let import = str_of(body.get("importId")).filter(|i| (1..=64).contains(&i.len()) && i.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        if body.get("importId").is_some() && import.is_none() {
            return Err(ApiError::with("invalid", "importId is the id of a CSV check."));
        }
        self.requests_new_with(who, body, import, t)
    }

    /// AC-2a 11.2: GET requests from a fleet call: admins see every request; a user manager (to remind and cancel
    /// invites) only `meet.invite` requests.
    pub fn requests_list_fleet(&self, who: &Who, state: &str, kind: &str, t: i64) -> Result<Out, ApiError> {
        if who.admin {
            return Ok(self.requests_list(state, kind, t));
        }
        if !who.manager || !(kind.is_empty() || kind == "meet.invite") {
            return Err(ApiError::of("role"));
        }
        Ok(self.requests_list(state, "meet.invite", t))
    }

    fn requests_new_with(&self, who: &Who, body: &Value, import: Option<&str>, t: i64) -> Result<Done, ApiError> {
        let kind = str_of(body.get("kind")).unwrap_or("");
        let prefix = if self.is_meet() { "meet." } else { "rs." };
        let kinds: &[&str] = if self.is_meet() { &["meet.approve", "meet.revoke", "meet.invite"] } else { &["rs.revoke", "rs.renew", "rs.seat"] };
        if !kind.starts_with(prefix) || !kinds.contains(&kind) {
            return Err(ApiError::with("invalid", format!("kind is one of {}.", kinds.join(", "))));
        }
        let reason = reason_of(body.get("reason"))?;
        let security = kind == "rs.revoke" || kind == "meet.revoke";
        if !security {
            self.need_product_license(t)?;
        }
        let section = self.section().ok_or_else(|| ApiError::with("invalid", "This relay has no product section."))?;
        let target = section.request_target(kind, body.get("target").unwrap_or(&Value::Null))?;
        let request = self.new_request_in(&who.email, kind, target, &reason, import, t)?;
        let id = request["id"].as_str().unwrap_or("").to_owned();
        Ok(Done { out: Out::ok(json!({ "ok": true, "request": request })), target: Some(id), result: "ok", approval: None, detail: json!({ "kind": kind, "reason": reason }) })
    }

    /// GET requests?state=&kind=.
    pub(crate) fn requests_list(&self, state: &str, kind: &str, t: i64) -> Out {
        let mut inner = self.inner.lock();
        if !sweep(&mut inner.book, t).is_empty() {
            let _ = self.save_book(&mut inner);
        }
        let list: Vec<Value> = inner.book.requests.iter().rev().filter(|r| (state.is_empty() || state == "all" || s(r, "state") == state) && (kind.is_empty() || s(r, "kind") == kind)).map(|r| Value::Object(r.clone())).collect();
        let total = list.len();
        Out::ok(json!({ "ok": true, "requests": list.into_iter().take(500).collect::<Vec<_>>(), "total": total }))
    }

    /// The waiting request `id` and whether the caller asked for it.
    pub(crate) fn request_owner(&self, id: &str) -> Option<String> {
        self.inner.lock().book.requests.iter().find(|r| s(r, "id") == id && waiting(r)).map(|r| s(r, "requested_by").to_owned())
    }

    /// POST requests/cancel {id} (own) or {id, stepup} (another admin's, checked by the caller of this).
    pub(crate) fn requests_cancel(&self, body: &Value, t: i64) -> Result<Done, ApiError> {
        let id = str_of(body.get("id")).unwrap_or("").to_owned();
        let mut inner = self.inner.lock();
        let r = inner.book.requests.iter_mut().find(|r| s(r, "id") == id && waiting(r)).ok_or_else(|| ApiError::of("gone"))?;
        r.insert("state".into(), Value::from("cancelled"));
        r.insert("done_at".into(), Value::from(t));
        let v = Value::Object(r.clone());
        self.save_book(&mut inner)?;
        Ok(Done { out: Out::ok(json!({ "ok": true, "request": v })), target: Some(id), result: "ok", approval: None, detail: Value::Null })
    }

    /// The waiting requests whose kind starts with `prefix` (the signing side's read routes).
    pub fn requests_waiting(&self, prefix: &str, t: i64) -> Vec<Value> {
        let mut inner = self.inner.lock();
        if !sweep(&mut inner.book, t).is_empty() {
            let _ = self.save_book(&mut inner);
        }
        inner.book.requests.iter().filter(|r| waiting(r) && s(r, "kind").starts_with(prefix)).map(|r| Value::Object(r.clone())).collect()
    }

    /// The relay observed an outcome: every waiting request of `kind` whose target `matches` is done (3.8). How many.
    pub fn observe_requests(&self, kind: &str, by: &str, t: i64, matches: &dyn Fn(&Value) -> bool) -> usize {
        let done: Vec<(String, Value)> = {
            let mut inner = self.inner.lock();
            let mut done = Vec::new();
            for r in inner.book.requests.iter_mut().filter(|r| waiting(r) && s(r, "kind") == kind) {
                if r.get("target").is_some_and(matches) {
                    r.insert("state".into(), Value::from("done"));
                    r.insert("done_at".into(), Value::from(t));
                    r.insert("observed".into(), json!({ "at": t, "by": by }));
                    done.push((s(r, "id").to_owned(), r.get("target").cloned().unwrap_or(Value::Null)));
                }
            }
            if !done.is_empty() {
                let _ = self.save_book(&mut inner);
            }
            done
        };
        for (id, _) in &done {
            let mut r = Record::new("relay", "requests.done", "ok");
            r.target = Some(id.clone());
            r.detail = json!({ "kind": kind, "by": by });
            self.record(r, t);
        }
        done.len()
    }

    /// Meeting Hub: an admin in the Hub app declines a request (it only closes the to-do).
    pub fn decline_request(&self, id: &str, by: &str, reason: &str, t: i64) -> Result<Value, ApiError> {
        let reason = reason_of(Some(&Value::from(reason)))?;
        let v = {
            let mut inner = self.inner.lock();
            let r = inner.book.requests.iter_mut().find(|r| s(r, "id") == id && waiting(r) && s(r, "kind").starts_with("meet.")).ok_or_else(|| ApiError::of("gone"))?;
            r.insert("state".into(), Value::from("declined"));
            r.insert("done_at".into(), Value::from(t));
            r.insert("observed".into(), json!({ "at": t, "by": by, "reason": reason }));
            let v = Value::Object(r.clone());
            self.save_book(&mut inner)?;
            v
        };
        let mut r = Record::new(by, "requests.decline", "ok");
        r.target = Some(id.to_owned());
        r.detail = json!({ "reason": reason });
        self.record(r, t);
        Ok(v)
    }

    /// Whether `email` is an active console admin (Remote Spokes: who may read requests, 4.10).
    pub fn is_active_admin(&self, email: &str) -> bool {
        self.inner.lock().book.people.get(email).is_some_and(Person::active_admin)
    }

    /// Every active console admin's email (the products' notices go to them, I12).
    pub fn active_admin_emails(&self) -> Vec<String> {
        self.inner.lock().book.people.iter().filter(|(_, p)| p.active_admin()).map(|(e, _)| e.clone()).collect()
    }

    /// I14: whether `email` may read people and seats (an active user manager or an active admin, by role).
    pub fn check_console_reader(&self, email: &str) -> bool {
        self.inner.lock().book.people.get(email).is_some_and(|p| p.active() && p.role != PersonRole::Viewer)
    }
}

/// What the audit keeps of an action's parameters: the reason and plain fields, never secrets (6 "Never in an entry").
pub fn params_detail(params: &Value) -> Value {
    const NEVER: [&str; 17] = ["stepup", "license", "crl", "crl_pem", "directory", "credential", "token", "files", "password", "current", "code", "totp", "secret", "blob", "smtp", "graph", "keyPem"];
    match params.as_object() {
        Some(o) => Value::Object(o.iter().filter(|(k, _)| !NEVER.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::console_auth::{Passkey, Person};

    const T0: i64 = 1_800_000_000_000;

    fn person(role: PersonRole, state: PersonState) -> Person {
        let mut p = Person::new("h".into(), role, state, "0a", T0);
        p.passkeys.push(Passkey { id: "AQ".into(), cose: "x".into(), count: 0, label: "L".into(), created: T0, last_used: T0, state: KeyState::Working, anchor: "0a".into(), invited_by: None, revoked_at: None, rk: Some(true), from: None, kind: crate::console_auth::KeyKind::Passkey, verdict: None });
        p
    }

    #[test]
    fn the_sole_admin_path_checks_all_four_conditions() {
        let mut b = Book::default();
        b.people.insert("a@x.example".into(), person(PersonRole::Admin, PersonState::Active));
        // Alone: the path is open.
        assert!(sole_admin_ok(&b, "a@x.example", "new@x.example", false, T0));
        // A waiting joiner does not count; a viewer does not count.
        b.people.insert("j@x.example".into(), person(PersonRole::Viewer, PersonState::Waiting));
        b.people.insert("v@x.example".into(), person(PersonRole::Viewer, PersonState::Active));
        assert!(sole_admin_ok(&b, "a@x.example", "new@x.example", false, T0));
        // Another admin-role person in any state closes it (a revoked one too, R2-L7).
        let mut revoked = person(PersonRole::Admin, PersonState::Active);
        revoked.passkeys[0].revoked_at = Some(T0);
        b.people.insert("r@x.example".into(), revoked);
        assert!(!sole_admin_ok(&b, "a@x.example", "new@x.example", false, T0));
        // ...unless it is the target.
        assert!(sole_admin_ok(&b, "a@x.example", "r@x.example", false, T0));
        // Condition 4: never the removal of another admin once the console has had two.
        b.latch_two();
        assert!(b.ever_two_admins);
        assert!(!sole_admin_ok(&b, "a@x.example", "r@x.example", true, T0));
        // Condition 2: nobody suspended, no removal or demotion in 7 days.
        b.people.shift_remove("r@x.example");
        b.removed_at.push(T0);
        assert!(!sole_admin_ok(&b, "a@x.example", "new@x.example", false, T0 + 6 * DAY));
        assert!(sole_admin_ok(&b, "a@x.example", "new@x.example", false, T0 + 7 * DAY));
        b.people.insert("s@x.example".into(), person(PersonRole::Admin, PersonState::Suspended));
        assert!(!sole_admin_ok(&b, "a@x.example", "new@x.example", false, T0 + 8 * DAY));
        assert!(!sole_admin_ok(&b, "a@x.example", "s@x.example", false, T0 + 8 * DAY));
        b.people.shift_remove("s@x.example");
        // Condition 3: an approval about the requester waits.
        let mut a = Map::new();
        a.insert("state".into(), Value::from("waiting"));
        a.insert("target".into(), Value::from("a@x.example"));
        b.approvals.push(a);
        assert!(!sole_admin_ok(&b, "a@x.example", "new@x.example", false, T0 + 8 * DAY));
    }

    #[test]
    fn approvals_and_requests_expire_and_cancel() {
        let mut b = Book::default();
        let mk = |id: &str, by: &str, target: &str| {
            let mut a = Map::new();
            for (k, v) in [("id", id), ("state", "waiting"), ("requested_by", by), ("target", target), ("action", "admins.remove")] {
                a.insert(k.into(), Value::from(v));
            }
            a.insert("requested_at".into(), Value::from(T0));
            a.insert("expires_at".into(), Value::from(T0 + APPROVAL_MS));
            a
        };
        b.approvals.push(mk("ap_1", "a@x.example", "b@x.example"));
        b.approvals.push(mk("ap_2", "c@x.example", "d@x.example"));
        b.approvals.push(mk("ap_3", "e@x.example", "a@x.example"));
        assert_eq!(cancel_requested_by(&mut b, "a@x.example", T0), vec!["ap_1".to_owned()]);
        assert_eq!(cancel_for(&mut b, "a@x.example", T0), vec!["ap_3".to_owned()]);
        assert_eq!(sweep(&mut b, T0 + APPROVAL_MS), vec![("ap_2".to_owned(), "admins.remove".to_owned())]);
        assert!(b.approvals.iter().all(|a| !waiting(a)));
        sweep(&mut b, T0 + APPROVALS_KEPT_MS + 1);
        assert!(b.approvals.is_empty());
    }

    #[test]
    fn audit_detail_never_keeps_secrets() {
        let d = params_detail(&json!({ "license": "tok", "reason": "r", "stepup": {}, "crl": "x", "node": "n_1" }));
        assert_eq!(d, json!({ "reason": "r", "node": "n_1" }));
    }

    fn who(role: PersonRole) -> Who {
        let (admin, manager) = (role == PersonRole::Admin, role != PersonRole::Viewer);
        let rights = match role {
            PersonRole::Admin => crate::console_settings::Rights::Admin,
            PersonRole::UserManager => crate::console_settings::Rights::Manager,
            _ => crate::console_settings::Rights::Viewer,
        };
        Who { sid: "s".into(), email: "um@x.example".into(), role, rights, why: None, admin, manager }
    }

    fn headless(name: &str) -> std::sync::Arc<Console> {
        let d = std::env::temp_dir().join(format!("lucid-approvals-fleet-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        crate::console::open_headless(crate::license::Product::Meet, &d, std::sync::Arc::new(crate::log::Logger::capture("t", Box::new(|_, _| {})))).unwrap()
    }

    /// AC-2a 16.1 f-relay (11.2, decision 11): a user manager may ask for `meet.invite` through a fleet call and for
    /// nothing else; viewers for nothing; the relay's own sessions keep the dispatcher's Admin row.
    #[test]
    fn ac2a_the_user_manager_invite_widening_applies_to_fleet_calls_only() {
        let c = headless("widening");
        let invite = json!({ "kind": "meet.invite", "target": { "name": "Bo", "email": "bo@x.example", "days": 7 }, "reason": "New hire" });
        let revoke = json!({ "kind": "meet.revoke", "target": { "principal": "bo@x.example", "device": "aaaaaaaaaaaaaaaa" }, "reason": "Lost" });
        let code = |r: Result<Done, ApiError>| r.err().map(|e| e.code);
        // past the role check the invite meets the relay's own rules (no section in this bare console), never `role`
        assert_ne!(code(c.requests_new_fleet(&who(PersonRole::UserManager), &invite, T0)), Some("role"));
        assert_eq!(code(c.requests_new_fleet(&who(PersonRole::UserManager), &revoke, T0)), Some("role"));
        assert_eq!(code(c.requests_new_fleet(&who(PersonRole::Viewer), &invite, T0)), Some("role"));
        assert_ne!(code(c.requests_new_fleet(&who(PersonRole::Admin), &revoke, T0)), Some("role"));
        // the relay's own console: requests/new stays an admin route
        let row = crate::console::CORE_ROUTES.iter().find(|r| r.method == "POST" && r.path == "requests/new").unwrap();
        assert_eq!(row.role, crate::console::Role::Admin);
        // reading: a user manager sees invites only
        assert!(c.requests_list_fleet(&who(PersonRole::UserManager), "waiting", "", T0).is_ok());
        assert_eq!(c.requests_list_fleet(&who(PersonRole::UserManager), "waiting", "meet.revoke", T0).err().map(|e| e.code), Some("role"));
        assert_eq!(c.requests_list_fleet(&who(PersonRole::Viewer), "waiting", "", T0).err().map(|e| e.code), Some("role"));
    }

    /// AC-2a 11.3: the requests of one CSV import count once toward the hourly cap of 30, each toward the waiting cap.
    #[test]
    fn ac2a_one_import_counts_once_toward_the_hourly_cap() {
        let c = headless("import");
        let target = |i: usize| json!({ "email": format!("p{i}@x.example") });
        for i in 0..40 {
            c.new_request_in("um@x.example", "meet.invite", target(i), "Import", Some("imp1"), T0 + i as i64).unwrap();
        }
        // 29 single requests still fit beside the one import
        for i in 40..69 {
            c.new_request_in("um@x.example", "meet.invite", target(i), "One", None, T0 + i as i64).unwrap();
        }
        assert_eq!(c.new_request_in("um@x.example", "meet.invite", target(99), "One", None, T0 + 100).err().map(|e| e.code), Some("rate"));
    }
}
