// Phase C (ADR-0540): the Meet relay's route tables (meet_relay.Handler.do_GET and do_POST), each route reading its
// caller, body and gate in the order the Python handler does, so the same request gets the same first refusal.

use crate::meet::{self as m, run, Ctx, R, CAPTIONS_LIMIT_MAX};
use crate::meet_hub::{ai, bridge, ce, files, parity, pc, push, E2EE_BODY_MAX, E2EE_ROSTER_BODY_MAX};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_tls::{crl_path, read_bytes};
use crate::meet_x509::pem_blocks;
use serde_json::Value;
use std::panic::AssertUnwindSafe;

type Route = fn(&mut Ctx) -> R<Obj>;

fn get_route(path: &str) -> Option<Route> {
    let route: Route = match path {
        // AC-1 4.10: the signing side reads the Admin Console's meet.* requests
        "/v1/admin/console/requests" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.relay.hub.check_admin(&session, &who)?;
            Ok(crate::console_meet::requests_for(c.relay, &who.principal))
        },
        // AI-1 6.6: the kept personal-access audit records, for the Admin Console's Usage
        "/v1/admin/ai/audit" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.relay.hub.check_admin(&session, &who)?;
            let since = m::number(Some(&Value::from(c.q("since", "0"))), "since")?.trunc() as i64;
            let cursor = c.q("cursor", "");
            c.relay.hub.ai_audit_list(&c.q("org", ""), since, Some(cursor.as_str()))
        },
        // AC-2a 5.7 (F13): whether this relay runs its own console and which Lucid Admin Console manages it
        "/v1/admin/console/where" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.relay.hub.check_admin(&session, &who)?;
            Ok(crate::console_meet::console_where(c.relay))
        },
        // AC-2a 3.9 (F20): the caller's first-roster entries, for the Hub app to endorse
        "/v1/admin/console/fleet-bootstrap" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            // AC-2a 3.9: the Meeting Hub endorsement routes are relay admins' (check_admin), as on the reference relay
            c.relay.hub.check_admin(&session, &who)?;
            crate::console_meet::fleet_bootstrap(c.relay, &who)
        },
        "/v1/whoami" => whoami,
        "/v1/events" => events,
        "/v1/inbox" => inbox,
        // NT-1 section 4.3: the iPhone's background read-mark fetch (own device, no session)
        "/v1/notify/reads" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.notify_reads(&who)
        },
        "/v1/dm/history" => dm_history,
        "/v1/channels" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.channels_list(&session, &who)
        },
        "/v1/channels/history" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.channel_history(&session, &who, &c.q("id", ""), &c.q("after", "0"), &c.q("thread", ""), &c.q("limit", "200"))
        },
        "/v1/pins" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let (peer, session) = (c.q("peer", ""), c.q("session", ""));
            c.gate(&who, None, &peer, &session)?;
            let opt = |v: String| Some(v).filter(|v| !v.is_empty());
            c.relay.hub.pins(&who, &c.q("scope", ""), opt(session), opt(peer), opt(c.q("with", "")), opt(c.q("channel", "")))
        },
        "/v1/search" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.search(&session, &who, &c.q("q", ""), &c.q("limit", "20"))
        },
        "/v1/meetings" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.meetings_list(&session, &who, &c.q("from", ""), &c.q("to", ""))
        },
        "/v1/room/history" => room_history,
        "/v1/room/captions" => room_captions,
        // parity wave A
        "/v1/prefs" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.prefs_get(&session, &who)
        },
        "/v1/attendance" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.attendance(&session, &who, &c.q("room", ""))
        },
        "/v1/emoji" => emoji_list,
        "/v1/emoji/file" => emoji_file,
        "/v1/admin/renewals" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.admin_renewals(&c.q("session", ""), &who)
        },
        "/v1/enroll/status" => |c: &mut Ctx| {
            let who = c.who(true)?;
            c.relay.hub.enroll_status(&who)
        },
        "/v1/admin/enrollments" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.admin_enrollments(&c.q("session", ""), &who)
        },
        "/v1/devices/add/status" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.devices_add_status(&c.q("session", ""), &who, &c.q("request", ""))
        },
        "/v1/admin/seed-requests" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.admin_seed_requests(&c.q("session", ""), &who)
        },
        "/v1/admin/devices" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.admin_devices(&c.q("session", ""), &who)
        },
        "/v1/admin/pending" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.admin_pending(&c.q("session", ""), &who)
        },
        "/v1/admin/signer" => |c: &mut Ctx| {
            let since = c.q("since", "");
            let who = c.who(false)?;
            let since = if since.is_empty() { None } else { Some(m::py_int(&since)?) };
            c.relay.admin_signer(&c.q("session", ""), &who, &c.q("op", ""), since)
        },
        "/v1/admin/organizations" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.admin_organizations(&c.q("session", ""), &who)
        },
        "/v1/version" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.version(&c.q("session", ""), &who)
        },
        "/healthz" => |_: &mut Ctx| Ok(obj([("ok", Value::Bool(true))])),
        // wave3:files
        "/v1/files/get" => files_get,
        "/v1/files/list" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.gate(&who, None, &c.q("peer", ""), &c.q("session", ""))?;
            let q = |name: &str| Some(c.q(name, "")).filter(|v| !v.is_empty());
            c.relay.hub.files_list(&who, &c.q("scope", ""), q("peer"), q("session"), q("with"), q("channel"), q("room"))
        },
        // wave3:meeting-tools
        "/v1/polls/mine" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.gate(&who, None, &c.q("peer", ""), &c.q("session", ""))?;
            let q = |name: &str| Some(c.q(name, "")).filter(|v| !v.is_empty());
            c.relay.hub.tools_polls_mine(&who, &c.q("ids", ""), q("session"), q("peer"))
        },
        "/v1/board" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let peer = c.q("peer", "");
            c.gate(&who, None, &peer, "")?;
            c.relay.hub.tools_board_view(&peer, &who)
        },
        // wave3:large-calls
        "/v1/crl" => crl,
        // wave3:guests
        "/v1/lobby" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let peer = c.q("peer", "");
            c.gate(&who, None, &peer, "")?;
            c.relay.hub.guests_lobby_list(&peer, &who)
        },
        "/v1/lobby/wait" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.guests_lobby_wait(&c.q("wait", ""), &who, &c.q("room", ""))
        },
        // bridges
        "/v1/bridge/links" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.bridge_links(&session, &who, &c.q("channel", ""))
        },
        "/v1/admin/bridge" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.bridge_admin(&c.q("session", ""), &who)
        },
        "/v1/admin/bridge/audit" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.bridge_audit(&c.q("session", ""), &who, &c.q("after", "0"), &c.q("limit", "200"))
        },
        "/v1/bridge/c/outbox" => |c: &mut Ctx| {
            let who = connector(c)?;
            c.relay.hub.bridge_c_outbox(&who, &c.q("after", "0"), &c.q("wait", "0"))
        },
        "/v1/bridge/c/file" => bridge_file_get,
        // wave3:chat-e2ee
        "/v1/chat/devices" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.ce_devices_get(&session, &who, &c.q("p", ""))
        },
        "/v1/chat/keys" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.ce_keys_get(&session, &who, &c.q("after", "0"), &c.q("limit", "500"))
        },
        "/v1/chat/log" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.ce_log_get(&session, &who, &c.q("cid", ""), &c.q("after", "0"), &c.q("limit", "500"))
        },
        // parity wave C
        "/v1/org/policy" => |c: &mut Ctx| {
            c.who(false)?;
            c.relay.hub.pc_policy_get(&c.q("org", ""), &c.q("sha256", ""))
        },
        // AI-1 2: org AI maps, only to people the org's current policy covers and its ai app
        "/v1/org/ai" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.pc_ai_get_for(&who, &c.q("org", ""), &c.q("sha256", ""))
        },
        // AI-1 6.4 and 7.6: who may use org AI, and AI history
        "/v1/ai/allowed" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.ai_allowed(&who, &c.q("principal", ""))
        },
        "/v1/ai/history" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let limit = ai::HISTORY_LIMIT.to_string();
            c.relay.hub.ai_history_get(&c.q("session", ""), &who, &c.q("cid", ""), &c.q("after", "0"), &c.q("limit", &limit))
        },
        // SD-1 13.5: org storage maps, only to people the org's current policy covers
        "/v1/org/storage" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.sd_storage_get(&who, &c.q("org", ""), &c.q("sha256", ""))
        },
        "/v1/apps" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            c.relay.hub.pc_apps(&session, &who)
        },
        "/v1/apps/icon" => |c: &mut Ctx| {
            c.who(false)?;
            let (headers, body) = c.relay.hub.pc_icon_get(&c.q("sha256", ""))?;
            c.raw = Some(m::Raw::Bytes(headers, body));
            Ok(Obj::new())
        },
        "/v1/org/background" => |c: &mut Ctx| {
            c.who(false)?;
            let (headers, body) = c.relay.hub.pc_background_get(&c.q("sha256", ""))?;
            c.raw = Some(m::Raw::Bytes(headers, body));
            Ok(Obj::new())
        },
        "/v1/apps/c/events" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.pc_apps_events(&c.q("session", ""), &who, &c.q("after", "0"), &c.q("wait", &(pc::EVENTS_WAIT as i64).to_string()))
        },
        "/v1/admin/holds" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.pc_holds_list(&c.q("session", ""), &who)
        },
        "/v1/sso/asks" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.pc_sso_asks(&c.q("session", ""), &who)
        },
        "/v1/docs/history" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            let q = |name: &str| Some(c.q(name, "")).filter(|v| !v.is_empty());
            c.relay.hub.pc_docs_history(&session, &who, &c.q("scope", ""), q("with"), q("channel"), &c.q("doc", ""), &c.q("after", "0"), &c.q("limit", "500"))
        },
        "/v1/docs/list" => |c: &mut Ctx| {
            let who = c.who(false)?;
            let session = c.q("session", "");
            c.gate(&who, None, "", &session)?;
            let q = |name: &str| Some(c.q(name, "")).filter(|v| !v.is_empty());
            c.relay.hub.pc_docs_list(&session, &who, &c.q("scope", ""), q("with"), q("channel"))
        },
        _ => return None,
    };
    Some(route)
}

