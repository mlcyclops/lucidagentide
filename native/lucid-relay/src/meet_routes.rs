// Phase C (ADR-0534): the Meet relay's route tables (meet_relay.Handler.do_GET and do_POST), each route reading its
// caller, body and gate in the order the Python handler does, so the same request gets the same first refusal.

use crate::meet::{self as m, run, Ctx, R, CAPTIONS_LIMIT_MAX};
use crate::meet_json::{self as pj, obj, Obj};
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
        "/v1/version" => |c: &mut Ctx| {
            let who = c.who(false)?;
            c.relay.version(&c.q("session", ""), &who)
        },
        "/healthz" => |_: &mut Ctx| Ok(obj([("ok", Value::Bool(true))])),
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
        "/v1/invite" => invite,
        "/v1/recording" => recording,
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
        _ => return None,
    };
    Some(route)
}

/// do_GET / do_POST: 404 `unknown path`, else the route's answer through Handler._run. None when the client went
/// away.
pub fn dispatch(ctx: &mut Ctx, method: &str) -> Option<(u16, Obj)> {
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
    c.relay.hub.dm_history(&session, &who, &c.q("with", ""), &Value::from(c.q("after", "0")), limit)
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
    let mut joined = c.relay.hub.join(&room, &who, &c.address, late, b.get("client"))?;
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
    c.relay.hub.say(&peer, &who, &text)
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
    c.relay.hub.recording(&peer, &who, b.get("on"))
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
    c.relay.hub.dm(&session, &who, &pj::s(&b, "to"), b.get("text"))
}

fn dm_read(c: &mut Ctx) -> R<Obj> {
    let (who, b, session) = session_gate(c)?;
    c.relay.hub.dm_read(&session, &who, &pj::s(&b, "with"), b.get("ts"))
}

fn react(c: &mut Ctx) -> R<Obj> {
    let (who, b) = (c.who(false)?, c.body()?);
    c.gate(&who, None, &pj::s(&b, "peer"), &pj::s(&b, "session"))?;
    let opt = |k: &str| Some(pj::s(&b, k)).filter(|v| !v.is_empty());
    c.relay.hub.react(&who, &pj::s(&b, "scope"), &pj::s(&b, "id"), &pj::s(&b, "emoji"), opt("session"), opt("peer"), opt("with"))
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
