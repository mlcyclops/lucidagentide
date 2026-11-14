// Phase C (ADR-0540): the Meet relay's route tables (meet_relay.Handler.do_GET and do_POST), each route reading its
// caller, body and gate in the order the Python handler does, so the same request gets the same first refusal.

use crate::meet::{self as m, run, Ctx, R, CAPTIONS_LIMIT_MAX};
use crate::meet_hub::{bridge, files, E2EE_BODY_MAX, E2EE_ROSTER_BODY_MAX};
use crate::meet_json::{self as pj, obj, Obj};
use crate::meet_tls::{crl_path, read_bytes};
use crate::meet_x509::pem_blocks;
use serde_json::Value;
use std::panic::AssertUnwindSafe;

type Route = fn(&mut Ctx) -> R<Obj>;

fn get_route(path: &str) -> Option<Route> {
    let route: Route = match path {
        "/v1/console/summary" => |c: &mut Ctx| console(c, "summary"),
        "/v1/console/links" => |c: &mut Ctx| console(c, "links"),
        "/v1/console/logs" => |c: &mut Ctx| console(c, "logs"),
        "/v1/console/servers" => |c: &mut Ctx| console(c, "servers"),
        "/v1/console/directory" => |c: &mut Ctx| console(c, "directory"),
        "/v1/whoami" => whoami,
        "/v1/events" => events,
        "/v1/inbox" => inbox,
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
            c.relay.hub.channel_create(&session, &who, b.get("kind"), b.get("name"), b.get("topic"), b.get("members"))
        },
        "/v1/channels/join" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_join(&session, &who, b.get("id"))
        },
        "/v1/channels/leave" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_leave(&session, &who, b.get("id"))
        },
        "/v1/channels/archive" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_archive(&session, &who, b.get("id"))
        },
        "/v1/channels/invite" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_invite(&session, &who, b.get("id"), b.get("principals"))
        },
        "/v1/channels/update" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_update(&session, &who, b.get("id"), b.get("name"), b.get("topic"))
        },
        "/v1/channels/post" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            c.relay.hub.channel_post(&session, &who, b.get("id"), b.get("text"), b.get("reply_to"), b.get("mentions"), b.get("thread"), b.get("also_channel"), b.get("preview"))
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
            c.relay.hub.meeting_create(&session, &who, b.get("title"), b.get("start"), b.get("end"), b.get("attendees"), b.get("description"), b.get("recurrence"), b.get("tz"))
        },
        "/v1/meetings/update" => |c: &mut Ctx| {
            let (who, b, session) = session_gate(c)?;
            let changes: Obj = ["title", "start", "end", "attendees", "description", "recurrence", "tz"].iter().filter_map(|k| b.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
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
            c.relay.hub.admin_approve(&pj::s(&b, "session"), &who, &pj::s(&b, "kind"), &pj::s(&b, "id"), &pj::s(&b, "csr_sha256"), &pj::s(&b, "decision"), b.get("reason"), b.get("proof"), b.get("ts"))
        },
        "/v1/admin/invite" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.hub.admin_invite(&pj::s(&b, "session"), &who, b.get("name"), b.get("email"), b.get("days"), b.get("seed_csr_pem"), b.get("proof"), b.get("ts"))
        },
        "/v1/admin/revoke" => |c: &mut Ctx| {
            let (who, b) = (c.who(false)?, c.body()?);
            c.relay.admin_revoke(&pj::s(&b, "session"), &who, b.get("principal"), b.get("device"), b.get("proof"), b.get("ts"))
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
            c.relay.hub.files_start(&who, &pj::s(&b, "scope"), b.get("name"), b.get("size"), b.get("type"), opt(&b, "peer"), opt(&b, "session"), opt(&b, "with"), opt(&b, "channel"))
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
        "/v1/bridge/c/unlink" => |c: &mut Ctx| {
            let (who, b) = connector_body(c)?;
            c.relay.hub.bridge_c_unlink(&who, b.get("link"), b.get("by_name"))
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
        _ => return None,
    };
    Some(route)
}

/// do_GET / do_POST: 404 `unknown path`, else the route's answer through Handler._run. None when the client went
/// away.
pub fn dispatch(ctx: &mut Ctx, method: &str) -> Option<(u16, Obj)> {
    // _bridge_confined: a connector certificate gets 403 on every path outside /v1/bridge/c/* (unknown ones too); the
    // connection closes with the body left unread
    if !ctx.path.starts_with(bridge::C_PREFIX) && m::connector_cert(ctx.der) {
        return run(ctx, Ok(Err(m::E::Forbidden(bridge::ROUTES_ONLY.into()))));
    }
    let route = if method == "GET" { get_route(&ctx.path) } else { post_route(&ctx.path) };
    let Some(route) = route else {
        return Some((404, obj([("error", Value::from("unknown path"))])));
    };
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| route(ctx)));
    run(ctx, result)
}

// ── GET ──────────────────────────────────────────────────────────────────────────────────────────────────────

fn console(c: &mut Ctx, what: &str) -> R<Obj> {
    let relay = c.relay.clone();
    relay.console.gate(&c.address)?;
    let who = c.who(false)?;
    relay.console.service(&who)?;
    let q = |name: &str, default: &str| c.q(name, default);
    match what {
        "summary" => Ok(relay.console.summary(&relay)),
        "links" => Ok(relay.console.links_view(&relay, &q("room", ""))),
        "logs" => relay.console.logs(&q("since", "0"), &q("level", "info"), &q("q", "")),
        "servers" => Ok(relay.console.servers(&relay)),
        _ => Ok(relay.console.directory(&relay)),
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
    c.relay.hub.inbox(&session, &who, after, m::POLL_WAIT)
}

fn dm_history(c: &mut Ctx) -> R<Obj> {
    let who = c.who(false)?;
    let session = c.q("session", "");
    c.gate(&who, None, "", &session)?;
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

fn chat(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    let text = m::text(b.get("text"), "messages")?;
    c.relay.hub.say(&peer, &who, &text, b.get("reply_to"), b.get("mentions"))
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
    let id = pj::text_of(&file, "id");
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
    let (who, b) = (c.who(false)?, c.body()?);
    c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
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
    c.relay.hub.set_status(&session, &who, b.get("state"), b.get("text"))
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

fn room_options(c: &mut Ctx) -> R<Obj> {
    let (who, b, peer) = peer_gate(c)?;
    c.relay.hub.room_options(&peer, &who, b.get("late_history"))
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
    let mut reply = c.relay.hub.hello(&who, &c.address, &client)?;
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

fn dm(c: &mut Ctx) -> R<Obj> {
    let (who, b, session) = session_gate(c)?;
    c.relay.hub.dm(&session, &who, &pj::s(&b, "to"), b.get("text"), b.get("reply_to"), b.get("thread"), b.get("preview"))
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