fn post_route(path: &str) -> Option<Route> {
    let route: Route = match path {
        "/v1/join" => join,
        "/v1/signal" => signal,
        "/v1/link" => link,
        "/v1/chat" => chat,
        "/v1/chat/edit" => |c: &mut Ctx| chat_change(c, false),
        "/v1/chat/delete" => |c: &mut Ctx| chat_change(c, true),
        "/v1/typing" => typing,
        "/v1/stage" => stage,
        "/v1/status" => status,
        "/v1/activity" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.activity(&session, &who, b.get("active"))
        },
        "/v1/admin/organizations" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.admin_set_organization(&pj::s(&b, "session"), &who, b.get("principal"), b.get("id"), b.get("label"), b.get("remove"))
        },
        "/v1/caption" => caption,
        "/v1/captions" => captions,
        "/v1/room/options" => room_options,
        "/v1/leave" => leave,
        "/v1/ice" => ice,
        "/v1/hello" => hello,
        "/v1/bye" => bye,
        "/v1/dm" => dm,
        "/v1/dm/read" => dm_read,
        "/v1/react" => react,
        "/v1/channels" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_create(&session, &who, b.get("kind"), b.get("name"), b.get("topic"), b.get("members"), b.get("id"), b.get("bridgeable"), b.get("log"))
        },
        "/v1/channels/join" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_join(&session, &who, b.get("id"), b.get("log"))
        },
        "/v1/channels/leave" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_leave(&session, &who, b.get("id"), b.get("log"))
        },
        "/v1/channels/archive" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_archive(&session, &who, b.get("id"))
        },
        "/v1/channels/invite" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_invite(&session, &who, b.get("id"), b.get("principals"), b.get("log"))
        },
        "/v1/channels/update" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_update(&session, &who, b.get("id"), b.get("name"), b.get("topic"))
        },
        "/v1/channels/post" => |c: &mut Ctx| {
            let (who, b, session) = session_gate_max(c, ce::BODY_MAX)?;
            if b.contains_key("enc") {
                return c.relay.hub.ce_post(&who, "channel", post(&b, Some(session), None));
            }
            c.relay.hub.channel_post(&session, &who, b.get("id"), b.get("text"), b.get("reply_to"), b.get("mentions"), b.get("thread"), b.get("also_channel"), b.get("preview"), b.get("fwd"))
        },
        "/v1/channels/read" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_read_mark(&session, &who, b.get("id"), b.get("ts"))
        },
        "/v1/pins" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
            c.relay.hub.pin(&who, &pj::s(&b, "scope"), &pj::s(&b, "id"), b.get("on"), opt(&b, "session"), opt(&b, "peer"), opt(&b, "with"), opt(&b, "channel"))
        },
        "/v1/meetings" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.meeting_create(&session, &who, b.get("title"), b.get("start"), b.get("end"), b.get("attendees"), b.get("description"), b.get("recurrence"), b.get("tz"), b.get("cohosts"))
        },
        "/v1/meetings/update" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            let changes: Obj = ["title", "start", "end", "attendees", "description", "recurrence", "tz", "cohosts"].iter().filter_map(|k| b.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
            c.relay.hub.meeting_update(&session, &who, b.get("id"), &changes)
        },
        "/v1/meetings/cancel" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.meeting_cancel(&session, &who, b.get("id"))
        },
        "/v1/meetings/rsvp" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.meeting_rsvp(&session, &who, b.get("id"), b.get("response"))
        },
        "/v1/invite" => invite,
        // NT-1 section 3.5: the caller's own device declines one of their invitations
        "/v1/invite/settle" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.hub.nt_own_device(&who)?;
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.invite_settle(&session, &who, b.get("id"), b.get("how"))
        },
        // parity wave A
        "/v1/prefs" => |c: &mut Ctx| {
            let (who, b, session) = session_gate_max(c, parity::PREFS_BODY_MAX)?;
            c.relay.hub.prefs_set(&session, &who, &b)
        },
        "/v1/emoji" => |c: &mut Ctx| {
            let (who, b, session) = session_gate_max(c, parity::EMOJI_BODY_MAX)?;
            c.relay.hub.emoji_add(&session, &who, b.get("name"), b.get("image"))
        },
        "/v1/emoji/delete" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.emoji_delete(&session, &who, b.get("name"))
        },
        // parity wave B and NT-1 section 3.2: iPhone push (bound to the calling device; no session needed)
        "/v1/push/register" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.push_register(&who, &b)
        },
        "/v1/push/unregister" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.body()?;
            c.relay.hub.push_unregister(&who)
        },
        "/v1/recording" => recording,
        "/v1/recording/policy" => recording_policy,
        "/v1/recording/consent" => recording_consent,
        "/v1/renew" => renew,
        "/v1/renew/ack" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.renew_ack(&pj::s(&b, "session"), &who)
        },
        "/v1/admin/renewed" => admin_renewed,
        "/v1/enroll" => enroll,
        "/v1/admin/enrolled" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.admin_enrolled(&pj::s(&b, "session"), &who, &pj::s(&b, "seed_serial"), b.get("cert_pem"), b.get("ca_pem"), b.get("refused"))
        },
        "/v1/devices/add" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.devices_add(&pj::s(&b, "session"), &who, b.get("csr_pem"), b.get("label"), b.get("chain"), b.get("proof"), b.get("ts"))
        },
        "/v1/admin/seeded" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.admin_seeded(&pj::s(&b, "session"), &who, &pj::s(&b, "request"), b.get("cert_pem"), b.get("ca_pem"), b.get("refused"))
        },
        "/v1/admin/crl" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.push_crl(&pj::s(&b, "session"), &who, b.get("crl_pem"))
        },
        "/v1/admin/ca" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.push_ca(&pj::s(&b, "session"), &who, b.get("ca_pem"))
        },
        "/v1/admin/approve" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            let link = console_request(c, &who, &b)?;
            let answer = c.relay.hub.admin_approve(&pj::s(&b, "session"), &who, &pj::s(&b, "kind"), &pj::s(&b, "id"), &pj::s(&b, "csr_sha256"), &pj::s(&b, "decision"), b.get("reason"), b.get("proof"), b.get("ts"))?;
            let target = obj([("kind", Value::from(pj::s(&b, "kind"))), ("id", Value::from(pj::s(&b, "id"))), ("csr_sha256", Value::from(pj::s(&b, "csr_sha256").to_lowercase()))]);
            c.relay.hub.console_observed("meet.approve", &target, &who.principal, link.as_deref());
            Ok(answer)
        },
        "/v1/admin/invite" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            let link = console_request(c, &who, &b)?;
            let answer = c.relay.hub.admin_invite(&pj::s(&b, "session"), &who, b.get("name"), b.get("email"), b.get("days"), b.get("seed_csr_pem"), b.get("proof"), b.get("ts"))?;
            let target = obj([("email", Value::from(pj::s(&b, "email").trim().to_lowercase()))]);
            c.relay.hub.console_observed("meet.invite", &target, &who.principal, link.as_deref());
            Ok(answer)
        },
        "/v1/admin/revoke" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            let link = console_request(c, &who, &b)?;
            let answer = c.relay.admin_revoke(&pj::s(&b, "session"), &who, b.get("principal"), b.get("device"), b.get("proof"), b.get("ts"))?;
            let target = obj([("principal", Value::from(crate::meet::principal(b.get("principal")))), ("device", Value::from(pj::s(&b, "device")))]);
            c.relay.hub.console_observed("meet.revoke", &target, &who.principal, link.as_deref());
            Ok(answer)
        },
        // AC-1 4.10: a sign-in link for the calling admin's own principal, and declining a request
        "/v1/admin/console/invite" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.check_admin(&pj::s(&b, "session"), &who)?;
            crate::console_meet::device_invite(c.relay, &who)
        },
        // AC-2a 3.9 (F20): a device endorsement of a first-roster key; the device certificate's checks are the TLS
        // layer's and `who`'s, the session is checked here, the 3.9 rules are fleet_trust's
        "/v1/admin/console/fleet-endorse" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.check_admin(&pj::s(&b, "session"), &who)?;
            crate::console_meet::fleet_endorse(c.relay, &who, &b)
        },
        "/v1/admin/console/requests/decline" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.check_admin(&pj::s(&b, "session"), &who)?;
            crate::console_meet::decline(c.relay, &who.principal, b.get("id"), b.get("reason"))
        },
        // AI-1 9: an admin's device answers a console AI signing request
        "/v1/admin/console/requests/sign" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::AI_MAP_BODY_MAX)?);
            c.relay.hub.check_admin(&pj::s(&b, "session"), &who)?;
            crate::console_meet::ai_request_signed(c.relay, &who, b.get("id"), b.get("sig"))
        },
        "/v1/admin/signer" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.signer_install(&pj::s(&b, "session"), &who, &b)
        },
        "/v1/update/link" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.update_link(&pj::s(&b, "session"), &who, b.get("platform"))
        },
        "/v1/admin/release" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.set_release(&pj::s(&b, "session"), &who, &b)
        },
        // wave3:files
        "/v1/files/start" => |c: &mut Ctx| {
            let (who, b) = conversation_gate(c)?;
            c.relay.hub.files_start(&who, &pj::s(&b, "scope"), b.get("name"), b.get("size"), b.get("type"), opt(&b, "peer"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"), b.get("e2ee"), b.get("clip"))
        },
        "/v1/files/chunk" => files_chunk,
        "/v1/files/finish" => |c: &mut Ctx| {
            let (who, b) = conversation_gate(c)?;
            c.relay.hub.files_finish(&who, b.get("upload"), b.get("sha256"), b.get("text"), b.get("reply_to"), b.get("thread"), opt(&b, "peer"), opt(&b, "session"))
        },
        "/v1/files/delete" => |c: &mut Ctx| {
            let (who, b) = conversation_gate(c)?;
            c.relay.hub.files_delete(&who, b.get("id"), opt(&b, "peer"), opt(&b, "session"))
        },
        // wave3:meeting-tools
        "/v1/polls" => |c: &mut Ctx| {
            let (who, b) = conversation_gate(c)?;
            c.relay.hub.tools_poll_create(&who, &pj::s(&b, "scope"), b.get("question"), b.get("options"), b.get("multiple"), b.get("anonymous"), opt(&b, "session"), opt(&b, "peer"), opt(&b, "with"), opt(&b, "channel"))
        },
        "/v1/polls/vote" => |c: &mut Ctx| {
            let (who, b) = conversation_gate(c)?;
            c.relay.hub.tools_poll_vote(&who, &pj::s(&b, "scope"), b.get("id"), b.get("choices"), opt(&b, "session"), opt(&b, "peer"), opt(&b, "with"), opt(&b, "channel"))
        },
        "/v1/polls/close" => |c: &mut Ctx| {
            let (who, b) = conversation_gate(c)?;
            c.relay.hub.tools_poll_close(&who, &pj::s(&b, "scope"), b.get("id"), opt(&b, "session"), opt(&b, "peer"), opt(&b, "with"), opt(&b, "channel"))
        },
        "/v1/board" => |c: &mut Ctx| {
            let (who, b, peer) = peer_gate(c)?;
            c.relay.hub.tools_board(&peer, &who, b.get("op"), b.get("stroke"), b.get("ids"), b.get("locked"))
        },
        // wave3:large-calls
        "/v1/sfu/token" => |c: &mut Ctx| {
            let (who, _, peer) = peer_gate(c)?;
            c.relay.hub.sfu_token(&peer, &who)
        },
        "/v1/e2ee" => |c: &mut Ctx| {
            let (who, b, peer) = peer_gate(c)?;
            c.relay.hub.e2ee_publish(&peer, &who, b.get("epk"), b.get("sig"))
        },
        // a body up to E2EE_BODY_MAX (E2EE_TO_MAX wrapped keys)
        "/v1/e2ee/keys" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(E2EE_BODY_MAX)?);
            let peer = pj::s(&b, "peer");
            c.gate(&who, None, &peer, "")?;
            c.relay.hub.e2ee_keys(&peer, &who, b.get("epoch"), b.get("to"))
        },
        // a body up to E2EE_ROSTER_BODY_MAX (a roster of the largest call)
        "/v1/e2ee/roster" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(E2EE_ROSTER_BODY_MAX)?);
            let peer = pj::s(&b, "peer");
            c.gate(&who, None, &peer, "")?;
            c.relay.hub.e2ee_roster(&peer, &who, b.get("seq"), b.get("sig"), b.get("roster"))
        },
        // wave3:guests
        "/v1/guest/link" => |c: &mut Ctx| {
            let (who, b) = conversation_gate(c)?;
            c.relay.hub.guests_link(&who, b.get("room"), b.get("minutes"), opt(&b, "peer"), opt(&b, "session"))
        },
        "/v1/lobby/leave" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.guests_lobby_leave(b.get("wait"), &who, b.get("room"))
        },
        // bridges: members (a session) and relay admins
        "/v1/bridge/code" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.bridge_code(&session, &who, b.get("channel"), b.get("platform"))
        },
        "/v1/bridge/dm-code" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.bridge_dm_code(&session, &who, b.get("platform"))
        },
        "/v1/bridge/unlink" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.bridge_unlink(&session, &who, b.get("link"))
        },
        "/v1/bridge/call" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.bridge_call(&session, &who, b.get("channel"))
        },
        "/v1/admin/bridge" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.bridge_admin_set(&pj::s(&b, "session"), &who, b.get("org"), b.get("policy"))
        },
        // bridges: connector certificates only, no session
        "/v1/bridge/c/hello" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_hello(&who, b.get("platform"), b.get("policy"), b.get("version"))
        },
        "/v1/bridge/c/claim" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_claim(&who, b.get("code"), b.get("platform"), b.get("target"), b.get("by_name"))
        },
        "/v1/bridge/c/claim-dm" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_claim_dm(&who, b.get("code"), b.get("platform"), b.get("target"), b.get("by_name"))
        },
        "/v1/bridge/c/backfill" => |c: &mut Ctx| {
            // up to 500 earlier messages: a larger body than the other routes
            let who = connector(c)?;
            let b = c.body_max(bridge::BACKFILL_BODY)?;
            c.relay.hub.bridge_c_backfill(&who, b.get("link"), b.get("messages"))
        },
        "/v1/bridge/c/unlink" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_unlink(&who, b.get("link"), b.get("by_name"))
        },
        "/v1/bridge/c/mode" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_mode(&who, b.get("link"), b.get("mode"), b.get("by_name"))
        },
        "/v1/bridge/c/notice" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_notice(&who, b.get("link"), b.get("kind"), b.get("start"), b.get("end"))
        },
        "/v1/bridge/c/ack" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_ack(&who, b.get("link"), b.get("seq"), b.get("ok"), b.get("ext"), b.get("reason"), b.get("state"))
        },
        "/v1/bridge/c/post" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_post(&who, b.get("link"), b.get("user"), b.get("msg"), b.get("text"), b.get("thread"), b.get("reply_to"), b.get("url"), b.get("files"))
        },
        "/v1/bridge/c/edit" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_edit(&who, b.get("link"), b.get("msg"), b.get("text"))
        },
        "/v1/bridge/c/delete" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_delete(&who, b.get("link"), b.get("msg"))
        },
        "/v1/bridge/c/react" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_react(&who, b.get("link"), b.get("msg"), b.get("emoji"), b.get("on"), b.get("user"))
        },
        "/v1/bridge/c/call" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_call(&who, b.get("link"), b.get("by_name"))
        },
        "/v1/bridge/c/file" => bridge_file_post,
        // wave3:chat-e2ee
        "/v1/chat/devices" => |c: &mut Ctx| {
            let (who, b, session) = session_gate_max(c, ce::BODY_MAX)?;
            c.relay.hub.ce_devices_post(&session, &who, b.get("bundle"))
        },
        "/v1/chat/keys" => |c: &mut Ctx| {
            let (who, b, session) = session_gate_max(c, ce::KEYS_BODY_MAX)?;
            c.relay.hub.ce_keys_post(&session, &who, b.get("wraps"), b.get("share"))
        },
        "/v1/chat/event" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
            c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
            c.relay.hub.ce_event(&who, &pj::s(&b, "scope"), &pj::s(&b, "id"), b.get("event"), b.get("enc"), opt(&b, "session"), opt(&b, "peer"), opt(&b, "with"), opt(&b, "channel"))
        },
        "/v1/chat/log" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.ce_log_post(&session, &who, b.get("cid"), b.get("entry"))
        },
        // parity wave C: org policies and the apps directory
        "/v1/org/policy" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::POLICY_BODY_MAX)?);
            c.relay.hub.pc_policy_upload(&pj::s(&b, "session"), &who, b.get("signed"), b.get("signer_policy"))
        },
        "/v1/org/policy/sign" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::POLICY_BODY_MAX)?);
            c.relay.pc_sign_policy(&pj::s(&b, "session"), &who, b.get("policy"), b.get("proof"), b.get("ts"))
        },
        // AI-1 2: org AI maps (a relay admin uploads; an org admin's device signs through the signer)
        "/v1/org/ai" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::AI_MAP_BODY_MAX)?);
            c.relay.hub.pc_ai_upload(&pj::s(&b, "session"), &who, b.get("signed"))
        },
        "/v1/org/ai/sign" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::AI_MAP_BODY_MAX)?);
            c.relay.pc_sign_ai(&pj::s(&b, "session"), &who, b.get("map"), b.get("proof"), b.get("ts"))
        },
        // AI-1 6.4, 6.6 and 7.6
        "/v1/sso/c/ai-groups" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.ai_groups_post(&who, &b)
        },
        "/v1/ai/audit" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.ai_audit_post(&who, &b)
        },
        "/v1/ai/history" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
            c.relay.hub.ai_history_post(&pj::s(&b, "session"), &who, b.get("id"), b.get("enc"))
        },
        "/v1/ai/history/delete" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
            c.relay.hub.ai_history_delete(&pj::s(&b, "session"), &who, b.get("id"), b.get("event"), b.get("enc"))
        },
        // SD-1 13.5: org storage maps (a relay admin uploads; an org admin's device signs through the signer)
        "/v1/org/storage" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::MAP_BODY_MAX)?);
            c.relay.hub.sd_storage_upload(&pj::s(&b, "session"), &who, b.get("signed"))
        },
        "/v1/org/storage/sign" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::MAP_BODY_MAX)?);
            c.relay.sd_sign_storage(&pj::s(&b, "session"), &who, b.get("map"), b.get("proof"), b.get("ts"))
        },
        "/v1/apps/icon" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::ICON_MAX * 2)?);
            c.relay.hub.pc_icon_put(&pj::s(&b, "session"), &who, b.get("png"))
        },
        "/v1/org/background" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(pc::BACKGROUND_BODY_MAX)?);
            c.relay.hub.pc_background_put(&pj::s(&b, "session"), &who, b.get("jpeg"))
        },
        // app and archive certificates
        "/v1/apps/c/hello" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.body()?;
            let minimums = c.relay.minimums(&c.relay.release());
            c.relay.hub.pc_apps_hello(&who, &c.address, minimums)
        },
        "/v1/apps/c/ack" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.pc_apps_ack(&pj::s(&b, "session"), &who, b.get("seq"))
        },
        "/v1/apps/c/renew" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.pc_apps_renew(&who, &b)
        },
        // legal holds
        "/v1/admin/holds" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.pc_holds_place(&pj::s(&b, "session"), &who, b.get("on"), b.get("principals"), b.get("cids"), b.get("reason"))
        },
        "/v1/admin/holds/release" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.pc_holds_release(&pj::s(&b, "session"), &who, b.get("id"), b.get("reason"))
        },
        // the SSO service and its admins
        "/v1/sso/answer" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.pc_sso_answer(&pj::s(&b, "session"), &who, b.get("id"), b.get("answer"), b.get("proof"), b.get("ts"), b.get("service"))
        },
        "/v1/sso/c/hello" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            let minimums = c.relay.minimums(&c.relay.release());
            c.relay.hub.pc_sso_hello(&who, b.get("asks"), minimums)
        },
        "/v1/sso/c/sign" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.pc_sso_sign(&who, &b)
        },
        "/v1/sso/c/revoke" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.pc_sso_revoke(&who, &b)
        },
        "/v1/sso/c/org-member" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.pc_sso_org_member(&who, b.get("principal"), b.get("org"), b.get("on"))
        },
        "/v1/sso/c/pending-add" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.pc_sso_pending_add(&who, b.get("principal"), b.get("cid"), b.get("idp"), b.get("group"))
        },
        // canvases and lists
        "/v1/docs/post" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
            c.gate(&who, None, "", &pj::s(&b, "session"))?;
            c.relay.hub.pc_docs_post(&who, &pj::s(&b, "scope"), b.get("doc"), b.get("id"), b.get("enc"), b.get("kind"), b.get("body"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"))
        },
        "/v1/docs/aware" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
            c.gate(&who, None, "", &pj::s(&b, "session"))?;
            c.relay.hub.pc_docs_aware(&who, &pj::s(&b, "scope"), b.get("doc"), b.get("id"), b.get("enc"), b.get("body"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"))
        },
        "/v1/docs/delete" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
            c.gate(&who, None, "", &pj::s(&b, "session"))?;
            c.relay.hub.pc_docs_delete(&who, &pj::s(&b, "scope"), b.get("doc"), b.get("id"), b.get("enc"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"))
        },
        _ => return None,
    };
    Some(route)
}

/// Whether the main port has this route (the gate table's test, meet_license.rs).
#[cfg(test)]
pub fn has_route(method: &str, path: &str) -> bool {
    if method == "GET" {
        get_route(path).is_some()
    } else {
        post_route(path).is_some()
    }
}

/// do_GET / do_POST: 404 `unknown path`, else the route's answer through Handler._run. None when the client went
/// away.
pub fn dispatch(ctx: &mut Ctx, method: &str) -> Option<(u16, Obj)> {
    if let Some(refused) = confined(ctx, method) {
        return run(ctx, Ok(Err(refused)));
    }
    let route = if method == "GET" { get_route(&ctx.path) } else { post_route(&ctx.path) };
    let Some(route) = route else {
        return Some((404, obj([("error", Value::from("unknown path"))])));
    };
    // AC-1 2.4 and 4.10 (R42-1): the service gate and the seat refusal, before the route reads anything
    if let Some(gate) = ctx.relay.hub.gate() {
        let who = m::identity_from_cert(ctx.der).ok();
        if let Err(refused) = gate.admits(method, &ctx.path, who.as_ref()) {
            return run(ctx, Ok(Err(refused)));
        }
    }
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| route(ctx)));
    run(ctx, result)
}

/// _pcr_confined (PC-1, before any route lookup; the connection closes with the body left unread): a service
/// certificate outside its allow-list or, with `enclave_networks`, outside them; and in an enclave every bridge route
/// (the answer says `enclave: true`).
fn confined(ctx: &Ctx, method: &str) -> Option<m::E> {
    let uris = m::cert_uris(ctx.der);
    // AC-2b-D 8.4 (R2-L10, D16): a relay or signer client certificate is accepted on no route of the main port
    if uris.iter().any(|u| u == m::RELAY_URI) {
        return Some(m::E::Forbidden(m::RELAY_NOT_PERSON.into()));
    }
    let (kind, mut words) = match pc::cert_kind(&uris) {
        Ok((kind, _)) => {
            let words = pc::service_confined(&kind, method, &ctx.path).to_string();
            (kind, words)
        }
        Err(e) => (String::new(), e.message()),
    };
    let s = &ctx.relay.settings;
    if words.is_empty() && !s.enclave_networks.is_empty() && matches!(kind.as_str(), "app" | "archive" | "sso" | "connector") && !pc::inside(&ctx.address, &s.enclave_networks) {
        words = pc::ENCLAVE_NETS.to_string();
    }
    if words.is_empty() && s.enclave && (ctx.path.starts_with(bridge::C_PREFIX) || (method == "POST" && pc::ENCLAVE_BRIDGE_ROUTES.contains(&ctx.path.as_str()))) {
        return Some(m::E::Held(pc::ENCLAVE_BRIDGES.into(), obj([("enclave", Value::Bool(true))])));
    }
    if words.is_empty() {
        None
    } else {
        Some(m::E::Forbidden(words))
    }
}

// ── GET ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// AC-1 4.10: the optional `console_request` of /v1/admin/approve, revoke and invite, checked after the admin check
/// and before anything else of the route: absent, or `rq_` and 16 lower-case hex.
fn console_request(c: &Ctx, who: &crate::meet::Identity, b: &Obj) -> R<Option<String>> {
    c.relay.hub.check_admin(&pj::s(b, "session"), who)?;
    match b.get("console_request") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if crate::console_meet::request_id_ok(id) => Ok(Some(id.clone())),
        Some(_) => Err(crate::meet::E::Bad(crate::console_meet::CONSOLE_REQUEST_FIELD.into())),
    }
}

fn whoami(c: &mut Ctx) -> R<Obj> {
    let who = c.who(true)?;
    if who.seed && c.relay.hub.seed_used(&who.serial) {
        return m::forbidden("this invite was already used");
    }
    Ok(obj([("principal", Value::from(who.principal)), ("name", Value::from(who.name))]))
}

fn events(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    let peer = c.q("peer", "");
    c.gate(&who, None, &peer, "")?;
    let after = m::py_int(&c.q("after", "0"))?;
    c.relay.hub.events(&peer, &who, after)
}

fn inbox(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    let session = c.q("session", "");
    c.gate(&who, None, "", &session)?;
    let after = m::py_int(&c.q("after", "0"))?;
    // NT-1 section 3.6: `wait` 1 to 25 seconds (the iPhone polls with 10)
    let wait = push::inbox_wait(&c.q("wait", "25"))?;
    c.relay.hub.inbox(&session, &who, after, wait)
}

fn dm_history(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    let session = c.q("session", "");
    c.gate(&who, None, "", &session)?;
    let (a, b) = (c.q("a", ""), c.q("b", ""));
    if !a.is_empty() || !b.is_empty() {
        // PC-1: an archive reads a DM it covers
        return c.relay.hub.pc_archive_dm_history(&session, &who, &a, &b, &c.q("after", "0"), &c.q("limit", "200"));
    }
    let limit = m::py_int(&c.q("limit", "200"))?;
    let thread = Value::from(c.q("thread", ""));
    c.relay.hub.dm_history(&session, &who, &c.q("with", ""), &Value::from(c.q("after", "0")), limit, Some(&thread))
}

fn room_history(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    c.gate(&who, None, "", "")?;
    let limit = m::py_int(&c.q("limit", "500"))?;
    c.relay.hub.room_history(&Value::from(c.q("room", "")), &who, &Value::from(c.q("since", "0")), limit)
}

fn room_captions(c: &mut Ctx) -> R<Obj> {
    let peer = c.q("peer", "");
    let who = c.who(false)?;
    c.gate(&who, None, &peer, "")?;
    c.relay.hub.room_captions(&peer, &who, &c.q("after", "0"), &c.q("limit", &CAPTIONS_LIMIT_MAX.to_string()))
}

// ── POST: rooms ──────────────────────────────────────────────────────────────────────────────────────────────

fn join(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    let given = if pj::truthy(b.get("client")) { b.get("client").cloned().unwrap_or(Value::Null) } else { Value::Object(Obj::new()) };
    c.gate(&who, Some(&given), "", "")?;
    let room = m::room_name(b.get("room"))?;
    let late = m::flag(b.get("late_history"), "late_history")?;
    let mut joined = c.relay.hub.join(&room, &who, &c.address, late, Some(&b))?;
    joined.insert("ice".into(), Value::Object(m::turn_credentials(&c.relay.settings, &c.relay.turn_secret, &who, &c.address)));
    Ok(joined)
}

fn peer_gate(c: &mut Ctx) -> R<(m::Identity, Obj, String)> {
    let (who, b) = (c.who(false)?, c.body()?);
    let peer = pj::s(&b, "peer");
    c.gate(&who, None, &peer, "")?;
    Ok((who, b, peer))
}

fn signal(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    c.relay.hub.signal(&peer, &who, &pj::s(&b, "to"), b.get("data").cloned().unwrap_or(Value::Null))?;
    Ok(obj([("ok", Value::Bool(true))]))
}

fn link(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    let level = b.get("level");
    if !matches!(level, Some(Value::String(s)) if pj::char_len(s) <= 20) {
        return m::bad("level must be full, audio or text");
    }
    if !matches!(b.get("reason"), Some(Value::String(s)) if pj::char_len(s) <= 200) {
        return m::bad("reason must be a short text");
    }
    let stats = b.get("stats").cloned().unwrap_or(Value::Null);
    if !matches!(stats, Value::Null | Value::Object(_)) {
        return m::bad("stats must be an object or null");
    }
    let get = |k: &str| b.get(k).cloned().unwrap_or(Value::Null);
    let data = obj([
        ("level", get("level")),
        ("reason", get("reason")),
        ("stats", stats),
        ("relay_rtt_ms", get("relay_rtt_ms")),
        ("peers", get("peers")),
        ("path", get("path")),
        ("proto", get("proto")),
    ]);
    let weak = m::weak(b.get("weak"))?;
    c.relay.hub.link(&peer, &who, &data, weak)?;
    Ok(obj([("ok", Value::Bool(true))]))
}

/// `{peer, id, enc, files?, reply_to?}` (end-to-end encrypted), or a plain `{peer, text, reply_to?, mentions?}` while
/// a web guest is in the call.
fn chat(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
    let peer = pj::s(&b, "peer");
    c.gate(&who, None, &peer, "")?;
    if b.contains_key("enc") {
        return c.relay.hub.ce_post(&who, "room", post(&b, None, opt(&b, "peer")));
    }
    let text = m::text(b.get("text"), "messages")?;
    c.relay.hub.say(&peer, &who, &text, b.get("reply_to"), b.get("mentions"), b.get("fwd"))
}

/// The encrypted message a route's body carries (ce_post).
fn post(b: &Obj, session: Option<String>, peer: Option<String>) -> ce::Post<'_> {
    ce::Post {
        id: b.get("id"),
        enc: b.get("enc"),
        files: b.get("files"),
        thread: b.get("thread"),
        reply_to: b.get("reply_to"),
        also_channel: b.get("also_channel"),
        session,
        peer,
        to: b.get("to"),
        channel: b.get("channel"),
        plain: ce::plain_fields(b),
    }
}

/// `str(body.get(key) or "") or None`.
fn opt(b: &Obj, key: &str) -> Option<String> {
    Some(pj::s(b, key)).filter(|v| !v.is_empty())
}

/// The caller and body of a conversation route (`{session|peer, ...}`), through the gate.
fn conversation_gate(c: &mut Ctx) -> R<(m::Identity, Obj)> {
    let (who, b) = (c.who(false)?, c.body()?);
    c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
    Ok((who, b))
}

// ── wave 3: files kept in conversations ──────────────────────────────────────────────────────────────────────

/// urllib.parse.quote(text, safe=""): every byte of its UTF-8 but letters, digits and `_.-~` as %XX.
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"_.-~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `POST /v1/files/chunk?upload=&offset=` with the part's bytes as the body (at most FILES_PART) -> `{upload,
/// received, expires}`. The relay's one raw-body route: its cap and the upload's checks come before a byte of the
/// body is read (any refusal before that closes the connection).
fn files_chunk(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    let no_length = || Err(m::E::Status(411, "send each part with its length (Content-Length)".into(), true));
    if c.transfer_encoding.is_some() {
        return no_length();
    }
    let length = match c.content_length.as_deref().map(m::py_int) {
        Some(Ok(n)) if n >= 0 => n as usize,
        _ => return no_length(),
    };
    if length > files::FILES_PART {
        return Err(m::E::Status(413, "a part of a file is at most 1 MB".into(), true));
    }
    let part = c.relay.hub.files_chunk_begin(&who, &c.q("upload", ""), &c.q("offset", ""), length)?;
    let data = match c.raw_body(length) {
        Ok(d) => d,
        Err(e) => {
            c.relay.hub.files_chunk_abort(part);
            return Err(e);
        }
    };
    c.relay.hub.files_chunk_write(part, &data)
}

/// `GET /v1/crl`: every CRL this relay checks client certificates against (the `crl` setting's file, or the bundle in
/// `state_dir`: the root CA's CRL, then the signer's), each one's DER exactly as its issuer signed it, back to back, as
/// `application/pkix-crl`. Members check them against the CA themselves (contract E2EE-2 section 4). 404 when the
/// relay has none.
fn crl(c: &mut Ctx) -> R<Obj> {
    c.who(false)?;
    let data = crl_path(&c.relay.settings).map(|p| read_bytes(&p)).unwrap_or_default();
    let body: Vec<u8> = pem_blocks(&data, "X509 CRL").into_iter().flat_map(|(_, der)| der).collect();
    if body.is_empty() {
        return Err(m::E::NotFound("this relay has no revocation list".into()));
    }
    let headers = vec![
        ("Content-Type", "application/pkix-crl".to_string()),
        ("Content-Length", body.len().to_string()),
        ("Cache-Control", "no-store".to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
    ];
    c.raw = Some(m::Raw::Bytes(headers, body));
    Ok(Obj::new())
}

/// `GET /v1/files/get?session=|peer=&id=&offset=&length=`: the file's bytes (or that range of them), always as an
/// attachment of type application/octet-stream, sent by the connection (meet::RawFile).
fn files_get(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    let (peer, session) = (c.q("peer", ""), c.q("session", ""));
    c.gate(&who, None, &peer, &session)?;
    let some = |v: String| Some(v).filter(|v| !v.is_empty());
    let (file, fh, offset, count) = c.relay.hub.files_open(&who, &c.q("id", ""), &c.q("offset", ""), &c.q("length", ""), some(peer), some(session))?;
    files_send(c, &file, fh, offset, count, who.principal);
    Ok(Obj::new())
}

/// _files_send: answer `count` bytes of an open kept file from `offset`, always as an attachment of type
/// application/octet-stream (`GET /v1/files/get` and the bridge's `GET /v1/bridge/c/file`).
fn files_send(c: &mut Ctx, file: &Obj, fh: std::fs::File, offset: u64, count: u64, principal: String) {
    let name = pj::text_of(file, "name");
    let plain: String = name.chars().map(|ch| if (' '..'\u{7f}').contains(&ch) && ch != '"' && ch != '\\' { ch } else { '_' }).collect();
    let quoted = quote(&name);
    let id = pj::text_of(file, "id");
    let field = |k: &str| file.get(k).map(pj::py_str).unwrap_or_default();
    let headers = vec![
        ("Content-Type", "application/octet-stream".to_string()),
        ("Content-Length", count.to_string()),
        ("Content-Disposition", format!("attachment; filename=\"{plain}\"; filename*=UTF-8''{quoted}")),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Content-Security-Policy", "default-src 'none'; sandbox".to_string()),
        ("Cache-Control", "no-store".to_string()),
        ("X-File-Id", id.clone()),
        ("X-File-Name", quoted),
        ("X-File-Type", field("type")),
        ("X-File-Size", field("size")),
        ("X-File-Sha256", field("sha256")),
        ("X-File-Offset", offset.to_string()),
    ];
    c.raw = Some(m::Raw::File(m::RawFile { headers, file: fh, offset, count, id, principal }));
}

// ── parity wave A: custom emoji ──────────────────────────────────────────────────────────────────────────────

/// `GET /v1/emoji?session=`: every custom emoji, as a JSON list `[{name, hash, org, by, ts}]`.
fn emoji_list(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    let session = c.q("session", "");
    c.gate(&who, None, "", &session)?;
    let rows = c.relay.hub.emoji_list(&session, &who)?;
    let body = pj::dumps(&Value::Array(rows)).into_bytes();
    let headers = vec![("Content-Type", "application/json".to_string()), ("Cache-Control", "no-store".to_string()), ("Content-Length", body.len().to_string())];
    c.raw = Some(m::Raw::Bytes(headers, body));
    Ok(Obj::new())
}

/// `GET /v1/emoji/file?hash=`: a custom emoji's image (public content, cached for good).
fn emoji_file(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    c.gate(&who, None, "", "")?;
    let (headers, body) = c.relay.hub.emoji_file(&c.q("hash", ""))?;
    c.raw = Some(m::Raw::Bytes(headers, body));
    Ok(Obj::new())
}

// ── bridges: connector routes ────────────────────────────────────────────────────────────────────────────────

/// _bridge_connector: the caller, a connector certificate (403 for anyone else).
fn connector(c: &Ctx) -> R<m::Identity> {
    let who = c.who(false)?;
    if !who.connector {
        return m::forbidden(bridge::CONNECTORS_ONLY);
    }
    Ok(who)
}

fn connector_body(c: &mut Ctx) -> R<(m::Identity, Obj)> {
    let who = connector(c)?;
    Ok((who, c.body()?))
}

/// `GET /v1/bridge/c/file?link=&id=`: the bytes of a file an op of that link named.
fn bridge_file_get(c: &mut Ctx) -> R<Obj> {
    let who = connector(c)?;
    let (file, fh, count) = c.relay.hub.bridge_c_file_open(&who, &c.q("link", ""), &c.q("id", ""))?;
    files_send(c, &file, fh, 0, count, who.principal);
    Ok(Obj::new())
}

/// `POST /v1/bridge/c/file?link=&name=&mime=` with the file's bytes as the body -> `{file}`. The checks (kind, size,
/// quota) come before a byte is read; the bytes go to the files slice's upload in FILES_PART pieces. Until every byte
/// is read, any answer closes the connection.
fn bridge_file_post(c: &mut Ctx) -> R<Obj> {
    c.close = true;
    let who = connector(c)?;
    let no_length = || Err(m::E::Status(411, "send the file with its length (Content-Length)".into(), true));
    if c.transfer_encoding.is_some() {
        return no_length();
    }
    let length = match c.content_length.as_deref().map(m::py_int) {
        Some(Ok(n)) if n >= 0 => n as u64,
        _ => return no_length(),
    };
    let relay = c.relay.clone();
    let hub = &relay.hub;
    let uid = hub.bridge_c_file_begin(&who, &c.q("link", ""), &c.q("name", ""), &c.q("mime", ""), length)?;
    let mut offset: u64 = 0;
    while offset < length {
        let n = (files::FILES_PART as u64).min(length - offset) as usize;
        let part = match hub.files_chunk_begin(&who, &uid, &offset.to_string(), n) {
            Ok(p) => p,
            Err(e) => {
                hub.bridge_c_file_drop(&uid);
                return Err(e);
            }
        };
        let data = match c.raw_body(n) {
            Ok(d) => d,
            Err(e) => {
                hub.files_chunk_abort(part);
                hub.bridge_c_file_drop(&uid);
                return Err(e);
            }
        };
        if let Err(e) = hub.files_chunk_write(part, &data) {
            hub.bridge_c_file_drop(&uid);
            return Err(e);
        }
        offset += n as u64;
    }
    c.close = false;
    hub.bridge_c_file_done(&uid)
}

/// _chat_change: `{peer|session, scope: room|dm, with?, id, text}`: edit or delete a message.
fn chat_change(c: &mut Ctx, delete: bool) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body_max(ce::BODY_MAX)?);
    c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
    if b.contains_key("enc") {
        if ce::plain_fields(&b) {
            return Err(m::E::Conflict(ce::PLAIN.into()));
        }
        return c.relay.hub.ce_change(&who, &pj::s(&b, "scope"), &pj::s(&b, "id"), b.get("event"), b.get("enc"), delete, opt(&b, "peer"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"));
    }
    let text = if delete { None } else { b.get("text") };
    c.relay.hub.chat_change(&who, &pj::s(&b, "scope"), &pj::s(&b, "id"), text, delete, opt(&b, "peer"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"))
}

fn typing(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
    c.relay.hub.typing(&who, &pj::s(&b, "scope"), opt(&b, "peer"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"))
}

fn stage(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    if let Some(Value::String(action)) = b.get("action") {
        if ["breakout_", "control_", "lobby_"].iter().any(|p| action.starts_with(p)) {
            return c.relay.hub.stage_ext(&peer, &who, action, &b);
        }
    }
    c.relay.hub.stage(&peer, &who, b.get("action"), b.get("target"), b.get("up"), b.get("emoji"))
}

fn status(c: &mut Ctx) -> R<Obj> {
    let (who, b, session) = session_gate(c)?;
    c.relay.hub.set_status(&session, &who, b.get("state"), b.get("text"), b.get("until"))
}

fn caption(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    let text = pj::s(&b, "text").trim().to_string();
    if text.is_empty() {
        return m::bad("empty caption");
    }
    let text = m::text(Some(&Value::from(text)), "captions")?;
    c.relay.hub.caption(&peer, &who, &text, b.get("cseq"), b.get("age_ms"), b.get("dur_ms"))
}

fn captions(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    let weak = m::weak(b.get("weak"))?;
    c.relay.hub.captions(&pj::s(&b, "peer"), &who, b.get("lines"), weak, b.get("sent_ms"))
}

/// `{peer, late_history?, catchup?}` (`catchup`: the signed catch-up option of chat encryption, Hub::ce_catchup).
fn room_options(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    if !b.contains_key("catchup") {
        return c.relay.hub.room_options(&peer, &who, b.get("late_history"));
    }
    if b.contains_key("late_history") {
        c.relay.hub.room_options(&peer, &who, b.get("late_history"))?;
    }
    c.relay.hub.ce_catchup(&peer, &who, b.get("catchup"))
}

fn leave(c: &mut Ctx) -> R<Obj> {
    let (who, _, peer) = peer_gate(c)?;
    c.relay.hub.leave(&peer, &who)?;
    Ok(obj([("ok", Value::Bool(true))]))
}

fn ice(c: &mut Ctx) -> R<Obj> {
    let (who, _, peer) = peer_gate(c)?;
    c.relay.hub.owned(&peer, &who)?;
    Ok(m::turn_credentials(&c.relay.settings, &c.relay.turn_secret, &who, &c.address))
}

fn recording(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    c.relay.hub.recording(&peer, &who, b.get("on"), b.get("acknowledged"), b.get("paused"))
}

fn recording_policy(c: &mut Ctx) -> R<Obj> {
    let (who, _, peer) = peer_gate(c)?;
    c.relay.hub.recording_policy(&peer, &who)
}

fn recording_consent(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    c.relay.hub.recording_consent(&peer, &who, &pj::s(&b, "request"), b.get("accepted"))
}

// ── POST: presence, messages, invitations ────────────────────────────────────────────────────────────────────

fn hello(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    let client = m::client(b.get("client"));
    let active = crate::meet_hub::parse_active(b.get("active"), Some(true))?;
    let mut reply = c.relay.hub.hello_active(&who, &c.address, &client, active)?;
    if let Some(info) = c.relay.outdated(&who, &client) {
        c.relay.note_outdated(&who, &info);
        reply.insert("update_required".into(), Value::Object(info));
    }
    Ok(reply)
}

fn bye(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    c.relay.hub.bye(&pj::s(&b, "session"), &who)
}

fn session_gate(c: &mut Ctx) -> R<(m::Identity, Obj, String)> {
    let (who, b) = (c.who(false)?, c.body()?);
    let session = pj::s(&b, "session");
    c.gate(&who, None, "", &session)?;
    Ok((who, b, session))
}

/// `{session, to, id, enc, files?, thread?, reply_to?}`; plain text is refused.
fn dm(c: &mut Ctx) -> R<Obj> {
    let (who, b, session) = session_gate_max(c, ce::BODY_MAX)?;
    if b.contains_key("enc") {
        return c.relay.hub.ce_post(&who, "dm", post(&b, Some(session), None));
    }
    c.relay.hub.dm(&session, &who)
}

fn session_gate_max(c: &mut Ctx, most: usize) -> R<(m::Identity, Obj, String)> {
    let (who, b) = (c.who(false)?, c.body_max(most)?);
    let session = pj::s(&b, "session");
    c.gate(&who, None, "", &session)?;
    Ok((who, b, session))
}

fn dm_read(c: &mut Ctx) -> R<Obj> {
    let (who, b, session) = session_gate(c)?;
    c.relay.hub.dm_read(&session, &who, &pj::s(&b, "with"), b.get("ts"), b.get("receipt"))
}

fn react(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
    c.relay.hub.react(&who, &pj::s(&b, "scope"), &pj::s(&b, "id"), &pj::s(&b, "emoji"), opt(&b, "session"), opt(&b, "peer"), opt(&b, "with"), opt(&b, "channel"))
}

fn invite(c: &mut Ctx) -> R<Obj> {
    let (who, b, session) = session_gate(c)?;
    c.relay.hub.invite(&session, &who, b.get("to"), b.get("room"), b.get("host"))
}

// ── POST: certificates ───────────────────────────────────────────────────────────────────────────────────────

fn renew(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    c.relay.hub.renew(&pj::s(&b, "session"), &who, b.get("csr_pem"), b.get("chain"), b.get("proof"), b.get("ts"))
}

fn admin_renewed(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    let device = match b.get("device") {
        None | Some(Value::Null) => None,
        Some(v) => Some(pj::py_str(v)),
    };
    c.relay.hub.admin_renewed(&pj::s(&b, "session"), &who, &pj::s(&b, "principal"), b.get("cert_pem"), b.get("ca_pem"), device)
}

fn enroll(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(true)?, c.body()?);
    c.relay.hub.enroll(&who, b.get("csr_pem"), b.get("chain"), b.get("proof"), b.get("ts"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_old_console_routes_are_gone_and_the_admin_console_routes_exist() {
        // AC-1 9.1: /v1/console/* answers the unknown-path 404 now
        for p in ["/v1/console/summary", "/v1/console/links", "/v1/console/logs", "/v1/console/servers", "/v1/console/directory"] {
            assert!(get_route(p).is_none() && post_route(p).is_none(), "{p}");
        }
        // AC-1 4.10 on the main port
        assert!(get_route("/v1/admin/console/requests").is_some());
        assert!(post_route("/v1/admin/console/invite").is_some());
        assert!(post_route("/v1/admin/console/requests/decline").is_some());
        // AC-2a 5.7 and 3.9 on the main port
        assert!(get_route("/v1/admin/console/where").is_some());
        assert!(get_route("/v1/admin/console/fleet-bootstrap").is_some());
        assert!(post_route("/v1/admin/console/fleet-endorse").is_some());
        for p in ["/v1/admin/approve", "/v1/admin/revoke", "/v1/admin/invite"] {
            assert!(post_route(p).is_some(), "{p}");
        }
    }
}
