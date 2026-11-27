// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

"use strict";
// Lucid Admin Console (contract AC-1 revision 4, sections 7 and 8). Served by the relay from /console/app.js, loaded
// with defer. No framework and no outside code. The DOM is built with createElement, textContent, append, classList
// and setAttribute for non-style attributes only; every value that comes from the relay is cleaned (clean below) and
// written as text inside a bdi element. Events: addEventListener only, delegation through data-act attributes.
// Every request is same-origin with credentials "same-origin"; POST carries X-Lucid-Console: 1 and a JSON body.
(() => {
  // ---- Words (8.1, exact; tests/vectors/admin_console_words_v1.json). Compound rows keep their first string under
  // the contract's id and the rest under "<id>.<part>". ----
  const W = {
    "title": "LUCID Admin Console",
    "title.document": "Lucid Admin Console: <host>",
    "product.spokes": "Remote Spokes relay",
    "product.meet": "Meeting Hub relay",
    "nav.overview": "Overview",
    "nav.spokes": "Remote Spokes",
    "nav.spokes.pages": ["Hubs", "Spokes", "Relays", "Seats", "License", "Logs", "Requests"],
    "nav.meet": "Meeting Hub",
    "nav.meet.pages": ["People and devices", "Seats", "Enrollments and renewals", "Organizations and policies", "Signer and revocation",
      "Bridges", "Legal holds", "Releases", "Push and notifications", "Organization sign-in", "Calls and links", "Servers",
      "License", "Logs", "Requests"],
    "nav.security": "Security",
    "nav.approvals": "Approvals",
    "nav.admins": "Admins and audit",
    "nav.admins.pages": ["People", "Sessions", "Audit log", "Settings", "Your account"],
    "profile.chip": "High security",
    "profile.chip.standard": "Standard security",
    "role.names": ["Admin", "User manager", "Viewer"],
    "nav.locked": "License needed",
    "search.placeholder": "Search people, devices, hubs and spokes",
    "search.placeholder.spokes": "Search hubs, spokes and people",
    "search.none": 'Nothing matches "<q>".',
    "theme.menu": "Theme",
    "theme.groups": ["Themes", "Special themes"],
    "theme.system": "Match my system",
    "account.menu": ["Your account", "Help", "Sign out"],
    "signin.title": "Sign in",
    "signin.button": "Sign in with a passkey or security key",
    "signin.email": "Email",
    "signin.email-hint": "Leave it empty to use a passkey this device keeps.",
    "signin.password": "Sign in with a password",
    "signin.password.field": "Password",
    "signin.password.button": "Continue",
    "signin.key-next": "Now confirm with your passkey or security key.",
    "signin.totp": "Enter the 6-digit code from your authenticator app.",
    "signin.totp.field": "Code",
    "signin.totp.button": "Sign in",
    "signin.forgot": "Forgot your password?",
    "signin.forgot.field": "Email",
    "signin.forgot.button": "Send reset link",
    "signin.forgot-sent": "If <email> belongs to a viewer of this console, a reset link is on its way.",
    "banner.title": "Before you sign in",
    "banner.accept": "I agree",
    "lock.warn": "You will be signed out in 1 minute.",
    "lock.warn.button": "Stay signed in",
    "lock.title": "Session locked",
    "lock.body": "You were inactive for <n> minutes, so this session ended and its contents are hidden. Sign in again to continue.",
    "lock.body.button": "Sign in again",
    "password.required": "This console now asks for a password too. Set one to continue.",
    "reset.title": "Choose a new password",
    "reset.title.field": "New password",
    "reset.title.button": "Save password",
    "signin.none.spokes": "No passkey yet? In the IDE, open Remote Spokes, Relay, and choose Admin Console. It gives you a one-time link.",
    "signin.none.meet": "No passkey yet? In the Meeting Hub app, open Settings, Organization, Admin Console, and choose Get a sign-in link.",
    "join.title": "Set up your passkey",
    "join.body": "This invite is for <email> and works once, until <time>. Your browser asks your device for a passkey (its PIN, fingerprint or face). Later you sign in with it here.",
    "join.label": "Name for this passkey",
    "join.button": "Create a passkey",
    "join.waiting": "Your passkey is set up. An admin of this console must approve you before you can sign in.",
    "join.passkey-waiting": "Your new passkey is set up. Confirm it from a passkey you already use, or ask another admin to approve it.",
    "join.passkey": "Set up a passkey",
    "join.security-key": "Set up your security key",
    "join.security-key.body": "Admins and user managers of this console sign in with an approved security key. Insert it and touch it when your browser asks.",
    "join.security-key.button": "Register security key",
    "join.choose": "How do you want to sign in?",
    "join.choose.options": ["A passkey on this device", "A password and an authenticator app", "A password and a passkey"],
    "join.password": "Choose a password",
    "join.password.body": "At least <n> characters. A few unrelated words are easy to remember and hard to guess.",
    "join.password.field": "Password",
    "join.password.button": "Save password",
    "join.totp": "Set up an authenticator app",
    "join.totp.body": "Scan this code with your authenticator app, or type the key below. Then enter the 6-digit code it shows.",
    "join.totp.field": "Code",
    "join.totp.buttons": ["Copy", "Finish"],
    "join.reset": "An admin reset your sign-in. Set up how you sign in again.",
    "account.key-waiting": "Your security key is set up. Another admin must approve it before it gives you admin rights.",
    // The relay answers this as the bootstrap-pinned refusal (8.3); the page shows the relay's words.
    "bootstrap.pinned": "This console waits for its first admin, <email>.",
    "banner.expiring": "The <product> license ends in <n> days, on <date>. Install a new license before then, or this relay stops serving people.",
    "banner.grace": "The <product> license ended on <date>. Service stops on <date and time> unless a new license is installed.",
    "banner.expired": "The license and its grace days are over. <product> pages are read-only until a new license is installed.",
    "banner.license-stopped": "This relay has stopped serving people: its <product> license is not active (<why>). Install a license to turn service back on.",
    "banner.upgrade-period": "This relay needs a Meeting Hub license. Service stops on <date and time> unless a license is installed.",
    // 8.1 license.why, in the order of the service view's `why` codes (R42-1).
    "license.why": ["no license is installed", "the license is for another product", "the license is for another root",
      "the license file could not be used: <verifier words>", "the license and its grace days are over"],
    "license.why.codes": ["none", "wrong-product", "wrong-root", "invalid", "expired"],
    "banner.seats-over": "<seated> people use Meeting Hub; the license covers <users>. On <date> the relay takes seats from <n> people. Request more seats, or pick who gives up a seat.",
    "banner.seats-over.button": "Request more seats",
    "locked.title": "<product> needs a license",
    "locked.body": "This relay's license does not include <product>, so its pages are not available. Security actions stay on the Security page. Install a license that includes <product>.",
    "locked.reason": "Why: <problem>",
    "license.install": "Install a license",
    "license.install.field": "License text or file",
    "license.install.button": "Install",
    "attention.title": "What needs your attention",
    "attention.none": "Nothing needs your attention.",
    "attention.license-none": "No license is installed for <product>.",
    "attention.license-grace": "The license ended. Service stops on <date and time> unless a new license is installed.",
    "attention.license-expired": "The license and its grace days are over.",
    "attention.license-expiring": "The license ends in <n> days. Install a new license before <date>.",
    "attention.license-stopped": "This relay has stopped serving people: the <product> license is not active. Install a license.",
    "attention.seats-high": "<used> of <users> licensed people are in use.",
    "attention.seats-over": "<used> people use Meeting Hub; the license covers <users>. Day <day> of 14: seats are taken from <n> people on <date>.",
    "attention.uncounted": "<n> hubs were refused because they have no license seat.",
    "attention.crl-stale": "The revocation list is out of date. Ask the root holder to refresh it.",
    "attention.signer-unhealthy": "The certificate signer is not answering.",
    "attention.signer-expiring": "The signer's certificate ends in <n> days.",
    "attention.cert-expiring": "<n> certificates end within 7 days.",
    "attention.tls-expiring": "This console's TLS certificate ends in <n> days.",
    "attention.spokes-silent": "<n> spokes have not checked in for a day.",
    "attention.enrollments-waiting": "<n> devices are waiting for approval.",
    "attention.approvals-mine": "<n> changes are waiting for your approval.",
    "attention.requests-old": "<n> requests have waited more than 3 days.",
    "attention.admins-few": "Add another admin so changes that lower security need two people.",
    "attention.anchor-single": "Every admin's access depends on <label> (<id>). Invite an admin from another hub or device.",
    "attention.admin-suspended": "<email> is suspended.",
    "attention.passkey-waiting": "A new passkey for <email> is waiting.",
    "attention.joiner-waiting": "<email> joined from <hub or device> and is waiting for approval.",
    "attention.audit-broken": "The audit log does not verify from entry <n>. Changes are paused. Export what you have, then start a new chain.",
    "attention.audit-rotating": "The audit log will soon drop entries that were never exported. Export it now.",
    "attention.audit-dropped-unexported": "The audit log dropped entries <from> to <to> before they were exported.",
    "attention.audit-not-exported": "The audit log has not been exported for 30 days.",
    "attention.quota-hits": "<n> requests were refused for limits in the last hour.",
    "attention.blocks-active": "<n> blocks are active on this relay.",
    "attention.support-waiting": "<n> support tickets from Meeting Hub wait for an answer.",
    "attention.admins-unproven": "<n> admins have not signed in since the upgrade. Ask them to try now.",
    "attention.license-upgrade-period": "Install a Meeting Hub license by <date and time>, or this relay stops serving people.",
    "attention.seats-unseated": "<n> people have no Meeting Hub seat.",
    "attention.seats-protected": "Admins alone use more seats than the license covers. Request more seats.",
    "attention.profile-standard": "This console was moved from the High security profile to Standard, which allows passwords with authenticator apps. Switch back to High if it serves a government deployment.",
    "attention.two-person-off": "This console has <n> admins. Turn on Require a second admin for sensitive changes.",
    "attention.break-glass-missing": "There is no break-glass account. The person who runs this relay creates one with lucid-relay console break-glass.",
    "attention.break-glass-used": "The break-glass account <email> signed in on <time>.",
    "attention.key-unattested": "<n> admins or user managers have no approved security key, so they have viewer rights.",
    "attention.mds-old": "The security key metadata is more than 90 days out of date. Update it in Settings.",
    "attention.signin-locked": "<n> accounts were locked after failed sign-ins in the last hour.",
    "attention.mail-failing": "Email is failing: <reason>. Check Settings, Email.",
    "attention.clock-uncertain": "This relay's clock jumped or was off for more than a day, so seat deadlines are on hold. Check the time, then confirm it. If no one confirms it within <n> hours, people over the license are held without service until someone does.",
    "attention.seats-held": "<n> people over the license have no service because the relay's time was not confirmed for 72 hours. Confirm the relay's time to release them.",
    "attention.seal-machine-scope": "Secrets are protected by machine-wide Windows DPAPI, which any account on this computer can unlock. Run lucid-relay console seal-setup to use the relay's own service account.",
    "attention.clock-back": "This relay's clock is behind the last time it trusted. Deadlines still count from that time. Fix the clock.",
    "attention.aaguids-relaxed": "Some approved security key models have no FIPS certificate in their metadata. Under the High profile they would not count.",
    "attention.seal-key-file": "Secrets are protected by a key file next to the state. Run lucid-relay console seal-setup to use the relay's service account or a systemd encrypted credential, as the High profile needs.",
    "attention.seal-lost": "Saved secrets could not be unlocked on this host. Email is off; enter its secrets again. Authenticator apps must be set up again.",
    "admins.unproven": "Not signed in since the upgrade",
    "meet.viewer-rights": "Signed in with a passkey that does not come from your Meeting Hub device, so admin actions are off. Sign out, then sign in with a passkey you added from your own Meeting Hub device.",
    "high.viewer-rights": "You signed in without an approved security key, so you have viewer rights. Under this console's High profile, admins and user managers sign in with a FIPS certified hardware security key. You can add one in Your account; another admin then approves it.",
    "seats.migrated": "People who had devices before this version are ordered by the earliest record this relay kept for them; where there was none, by their ID.",
    "clock.title": "Relay time",
    "clock.title.line": "Relay clock: <time>. Your browser: <time>.",
    "clock.title.button": "Confirm the relay's time",
    "clock.title.note": "This changes only the seat clock. It never extends a license, its grace or the upgrade period.",
    "seal.provider": "Secrets are protected by <provider>.",
    "seal.provider.names": ["Windows DPAPI under the relay's service account", "machine-wide Windows DPAPI (Standard only)",
      "a systemd encrypted credential (<key mode>)", "a key file next to the state (Standard only)"],
    "seal.provider.refused": "Not used: <provider>, because <why>.",
    // String.raw keeps the one backslash of the account name as written in 8.1.
    "seal.provider.why": [String.raw`the relay does not run as NT SERVICE\LucidRelay`, "it runs in a container", "/etc/lucid-relay/seal-provider.json is missing",
      "the install record names no key", "the install record is not owned by root", "the credential file named in the install record is missing",
      "the credential file does not match the install record"],
    "breakglass.gate": "This console needs its break-glass account before it can be administered. The person who runs this relay creates it with lucid-relay console break-glass.",
    "seats.summary": "<seated> of <users> seats in use.",
    "seats.stopped": "No Meeting Hub license is active, so this relay serves no one and seat rules wait. Install a license.",
    // 8.1 "Words the Meeting Hub relay answers people" (R42-1); the fleet People page shows them beside the invite
    // controls of a stopped Meeting Hub relay (AC-2a 11.4).
    "meet.license-inactive": "Your organization's Meeting Hub license is not active. Ask your admin.",
    "seats.state": ["Seated", "Picked to give up a seat", "No seat", "Always keeps a seat"],
    "seats.actions": ["Give up seat first", "Keep seat", "Request more seats"],
    "seats.request": "Request more Meeting Hub seats",
    "seats.request.field": "Seats wanted",
    "seats.request.button": "Send request",
    "seats.request-sent": "Sent to <address>. The same request is below if you want to send it another way.",
    "seats.request-sent.button": "Copy",
    "seats.request-copy": "Email is not set up, so nothing was sent. Copy this request and send it to whoever sells you Lucid licenses.",
    "seats.request-copy.button": "Copy",
    "settings.sections": ["Security", "Sign-in and sessions", "Email", "License", "Other consoles"],
    "settings.profile": "Security profile",
    "settings.profile.button": "Change profile",
    "settings.profile.high": "High: everyone signs in with a passkey or security key, and admins and user managers with an approved hardware security key. For government and regulated use.",
    "settings.profile.standard": "Standard: people may also sign in with a password and an authenticator app, and admins with any passkey. For commercial organizations.",
    "settings.two-person": "Require a second admin for sensitive changes",
    "settings.banner": "Sign-in banner",
    "settings.aaguids": "Approved security keys",
    "settings.aaguids.buttons": ["Add", "Remove"],
    "settings.mds": "Security key metadata: number <no>, next update <date>",
    "settings.mds.button": "Update security key metadata",
    "settings.require-password": "Require a password too",
    "settings.sessions": "Sign out after <n> minutes without activity, and after <h> hours at most",
    "settings.sessions-fixed": "Under the High profile, sessions end after 15 minutes without activity and after 12 hours.",
    "settings.email": "Send with",
    "settings.email.modes": ["Off", "SMTP server", "Microsoft Graph"],
    "settings.email.from": "Sender address",
    "settings.email.host": "Server",
    "settings.email.port": "Port",
    "settings.email.tls": "Security",
    "settings.email.tls-modes": ["STARTTLS", "TLS"],
    "settings.email.username": "User name",
    "settings.email.password": "Password",
    "settings.email.ca": "Extra trusted certificate",
    "settings.email.cloud": "Cloud",
    "settings.email.clouds": ["Microsoft 365", "Microsoft 365 GCC High", "Microsoft 365 DoD"],
    "settings.email.tenant": "Tenant ID",
    "settings.email.client": "Application ID",
    "settings.email.mailbox": "Mailbox",
    "settings.email.credential": "Credential",
    "settings.email.credentials": ["Certificate", "Client secret"],
    "settings.email.saved": "Saved",
    "settings.email.buttons": ["Save", "Send test email"],
    "settings.email-sent": "A test email went to <email>.",
    "settings.license-request-to": "Seat requests go to",
    "breakglass.none": "No break-glass account yet. The person who runs this relay creates it with lucid-relay console break-glass.",
    "breakglass.set": "Break-glass account: <email>. Last used: <time or never>.",
    "account.methods": "Sign-in methods",
    "account.methods.buttons": ["Add a passkey", "Add a security key", "Set a password", "Change password", "Set up an authenticator app", "Remove"],
    "account.methods.fields": ["Current password", "New password"],
    "account.methods.key": "Approved security key: <model>",
    "account.methods.app": "Authenticator app",
    "account.mail": "Email me about",
    "stepup.totp": "Enter the 6-digit code from your authenticator app to confirm.",
    "stepup.totp.field": "Code",
    "dialog.single": "Two-person control is off, so this happens as soon as you confirm. It is recorded in the audit log.",
    "admins.break-glass": "Break-glass account",
    "empty.hubs": "No hubs have reached this relay yet.",
    "empty.spokes": "No spokes have reached this relay yet. A spoke appears after its first message through this relay.",
    "empty.seats": "No one holds a license seat yet.",
    "empty.people": "No one has a device on this relay yet.",
    "empty.seats-meet": "No one holds a Meeting Hub seat yet.",
    "empty.enrollments": "No devices are waiting for approval.",
    "empty.organizations": "No organizations yet. People are put into one from People and devices.",
    "empty.holds": "No legal holds.",
    "empty.support": "No support tickets.",
    "help.support": "Every Meeting Hub has a built-in support engineer. When it cannot solve a problem, the person can send the case here as a ticket: their words and the redacted checks, never meeting content. Answer it, and the person sees the answer in their Meeting Hub.",
    "empty.bridges": "No bridges are on.",
    "empty.approvals": "Nothing is waiting for approval.",
    "empty.requests": "No requests.",
    "empty.audit": "No entries match these filters.",
    "empty.logs": "No lines match these filters.",
    "empty.filtered": "Nothing matches these filters.",
    "empty.filtered.button": "Clear filters",
    "help.overview": "A summary of this relay and what needs an admin. Each card opens its page.",
    "help.requests": "Some changes need a signature that this relay never holds. The console sends them as requests, and they are done when the signing side does them.",
    "help.approvals": "With two-person control on, changes that lower security or take access away need a second admin. Each request lasts 24 hours.",
    "help.seats": "When more people use Meeting Hub than the license covers, the relay waits 14 days, then takes seats from the people picked here first, then from the newest. Relay admins always keep a seat, and no certificate is revoked.",
    "help.two-person": "When on, changes that lower security or take access away wait for a second admin. Recommended with three or more admins.",
    "help.banner": "Shown before sign-in. Each person accepts it once per session. Leave it empty for none.",
    "help.aaguids": "When this list has entries, only these models give admins and user managers their rights, and each must still have a FIPS certificate and hardware key protection in its metadata. An empty list allows every model that does.",
    "help.aaguids.standard": "These models count as approved security keys, even without a FIPS certificate in their metadata. Under the High profile that is not enough.",
    "help.mds": "Load a newer metadata file from the FIDO Alliance. The console checks its signature.",
    "help.audit": "Every change made here, who made it and when. Each entry is chained to the one before, so an exported copy shows any later edit.",
    "help.blocks": "A block stops this relay from serving a node or device for a while. It does not revoke the certificate; ask for a revocation for that.",
    "help.security": "These actions shut doors, so they work whatever the license says.",
    "help.spokes-elsewhere": "Pairing, taking a spoke out of service, tasks, kits and backups are done in the IDE's Remote Spokes panel or with lucid-spoke on that machine.",
    "help.meet-signing": "Approvals are signed in the Meeting Hub app by an admin's own device. The console sends the request; the app shows it under Admin Console requests.",
    "help.meet-policies": "Policies are signed in the Meeting Hub app.",
    "help.id1": "Verify and approve in the Meeting Hub app. This list is the relay's copy and is not verified here.",
    "help.id1-none": "This relay does not carry organization sign-in yet.",
    "help.push": "Push settings live in relay.json and need a restart.",
    "admins.unverified": "Invited by <email>, not verified by a hub",
    "dialog.id": "ID",
    "dialog.second": "Another admin must approve this before it happens.",
    "dialog.sent": "Sent for approval. Another admin has 24 hours to approve it.",
    "audit.restart": "Start a new chain",
    "footer": "The relay carries sealed messages and never shows their contents.",
  };

  // ---- Confirmation dialogs (8.2, exact): title, body lines, buttons. The last button is the one shown when a second
  // admin must approve; `single` is the button with two-person control off where 8.2 names a different one. ----
  const D = {
    "invite-viewer": { title: "Invite <email> as a viewer?", body: ["They can see health and lists but change nothing. The link works once, for 24 hours."], button: ["Create invite"] },
    "invite-admin-spokes": { title: "Invite <email> as an admin?", body: ["Admins can change everything in this console. After approval the link goes to you, and you pass it on."], button: ["Ask for approval"], single: "Create invite" },
    "invite-admin-meet": { title: "Ask <email> to join as an admin?", body: ["They get their own sign-in link from their device in the Meeting Hub app, then join as a viewer until a second admin makes them an admin."], button: ["Send request"] },
    "approve-joiner": { title: "Let <email> sign in as a viewer?", body: ["They joined from <hub or device>. Approve only if you expected them."], button: ["Approve"] },
    "approve-passkey": { title: "Approve a new passkey for <email>?", body: ["It was added from <hub or device> on <time>. Approve only if <email> told you they added it."], button: ["Approve"] },
    "confirm-passkey": { title: 'Confirm your new passkey "<label>"?', body: ["Confirm with a passkey you already use."], button: ["Confirm"] },
    "role-admin": { title: "Make <email> an admin?", body: ["Admins can change everything in this console."], button: ["Ask for approval"], single: "Make admin" },
    "role-viewer": { title: "Make <email> a viewer?", body: ["They lose every admin action at once."], button: ["Ask for approval"], single: "Make viewer" },
    "role-user-manager": { title: "Make <email> a user manager?", body: ["They can invite and suspend viewers and user managers, pick who gives up a seat, and see people lists. They change no settings."], button: ["Make user manager", "Ask for approval"] },
    "user-manager-viewer": { title: "Make <email> a viewer?", body: ["They lose every user manager action at once."], button: ["Make viewer"] },
    "remove-viewer": { title: "Remove <email>?", body: ["Their sign-in methods and sessions are deleted. They need a new invite to come back."], button: ["Remove"] },
    "remove-admin": { title: "Remove <email> as an admin?", body: ["Their sign-in methods and sessions are deleted."], button: ["Ask for approval"], single: "Remove" },
    "suspend": { title: "Suspend <email>?", body: ["They are signed out now and cannot sign in until someone unsuspends them."], button: ["Suspend", "Ask for approval"] },
    "unsuspend": { title: "Unsuspend <email>?", body: ["They can sign in again with their sign-in methods."], button: ["Unsuspend"] },
    "reset-sign-in": { title: "Reset sign-in for <email>?", body: ["Their password, authenticator app, passkeys and security keys are deleted and they are signed out. You get a link to pass on so they can set up sign-in again."], button: ["Reset", "Ask for approval"] },
    "invite-user-manager": { title: "Invite <email> as a user manager?", body: ["They can invite viewers and user managers, suspend them, pick who gives up a seat, and see people lists. The link works once, for 24 hours; pass it on yourself."], button: ["Create invite"] },
    "resend-invite": { title: "Send a new invite link to <email>?", body: ["The old link stops working now. The new one works once, for 24 hours."], button: ["Resend"] },
    "end-sessions": { title: "Sign <email> out everywhere?", body: ["Every session of theirs ends now. They can sign in again."], button: ["Sign out everywhere"] },
    "remove-passkey": { title: 'Remove the passkey "<label>"?', body: ["You can no longer sign in with it."], button: ["Remove"] },
    "license": {
      title: "Install the license for <org>?",
      body: ["Now: <product>, <edition>, <users> people, <relays> relays, ends <date>, ID <id>.",
        "New: <product>, <edition>, <users> people, <relays> relays, ends <date>, ID <id>.",
        "Every hub needs a new license seat from the root before it is admitted again.",
        "This relay starts serving people again.",
        "This relay honors 2 grace days of the <n> in this license."],
      meet: ["The upgrade period ends now: this license lasts past <date>.",
        "The upgrade period stays until <date>, because this license ends before it.",
        "<seated> people use Meeting Hub and this license covers <users>, so a 14-day seat clock starts.",
        "<seated> people use Meeting Hub and this license covers <users>, so the seat clock keeps running (day <day> of 14).",
        "<seated> people use Meeting Hub and this license covers <users>, so the seat clock stops.",
        "<n> people without a seat get one back now."],
      button: ["Install", "Ask for approval"],
    },
    "export": { title: "Export the audit log, entries <from> to <to>?", body: ["The file holds admin emails and addresses. Keep it somewhere safe."], button: ["Export"] },
    "approve-approval": {
      title: "Approve: <summary>?",
      body: ['Asked by <email> on <time>: "<reason>". It happens as soon as you approve.', "Every detail:",
        "The link goes to <requester>, who passes it on."],
      button: ["Approve"],
    },
    "refuse-approval": { title: "Refuse: <summary>?", body: ["Nothing changes."], button: ["Refuse"] },
    "block": { title: "Block <name> on this relay for <n> hours?", body: ["This relay stops serving it until <time>. Its certificate stays valid elsewhere."], button: ["Block", "Ask for approval"] },
    "unblock": { title: "Unblock <name>?", body: ["This relay serves it again."], button: ["Unblock", "Ask for approval"] },
    "crl": { title: "Use revocation list version <v>?", body: ["It revokes <n> certificates. Sessions of revoked certificates end now."], button: ["Use this list"] },
    "directory": { title: "Use relay directory version <v>?", body: ["It lists <n> relays."], button: ["Use this directory"] },
    "request-revoke": { title: "Ask to revoke <name>?", body: ["The root holder (Remote Spokes) or an admin in the Meeting Hub app does the revocation. Until then, you can block it on this relay."], button: ["Send request"] },
    "request-renew": { title: "Ask the root to renew <name>?", body: ["The root holder renews it and installs the new certificate."], button: ["Send request"] },
    "request-seat": { title: "Ask the root for a license seat for <name>?", body: ["The root holder signs a seat; the hub installs it."], button: ["Send request"] },
    "request-approve": { title: "Ask an admin to approve <name>'s <device>?", body: ["Check code <check>. An admin approves it in the Meeting Hub app after checking the code with <name>."], button: ["Send request"] },
    "request-refuse": { title: "Ask an admin to refuse <name>'s <device>?", body: ["Check code <check>. An admin approves it in the Meeting Hub app after checking the code with <name>."], button: ["Send request"] },
    "request-invite": { title: "Ask an admin to invite <name> (<email>)?", body: ["An admin makes the invite in the Meeting Hub app and sends it."], button: ["Send request"] },
    "cancel-request": { title: "Cancel the request to <summary>?", body: ["Asked by <email>. The signing side will no longer see it."], button: ["Cancel request"] },
    "org-set": { title: "Put <name> in <org>?", body: ["<org>'s signed policy applies to them from their next connection."], button: ["Put in <org>", "Ask for approval"] },
    "org-move": { title: "Take <name> out of <org>?", body: ["<org>'s policy stops applying to them."], button: ["Ask for approval"], single: "Take out" },
    "bridge-off": { title: "Turn off bridges for <org>?", body: ["Messages stop flowing to and from <platform list> now."], button: ["Turn off"] },
    "bridge-change": { title: "Change bridges for <org>?", body: ["<diff>."], button: ["Ask for approval"], single: "Change bridges" },
    "hold-place": { title: "Place a legal hold on <n> people or conversations?", body: ["Their messages and files are kept past retention until the hold is released."], button: ["Place hold", "Ask for approval"] },
    "hold-release": { title: 'Release the hold "<reason>"?', body: ["Retention applies again."], button: ["Release hold", "Ask for approval"] },
    "support-answer": { title: 'Answer "<title>"', body: ["The person sees your answer in their Meeting Hub."], button: ["Send answer"] },
    "support-close": { title: 'Close "<title>"?', body: ["The person sees it closed. A new question starts a new ticket."], button: ["Close ticket"] },
    "release": { title: "Publish Lucid Meeting Hub <version>?", body: ["Every Hub sees it at its next check. Minimums: Hub <hub> (now <hub now>), iPhone <ios> (now <ios now>)."], button: ["Publish", "Ask for approval"] },
    "files-start": { title: "Start the download server?", body: ["Invite links work while it runs."], button: ["Start"] },
    "audit-restart": { title: "Start a new audit chain?", body: ["Export first. The new chain names the torn file so the gap is on record."], button: ["Start a new chain"] },
    "profile-standard": { title: "Switch this console to the Standard profile?", body: ["People may then sign in with a password and an authenticator app, which can be phished, and admins no longer need an approved security key."], button: ["Switch to Standard", "Ask for approval"] },
    "profile-high": { title: "Switch this console to the High profile?", body: ["Everyone must then sign in with a passkey or security key, and admins and user managers with an approved security key. Sessions that do not meet this end now."], button: ["Switch to High"] },
    "two-person-on": { title: "Require a second admin for sensitive changes?", body: ["Changes that lower security or take access away will wait for another admin's approval."], button: ["Turn on"] },
    "two-person-off": { title: "Stop requiring a second admin?", body: ["Any one admin can then make every change alone. Another admin must approve this."], button: ["Ask for approval"] },
    "sign-in-settings": { title: "Change sign-in settings?", body: ["<diff>."], button: ["Save", "Ask for approval"] },
    "banner": { title: "Change the sign-in banner?", body: ["Everyone sees the new text before their next sign-in."], button: ["Save"] },
    "key-approve": {
      title: "Add <model> to the approved security keys?",
      body: ["Once the list has entries, only listed models give admins and user managers their rights, and only with a FIPS certificate and hardware key protection in their metadata."],
      bodyStandard: ["Keys of this model count as approved even without a FIPS certificate in their metadata. Under the High profile that is not enough."],
      button: ["Approve", "Ask for approval"],
    },
    "key-remove": { title: "Remove <model> from the approved security keys?", body: ["If the list still has entries, admins and user managers who sign in with this model have viewer rights until they add a listed key."], button: ["Remove", "Ask for approval"] },
    "confirm-time": { title: "Confirm the relay's time?", body: ["Relay clock: <time>. Your browser: <time>. Seat deadlines held while the time was uncertain continue from now."], button: ["Confirm", "Ask for approval"] },
    "metadata": { title: "Use security key metadata number <no>?", body: ["It was published by the FIDO Alliance and is valid until <date>."], button: ["Use this metadata"] },
    "email": { title: "Save email settings?", body: ["Mail is sent with <mode> from <from>. A test email goes to you through the new settings first; if it does not go through, nothing changes."], button: ["Save"] },
    "email-off": { title: "Turn email off?", body: ["No invites, seat notices or security alerts will be mailed."], button: ["Turn off", "Ask for approval"] },
    "seat-request-address": { title: "Send seat requests to <address>?", body: ["Requests for more Meeting Hub seats go to this address."], button: ["Save"] },
    "seat-pick": { title: "Pick <name> to give up a seat first?", body: ["If this relay still has more people than seats on <date>, <name> loses their seat before others. Their certificate stays valid."], button: ["Pick"] },
    "seat-unpick": { title: "Keep <name>'s seat?", body: ["<name> no longer gives up a seat first."], button: ["Keep seat"] },
    "seat-request": { title: "Request <n> Meeting Hub seats?", body: ["A request goes to <address> with your organization, license ID, <seated> seats in use and your email."], button: ["Send request"] },
    "add-security-key": { title: "Add a security key?", body: ["Insert your security key, then confirm with a method you already use."], button: ["Add"] },
    "set-password": { title: "Set a new password?", body: ["You use it the next time you sign in."], button: ["Save password"] },
    "totp-setup": { title: "Set up an authenticator app?", body: ["Confirm first; then scan the code it shows."], button: ["Continue"] },
    "totp-remove": { title: "Remove your authenticator app?", body: ["You can no longer use its codes here."], button: ["Remove"] },
  };

  // Refusal words the page shows on its own (8.3), before the relay is asked.
  const R = {
    "bad-url": "Links must start with https:// and name a host.",
    "crl-refused": "This revocation list cannot be used: <reason>.",
    "directory-refused": "This relay directory cannot be used: <reason>.",
    "license-refused": "This license cannot be used here: <reason>.",
    "license-ended": "This license has already ended. Install a current one.",
    "mds-refused": "This metadata file cannot be used: <reason>.",
  };

  // Plain words the contract leaves to the page (labels, columns, short notices).
  const MSG = {
    plainTitle: "Lucid Admin Console",
    more: "More actions",
    moreFor: "More actions for <name>",
    showing: "Showing <n> of <total>",
    loadMore: "Load more",
    filters: "Filters",
    filterText: "Filter",
    all: "All",
    whatIsThis: "What is this?",
    reason: "Reason",
    reasonCount: "<n> of 500 characters",
    reasonNeeded: "Write a reason of 1 to 500 characters.",
    done: "Done.",
    requestSent: "Request sent. It shows on the Requests page until the signing side does it.",
    copied: "Copied.",
    copy: "Copy",
    passkeyClosed: "The passkey prompt closed before it finished. Nothing was changed.",
    codeClosed: "Nothing was changed.",
    codeNeeded: "Enter the 6 digits.",
    noPasskeys: "This browser does not support passkeys. Use a current browser.",
    noAnswer: "The relay did not answer. Check your connection and try again.",
    httpError: "The relay answered with an error (<status>).",
    signedOut: "Signed out.",
    linkOnce: "The link, shown once. Pass it on yourself.",
    linkMailed: "A copy went to <email> by email.",
    yes: "Yes",
    no: "No",
    on: "On",
    off: "Off",
    turnOn: "Turn on",
    turnOff: "Turn off",
    never: "Never",
    unknown: "Unknown",
    set: "Set",
    notSet: "Not set",
    choose: "Choose a file",
    paste: "Or paste it here",
    check: "Check the chain",
    exportBtn: "Export",
    show: "Show",
    hours: "Hours (1 to 720)",
    save: "Save",
    add: "Add",
    remove: "Remove",
    cancelInvite: "Cancel invite",
    resend: "Resend",
    endSession: "End session",
    rename: "Rename",
    confirm: "Confirm",
    approve: "Approve",
    refuse: "Refuse",
    cancel: "Cancel",
    discard: "Discard",
    inviteSomeone: "Invite someone",
    addPasskeyBody: "Your browser first asks for a passkey you already use, then creates the new one.",
    renameTitle: 'Rename the passkey "<label>"?',
    noneYet: "None yet.",
    thisSession: "This session",
    chainOk: "The chain verifies through entry <n>.",
    chainBad: "The chain does not verify from entry <n>.",
    sev: { bad: "Needs action", warn: "Check", info: "Note" },
    cardState: { ok: "Good", warn: "Check", bad: "Needs action" },
    go: "Go",
    help: "Help",
    helpGuide: "The relay's guide has a section on the Admin Console: setup, source networks, trusted fronts, sign-in methods and profiles, email, and the operator commands.",
    unreadable: "it could not be read",
    sole: "One admin can do this.",
    waitingFor: "Waiting for me",
    allApprovals: "All",
    shownOnce: "Shown once",
    kinds: { passkey: "Passkey", "security-key": "Security key" },
    password: "Password",
    privateKey: "Private key (PEM)",
    certificate: "Certificate (PEM)",
    secret: "Client secret",
    minutes: "Minutes without activity",
    maxHours: "Hours at most",
    aaguid: "AAGUID",
    model: "Model",
    metadataFile: "Metadata file",
    held: "Held without service since",
    qrLabel: "QR code for your authenticator app",
    key: "Key",
    changed: "<name>: <old> to <new>",
    // The license view's `service` (4.7, R42-1).
    service: { on: "On", grace: "Grace", "upgrade-period": "Upgrade period", stopped: "Stopped" },
    serviceLabel: "Service to people",
    stopsAt: "Service stops",
    serviceWhy: "Why",
    reminders: "Reminders sent",
    reminderKind: { "days-30": "30 days", "days-14": "14 days", "days-7": "7 days", "days-3": "3 days", "days-1": "1 day",
      "grace-start": "At expiry", "grace-repeat": "In grace", stopped: "Service stopped", "upgrade-period": "Upgrade period" },
    wantedNeeded: "Write a number of seats above the license's <users>, at most 10,000.",
    emailNeeded: "Write an email.",
    none: "None",
    noneSent: "none yet",
    noEntries: "No entries yet.",
    noAnswerConsole: "The console did not answer. Check your connection and try again.",
    httpErrorConsole: "The console answered with an error (<status>).",
    httpErrorRelay: "<name> answered with an error (<status>).",
    footerFleet: "Relays carry sealed messages, and neither they nor this console show their contents.",
    helpGuideFleet: "The Lucid Admin Console guide covers setup, deploying relays, sign-in methods and profiles, email, and the operator commands.",
    invite: "Invite",
    askInvite: "Ask an admin to invite someone",
    stoppedAdmin: "The Meeting Hub license of <relay> is not active, so it takes no invites. Install a license on that relay first.",
    stoppedAdminHere: "The Meeting Hub license is not active, so this relay takes no invites. Install a license first.",
    removeLicense: { title: "Remove license <id> from the library?", body: ["Relays that already installed it keep it. You can add it again later."], button: ["Remove"] },
    revokeToken: { title: "Revoke the scrape token <label>?", body: ["Anything that reads metrics with it stops working now."], button: ["Revoke"] },
    cancelInviteDlg: { title: "Cancel the invite for <email>?", body: ["The link stops working now. You can invite them again later."], button: ["Cancel invite"] },
    cancelApproval: { title: "Cancel your request: <summary>?", body: ["Nothing changes, and other admins no longer see it."], button: ["Cancel request"] },
    endThis: { title: "End this session?", body: ["This signs you out of this browser now."], button: ["Sign out"] },
    endOther: { title: "End this session?", body: ["That browser is signed out now. You stay signed in here."], button: ["End session"] },
    // Full sentences for a field the page refuses before asking (7.6), shown next to the field.
    need: {
      name: "Enter a name of 1 to 64 letters, digits, spaces, dots, dashes, underscores or parentheses.",
      site: "Enter a site of up to 64 letters, digits, spaces, dots, dashes, underscores or parentheses.",
      pki: "Choose where the relay certificate comes from.",
      fingerprint: "Enter the fingerprint the relay printed.",
      personName: "Enter the person's name.",
      days: "Enter a number of days from 1 to 30.",
      hours: "Enter a number of hours from 1 to 720.",
      label: "Enter a label of 1 to 64 characters.",
      tokenDays: "Enter a number of days from 30 to 90.",
      aaguid: "Enter the AAGUID as 32 hexadecimal digits, grouped 8-4-4-4-12.",
      serial: "Enter the serial as 2 to 64 hexadecimal digits.",
      certPem: "Paste the ended certificate in PEM form.",
      passkeyName: "Enter a name for this passkey.",
      setupCode: "Enter the setup code from setup-code.txt.",
      generation: "Enter the CA generation as a whole number and its fingerprint.",
      adminKeys: "Enter each admin key fingerprint as 64 hexadecimal digits.",
      sessions: "Enter 5 to 60 minutes without activity and 1 to 24 hours at most.",
    },
  };

  // ---- Fleet words (AC-2a 13.1, exact; tests/vectors/admin_console_fleet_words_v1.json "page"), by the vector's ids.
  // The endorse.* words and the "endorse key" dialog are the IDE plugin's and the Hub app's, and the phase 4 and 5 nav
  // places are not rendered (12.4), so none of them is here. ----
  const FW = {
    "nav.overview": "Overview",
    "nav.people": "People",
    "nav.spokes": "Remote Spokes",
    "nav.meet": "Meeting Hub",
    "nav.relays": "Relays and locations",
    "nav.license": "License",
    "nav.sign-in": "Sign-in",
    "nav.email": "Email",
    "nav.security": "Security and audit",
    "nav.settings": "Settings",
    "chip.fleet": "All relays",
    "chip.count": "<n> relays",
    "fleet.managed": "This relay is managed by the Lucid Admin Console at <origin>. Changes made there are checked here first.",
    "fleet.no-relays-spokes": "No Remote Spokes relay is connected yet.",
    "fleet.no-relays-meet": "No Meeting Hub relay is connected yet.",
    "fleet.add": "Add a relay",
    "fleet.picker": "Relay: <name>",
    "fleet.all": "All relays",
    "fleet.missing": "Some relays did not answer: <names>.",
    "fleet.as-of": "As of <time>",
    "fleet.scope-missing": "This relay did not give the Admin Console the <scope> scope, so this page is empty.",
    "fleet.scope-ask": "Ask the relay's operator to add it",
    "fleet.unconfirmed": "Not confirmed yet. Compare the fingerprint with the one the relay printed, then confirm it.",
    "fleet.waiting-operator": "Waiting for this relay's operator to confirm the change (<id>).",
    "fleet.confirm-unknown": "The relay stopped while running this change (<id>). It was not run again. Check the relay, then ask again if the change is missing.",
    "fleet.read-only": "Read only",
    "fleet.confirm-here": "Confirm here",
    "fleet.roster-waiting": "Relays need to learn <n> new keys before those people can make changes on them.",
    "fleet.endorse": "Confirm the new keys",
    "fleet.webauthn-only": "Changes on relays need a passkey or security key. Add one in Your account.",
    "health.ok": "Healthy",
    "health.warn": "Needs a look",
    "health.bad": "Problem",
    "health.silent": "Not reachable",
    "state.pending": "Waiting for the relay",
    "state.unconfirmed": "Not confirmed",
    "state.active": "Connected",
    "state.left": "Left the console",
    "state.removed": "Removed",
    "scope.read-health": "Health and status",
    "scope.read-logs": "Logs and audit",
    "scope.people": "People",
    "scope.config": "Configuration",
    "scope.license": "License",
    "scope.upgrade": "Upgrades (coming later)",
    "enroll.title": "Deploy a relay",
    "enroll.product": "Product",
    "enroll.name": "Name",
    "enroll.site": "Site or cloud region",
    "enroll.scopes": "What this console may do on the relay",
    "enroll.replaces": "Replace <name>",
    "enroll.code-title": "Enrollment code",
    "enroll.code-once": "Copy this code now. It is shown only once and works for 1 hour, on one relay.",
    "enroll.commands": "On the relay's host, stop the relay, run this command and paste the code when it asks, then start the relay:",
    "enroll.no-code-in-command": "The command does not contain the code, so it stays out of shell history.",
    "bootstrap.how-to-anchor": "This relay trusts an admin's key only after that admin endorses it from their IDE or Hub app (Endorse my Admin Console key), or after the relay's operator added its fingerprint when enrolling.",
    "account.record-key": "Record this key in my IDE or Hub app",
    "bootstrap.pending": "The relay has not confirmed which admins it trusts yet.",
    "bootstrap.done": "The relay trusts these admins.",
    "account.fingerprints": "Key fingerprints for relays",
    "account.fingerprints-help": "Write these down now and keep them outside the console. A relay operator can use them to trust your key.",
    "trust.title": "Trust",
    "trust.ca-new": "New management CA <generation>, fingerprint <fingerprint>. Each relay's operator confirms it on the relay.",
    "trust.server-revoke": "Replace the management certificate now",
    "trust.ca-rollover": "Start a new management CA",
    "setup.this-host-standard": "On one machine the console and this relay share one trust boundary: if the console is broken into, so is this relay. Other relays keep their own protection.",
    "setup.this-host-high": "Under High the console and the relay run as two services with separate accounts on this host. Run these two commands as an administrator, then add the relay with a code like any other:",
    "enroll.local": "Or paste the code in the relay's own Admin Console, under Settings, Lucid Admin Console.",
    "enroll.copied": "I copied the code",
    "enroll.fingerprint": "Fingerprint",
    "enroll.confirm-help": "The relay printed its fingerprint when it joined. Confirm only if both match.",
    "charts.range-1h": "1 hour",
    "charts.range-24h": "24 hours",
    "charts.range-7d": "7 days",
    "charts.range-30d": "30 days",
    "charts.table": "Show as a table",
    "charts.no-data": "No data for this time.",
    "charts.people": "People online",
    "charts.calls": "Calls and call minutes",
    "charts.messages": "Messages",
    "charts.spokes": "Spokes and lanes busy",
    "charts.cpu": "CPU",
    "charts.memory": "Memory",
    "charts.network": "Network in and out",
    "charts.latency": "Latency to the console",
    "charts.expiry": "Certificate and license expiry",
    "charts.health": "Health over time",
    "kpi.relays": "Relays healthy",
    "kpi.people": "People online",
    "kpi.calls": "Calls now",
    "kpi.messages": "Messages today",
    "people.title": "People",
    "people.kind-console": "Admin Console",
    "people.kind-meet": "Meeting Hub",
    "people.kind-spokes": "Remote Spokes",
    "people.invite": "Invite",
    "people.import": "Import from CSV",
    "people.import-check": "Check the file",
    "people.import-run": "Send <n> invites",
    "people.remind": "Remind the relay's admins",
    "people.suspend": "Suspend on this relay",
    "people.unsuspend": "Lift the suspension",
    "people.remove": "Remove from this relay",
    "people.request-waiting": "Waiting for an admin in the Hub app",
    "setup.code-title": "Set up the Lucid Admin Console",
    "setup.code-help": "Enter the setup code. It is in the file setup-code.txt in the console's state folder on its host.",
    "setup.code-field": "Setup code",
    "setup.gov": "Is this a government deployment?",
    "setup.gov-yes": "Yes, use the High security profile",
    "setup.gov-no": "No, use the Standard security profile",
    "setup.gov-help": "High is for government and other regulated organizations: everyone signs in with phishing-resistant methods, and admins need approved security keys. Standard suits most companies: passkeys, Windows Hello and authenticator apps all work. This cannot be changed later.",
    "setup.gov-fixed": "This console was started with the <profile> profile by its operator.",
    "setup.first-admin": "First admin",
    "setup.email-field": "Your email",
    "setup.breakglass": "Under High, create the break-glass account now. On the console's host, run:",
    "setup.signin": "Sign-in methods",
    "setup.sso-later": "SSO comes in a later update.",
    "setup.email": "Email",
    "setup.license": "License",
    "setup.relay": "First relay",
    "setup.this-host": "Run a relay on this host",
    "setup.this-host-help": "Restart the relay with --with-console <folder> (Remote Spokes) or set with_console in relay.json (Meeting Hub). It joins this console at its next start.",
    "setup.other-host": "Deploy a relay on another host",
    "setup.step": "Step <n> of 6",
    "setup.save": "Save and continue",
    "setup.skip": "Skip for now",
    "setup.back": "Back",
    "setup.finish": "Finish",
    "setup.checklist": "Finish setup",
    "setup.state-open": "Not done",
    "setup.state-done": "Done",
    "setup.state-skipped": "Skipped",
    "setup.continue": "Continue",
    "setup.hide": "Hide the checklist",
    "exports.title": "Exports",
    "exports.token-new": "Create a scrape token",
    "exports.token-once": "Copy this token now. It is shown only once.",
    "exports.siem": "Send audit and security events to a SIEM",
    "exports.siem-reasons": "Include the reasons people typed",
    "exports.siem-test": "Send a test message",
    // API-1 7.3 (API-1a6): Settings > API access, and the API destinations and failover credentials of Exports.
    "api.title": "API access",
    "api.org": "Organization",
    "api.no-orgs": "This console holds no organization yet.",
    "api.state-none": "No API map is signed for this organization yet, so nothing can use the API.",
    "api.state-on": "The API is on.",
    "api.state-off": "The API is turned off: every API client and scrape token of this organization is refused. Exports continue.",
    "api.state-expired": "The API map has ended: every API client and scrape token is refused and exports have stopped. Save to sign a new map.",
    "api.state-set-aside": "The API map was set aside: clients, scrape tokens and exports of this organization are stopped until a new map is signed.",
    "api.map": "Map <seq>, signed <issued>, ends <expires>.",
    "api.edition": "The API needs the Enterprise edition.",
    "api.limits": "Up to <clients> clients, <destinations> destinations and <tokens> scrape tokens.",
    "api.clients": "API clients",
    "api.client-add": "Add a client",
    "api.col-owner": "Owner",
    "api.col-scopes": "Scopes",
    "api.col-ceiling": "Highest data class",
    "api.col-credentials": "Credentials",
    "api.shown-active": "Active",
    "api.shown-suspended": "Suspended",
    "api.shown-expired": "Expired",
    "api.shown-owner-gone": "Owner left",
    "api.edit": "Edit",
    "api.suspend": "Suspend",
    "api.resume": "Resume",
    "api.delete": "Delete",
    "api.new-secret": "New secret",
    "api.revoke-tokens": "Revoke tokens",
    "api.denied": "<n> tokens are refused now.",
    "api.kind-monitoring": "Monitoring",
    "api.kind-integration": "Integration",
    "api.ceiling-public": "Public",
    "api.ceiling-internal": "Internal",
    "api.ceiling-confidential": "Confidential",
    "api.ceiling-cui": "CUI",
    "api.f-name": "Name (lowercase letters, digits and dashes)",
    "api.f-kind": "Kind",
    "api.f-owner": "Owner (a person's email)",
    "api.f-scopes": "Scopes, separated by commas (monitor.read, fleet.read, audit.read, events.subscribe, compliance.metadata.read, compliance.holds.write, compliance.export.request, directory.read, directory.write, content.read, content.post)",
    "api.f-relays": "Relays, separated by commas, or * for all",
    "api.f-networks": "Source networks (CIDR), separated by commas; empty means any",
    "api.f-hours-tz": "Hours: time zone, like America/Chicago; empty means any time",
    "api.f-hours-from": "Hours: from (HH:MM)",
    "api.f-hours-to": "Hours: to (HH:MM)",
    "api.f-hours-days": "Hours: days, 1 (Monday) to 7, separated by commas",
    "api.f-mtls": "Require mTLS",
    "api.f-rate-minute": "Requests a minute on each relay (1 to 6000)",
    "api.f-rate-day": "Requests a day on each relay (1 to 10000000)",
    "api.f-credentials": "Credentials (a JSON list)",
    "api.f-credentials-keep": "Leave empty to keep the credentials. A list here replaces them all.",
    "api.f-days": "Days until the client ends (1 to 366)",
    "api.f-days-keep": "Leave empty to keep the end date.",
    "api.f-secret-days": "Days the secret works (1 to 90)",
    "api.check-name": "Write a name of 1 to 32 lowercase letters, digits or dashes.",
    "api.check-owner": "Write the owner's email.",
    "api.check-scopes": "Name at least one scope.",
    "api.check-relays": "Name at least one relay, or * for all.",
    "api.check-json": "The credentials are not a JSON list.",
    "api.check-number": "Write a whole number in the range shown.",
    "api.check-hours": "Fill in all of the hours, with days from 1 to 7, or none of them.",
    "api.reveal-secret": "New secret for <name>",
    "api.reveal-token": "New scrape token <label>",
    "api.secret-once": "Copy this secret now. It is shown only once.",
    "api.close": "Close",
    "api.scrape": "Relay scrape tokens",
    "api.scrape-new": "Create a relay scrape token",
    "api.f-scrape-days": "Days (30 to 90)",
    "api.grace": "Grace after expiry",
    "api.grace-help": "Hours a credential still works after it ends, from 0 to 168. Raising a value needs a second admin.",
    "api.grace-person": "People's devices",
    "api.grace-app": "Apps and API clients",
    "api.grace-connector": "Connectors",
    "api.grace-relay": "Relays",
    "api.stage": "Stage",
    "api.check-grace": "Each grace is a whole number of hours from 0 to 168.",
    "api.origins": "Relay API origins",
    "api.col-origin": "Origin",
    "api.col-applied": "Changes applied",
    "api.col-synced": "In sync",
    "api.set-origin": "Set origin",
    "api.f-origin": "Origin with its port; empty removes it; it must start with https://",
    "api.check-origin": "The origin must start with https:// and name a port.",
    "api.kill": "Kill switch",
    "api.off": "Turn off the API",
    "api.on": "Turn the API back on",
    "api.journal": "Changes applied at once",
    "api.col-target": "Target",
    "api.col-when": "When",
    "api.undo": "Undo",
    "api.explain": "Explain a request",
    "api.explain-help": "See which check would refuse a request from a client now, and why.",
    "api.f-client": "Client",
    "api.f-method": "Method",
    "api.f-path": "Path, like /v1/health",
    "api.f-ip": "Source IP (optional)",
    "api.explain-run": "Explain",
    "api.check-passes": "Passes",
    "api.check-refuses": "Refused (<code>): <words>",
    "api.explain-first": "Check <n> refuses this request.",
    "api.explain-ok": "Every check passes.",
    "api.staged": "Staged changes",
    "api.staged-none": "Nothing is staged.",
    "api.staged-by": "Staged by <email>. Kept until <time> unless changed again.",
    "api.two-person": "A second admin must approve this save because it:",
    "api.tests-needed": "These destinations need a passing test before saving:",
    "api.discard": "Discard",
    "api.f-sign-relay": "Relay your Hub device uses",
    "api.signing-waiting": "Waiting for your Hub device on <relay> to sign the map.",
    "api.signing-waiting-other": "Waiting for the Hub device of <email> on <relay> to sign the map.",
    "api.signing-done": "The map was signed and sent to the relays.",
    "api.signing-failed": "The map was not signed: <why>",
    "api.signing-sending": "Asking the relay to send the signing request to your device.",
    "api.signing-cancel": "Cancel signing",
    "api.action-client-limit": "Client limits lowered",
    "exports.destinations": "API destinations",
    "exports.dest-org": "Destinations of <org>",
    "exports.dest-preset": "Kind and preset",
    "exports.dest-add": "Add a destination",
    "exports.dest-from-siem": "Copy from SIEM settings",
    "exports.dest-test": "Test",
    "exports.dest-credential": "Set credential",
    "exports.test-ok": "The test record arrived.",
    "exports.test-failed": "The test record did not arrive: <why>",
    "exports.col-signals": "Signals",
    "exports.col-source": "Source",
    "exports.col-backlog": "Backlog",
    "exports.col-oldest": "Oldest waiting",
    "exports.col-last-success": "Last success",
    "exports.col-credential": "Credential",
    "exports.col-tested": "Tested",
    "exports.source-staged": "Staged",
    "exports.source-pinned": "Signed",
    "exports.state-ok": "Delivering",
    "exports.state-retrying": "Retrying",
    "exports.state-paused": "Paused: audit is waiting",
    "exports.state-failed": "Failed",
    "exports.state-suspended": "Suspended",
    "exports.state-none": "No status yet",
    "exports.cred-held": "Held",
    "exports.cred-missing": "Not set",
    "exports.rotate-by": "Rotate by <date>",
    "exports.cred-sealed": "The credential is sealed. It is never shown again.",
    "exports.untested": "Needs a passing test",
    "exports.f-signals": "Signals, separated by commas (metrics, logs, traces, audit, events)",
    "exports.f-identities": "People and devices in records",
    "exports.identities-as-is": "As they are",
    "exports.identities-pseudonymized": "Pseudonymized",
    "exports.identities-removed": "Removed",
    "exports.f-failover": "Relays send directly when they cannot reach the console (failover)",
    "exports.f-private": "Allow a private network address",
    "exports.f-endpoint": "Endpoint address",
    "exports.f-queue-mib": "Queue size in MiB (64 to 65536)",
    "exports.f-queue-hours": "Oldest record kept, in hours (1 to 720)",
    "exports.f-credential-type": "Credential type",
    "exports.cred-entra": "Microsoft Entra certificate",
    "exports.cred-aws": "AWS IAM Roles Anywhere",
    "exports.cred-gcp": "Google Cloud service account key",
    "exports.cred-mtls": "Client certificate (mTLS)",
    "exports.cred-token": "Vendor token",
    "exports.s-traces": "Traces endpoint",
    "exports.s-metrics": "Metrics endpoint",
    "exports.s-logs": "Logs endpoint",
    "exports.s-temporality": "Temporality",
    "exports.s-delta": "Delta",
    "exports.s-cumulative": "Cumulative",
    "exports.s-headers": "Header names, separated by commas",
    "exports.s-sampling": "Trace sampling, from 0 to 1",
    "exports.s-index": "Index",
    "exports.s-sourcetypes": "Source types, separated by commas",
    "exports.s-dce": "Logs ingestion endpoint",
    "exports.s-dcr": "DCR immutable ID",
    "exports.s-stream": "Stream",
    "exports.s-events": "Events, separated by commas (audit, security, relays)",
    "exports.m-token": "Token",
    "exports.m-cert": "Certificate (PEM)",
    "exports.m-key": "Private key (PEM)",
    "exports.m-ca": "CA certificate (PEM, optional)",
    "exports.m-chain": "Chain (PEM, optional)",
    "exports.m-key-json": "Service account key (JSON)",
    "exports.m-tenant": "Tenant ID",
    "exports.m-client-id": "Application (client) ID",
    "exports.m-cloud": "Cloud",
    "exports.m-cloud-public": "Public",
    "exports.m-cloud-usgov": "US Government",
    "exports.m-trust-anchor": "Trust anchor ARN",
    "exports.m-profile": "Profile ARN",
    "exports.m-role": "Role ARN",
    "exports.m-region": "Region",
    "exports.check-name": "Write a name.",
    "exports.check-endpoint": "The endpoint address must start with https://.",
    "exports.check-material": "Fill in every field the credential needs.",
    "exports.failover": "Failover credentials",
    "exports.failover-help": "Relays use these only when they cannot reach the console.",
    "exports.col-public-id": "Public ID",
    "exports.col-valid-from": "Valid from",
    "exports.fo-pending": "Pending",
    "exports.fo-armed": "Armed",
    "exports.fo-deleted": "Deleted",
    "exports.fo-csr": "Request CSR",
    "exports.fo-install": "Install",
    "exports.fo-csr-shown": "Register this certificate request with the tool, then install the certificate it issues.",
    "exports.fo-download": "Download the PEM",
    "exports.fo-days": "Days until it ends (1 to 90)",
    // API-1 revision 4 13.2 (API-1b8): the client editor's Compliance and Directory sections and the relay set.
    "api.kind-compliance": "Compliance",
    "api.f-compliance": "Compliance block (JSON): holds_per_day, or recipient, job_max_bytes, day_max_bytes and jobs_per_day",
    "api.f-directory": "Directory block (JSON): provider, resource (the SCIM URL) and domains",
    "api.f-block-keep": "Leave empty to keep it. Write null to remove it.",
    "api.check-block": "The compliance and directory blocks are JSON objects.",
    "api.blocks": "Compliance and directory",
    "api.compliance": "Compliance",
    "api.compliance-rule": "Exports need 2 archive reviewers; the owner cannot be one.",
    "api.cap-holds": "Holds a day",
    "api.cap-jobs": "Exports a day",
    "api.cap-job-bytes": "Largest export",
    "api.cap-day-bytes": "Export bytes a day",
    "api.f-cap-holds": "Holds a day (1 to 100)",
    "api.f-cap-jobs": "Exports a day (1 to 20)",
    "api.f-cap-job-mib": "Largest export in MiB (1 to 51200)",
    "api.f-cap-day-mib": "Export MiB a day (up to 204800)",
    "api.recipient": "Recipient key",
    "api.recipient-none": "No recipient key",
    "api.thumbprint": "Thumbprint (SHA-256)",
    "api.recipient-set": "Set recipient key",
    "api.recipient-drop": "Drop recipient key",
    "api.caps-set": "Change export limits",
    "api.f-recipient": "Public key (JWK or PEM, EC P-256)",
    "api.check-recipient": "Paste a public EC P-256 key as a JWK or a PEM.",
    "api.check-caps": "Each limit is a whole number in its range.",
    "api.meet-ca": "Meet CA fingerprint (SHA-256) for compliance tools to pin",
    "api.directory": "Directory",
    "api.dir-provider": "Identity provider",
    "api.dir-scim": "SCIM URL",
    "api.dir-domains": "Domains",
    "api.dir-tenant": "Tenant",
    "api.dir-audience": "Audience",
    "api.dir-azp": "Authorized party",
    "api.dir-paste": "Paste these into Entra (Provisioning, Admin credentials), then use Test Connection:",
    "api.dir-client-id": "Client ID",
    "api.dir-token-url": "Token URL",
    "api.relay-set": "Relays of this organization",
    "api.col-connected": "Connected",
    "api.col-features": "Reports",
    "api.col-lacks": "Lacks",
    "api.lacks-none": "Nothing",
    "api.not-reported": "Not reported yet",
    "api.retire": "Retire",
    "api.outdated": "Some relays of this organization do not support what its map needs. Update them, or retire a relay that no longer serves it.",
    // API-1 revision 5 14.2 (API-1c7): connectors, identity providers (EMA), the client editor's Content and Delegation, and People.
    "api.kind-app": "App",
    "api.kind-agent": "Agent",
    "api.kind-agent-delegated": "Delegated agent",
    "api.connectors": "Connectors",
    "api.connectors-help": "A connector reads and posts conversations for the organization's api apps, on its own host. Clients reach conversations only through a connector.",
    "api.conn-add": "Add connector",
    "api.conn-no-apps": "This console holds no verified policy listing api apps of this organization, so no connector can be added yet. Add an api app to the organization policy from a Hub first.",
    "api.col-apps": "Apps",
    "api.col-conversations": "Conversations",
    "api.col-sync-age": "Sync age",
    "api.col-key-store": "Key store",
    "api.sync-age": "<n> seconds ago",
    "api.shown-stale": "Stale",
    "api.shown-never-synced": "Never synced",
    "api.change": "Change",
    "api.f-conn-origin": "Origin with its port; it must start with https://",
    "api.f-conn-apps": "Apps (the api apps of the organization policy)",
    "api.f-conn-stale": "Seconds without a full sync before it is stale (30 to 300)",
    "api.check-conn": "Write a name, an origin with its port, 1 to 16 apps and a stale time from 30 to 300 seconds.",
    "api.idps": "Identity providers (EMA)",
    "api.idps-help": "Enterprise-managed sign-in: an identity provider such as Okta gives an AI app a signed assertion for a person, and this console trades it for a token that acts as that person.",
    "api.idp-add": "Add identity provider",
    "api.idp-test": "Test",
    "api.col-provider": "Provider",
    "api.col-issuer": "Issuer",
    "api.col-algs": "Algorithms",
    "api.col-max-age": "Longest assertion (seconds)",
    "api.col-auth-max": "Oldest sign-in (seconds)",
    "api.col-private": "Private addresses",
    "api.col-last-test": "Last test",
    "api.col-keys": "Keys",
    "api.f-issuer": "Issuer, exactly as the identity provider signs it; it must start with https://",
    "api.f-algs": "Signing algorithms",
    "api.f-tenant": "Tenant (optional; when set, each assertion's tenant must equal it)",
    "api.f-max-age": "Longest assertion lifetime in seconds (60 to 600)",
    "api.f-auth-max": "Oldest sign-in accepted, in seconds (300 to 86400)",
    "api.check-idp": "Write a name, pick at least one algorithm, keep the ages in their ranges, and give an issuer; it must start with https://.",
    "api.check-idp-change": "Pick at least one algorithm and keep the ages in their ranges.",
    "api.idp-tested": "Test result",
    "api.idp-jwks": "Key set address",
    "api.col-kid": "Key id",
    "api.col-alg": "Algorithm",
    "api.col-kty": "Key type",
    "api.providers": "Sign-in providers of this organization",
    "api.providers-help": "The identity providers of the organization's signed policy. Set the SSO URL of each provider people sign in with, then copy the return address into the SSO service's sso.json as api_return.",
    "api.col-sso-url": "SSO URL",
    "api.not-set": "Not set",
    "api.sso-set": "Set SSO URL",
    "api.f-sso-url": "The SSO service's public address; empty removes it; it must start with https://",
    "api.check-sso-url": "The SSO URL must start with https://.",
    "api.api-return": "api_return for sso.json",
    "api.api-return-none": "The return address comes from the console's issuer URL, which is not set yet.",
    "api.f-content-only": "For kinds App, Agent and Delegated agent.",
    "api.f-connectors": "Connectors it reaches",
    "api.f-apps": "Apps whose conversations it reads or posts in",
    "api.f-channels": "Conversations",
    "api.channels-all": "All conversations these apps are in",
    "api.channels-list": "Only the conversations listed below",
    "api.f-channel-ids": "Conversation ids, one per line",
    "api.f-confirm": "Ask a person before posting",
    "api.confirm-forced": "Always on for a delegated agent, and for an agent that both reads and posts.",
    "api.check-content": "A content client needs 1 to 4 connectors, 1 to 16 of their apps, and its conversations.",
    "api.f-delegation-only": "For kind Delegated agent.",
    "api.f-groups": "Groups whose people may delegate (from Who may use AI)",
    "api.f-people": "People who may delegate, one email per line",
    "api.f-denied": "People who may not delegate, one email per line",
    "api.f-idps": "Identity providers (EMA) it accepts",
    "api.f-consent-days": "Days a person's consent lasts (1 to 30)",
    "api.f-redirects": "Redirect URIs, one per line; each must start with https:// or be a loopback address such as 127.0.0.1",
    "api.f-cimd": "Client ID Metadata Document (CIMD) address; it must start with https://",
    "api.f-cimd-note": "A new address replaces the client's credentials unless the credentials list above is filled in.",
    "api.f-loopback": "This app runs on people's computers (loopback only)",
    "api.loopback-warn": "Lucid cannot check which program on a person's computer receives access. People see this warning before they allow it: This app runs on your own computer. Lucid cannot check which program on this computer receives access. Allow only if you just started this sign-in from this app.",
    "api.check-delegation": "A delegated agent needs at least one group or person, and consent days from 1 to 30.",
    "api.check-redirects": "Each redirect URI must start with https:// or be a 127.0.0.1 or ::1 loopback address with a path.",
    "api.check-cimd": "The CIMD address must start with https://.",
    "api.content": "Content and delegation",
    "api.col-connectors": "Connectors",
    "api.delegation": "Delegation",
    "api.dlg-groups": "Groups",
    "api.dlg-people": "People",
    "api.dlg-denied": "People denied",
    "api.dlg-idps": "Identity providers",
    "api.dlg-consent": "Consent days",
    "api.redirects": "Redirect URIs",
    "api.loopback": "Runs on people's computers (loopback only)",
    "api.cimd": "Client ID Metadata Document",
    "api.people": "People",
    "api.people-help": "People with a live refresh token family or a delegated token in the last 24 hours.",
    "api.col-person": "Person",
    "api.col-grant": "Grant",
    "api.col-first-use": "First use",
    "api.col-last-use": "Last use",
    "api.revoked": "Revoked",
    "api.revoke": "Revoke",
    "api.revokes": "People who stopped or were revoked",
    "api.revokes-help": "These people may not delegate to the client again until an admin allows them. Allow again is staged, and a second admin must approve the save.",
    "api.allow": "Allow again",
    "api.revoke-all": "Revoke for every client",
    "api.all-clients": "All delegated clients",
    "api.approvals": "Approvals",
    "api.approvals-help": "Posts people approved or declined on their devices, from the connectors' audit chains. No text is shown.",
    "api.col-approval": "Approval",
    "api.col-result": "Result",
    "api.col-app": "App",
    // API-1 revision 6 7.14 (API-1d5): the Agents and Remote Spokes tabs, the Tasks list, the client editor's service
    // hub and agent fields, the partner card check and the partner hand-off (7.1.2 R6-12).
    "api.tabs": "API access sections",
    "api.tab-general": "Clients and settings",
    "api.tab-agents": "Agents",
    "api.tab-spokes": "Remote Spokes",
    "api.agents": "Agents",
    "api.agents-help": "Each agent publishes a signed A2A Agent Card built from the signed map. Partners reach it through a connector, and a person at your organization approves each task on Remote Spokes.",
    "api.agent-add": "Add agent",
    "api.agents-url": "Agent list",
    "api.col-version": "Version",
    "api.col-connector": "Connector",
    "api.col-hub": "Service hub",
    "api.col-skills": "Skills",
    "api.col-card": "Card",
    "api.card-served": "Served",
    "api.card-unsigned": "Not signed",
    "api.card-off": "Off",
    "api.card-not-pinned": "Not in a signed map",
    "api.card-url": "Card URL",
    "api.card-copy-url": "Copy card URL",
    "api.card-signed": "Signed <time> with <kids>, map <seq>",
    "api.card-preview": "Signed card",
    "api.card-etag": "ETag",
    "api.skill-dropped": "Dropped",
    "api.col-targets": "Spokes",
    "api.col-model": "Model",
    "api.col-turns": "Turns",
    "api.col-approve-within": "Approval wait (seconds)",
    "api.targets-all": "All spokes",
    "api.f-agent-name": "Name shown on the card (1 to 64 characters)",
    "api.f-description": "Description (1 to 1024 characters)",
    "api.f-version": "Version; change it whenever the card changes",
    "api.f-connector": "Connector",
    "api.f-hub": "Service hub client",
    "api.f-provider-org": "Provider organization (optional)",
    "api.f-provider-url": "Provider URL (optional); it must start with https://",
    "api.f-doc-url": "Documentation URL (optional); it must start with https://",
    "api.f-streaming": "Streaming",
    "api.f-push": "Push notifications",
    "api.f-skills": "Skills (a JSON list)",
    "api.f-skills-note": "Each skill has id, name, description, tags, examples, targets (spoke node ids), model (optional), turns (one or many), approve_within_s (300 to 86400) and idle_close_s (optional).",
    "api.check-agent": "Write a name, a description and a version of letters, digits, dots, plus and minus signs, pick a connector and a service hub, and give addresses that start with https://.",
    "api.check-skills": "Skills must be a list of 1 to 16 skills, each with an id of lowercase letters, digits and dashes, a name, a description, 1 to 8 tags, 1 to 64 spokes, turns one or many, and an approval wait from 300 to 86400 seconds.",
    "api.refusal-card-version": "Change the agent's version: its card changes with this save.",
    "api.refusal-well-known-taken": "Another organization on this console already publishes the root agent card.",
    "api.refusal-card-unsigned": "No card key is inside its window. Make a card key and save the map.",
    "api.a2a-second": "These changes need a second admin:",
    "api.two-a2a-client": "Adds a service hub client, gives a client spokes.tasks.submit, or widens such a client",
    "api.two-a2a-private": "Lets pushes or partner card fetches reach private addresses",
    "api.two-a2a-agent": "Adds an agent, a skill or a target, or allows a longer approval wait",
    "api.two-well-known": "Publishes an agent at this console's root well-known address",
    "api.card-keys": "Card keys",
    "api.card-keys-help": "Each card is signed with every card key inside its window. The private keys are made and sealed on this console and never leave it.",
    "api.card-key-new": "Make a card key",
    "api.card-key-drop": "Drop key",
    "api.draft-keys": "Card keys in the staged changes",
    "api.col-thumbprint": "Thumbprint",
    "api.col-sealed": "Sealed here",
    "api.key-active": "Active",
    "api.key-pending": "Not yet in force",
    "api.key-expired": "Ended",
    "api.key-dropped": "Dropped",
    "api.well-known": "Root well-known card",
    "api.well-known-help": "One agent may be published at this console's root address: <url>",
    "api.well-known-none": "No agent",
    "api.well-known-set": "Choose the root agent",
    "api.f-well-known": "Agent published at the root address",
    "api.tasks": "Tasks",
    "api.tasks-help": "Task metadata from the connectors' audit chains this console holds. No text is shown.",
    "api.filter-all": "All",
    "api.col-task": "Task",
    "api.col-agent": "Agent",
    "api.col-skill": "Skill",
    "api.col-spoke": "Spoke",
    "api.col-created": "Created",
    "api.col-updated": "Updated",
    "api.col-bytes-in": "Bytes in",
    "api.col-bytes-out": "Bytes out",
    "api.spokes": "Remote Spokes",
    "api.spokes-help": "Spokes relays bound to this organization enforce its map for service hubs. Each needs the same organization root as this console.",
    "api.console-root": "This console's Remote Spokes root",
    "api.map-root": "Root in the signed map",
    "api.draft-root": "Root in the staged changes",
    "api.root-none": "None",
    "api.root-set": "Set root",
    "api.bound-relays": "Spokes relays of this organization",
    "api.col-bound": "Bound",
    "api.col-listed": "In the signed map",
    "api.col-staged": "Staged",
    "api.needs-update": "Needs an update",
    "api.bind": "Bind",
    "api.unbind": "Unbind",
    "api.candidates": "Spokes relays that can be bound",
    "api.hubs": "Service hubs",
    "api.col-principal": "Principal",
    "api.col-node": "Node",
    "api.col-serial": "Serial",
    "api.kind-spokes-hub": "Service hub",
    "api.f-spokes-only": "For kind Service hub.",
    "api.f-targets": "Spokes it may send to, one node id per line, or * for all",
    "api.f-node-cert": "Node certificate token from lucid-spoke root approve --service (empty keeps the credentials)",
    "api.f-key-store": "Where the node key is kept",
    "api.key-store-os-store": "Operating system store",
    "api.key-store-pkcs11": "PKCS#11 hardware module",
    "api.key-store-azure-key-vault": "Azure Key Vault",
    "api.key-store-tpm": "TPM",
    "api.check-spokes-hub": "A service hub needs exactly the scope spokes.tasks.submit, its spokes, and a node certificate.",
    "api.f-a2a-only": "For kind Agent with the scope spokes.tasks.submit.",
    "api.f-a2a-agents": "Agents it may use",
    "api.f-a2a-skills": "Skills, one agent id/skill id per line, or * for all",
    "api.f-max-tasks": "Most open tasks at once (1 to 256)",
    "api.f-push-origins": "Push origins, one https origin per line (empty: no pushes)",
    "api.f-push-cidrs": "Private networks pushes may reach, one CIDR per line",
    "api.f-card-url": "Partner card URL (optional); it must start with https://",
    "api.f-card-jwks": "Partner key set URL the card is checked with; it must start with https://",
    "api.f-card-cidrs": "Private networks the partner card fetch may reach, one CIDR per line",
    "api.check-a2a": "An agent with spokes.tasks.submit needs 1 to 16 agents, its skills, 1 to 256 open tasks, https push origins and partner card addresses, and private networks as CIDRs.",
    "api.partners": "Partner agents",
    "api.col-max-tasks": "Most open tasks",
    "api.push-origins": "Push origins",
    "api.partner-card": "Partner card",
    "api.partner-unchecked": "Not checked yet",
    "api.partner-verified": "Verified",
    "api.partner-invalid": "Did not verify",
    "api.col-checked": "Checked",
    "api.col-why": "Why",
    "api.partner-interfaces": "Interfaces",
    "api.card-check": "Check now",
    "api.push-off": "Push off",
    "api.handoff": "Partner hand-off",
    "api.handoff-help": "Give the partner this key set address and these key thumbprints when you register them. The partner must pin this key source and verify your cards only with it, and must never follow a card's own jku.",
    "api.handoff-jwks": "Key set address",
    "api.handoff-thumbprints": "Key thumbprints",
    // API-1 revision 5 10.6 and 14.2: Settings > AI > Local MCP.
    "lmcp.title": "Local MCP",
    "lmcp.help": "AI apps on people's own computers may use these Hub tools through the person's running Hub. The Hub records each call.",
    "lmcp.enterprise": "Enterprise only",
    "lmcp.standard": "Local MCP for the organization's people needs an enterprise license. This relay's license is Standard, so it stays off.",
    "lmcp.state": "State",
    "lmcp.classes": "Data classes",
    "lmcp.tools": "Tools",
    "lmcp.send": "Allow sending",
    "lmcp.change": "Change Local MCP",
    "lmcp.f-enabled": "Local MCP",
    "lmcp.f-classes": "Data classes it may return (never CUI)",
    "lmcp.f-tools": "Tools",
    "lmcp.f-send": "Allow sending (needs send_message)",
    "lmcp.check": "Pick at least one tool. Allow sending needs the send_message tool.",
    // API-1 revision 4 13.2: Exports, webhook destinations, webhook keys and the outbound identity.
    "exports.cred-none": "None",
    "exports.cred-entra-fed": "Microsoft Entra federation (no stored secret)",
    "exports.cred-gcp-fed": "Google Cloud workload identity federation (no stored secret)",
    "exports.prefer-federation": "Prefer federation: a service account key is a long-lived secret.",
    "exports.m-audience": "Audience",
    "exports.m-token-audience": "Token audience",
    "exports.m-service-account": "Service account email (optional)",
    "exports.s-client": "Client whose events it receives",
    "exports.s-types": "Event types, separated by commas; empty means every type the client may see",
    "exports.s-signing": "Signing",
    "exports.s-signing-v2a": "Ed25519 (v2a)",
    "exports.s-signing-v1": "Shared secret (v1, needs a second admin)",
    "exports.s-verification": "Endpoint verification",
    "exports.s-verify-wev": "Verify the endpoint first",
    "exports.s-verify-none": "Skip it (needs a second admin)",
    "exports.s-events-stream": "Events stream",
    "exports.col-events": "Events",
    "exports.ev-verified": "Verified",
    "exports.ev-unverified": "Not verified: nothing is sent",
    "exports.ev-none": "Not checked",
    "exports.ev-paused": "Paused: events wait for Resume",
    "exports.ev-at": "Delivered up to <cursor>",
    "exports.send-test": "Send a test",
    "exports.verify": "Verify",
    "exports.verify-ok": "The endpoint passed verification.",
    "exports.verify-failed": "The endpoint did not pass verification: <why>",
    "exports.replay": "Replay from",
    "exports.f-from": "Feed position to replay from; empty means the oldest event kept",
    "exports.resume": "Resume",
    "exports.secret": "New v1 secret",
    "exports.secret-title": "New signing secret for <name>",
    "exports.secret-once": "Copy this secret into the receiver now. It is shown only once.",
    "exports.secret-rotate": "Rotate it by <date>.",
    "webhooks.keys": "Webhook keys",
    "webhooks.keys-help": "Receivers check v2a signatures with these public keys, also published at <url>.",
    "webhooks.key-new": "Make a webhook key",
    "webhooks.col-public": "Public key",
    "webhooks.drop": "Drop",
    "webhooks.dropped": "Dropped",
    "webhooks.in-force": "In force",
    "federation.title": "Outbound identity",
    "federation.help": "Destinations sign in to Microsoft Entra or Google Cloud with short tokens this console issues, so no cloud secret is stored.",
    "federation.none": "No outbound identity is set.",
    "federation.issuer": "Issuer",
    "federation.set": "Set the issuer",
    "federation.f-issuer": "Issuer URL; empty uses this console's front door",
    "federation.key-new": "Make a federation key",
    "federation.download": "Download documents",
    "federation.front-door": "The console's front door serves these documents itself.",
    "federation.publish": "Publish the discovery document at <discovery> and the key set at <jwks>.",
    "federation.staged": "The staged documents differ. Publish them before you save a key rotation.",
    "federation.republished": "Confirm it is gone",
    "federation.test": "Test exchange",
    "federation.test-ok": "The exchange worked: <provider> issued a token until <time>.",
    "federation.test-failed": "The exchange failed: <why>",
    // API-1 revision 4 13.2: the Compliance page (holds, exports and their reviewers; never content).
    "compliance.title": "Compliance",
    "compliance.help": "Holds and exports that compliance tools asked for through the API, with their relay and archive states. Nothing here shows content.",
    "compliance.holds": "Holds",
    "compliance.exports": "Exports",
    "compliance.col-by": "Placed by",
    "compliance.col-people": "People",
    "compliance.col-matter": "Matter",
    "compliance.col-placed": "Placed",
    "compliance.col-relays": "Relays",
    "compliance.col-archive": "Archive",
    "compliance.col-client": "Client",
    "compliance.col-requested": "Requested",
    "compliance.col-reviewers": "Reviewers",
    "compliance.col-size": "Size",
    "compliance.by-console": "Console admin",
    "compliance.archive-waiting": "Waiting for a reviewer",
    "compliance.archive-placed": "Placed",
    "compliance.archive-declined": "Declined",
    "compliance.archive-failed": "Failed",
    "compliance.archive-none": "No archive",
    "compliance.relay-placed": "Placed",
    "compliance.relay-released": "Released",
    "compliance.relay-off": "Holds are off",
    "compliance.job-waiting": "Waiting for reviewers",
    "compliance.job-released": "Released",
    "compliance.job-building": "Building",
    "compliance.job-transferring": "Transferring",
    "compliance.job-ready": "Ready to download",
    "compliance.job-canceled": "Canceled",
    "compliance.job-expired": "Expired",
    "compliance.job-failed": "Failed",
    "compliance.job-refused": "Refused",
    "compliance.released": "<n> of 2 reviewers released it",
    "compliance.released-by": "Released by <reviewers>",
    "compliance.waiting-until": "Ends unreleased on <time>",
    "compliance.ask-reviewers": "Ask reviewers to open their Lucid Hub. Each reviewer releases an export there, on their own device; this console cannot release one.",
    "compliance.cancel": "Cancel export",
    "compliance.storage-low": "The console has less than 10 GiB free, so new exports are refused. Free space on its disk.",
    "compliance.no-archive": "No archive relay of this organization is known, so exports cannot run.",
    // API-1 revision 4 13.2: the Directory card of the People page.
    "directory.title": "Directory",
    "directory.governed": "Governed: identity providers provision people through API clients, and a relay checks and audits every SCIM request.",
    "directory.legacy": "Legacy: identity providers provision people with the relays' own SCIM tokens.",
    "directory.clients": "SCIM clients",
    "directory.col-last": "Last request",
    "directory.col-requests": "Requests",
    "directory.col-refused": "Refused",
    "directory.refusals": "Refusals: <list>",
    "directory.tokens": "Legacy SCIM tokens",
    "directory.col-issued": "Issued",
    "directory.col-networks": "Address list",
    "directory.pre-r4d3": "Made before the upgrade",
    "directory.pre-r4d3-help": "Tokens made before the upgrade end 90 days after it and keep working from any address until then if they had no address list.",
    "directory.any-address": "Any address until it ends",
    "directory.pending": "Group confirmations waiting",
    "directory.pending-help": "Memberships a SCIM client made stay pending until the directory reader confirms them.",
    "directory.col-group": "Group",
    "directory.col-since": "Waiting since",
    "directory.not-reported": "The relays do not report these yet: <list>.",
    "directory.owner-gone": "Owners who left with API clients",
    "directory.col-clients": "Clients",
    // API-1d6 (r6 8.11): Settings > AI > Tools (MCP).
    "mcp.title": "Tools (MCP)",
    "mcp.help": "The AI gateways may call these MCP servers' read tools while answering a person who turned on organization tools for that request. Each call uses the gateway's own credential, not the person's.",
    "mcp.readers": "Tools can be staged once the Enterprise edition is installed, every Meeting Hub and iPhone app is at <version> or later and every AI gateway reads MCP servers.",
    "mcp.servers": "MCP servers",
    "mcp.staged": "Staged MCP servers (saved with the AI settings)",
    "mcp.none": "No MCP server is listed.",
    "mcp.add": "Add an MCP server",
    "mcp.stage": "Stage",
    "mcp.update": "Change",
    "mcp.server-off": "Turn off this server",
    "mcp.off": "Turn off all tools",
    "mcp.credential": "Credential",
    "mcp.test": "Test",
    "mcp.col-url": "Address",
    "mcp.col-ceiling": "Highest data class",
    "mcp.col-groups": "Groups",
    "mcp.col-activities": "Activities",
    "mcp.col-tools": "Tools",
    "mcp.col-credential": "Credential",
    "mcp.col-ends": "Credential ends",
    "mcp.col-gateway": "Gateway",
    "mcp.col-action": "Action",
    "mcp.col-target": "Target",
    "mcp.col-when": "When",
    "mcp.col-state": "State",
    "mcp.offered": "Offered",
    "mcp.not-offered": "Not offered (<why>)",
    "mcp.risk": "The gateway calls <server> with its own credential, not the person's: any member of <groups> may reach, through the model, everything that credential can read, even records the source system would not show them.",
    "mcp.statement": "Every member of <groups> may read everything the <scope> credential of <server> can read.",
    "mcp.scope-mtls": "client certificate",
    "mcp.attest": "Attestation",
    "mcp.attest-help": "You and the second admin you name state this. The save that carries it must be requested and approved by you two.",
    "mcp.attest-by": "Attested by <by> on <date>",
    "mcp.second": "Second admin who attests (their email)",
    "mcp.second-help": "Needed to add a server, or when a change adds a group or tool, approves a changed tool, raises the ceiling, changes the address, scope or credential, or allows a private address.",
    "mcp.journal": "Turned off at once",
    "mcp.journal-none": "Nothing is turned off.",
    "mcp.active": "In force",
    "mcp.done": "No longer in force",
    "mcp.gateways": "Gateways",
    "mcp.applied": "Applied",
    "mcp.not-applied": "Not yet applied",
    "mcp.waiting": "Not yet applied: <n> changes wait. The console sends them again every minute.",
    "mcp.gateway-error": "Did not answer: <why>",
    "mcp.expires-soon": "The credential of <server> ends in <days> days.",
    "mcp.expired": "The credential of <server> has ended. Its tools are not offered.",
    "mcp.tool-changed": "The tool <tool> of <server> changed on <gateway>. It is not offered until an admin approves the new hash.",
    "mcp.tool-approve": "Approve the new hash",
    "mcp.f-id": "Server id (m_ and 16 hex digits)",
    "mcp.f-name": "Name",
    "mcp.f-url": "MCP endpoint address; it must start with https://",
    "mcp.f-ceiling": "Highest data class it may see",
    "mcp.f-private": "Allow a private network address",
    "mcp.f-groups": "Groups, one per line (from Who may use AI)",
    "mcp.f-activities": "Activities, separated by commas (search, catch_up, notes, summary, brief, assist)",
    "mcp.f-auth": "Credential type",
    "mcp.auth-jwt": "OAuth with a signed key (private_key_jwt)",
    "mcp.auth-mtls": "OAuth with a client certificate",
    "mcp.auth-mtls-only": "Client certificate only (in-house servers)",
    "mcp.f-issuer": "Authorization server issuer; it must start with https://",
    "mcp.f-client-id": "Client ID",
    "mcp.f-scope": "Scope",
    "mcp.f-kids": "Key ids, one per line: gateway principal = key id",
    "mcp.f-expires": "Credential ends (YYYY-MM-DD, at most 366 days ahead)",
    "mcp.f-ca": "Server CA certificate (PEM, optional)",
    "mcp.f-tools": "Tools (JSON, filled from Test)",
    "mcp.f-max-calls": "Tool calls per request (1 to 8)",
    "mcp.f-args-max": "Argument bytes per call (256 to 16384)",
    "mcp.f-result-max": "Result bytes per call (1024 to 262144)",
    "mcp.f-clear": "Journal ids to clear, one per line (optional)",
    "mcp.f-op": "What to do",
    "mcp.op-key": "Make a signing key on every gateway",
    "mcp.op-csr": "Make a certificate request on every gateway",
    "mcp.op-cert": "Install a certificate on one gateway",
    "mcp.f-cert": "Certificate (PEM)",
    "mcp.f-chain": "Chain (PEM, optional)",
    "mcp.answers": "Gateway answers",
    "mcp.answer-kid": "Key id <kid>: register this public key with the authorization server.",
    "mcp.answer-csr": "Have this certificate request issued, then install the certificate.",
    "mcp.answer-cert": "Installed. The certificate ends on <date>.",
    "mcp.tested": "Tools the server lists",
    "mcp.use-tools": "Use these tools",
    "mcp.journaled": "<n> changes were turned off at once on every gateway.",
    "mcp.dlg-add": "Add the MCP server <server> to the staged AI settings?",
    "mcp.dlg-add-body": "It is saved with the AI settings. The save is signed from your device once the second admin approves it.",
    "mcp.dlg-update": "Change the MCP server <server>?",
    "mcp.dlg-update-body": "Narrowing changes reach every gateway at once. Widening changes wait for the signed save.",
    "mcp.dlg-server-off": "Turn off the MCP server <server> on every gateway?",
    "mcp.dlg-server-off-body": "Gateways stop offering its tools at once. Only a newer signed AI map that clears this turns it back on.",
    "mcp.dlg-off": "Turn off all MCP tools of <org>?",
    "mcp.dlg-off-body": "Every gateway stops offering MCP tools at once. Only a newer signed AI map that clears this turns them back on.",
    "mcp.dlg-credential": "Change the credential of <server>?",
    "mcp.dlg-credential-body": "Each gateway makes its own key; the private key never leaves it.",
    "mcp.dlg-test": "Test the MCP server <server>?",
    "mcp.dlg-test-body": "A gateway connects to the server, signs in with its credential and lists its tools.",
    "local.title": "Lucid Admin Console",
    "local.join": "Join a console",
    "local.read-only": "Read only from the console",
    "local.confirm-scopes": "Ask me before changes in",
    "local.waiting": "Changes waiting for you",
    "local.accept-scopes": "The console asks for more scopes: <scopes>",
    "local.leave": "Leave the Admin Console",
    "attention.relay-silent": "<relay> has not been in touch for <minutes> minutes.",
    "attention.relay-unconfirmed": "<relay> joined and is waiting for an admin to confirm its fingerprint.",
    "attention.relay-pending": "<relay> was enrolled but has not connected yet.",
    "attention.relay-cert-expiring": "The management certificate of <relay> ends in <days> days and has not renewed.",
    "attention.relay-cert-expired": "The management certificate of <relay> has ended. Enroll it again with Replace.",
    "attention.relay-left": "<relay> left the console.",
    "attention.relay-flapping": "Two machines are connecting as <relay>. Its key may have been copied.",
    "attention.export-audit-backlog": "Audit records of <org> are waiting to reach <destination>. They are kept until it takes them.",
    "attention.failover-credential-expiring": "The failover credential of <destination> on <relay> ends in <days> days. Install a new one.",
    "attention.failover-credential-expired": "The failover credential of <destination> on <relay> has ended. The relay no longer uses it.",
    // API-1 revision 4: the attention items of slices 1b1, 1b3, 1b5, 1b6 and 1b7.
    "attention.relay-outdated": "<relay> does not support what the API map of <org> needs (<needs>). Update it, or retire it from the organization.",
    "attention.api-owner-gone": "<principal> left <org> but still owns <n> API clients. Give them a new owner or delete them.",
    "attention.federation-jwks-republish": "The federation key <kid> of <org> was dropped. Remove it from every key set you host or uploaded, then confirm it on Exports.",
    "attention.webhook-paused": "Events to <destination> of <org> are paused after failing too long. Nothing was dropped; fix the receiver, then Resume.",
    "attention.webhook-key-dropped": "The webhook key <kid> of <org> was dropped. Tell receivers, then save a map without it.",
    // API-1 revision 6 7.1.2 and 7.13.
    "attention.a2a-card-key-missing": "The agent <agent> of <org> has no card key inside its window, so its card is not served. Make a card key and save the map.",
    "attention.a2a-partner-card-invalid": "The partner card of client <client> of <org> did not verify: <why>",
    "attention.export-storage": "The console has less than 10 GiB free, so compliance exports of <org> are refused. Free space on its disk.",
    "attention.relay-read-only": "<relay> is read only from the console.",
    "attention.relay-confirm-waiting": "<n> changes wait for the operator of <relay>.",
    "attention.relay-scopes-pending": "<relay> has not accepted the scopes you asked for yet.",
    "attention.relay-not-high": "<relay> is not in the High profile, so this console makes no changes on it.",
    "attention.relay-needs-high": "<relay> is in the High profile and takes no changes until this console is High too.",
    "attention.relay-clock": "The clock of <relay> is more than 5 minutes off.",
    "attention.relay-version-mixed": "Your <product> relays run different versions.",
    "attention.roster-pending": "Relays need to learn <n> new keys.",
    "attention.roster-behind": "<relay> has not taken the latest admin keys for an hour.",
    "attention.roster-empty": "No admin here has a passkey or security key, so no changes can be made on relays.",
    "attention.fleet-seal-needed": "Set up sealed storage on this host before adding relays.",
    "attention.fleet-state-unreadable": "The console could not read its list of relays; see its log.",
    "attention.fleet-ca-expiring": "The console's management certificate authority ends in <days> days.",
    "attention.fips-needed": "The High profile needs the FIPS build for relays, metrics export and SIEM forwarding.",
    "attention.metrics-refused": "<relay> sent <n> health reports that were not accepted.",
    "attention.metrics-space": "Health history reached its space limit; the oldest detail is being dropped.",
    "attention.siem-failing": "Events cannot reach the SIEM: <why>.",
    "attention.siem-dropped": "<n> events were dropped before the SIEM took them. Export the audit to fill the gap.",
    "attention.token-expiring": "The scrape token <label> ends in <days> days.",
    "attention.setup-unfinished": "Finish setting up the console.",
    "attention.relay-bootstrap-pending": "<relay> is waiting for its operator to confirm which admins it trusts.",
    "attention.relay-keys-held": "<n> new keys are in the 24-hour hold on <relay>.",
    "attention.relay-keys-unattested": "<relay> could not verify <n> keys as approved security keys, so they cannot act there.",
    "attention.key-no-evidence": "<n> admin keys were added before this version and cannot act on High relays. Add a new security key.",
    "attention.relay-ca-unconfirmed": "<n> relays have not confirmed the new management CA.",
    "attention.fleet-ca-lost": "The console can no longer use its management CA. Its operator must run the recovery command.",
    "attention.relay-gap": "Some audit entries from <relay> did not reach the SIEM.",
    "attention.relay-scope-stale": "The scope request to <relay> was replaced before its operator answered.",
    "attention.relay-confirm-unknown": "A confirmed change on <relay> may not have run. Check it.",
    // Revision 3.4 (R42-6): a relay's license service.
    "relay.license-stopped": "Stopped: no active license",
    "relay.license-grace": "Grace: stops on <date and time>",
    "relay.license-upgrade-period": "Upgrade period: stops on <date and time>",
    "relay.license-why-none": "No license is installed.",
    "relay.license-why-wrong-product": "The license is for another product.",
    "relay.license-why-wrong-root": "The license is for another organization.",
    "relay.license-why-invalid": "The relay could not use its license file. See the relay's log.",
    "relay.license-why-expired": "The license ended and its grace is over.",
    "relay.license-reminders": "Reminders sent: <list>. Next: <date>.",
    "relay.license-install-stopped": "Installing a license here starts the relay serving people again.",
    "attention.relay-license-stopped": "<relay> stopped: no active license. It serves no one until a license is installed.",
    "attention.relay-license-grace": "The license of <relay> has ended. Service stops on <date and time> unless a new license is installed.",
    "attention.relay-license-expiring": "The license of <relay> ends in <days> days.",
    // AC-2b-D 13.1: Deploy a relay, the Meeting Hub organization CA and the Remote Spokes organization root.
    "deploy.title": "Deploy a relay",
    "deploy.step": "Step <n> of 4",
    "deploy.continue": "Continue",
    "deploy.product-h": "Which product will this relay serve?",
    "deploy.product-meet-help": "Calls, chat and files for your people's Hub apps.",
    "deploy.product-spokes-help": "A mailbox relay for your Remote Spokes hubs and spokes.",
    "deploy.product-none": "Choose a product to continue.",
    "deploy.where-h": "Where will it run?",
    "deploy.env-linux": "Linux server or VM",
    "deploy.env-linux-help": "Debian 12 or 13, or Ubuntu 22.04 or 24.04, with systemd. One command installs everything.",
    "deploy.env-proxmox": "Proxmox",
    "deploy.env-proxmox-help": "Create a Debian 13 VM from the cloud image, then run the Linux command inside it.",
    "deploy.env-docker": "Docker",
    "deploy.env-docker-help": "Builds a local image from this console's relay program and runs it with Docker Compose.",
    "deploy.env-installed": "Already installed",
    "deploy.env-installed-help": "The relay program is already on the host. Join it to this console with a code.",
    "deploy.env-next": "Coming next",
    "deploy.env-azure": "Azure",
    "deploy.env-aws": "AWS",
    "deploy.env-gcp": "Google Cloud",
    "deploy.env-windows": "Windows Server",
    "deploy.env-docker-high": "Not offered under the High profile: a container cannot seal the relay's key with a provider High allows.",
    "deploy.env-os-mismatch": "This console cannot hand out the Linux relay program (<why>). Install the relay from your release media and use Already installed.",
    "deploy.needs": "Before you start",
    "deploy.need-os": "Debian 12 or 13, or Ubuntu 22.04 or 24.04, on <arch>",
    "deploy.need-size-meet": "2 CPU cores, 2 GB of memory, 20 GB of disk",
    "deploy.need-size-spokes": "1 CPU core, 1 GB of memory, 10 GB of disk",
    "deploy.need-dns-meet": "A DNS name your people's Hub apps reach, pointing at this host (for example meet.example.org)",
    "deploy.need-dns-spokes": "A DNS name or IP address your hubs and spokes reach",
    "deploy.need-ports-meet": "Open to your people: TCP 443, UDP and TCP 3478, TCP 5349, UDP 49160 to 49260",
    "deploy.need-ports-spokes": "Open to your hubs and spokes: TCP 8443",
    "deploy.need-console": "Outbound from the host to this console's management port: <host>:<port> (TCP)",
    "deploy.need-tls-meet": "No public TLS certificate: this console issues the relay's certificate from your organization's CA.",
    "deploy.need-tls-meet-own": "The relay's certificate, key, CA certificate and revocation list from your organization's signer, in one folder on the host (ca.crt, relay.crt, relay.key, crl.pem)",
    "deploy.need-tls-spokes": "No public TLS certificate: the script makes one, and your hubs pin it.",
    "deploy.need-root-spokes": "Your organization root's public key (root.pub) on the host",
    "deploy.need-signer": "The certificate server at <url> lets this host connect (add its address to the server's allowed relays)",
    "deploy.need-sudo": "A user who can run sudo, and curl",
    "deploy.need-docker": "Docker Engine with the Compose plugin on a Linux host",
    "deploy.need-proxmox": "Proxmox VE 7.2 or later, a storage, a network bridge, and an SSH public key for the VM",
    "deploy.details-h": "About this relay",
    "deploy.host": "Relay DNS name",
    "deploy.host-help": "The name people's apps use to reach this relay.",
    "deploy.turn-host": "TURN name or address (calls through firewalls)",
    "deploy.turn-host-help": "Leave empty to use the relay DNS name.",
    "deploy.admins-note": "The script asks for the relay admins' emails on the host.",
    "deploy.clients": "Networks that may reach the relay",
    "deploy.clients-help": "Addresses with a prefix, separated by commas. 0.0.0.0/0, ::/0 means everyone.",
    "deploy.pki": "Relay certificate",
    "deploy.pki-console": "Issue it from the organization CA in this console",
    "deploy.pki-own": "I bring it from our own signer",
    "deploy.pki-ca-missing": "This console holds no Meeting Hub organization CA. Import one under License, or bring the certificate yourself.",
    "deploy.license": "License",
    "deploy.license-help": "The relay installs it when it joins.",
    "deploy.license-none": "No license yet: the relay starts stopped until you install one.",
    "deploy.make": "Make code and command",
    "deploy.install-h": "Install",
    "deploy.install-linux": "On the host, run this command. When it asks for the enrollment code, paste the code from above.",
    "deploy.install-docker": "On the Docker host, run this command. When it asks for the enrollment code, paste the code from above.",
    "deploy.install-high": "Under the High profile, install from your verified release media. Check the program's SHA-256 against your release notes, then run:",
    "deploy.install-proxmox": "On the Proxmox host shell, create the VM:",
    "deploy.install-proxmox-then": "Then sign in to the VM and run the Linux command:",
    "deploy.pin-note": "The command trusts only this console's management keys, so it works without a public certificate.",
    "deploy.binary": "Relay program <version> for <arch>, SHA-256 <sha256>",
    "deploy.uninstall": "To remove it later:",
    "deploy.uninstall-offline": "Or, without this console:",
    "deploy.anchor-note": "The script asks for admin key fingerprints. Each admin reads theirs from Your account, Key fingerprints for relays, and gives them to the operator. Admins can also endorse their key from the IDE or Hub app after the relay joins.",
    "deploy.offered-key": "The script also offers your key (<hint>) as the relay's first admin key. The operator types yes to trust it.",
    "deploy.wait-h": "Join and confirm",
    "deploy.wait-code": "Waiting for the script to use the code.",
    "deploy.wait-start": "The code was used. Waiting for the relay to start and connect.",
    "deploy.wait-connected": "<name> connected.",
    "deploy.compare": "Compare this fingerprint with the one the script printed:",
    "deploy.confirmed": "Confirmed. <name> is part of this console.",
    "deploy.anchors": "Admin keys the relay trusts: <n>",
    "deploy.anchor-none": "The relay trusts no admin key yet. Endorse your key from your IDE or Hub app.",
    "deploy.service-on": "Serving people.",
    "deploy.expired": "The code ended before the relay joined. Make a new one.",
    "deploy.new-code": "Make a new code",
    "deploy.done": "Done",
    "meet-ca.title": "Meeting Hub organization CA",
    "meet-ca.none": "This console holds no organization CA.",
    "meet-ca.warn": "This console will hold your organization's Meeting Hub CA in its sealed storage. Anyone who breaks into this console could then make certificates for any person in your organization and act as them on every Meeting Hub relay that trusts this CA. Any High relay that trusts this CA loses its High protection; such relays cannot join this console.",
    "meet-ca.high": "Under the High profile the organization CA stays on its own signer. This console does not hold it.",
    "meet-ca.create-next": "Create a new CA (coming next, with device certificates issued here)",
    "meet-ca.import": "Import our CA",
    "meet-ca.import-help": "Upload ca.crt and ca.key from your CA folder, and issued.json and crl.pem so revocations are kept. From now on, only this console signs this CA's revocation lists: stop signing them on the PC and on a certificate server in root mode.",
    "meet-ca.signer": "Certificate server address",
    "meet-ca.signer-help": "If a certificate server signs your people's devices, enter its address (https://...). Relays then fetch its revocation list; without it they refuse those devices.",
    "meet-ca.id": "CA id",
    "meet-ca.ends": "Ends",
    "meet-ca.crl": "Revocation list <number>, next by <date>",
    "meet-ca.issued": "Relay certificates issued: <n>",
    "meet-ca.revoke": "Revoke a certificate",
    "meet-ca.remove": "Remove the CA from this console",
    "meet-ca.remove-elsewhere": "I will sign this CA's revocation lists elsewhere before <date>.",
    "meet-ca.diverged": "<relay> holds a revocation list of this CA that another signer made. Its revocations were added here. Stop the other signer.",
    "meet-ca.lost": "The CA key cannot be opened (sealing lost). Import it again before <date>, when relays that trust it stop accepting anyone.",
    "meet-ca.unreadable": "The CA records do not read back. Nothing is issued until they do.",
    "spokes-root.title": "Remote Spokes organization root",
    "spokes-root.help": "The root's public key, root.pub. Relays this console installs check it against your license before they trust it. Never upload the private key.",
    "spokes-root.set": "Save root public key",
    "attention.meet-ca-expiring": "The Meeting Hub organization CA ends in <days> days.",
    "attention.meet-ca-lost": "The Meeting Hub organization CA key cannot be opened. Relays that trust it stop accepting anyone after <date>.",
    "attention.meet-ca-unreadable": "The Meeting Hub organization CA records do not read back.",
    "attention.meet-crl-failing": "The Meeting Hub organization CA's revocation list could not be renewed. It ends <date>.",
    "attention.meet-crl-diverged": "Another signer is making revocation lists for the Meeting Hub organization CA (seen on <relay>).",
    "attention.meet-crl-future": "A revocation list for the Meeting Hub organization CA is dated in the future (<date>, seen on <where>). Its revocations were added here; fix that signer's clock.",
    "relay.fleet-ca-held": "The Admin Console at <origin> holds the CA this High relay trusts, so it takes no changes from that console. Move this relay to a CA the console does not hold.",
    "meet-ca.confirm-no-high": "No High Meeting Hub relay anywhere, in this console or not, trusts this CA.",
    "meet-ca.crl-number-ceiling": "That revocation list's number is too high to follow, so this console did not sign a newer one. Decide which signer stays.",
    "deploy.remove-signer-note": "This relay can still reach the certificate server at <url> until its certificate there ends (<date>), because that server is not marked as checking revocation. Remove the host's address from the server's allowed relays now.",
    "attention.profile-lock-refused": "<relay> refused to start on <date> because its configuration said <configured> while the host is locked to the High profile.",
    "meet-ca.crl-not-pushed": "<relay> trusts this CA but does not take revocation lists from this console (<why>).",
    "meet-ca.crl-fixed": "its crl setting names a fixed file",
    "meet-ca.crl-none": "it checks no revocation list yet; turning one on would change who it accepts",
    "attention.relay-meet-cert-expiring": "The TLS certificate of <relay> ends in <days> days and has not renewed.",
    "attention.relay-signer-cert-expiring": "The certificate <relay> uses with the certificate server ends in <days> days and has not renewed. When it ends, people whose devices come from that server stop being accepted on <relay> within 7 days.",
    "attention.signer-crl-mismatch": "<relay> says the certificate server at <url> does not check revocation, so relays using that server get 30-day certificates until it agrees or you turn the setting off.",
    "attention.meet-crl-size": "The organization CA's revocation list is <size> KB, half of what relays accept. Remove entries that no longer matter on the CA page.",
    "meet-ca.signer-enforced": "This certificate server checks revocation of relay certificates",
    "meet-ca.signer-enforced-help": "Turn on only after the server runs a version that checks revoked relay certificates. Relays using it then get 90-day certificates, as long as every one of them confirms.",
    "meet-ca.prune": "Remove from the list",
    "meet-ca.prune-help": "Upload the certificate itself. It is removed only if this CA signed it and it has already ended. Entries older than <days> days leave the list on their own.",
    "meet-ca.max-lifetime": "Longest lifetime of any certificate this CA has issued (days)",
    "attention.signer-crl-stale": "The certificate server at <url> still holds revocation list <number>, older than this console's. Relays it refuses are not refused there yet.",
    "deploy.docker-turn-note": "On Docker this installer writes no host firewall, so calls between two people who both need TURN do not work until you open UDP 49160 to 49260 toward this host's own address in your firewall.",
  };

  // ---- Fleet confirmation dialogs (AC-2a 13.2, exact; the vector's "dialogs", keyed by its kebab-case action). ----
  const FD = {
    "enroll": { title: "Make an enrollment code for <name>?", body: "Anyone with the code can join one <product> relay to this console in the next hour.", button: "Make code" },
    "confirm-relay": { title: "Confirm <name>?", body: "Fingerprint <fingerprint>. Confirm only if the relay printed the same.", button: "Confirm" },
    "label": { title: "Rename <name>?", body: "Only this console's name for it changes.", button: "Save" },
    "narrow-scopes": { title: "Remove <scopes> from <name>?", body: "This console can no longer use them on the relay.", button: "Remove" },
    "widen-scopes": { title: "Ask <name> for <scopes>?", body: "The relay's operator must accept before they apply.", button: "Ask" },
    "remove-relay": { title: "Remove <name> from the console?", body: "The relay keeps running and keeps its people. This console loses access to it.", button: "Remove relay" },
    "endorse": { title: "Confirm <n> new keys for <m> relays?", body: "These people can then make changes on those relays.", button: "Confirm keys" },
    "library-add": { title: "Add license <id> to the library?", body: "<product>, <edition>, <users> users, ends <date>.", button: "Add" },
    "invite-meet": { title: "Ask for <email> to be invited to Meeting Hub on <relay>?", body: "An admin of that relay completes the invite in the Hub app.", button: "Send request" },
    "import": { title: "Send <n> invites?", body: "<c> console invites and <m> Meeting Hub requests on <r> relays.", button: "Send invites" },
    "suspend": { title: "Suspend <name> on <relay>?", body: "Their <n> devices are blocked on this relay for <hours> hours. Other relays are not affected.", button: "Suspend" },
    "unsuspend": { title: "Lift the suspension of <name> on <relay>?", body: "Their devices work on this relay again.", button: "Lift" },
    "remove-person": { title: "Remove <name> from <relay>?", body: "Revocation requests go to the relay's admins for each of <n> devices.", button: "Remove" },
    "token": { title: "Create a scrape token for <label>?", body: "It reads health metrics of <relays> for <days> days.", button: "Create" },
    "siem-on": { title: "Send events to <host>:<port>?", body: "A test message goes first; the change applies only if it arrives.", button: "Save" },
    "siem-off": { title: "Stop sending events to the SIEM?", body: "Audit and security events stop leaving this console.", button: "Stop" },
    "local-read-only-on": { title: "Set this relay read only from the console?", body: "The Admin Console can still read; it can change nothing here.", button: "Set read only" },
    "local-read-only-off": { title: "Let the console make changes again?", body: "Changes still need an admin's confirmation, checked here.", button: "Allow changes" },
    "local-confirm": { title: "Run this change from the console?", body: "<summary>, asked by <email>.", button: "Run it" },
    "local-accept-scopes": { title: "Give the console <scopes>?", body: "It can then use them on this relay.", button: "Accept" },
    "local-trust-ca": { title: "Trust the new management CA?", body: "Fingerprint <fingerprint>. Only if a console admin read you the same one by phone or in person.", button: "Trust CA" },
    "server-revoke": { title: "Replace the management certificate now?", body: "Relays drop the old one as soon as they get the new trust list. Use this if the console's key may have been copied.", button: "Replace now" },
    "ca-rollover": { title: "Start management CA <generation>?", body: "Every relay's operator must confirm its fingerprint on the relay within 90 days, or that relay stops connecting.", button: "Start" },
    "roster-cancel": { title: "Cancel <hint> on <relay>?", body: "The console may fail to deliver this. Also call the relay's operator to refuse the key on the relay.", button: "Cancel key" },
    "local-leave": { title: "Leave the Admin Console at <origin>?", body: "This relay stops sending health and stops taking changes from it. Its own console stays.", button: "Leave" },
    // AC-2b-D 13.2.
    "meet-ca-import": { title: "Import the CA <id> into this console?", body: "This console then holds the key that vouches for every person in your organization, and only it signs this CA's revocation lists. Any High relay that trusts this CA would lose its High protection.", button: "Import CA" },
    "meet-ca-revoke": { title: "Revoke certificate <serial>?", body: "Relays refuse it once they get the new revocation list.", button: "Revoke" },
    "meet-ca-remove": { title: "Remove the CA from this console?", body: "The sealed key is wiped. The last revocation list is valid until <date>; after that, relays that trust this CA refuse everyone unless another signer renews it.", button: "Remove CA" },
    "spokes-root": { title: "Use root <id> for new Remote Spokes relays?", body: "Relays this console installs trust it only when it matches their license.", button: "Save" },
    // API-1 7.3 (API-1a6)
    "api-client": { title: "Stage the client <name>?", body: "It joins the next API map. Nothing changes on relays until the map is saved and signed.", button: "Stage" },
    "api-client-update": { title: "Stage changes to <name>?", body: "Removals apply on relays at once. The rest waits for the next signed map.", button: "Stage" },
    "api-client-suspend": { title: "Suspend <name>?", body: "Relays refuse it at once. Resuming it needs a signed map.", button: "Suspend" },
    "api-client-resume": { title: "Resume <name>?", body: "It works again once the next map is signed.", button: "Resume" },
    "api-client-delete": { title: "Delete <name>?", body: "Relays refuse it at once, and the next map leaves it out.", button: "Delete" },
    "api-secret": { title: "Make a new secret for <name>?", body: "The secret is shown once. It works for <days> days once the next map is signed. Saving needs a second admin.", button: "Make secret" },
    "api-revoke-tokens": { title: "Revoke the tokens of <name>?", body: "Relays refuse every access token it holds now. It can ask for new ones.", button: "Revoke" },
    "api-scrape-token": { title: "Create a relay scrape token for <label>?", body: "The token is shown once. It reads health metrics of <relays> for <days> days once the next map is signed.", button: "Create" },
    "api-scrape-delete": { title: "Delete the scrape token <hint>?", body: "Relays refuse it at once.", button: "Delete" },
    "api-grace": { title: "Stage grace hours for <org>?", body: "Lowering a value applies on relays at once. Raising one waits for the next signed map and needs a second admin.", button: "Stage" },
    "api-off": { title: "Turn off the API for <org>?", body: "Every API client and scrape token of this organization is refused at once. Exports continue.", button: "Turn off" },
    "api-on": { title: "Turn the API back on for <org>?", body: "It works again once the next map is signed. Saving needs a second admin.", button: "Stage" },
    "api-undo": { title: "Undo <change>?", body: "It is undone once the next map is signed.", button: "Stage" },
    "api-origin": { title: "Set the API origin of <relay>?", body: "API clients reach this relay at this origin once the next map is signed.", button: "Stage" },
    "api-discard": { title: "Discard the staged changes for <org>?", body: "Changes already applied on relays stay as they are.", button: "Discard" },
    "api-save": { title: "Save the API settings of <org>?", body: "Your Hub device signs the new map, then the console sends it to the organization's relays.", button: "Save" },
    "api-signing-cancel": { title: "Cancel the signing for <org>?", body: "The Hub device is no longer asked to sign this map, and nothing is sent to the relays.", button: "Cancel signing" },
    "dest-add": { title: "Stage the destination <name>?", body: "It joins the next API map. Test it before you save.", button: "Stage" },
    "dest-update": { title: "Stage changes to the destination <name>?", body: "Removals apply on relays at once. Test it again before you save.", button: "Stage" },
    "dest-delete": { title: "Delete the destination <name>?", body: "Relays stop sending to it at once and delete its queues and failover credentials.", button: "Delete" },
    "dest-credential": { title: "Set the credential of <name>?", body: "It is sealed on this console and never shown again.", button: "Set" },
    "dest-siem": { title: "Copy the SIEM settings into a destination for <org>?", body: "The SIEM export keeps running until you turn it off.", button: "Copy" },
    "failover-csr": { title: "Ask <relay> for a certificate request?", body: "The relay makes the key and keeps it. Register the request with the tool, then install the certificate.", button: "Ask" },
    "failover-install": { title: "Install the failover credential of <name> on <relay>?", body: "The relay seals it and uses it only when it cannot reach the console.", button: "Install" },
    "failover-delete": { title: "Delete the failover credential of <name> on <relay>?", body: "The relay deletes it and stops failover delivery for this destination.", button: "Delete" },
    // API-1 revision 4 13.2 (API-1b8).
    "api-recipient": { title: "Set the recipient key of <name>?", body: "Exports are sealed to this key. Saving needs a second admin.", button: "Stage" },
    "api-caps": { title: "Change the export limits of <name>?", body: "Lowering a limit applies at once. Raising one waits for the next signed map and needs a second admin.", button: "Stage" },
    "api-recipient-drop": { title: "Drop the recipient key of <name>?", body: "Exports stop at once and ready ones are deleted. A new key needs a signed map.", button: "Drop" },
    "api-retire": { title: "Retire <relay> from <org>?", body: "It leaves this organization's relay set. If it reports the organization again, it rejoins.", button: "Retire" },
    "compliance-cancel": { title: "Cancel the export <job>?", body: "It ends at once and its parts are deleted. The client must ask again.", button: "Cancel export" },
    "webhook-key": { title: "Make a webhook key for <org>?", body: "The private key is made and sealed on this console. Its public key joins the next signed map.", button: "Make key" },
    "webhook-key-drop": { title: "Drop the webhook key <kid>?", body: "Signatures with it stop at once. Tell receivers before the next map leaves it out.", button: "Drop" },
    "dest-secret": { title: "Make a new v1 secret for <name>?", body: "The secret is shown once. A webhook not yet on v1 moves to it with the next signed map, which needs a second admin.", button: "Make secret" },
    "dest-replay": { title: "Send the events of <name> again?", body: "Events from the position you give are sent again. Receivers drop repeats by webhook-id.", button: "Replay" },
    "dest-resume": { title: "Resume events to <name>?", body: "Delivery goes on from where it paused. Nothing was dropped.", button: "Resume" },
    "federation-issuer": { title: "Set the outbound identity of <org>?", body: "It joins the next signed map. The first key is made and sealed on this console.", button: "Stage" },
    "federation-key": { title: "Make a federation key for <org>?", body: "The private key never leaves this console. It signs 24 hours after the next signed map lists it.", button: "Make key" },
    "federation-key-drop": { title: "Drop the federation key <kid>?", body: "This console stops signing with it at once and the key sets leave it out. Remove it from any key set you host or uploaded.", button: "Drop" },
    "federation-republished": { title: "Confirm the key <kid> is gone from hosted key sets?", body: "Confirm only once every key set you host or uploaded no longer lists it.", button: "Confirm" },
    // API-1 revision 5 14.2 (API-1c7).
    "api-connector": { title: "Stage the connector <name>?", body: "It joins the next API map. Saving needs a second admin.", button: "Stage" },
    "api-connector-update": { title: "Change the connector <name>?", body: "Removing an app or narrowing its networks applies at once. Adding an app, wider networks or a longer stale time waits for the next signed map and needs a second admin.", button: "Stage" },
    "api-connector-suspend": { title: "Suspend the connector <name>?", body: "Clients are refused through it at once. Resuming it needs a signed map and a second admin.", button: "Suspend" },
    "api-connector-resume": { title: "Resume the connector <name>?", body: "It works again once the next map is signed. Saving needs a second admin.", button: "Resume" },
    "api-connector-delete": { title: "Delete the connector <name>?", body: "Clients are refused through it at once, and the next map leaves it out, also from every client that lists it.", button: "Delete" },
    "api-idp": { title: "Stage the identity provider <name>?", body: "It joins the next API map. Saving needs a second admin.", button: "Stage" },
    "api-idp-update": { title: "Change the identity provider <name>?", body: "Narrowing applies at once. Widening (another algorithm, a longer age, a removed or changed tenant, private addresses) waits for the next signed map and needs a second admin.", button: "Stage" },
    "api-idp-test": { title: "Test the identity provider <name>?", body: "The console fetches its discovery document and key set now and shows what it found. Nothing is kept but the time and the number of keys.", button: "Test" },
    "api-idp-suspend": { title: "Suspend the identity provider <name>?", body: "Its assertions are refused at once. Resuming it needs a signed map and a second admin.", button: "Suspend" },
    "api-idp-resume": { title: "Resume the identity provider <name>?", body: "Its assertions work again once the next map is signed. Saving needs a second admin.", button: "Resume" },
    "api-sso-url": { title: "Set the SSO URL of <provider>?", body: "People who sign in to an AI app through this provider are sent to this address.", button: "Set" },
    "api-delegation-revoke": { title: "Revoke <principal> for <name>?", body: "The person's tokens end at once, and the person may not delegate again until an admin allows it.", button: "Revoke" },
    "api-delegation-revoke-all": { title: "Revoke <principal> for every delegated client?", body: "The person's tokens for every delegated client end at once, and the person may not delegate to any of them until an admin allows it.", button: "Revoke" },
    "api-delegation-allow": { title: "Allow <principal> to delegate to <name> again?", body: "It is staged, and a second admin must approve the save before it applies.", button: "Stage" },
    "local-mcp": { title: "Stage Local MCP for <org>?", body: "It is saved with the AI settings, signed from your device.", button: "Stage" },
    // API-1 revision 6 7.14 (API-1d5).
    "api-agent": { title: "Stage the agent <name>?", body: "It joins the next API map, and its card is signed once the map is saved. Saving needs a second admin.", button: "Stage" },
    "api-agent-update": { title: "Change the agent <name>?", body: "Removing a skill applies at once. Adding a skill or a spoke, or a longer approval wait, waits for the next signed map and needs a second admin.", button: "Stage" },
    "api-agent-delete": { title: "Delete the agent <name>?", body: "Its card and new tasks are refused at once, and the next map leaves it out, also from every client that lists it.", button: "Delete" },
    "api-a2a-key": { title: "Make a card key for <org>?", body: "The private key is made and sealed on this console. Its public key joins the next signed map, and cards are signed with it from then on.", button: "Make key" },
    "api-a2a-key-drop": { title: "Drop the card key <kid>?", body: "Cards stop being signed with it at once. A card with no other key is not served until a new key is in a signed map.", button: "Drop" },
    "api-well-known": { title: "Choose the root agent card of <org>?", body: "The chosen agent is published at this console's root well-known address once the next map is signed. Saving needs a second admin.", button: "Stage" },
    "api-spokes-bind": { title: "Bind <relay> to <org>?", body: "The relay joins the organization's spokes relays and receives its map. Saving needs a second admin.", button: "Bind" },
    "api-spokes-unbind": { title: "Unbind <relay> from <org>?", body: "The relay stops serving this organization's service hubs once it drops the map.", button: "Unbind" },
    "api-spokes-root": { title: "Set the Remote Spokes root of <org>?", body: "This console's Remote Spokes root <root> joins the next signed map. Spokes relays take the map only when their root matches.", button: "Stage" },
    "api-push-off": { title: "Turn off pushes to <name>?", body: "Push notifications to this partner stop at once, and the next map leaves its push origins out.", button: "Push off" },
    "api-card-check": { title: "Check the partner card of <name> now?", body: "The console fetches the partner's card and verifies it with the key set you pinned, never with the card's own jku.", button: "Check" },
  };
  // An AC-1-shaped dialog spec (title, body lines, buttons) from a fleet dialog.
  const fspec = (k) => ({ title: FD[k].title, body: [FD[k].body], button: [FD[k].button] });

  // ---- Fleet navigation (12.4, exact order and names; the vector's "nav" without the phase 4 and 5 places) ----
  const FNAV = [
    { id: "nav.overview", route: "overview", pages: [] },
    { id: "nav.people", route: "people", pages: [] },
    { id: "nav.spokes", route: "spokes", pages: [["relays", "Relays"], ["hubs", "Hubs"], ["spokes", "Spokes"], ["seats", "Seats"], ["revocation", "Relays and revocation"], ["blocks", "Blocks"], ["logs", "Logs"]] },
    { id: "nav.meet", route: "meet", pages: [["relays", "Relays"], ["people", "People and devices"], ["seats", "Seats"], ["calls", "Calls"], ["approvals", "Waiting approvals"], ["organizations", "Organizations"], ["bridges", "Bridges"], ["holds", "Legal holds"], ["release", "Release"], ["signer", "Signer and servers"], ["push", "Push"], ["logs", "Logs"]] },
    { id: "nav.relays", route: "relays", pages: [["list", "Relays"], ["locations", "Locations"], ["health", "Health"], ["add", "Deploy a relay"]] },
    { id: "nav.license", route: "license", pages: [] },
    { id: "nav.sign-in", route: "sign-in", pages: [] },
    { id: "nav.email", route: "email", pages: [] },
    { id: "nav.security", route: "security", pages: [["approvals", "Approvals"], ["requests", "Requests"], ["audit", "Audit log"], ["settings", "Security settings"], ["exports", "Exports"], ["api", "API access"], ["compliance", "Compliance"]] },
    { id: "nav.settings", route: "settings", pages: [["console", "Console"], ["setup", "Setup"], ["consoles", "Other consoles"], ["account", "Your account"]] },
  ];
  // Role views (12.4): viewers see health and lists without people and no controls; user managers add People and the
  // seat pages; admins see everything. Each entry lists the groups and the pages inside them.
  const FROLE = {
    viewer: { overview: [], spokes: ["relays", "revocation"], meet: ["relays", "release", "signer"], relays: ["list", "locations", "health"], license: [], settings: ["account"] },
    "user-manager": { overview: [], people: [], spokes: ["relays", "hubs", "spokes", "seats", "revocation"], meet: ["relays", "people", "seats", "release", "signer"],
      relays: ["list", "locations", "health"], license: [], settings: ["account"] },
  };
  // The scope each fleet product page needs for its full answer (5.4), named in fleet.scope-missing.
  const PAGE_SCOPE = {
    spokes: { hubs: "people", spokes: "people", seats: "people", revocation: "read-health", blocks: "people", logs: "read-logs" },
    meet: { people: "people", seats: "people", calls: "people", approvals: "people", organizations: "people", bridges: "people", holds: "people",
      release: "read-health", signer: "read-health", push: "people", logs: "read-logs" },
    security: { requests: "people" },
  };
  const SCOPES = ["read-health", "read-logs", "people", "config", "license"];
  // The 9.6 range buttons and the 9.5 query ranges.
  const RANGES = [["1h", "charts.range-1h"], ["24h", "charts.range-24h"], ["7d", "charts.range-7d"], ["30d", "charts.range-30d"]];
  // Plain fleet words the contract leaves to the page (column and card labels, short notices).
  const FMSG = {
    product: { spokes: "Remote Spokes", meet: "Meeting Hub" },
    cols: { name: "Name", product: "Product", site: "Site or region", version: "Version", license: "License", health: "Health", contact: "Last seen", relay: "Relay",
      kind: "Kind", role: "Role", state: "State", source: "Source", email: "Email", days: "Days left", ends: "Ends", count: "Relays", worst: "Worst health" },
    cards: { spokes: "Spokes busy", licenses: "Licenses", certificates: "Certificates", approvals: "Approvals", requests: "Requests" },
    tabs: { summary: "Summary", health: "Health", scopes: "Scopes and controls", attention: "Attention", pages: "Product pages" },
    roles: { "relay-admin": "Relay admin", member: "Member", "hub-user": "Hub user" },
    metric: { call_minutes: "Call minutes", calls_active: "Calls now", spokes_busy: "Spokes busy", spokes_online: "Spokes online", lanes_busy: "Lanes busy",
      lanes_total: "Lanes in all", cpu_host: "Host", cpu_process: "Relay process", mem_host_used: "Host memory in use", mem_process: "Relay process memory",
      net_in: "In, per minute", net_out: "Out, per minute" },
    kinds: { tls: "TLS certificate", console: "Console certificate", mgmt: "Management certificate", signer: "Signer certificate", crl: "Revocation list", license: "License" },
    daysWord: "days",
    certEnds: "Management certificate ends",
    nodes: "Hubs and spokes",
    services: "Meeting Hub services",
    signer: "Signer healthy",
    push: "Push",
    anchor: "Anchor",
    scopesNow: "Scopes",
    waitingChanges: "Changes waiting on the relay",
    time: "Time",
    range: "Time range",
    expires: "Expires <time>",
    cancelRequest: "Cancel request",
    daysInvite: "Days the invite works (1 to 30)",
    issued: "Trust list issued",
    leaves: "Server certificates listed",
    revoked: "Server certificates revoked",
    evidence: "Attestation kept",
    rosterSeq: "Key list number",
    created: "Created",
    lastError: "Last error",
    spooled: "Waiting to send",
    dropped: "Dropped",
    change: "Change",
    asked: "Asked",
    rename: "Rename",
    scopes: "Change scopes",
    replace: "Replace",
    remove: "Remove relay",
    leaveCmd: "To leave from the relay's host:",
    enrolledBy: "Enrolled by",
    enrolled: "Enrolled",
    readOnlyRelay: "Read only from the console",
    confirmHere: "Confirm here",
    pending: "Waiting for the relay's operator",
    pins: "Management CA pins",
    manifest: "Trust list number",
    held: "Keys in the 24-hour hold",
    unattested: "Keys the relay could not verify",
    anchored: { device: "Endorsed from the admin's IDE or Hub app", "admin-key": "Fingerprint added by the operator", none: "Not anchored yet" },
    caGenerations: "Management CA generations",
    keys: "Admin keys",
    waitingKeys: "Keys waiting for relays",
    relaysTrust: "Relays and their trust",
    acceptCmd: "The operator accepts it on the relay with:",
    library: "License library",
    install: "Install a license",
    tokens: "Scrape tokens",
    revoke: "Revoke",
    siemHost: "Host",
    siemPort: "Port",
    siemCa: "Certificate authority (PEM)",
    siemCert: "Client certificate (PEM)",
    siemKey: "Client key (PEM)",
    siemEvents: "Events",
    siemEventNames: { audit: "Audit", security: "Security", relays: "Relays" },
    turnOff: "Turn off",
    label: "Label",
    relaysAll: "All relays",
    daysField: "Days (30 to 90)",
    olderToken: "Made for more than 90 days, before the limit. Replace it before it ends.",
    codeCopy: "Copy the code",
    commandsCopy: "Copy the command",
    consoleUrl: "Console address",
    adminKeys: "Admin key fingerprints, one per line",
    preview: "Check the console",
    generation: "CA generation",
    recordFirst: "Open the Admin Console from your IDE or Hub app first, then choose this again.",
    csvFile: "CSV file",
    csvProblem: "Problem",
    csvOk: "OK",
    seated: "Seated",
    pick: "Pick",
    devices: "Devices",
    profileWords: { high: "High", standard: "Standard" },
    // The registry state "active" in lists: enrolled with the console, which says nothing about whether it answers now.
    stateActive: "Enrolled",
    failures24h: "<n> failures in 24 hours",
    pickerNote: "Choosing a relay shows its page.",
    pickerNone: "Choose a relay",
    notReadable: "<name> cannot be read now (<state>), so this page shows no relay. Choose another relay.",
    notFound: "Page not found",
    notFoundBody: "There is no page at this address.",
    notAllowed: "Your role cannot open this page.",
    toOverview: "Go to Overview",
    caOpen: "Open the CA page",
    setupDone: "Setup is complete.",
    review: "Review",
    replaces: "Replaces an existing relay",
    // Help on a fleet console: what each part of the console does (WCAG 3.2.6, one place from the account menu).
    help: [
      ["Relays", "Relays and locations lists every relay that joined this console, with its health, license and last contact. Open a relay for its summary, trust, charts and scopes, or deploy a new one."],
      ["People", "People shows console accounts and the people on each relay in one list. Invite, suspend or remove them here; a change on a relay goes to that relay."],
      ["Security and approvals", "With two-person control on, changes that lower security or take access away wait for a second admin for up to 24 hours. Changes on relays also need a passkey or security key."],
      ["Audit", "The audit log records every change made in this console, who made it and when. Each entry is chained to the one before, so an exported copy shows any later edit."],
      ["Blocks and revocation", "A block stops a relay from serving a device, hub or spoke for a while; its certificate stays valid elsewhere. To revoke a certificate, the console sends a request to the root holder or to an admin in the Meeting Hub app."],
      ["Licenses", "License shows each relay's license and whether it serves people. Keep licenses in the library, then install them on relays from there."],
    ],
    // AC-2b-D 3: labels the contract leaves to the page.
    deploy: {
      confirmRelay: "Confirm relay", installLicense: "Install a license", copyInstall: "Copy the install command", caFile: "ca.crt", keyFile: "ca.key",
      issuedFile: "issued.json (optional)", crlFile: "crl.pem (optional)", rootFile: "root.pub", subject: "Subject", serial: "Serial", names: "Names",
      kind: { server: "Server", "signer-client": "Certificate server client" }, revokedList: "Revocation list entries", at: "Since", savedRoot: "Saved root",
      caState: { ok: "OK", lost: "Key cannot be opened", unreadable: "Records do not read back" }, confirms: "Confirms", disagrees: "Disagrees",
      certPem: "The ended certificate (PEM)", dismiss: "Dismiss", saveDays: "Save", open: "Open",
    },
    // MR-1 section 4: a Meeting Hub relay cluster (one active relay, one standby) and its signed relay directory.
    cluster: {
      col: "Cluster",
      id: "Cluster",
      node: "Cluster node",
      role: "Cluster role",
      roles: { active: "Active", standby: "Standby", fenced: "Fenced" },
      epoch: "Epoch",
      generation: "Replica generation",
      lag: "Replica lag",
      peer: "Peer node",
      witness: "Witness lease",
      autoPromote: "Standby promotes itself",
      short: "epoch <epoch>, generation <generation>",
      lagShort: "lag <lag>",
      seconds: "<n> s",
      directory: "Relay directory",
      directoryShort: "version <version>, ends <time>",
      promote: "Promote",
      demote: "Make standby",
      handover: "Hand over",
      force: "Promote even if the other relay still answers as active",
      dlg: {
        promote: { title: "Promote <name> to the active relay of <cluster>?", body: ["<name> starts serving people with a new epoch. Do this only when the active relay is down: while it still answers as active the relay refuses unless you choose to force it, and two active relays would split the cluster's data."], button: ["Promote"] },
        demote: { title: "Make <name> a standby of <cluster>?", body: ["<name> stops serving people and copies the active relay. Until another relay of the cluster is active, people cannot connect. Calls in progress drop."], button: ["Make standby"] },
        handover: { title: "Hand over <cluster> from <name>?", body: ["<name> stops taking changes, waits until the standby has every change, then the standby becomes the active relay and <name> becomes the standby. People reconnect on their own; calls in progress drop and rejoin."], button: ["Hand over"] },
      },
      dir: {
        title: "Relay directory of <cluster>",
        version: "Version",
        issued: "Issued",
        expires: "Ends",
        nodes: "Nodes",
        server: "Server",
        address: "Connects to",
        port: "Port",
        region: "Region",
        priority: "Priority",
        from: "As <relay> holds it.",
        none: "<relay> holds no signed relay directory. Sign one with meet_pki.py relay-directory on the signer and post it to the active relay.",
        unreadable: "The relay directory could not be read from <relay>: <message>",
      },
      attention: {
        "relay-directory-expiring": "The relay directory of cluster <cluster> ends in <days> days. Sign a new one and post it to the active relay.",
        "relay-directory-expired": "The relay directory of cluster <cluster> has ended. Apps connect only to the relay they enrolled with until a new one is posted.",
      },
    },
    // ADR-0343: the Lucid Meet password accounts this console keeps (moved from the old Meet console, ADR-0347).
    accounts: {
      title: "Lucid Meet accounts",
      signIn: "Password sign-in",
      org: "Organization people enter",
      howSignIn: "In Lucid Meet, people choose Sign in, enter the organization <org>, their username and password.",
      relay: "Relay that approves devices",
      relayNone: "Not set up; new devices wait",
      testflight: "TestFlight invitations",
      always: "Always approved",
      approval: "New devices",
      queue: "Approve each new device",
      auto: "Approve automatically",
      queueNote: "A device signed in with a password waits until an admin approves it.",
      autoNote: "A device signed in with a password is approved at once.",
      noAccounts: "No accounts yet. People get one when they accept an invite.",
      save: "Save",
      off: "Password sign-in is not set up on this console.",
      offHow: "An operator imports the accounts and invites of the old Meet console on this console's host, with the console stopped:",
      offCheck: "To check what the console holds:",
      importCmd: "lucid-relay console meet-accounts import --state-dir <console state dir> --old-state <state.json> --old-config <console.json> --relay-cert <pem> --relay-key <pem> --relay-ca <pem> [--asc-key <p8>]",
      statusCmd: "lucid-relay console meet-accounts status --state-dir <console state dir>",
      accounts: "Accounts",
      invites: "Open invites",
      cols: { name: "Name", username: "Username", email: "Email", last: "Last sign-in", state: "State", by: "Created by", sent: "Sent", expires: "Expires", kind: "Kind" },
      active: "Active",
      locked: "Locked",
      lockedUntil: "Locked until <time>",
      kindInvite: "Invite",
      kindReset: "Reset",
      inviteBtn: "Invite to Lucid Meet",
      resetBtn: "Reset password",
      unlock: "Unlock",
      remove: "Remove",
      inviteDlg: { title: "Invite a person to Lucid Meet?", body: ["They get a link to choose a username and password. The link works once."], button: ["Invite"] },
      resetDlg: { title: "Reset the password of <name>?", body: ["They get a link to set a new password. Their username stays <username>, and the old password works until they set the new one."], button: ["Reset password"] },
      removeDlg: { title: "Remove the account <name>?", body: ["They can no longer sign in with it. Devices it set up keep working until you revoke them."], button: ["Remove"] },
      unlocked: "<name> can sign in again.",
      saved: "New devices: <mode>.",
      result: { invite: "Invite for <name>", reset: "Password reset for <name>" },
      mailSent: "The email went to <email>.",
      mailUnset: "This console has no email set up, so nothing was sent. Send this email to <email> yourself.",
      mailFailed: "The email to <email> could not be sent. Send this email yourself.",
      draft: "Email text",
      to: "To",
      subject: "Subject",
      copyDraft: "Copy the email",
      tf: {
        added: "TestFlight: Apple emails <email> an invitation to install Lucid Meet.",
        exists: "TestFlight: <email> is already a tester.",
        off: "TestFlight is not set up on this console. Add <email> to TestFlight yourself.",
        failed: "TestFlight could not add <email> (<message>). Add them to TestFlight yourself.",
      },
      expires: "The link works once, until <time>.",
    },
  };

  const PAGES = {
    spokes: ["hubs", "spokes", "relays", "seats", "license", "logs", "requests"],
    meet: ["people", "seats", "enrollments", "organizations", "signer", "bridges", "holds", "releases", "push", "identity", "calls", "servers", "license", "logs", "requests", "ai", "support", "branding"],
    admins: ["people", "sessions", "audit", "settings", "account"],
  };
  // Settings > AI (contract AI-1 section 9). The contract's own words are verbatim; the rest are the page's labels.
  const AIW = {
    page: "AI",
    // ends with the scheme so the asset test reads it as words, not a link
    url: "Address with its port; it must start with https://",
    presets: { device: "This computer only", "org-first": "Org servers first", "device-org-frontier": "This computer, then org servers, then frontier", advanced: "Advanced" },
    who: "Who may use AI", groups: "Groups (immutable ID-1 group ids, one per line)", people: "People (one email per line, for organizations without single sign-on or as well)",
    routing: "Routing", preset: "Route order", advancedAi: "Advanced: the ai key (every field of the policy's ai settings)", advancedMap: "Advanced: the AI map's channel_classes and excluded_channels",
    review: "Review changes", save: "Save", staged: "Staged change", noStage: "Nothing is staged.",
    signing: { map: "Waiting for <principal> to sign the AI map from their device.", policy: "Waiting for <principal> to sign the policy that names the AI map." },
    gateways: "AI gateways", enroll: "Enroll a gateway", remove: "Remove", consoleSpki: "This console's key for the gateway's admin_spki",
    cards: "Model cards", bench: "Run benchmark", approve: "Approve",
    usage: "Usage", requests: "Requests", refusals: "Refusals by code", spend: "Spend this month", budgets: "Budgets", health: "Card health", missing: "Request ids missing from the archive",
    personal: "Personal access (people's own accounts)", byProvider: "Requests by provider and method", plans: "Business-plan answers", tokens: "Tokens in and out",
    dropped: "AI history records that could not be saved", droppedLatest: "Latest", droppedCount: "Records", reasons: "Reasons", partial: "Only the first 20,000 device audit records of the last 30 days are counted.",
    hold: "Place a legal hold", reviewer: "Archive reviewer who signs",
    archive: "Archive", addArchive: "Add an archive", offlineCopy: "Offline copy", shares: "Reviewers' shares", recoverable: "Recoverable", notTested: "Not tested",
    code: "Recovery code", makeCode: "Make a recovery code", replaceCode: "Replace the recovery code", confirmCode: "Confirm the recovery code",
    codeOnce: "Write this code down now. It is shown only once.", group: "Group <n>",
    noArchive: "No archive. AI history stays on each person's devices; a legal hold cannot retrieve it.",
    noCopy: "No offline copy. Legal holds depend on restoring this archive server from your own backups.",
    dlg: {
      save: { title: "Save the AI settings of <org>?", body: ["The AI map is signed first, then the policy that names it, from your device."], button: ["Save", "Ask for approval"] },
      approve: { title: "Approve the model card <card>?", body: ["It passed its benchmark. Approved cards can carry the classes you list."], button: ["Approve", "Ask for approval"] },
      enroll: { title: "Enroll a gateway for <org>?", body: ["It is listed in the next AI map you save."], button: ["Enroll"] },
      hold: { title: "Place a legal hold on <principal>?", body: ["A reviewer signs the archive hold; the relay hold and the archive hold are placed together."], button: ["Place a legal hold"] },
      archive: { title: "Add an archive for <org>?", body: ["The console reaches the archive at this address and checks its key."], button: ["Add an archive"] },
      copy: { title: "Change the offline copy settings of <org>?", body: ["A reviewer signs the change before the archive takes it."], button: ["Save"] },
      code: { title: "Make a recovery code for <org>?", body: ["A new code replaces the old one for new copies. A reviewer signs the request."], button: ["Make a recovery code"] },
      confirm: { title: "Confirm the recovery code", body: ["Type groups <first> and <second> of the code."], button: ["Confirm"] },
      bench: { title: "Run the benchmark of <card>?", body: ["The gateway measures the card again (3.2)."], button: ["Run benchmark"] },
    },
  };
  const PAGE_LABEL = {
    spokes: Object.fromEntries(PAGES.spokes.map((id, i) => [id, W["nav.spokes.pages"][i]])),
    meet: Object.fromEntries(PAGES.meet.map((id, i) => [id, W["nav.meet.pages"][i]])),
    admins: Object.fromEntries(PAGES.admins.map((id, i) => [id, W["nav.admins.pages"][i]])),
  };
  PAGE_LABEL.meet.ai = AIW.page;
  // SE-1: the page is named for its tickets; the AC-2a fleet nav keeps the one-word support group for a later phase
  PAGE_LABEL.meet.support = "Support tickets";
  // TH-1 6: the organization's brand on the guest portal, the web sign-in and the account pages
  PAGE_LABEL.meet.branding = "Branding";
  // What each role below admin may open (2.3, 7.2): user managers the people lists and seats, viewers health and lists.
  const ROLE_PAGES = {
    "user-manager": { spokes: ["hubs", "spokes", "seats"], meet: ["people", "seats"], admins: ["people", "account"] },
    viewer: { spokes: ["hubs", "spokes", "relays", "license"], meet: ["calls", "releases", "license"], admins: ["account"] },
  };
  const PRODUCT_NAME = { spokes: W["nav.spokes"], meet: W["nav.meet"] };
  const ROLE_WORD = { admin: W["role.names"][0], "user-manager": W["role.names"][1], viewer: W["role.names"][2] };
  // The attention kinds of 7.3 for "Email me about" (account.mail), grouped, each with a short sentence. `fleet` marks
  // the console's own relay kinds the mail sender knows (AC-2a revision 3.4), offered on a fleet console only.
  const MAIL_GROUPS = [
    ["License and seats", [
      ["license-none", "No license is installed"], ["license-expiring", "The license ends soon"], ["license-grace", "The license ended and is in its grace days"],
      ["license-expired", "The license and its grace days are over"], ["license-stopped", "Service stopped for want of a license"],
      ["license-upgrade-period", "The upgrade period is ending"], ["seats-high", "Most licensed seats are in use"], ["seats-over", "More people than the license covers"],
      ["seats-unseated", "Some people have no seat"], ["seats-protected", "Admins alone use more seats than the license covers"],
      ["seats-held", "People over the license are held without service"], ["uncounted", "Hubs were refused for want of a seat"],
      ["relay-license-expiring", "A relay's license ends soon", "fleet"], ["relay-license-grace", "A relay's license ended", "fleet"],
      ["relay-license-stopped", "A relay stopped for want of a license", "fleet"]]],
    ["Certificates and revocation", [
      ["crl-stale", "A revocation list is out of date"], ["signer-unhealthy", "The certificate signer is not answering"],
      ["signer-expiring", "The signer's certificate ends soon"], ["cert-expiring", "Certificates end within 7 days"],
      ["tls-expiring", "The console's TLS certificate ends soon"], ["mds-old", "The security key metadata is old"],
      ["aaguids-relaxed", "Approved key models have no FIPS certificate"], ["key-unattested", "Admins have no approved security key"]]],
    ["People and sign-in", [
      ["admins-few", "There is only one admin"], ["anchor-single", "Every admin depends on one hub or device"], ["admin-suspended", "An admin is suspended"],
      ["passkey-waiting", "A new passkey is waiting for approval"], ["joiner-waiting", "Someone joined and is waiting for approval"],
      ["admins-unproven", "Admins have not signed in since the upgrade"], ["signin-locked", "Accounts were locked after failed sign-ins"],
      ["break-glass-missing", "There is no break-glass account"], ["break-glass-used", "The break-glass account signed in"],
      ["profile-standard", "The console was moved to the Standard profile"], ["two-person-off", "A second admin is not required"],
      ["enrollments-waiting", "Devices are waiting for approval"], ["spokes-silent", "Spokes have not checked in for a day"]]],
    ["Approvals, requests and blocks", [
      ["approvals-mine", "Changes are waiting for your approval"], ["requests-old", "Requests have waited more than 3 days"],
      ["blocks-active", "Blocks are active"], ["quota-hits", "Requests were refused for limits"],
      ["support-waiting", "Support tickets from Meeting Hub wait for an answer"]]],
    ["Audit", [
      ["audit-broken", "The audit log does not verify"], ["audit-rotating", "The audit log will soon drop entries"],
      ["audit-dropped-unexported", "The audit log dropped entries before they were exported"], ["audit-not-exported", "The audit log has not been exported for 30 days"]]],
    ["Email, clock and secrets", [
      ["mail-failing", "Email is failing"], ["clock-uncertain", "The relay's clock is uncertain"], ["clock-back", "The relay's clock is behind"],
      ["seal-key-file", "Secrets are protected by a key file"], ["seal-machine-scope", "Secrets are protected for the whole machine"],
      ["seal-lost", "Saved secrets could not be unlocked"]]],
  ];

  // ---- Themes (7.1): the 23 palettes of Meeting Hub 0.96.0, same ids, labels and blurbs ----
  const THEMES = [
    { id: "lucid-dark", label: "Lucid Dark", blurb: "The original: near-black ground, magenta accent, cyan for data." },
    { id: "midnight", label: "Midnight", blurb: "Deep indigo, cooler and quieter than the default." },
    { id: "slate", label: "Slate", blurb: "Neutral gray with the color turned right down." },
    { id: "ember", label: "Ember", blurb: "Warm amber and red over a roasted dark ground." },
    { id: "contrast", label: "High Contrast", blurb: "Pure black with maximum-contrast text for low vision." },
    { id: "lucid-light", label: "Lucid Light", blurb: "The same brand hues on a light neutral ground." },
    { id: "paper", label: "Paper", blurb: "Warm sepia light, easy on the eyes in a bright room." },
    { id: "evergreen", label: "Evergreen", blurb: "Pine green ground, Christmas red, warm gold.", special: true },
    { id: "liberty", label: "Liberty", blurb: "Deep navy, flag red and bright star blue.", special: true },
    { id: "honor", label: "Honor", blurb: "Quiet charcoal with brass gold and steel blue.", special: true },
    { id: "gilded", label: "Gilded", blurb: "Midnight black with champagne gold and silver.", special: true },
    { id: "dawn", label: "Dawn", blurb: "Indigo night breaking into sunrise amber.", special: true },
    { id: "rosewood", label: "Rosewood", blurb: "Deep wine ground with rose and lilac.", special: true },
    { id: "shamrock", label: "Shamrock", blurb: "Clover green with a pot of gold.", special: true },
    { id: "blossom", label: "Blossom", blurb: "Twilight plum with cherry blossom pink.", special: true },
    { id: "harbor", label: "Harbor", blurb: "Deep sea navy with lantern amber.", special: true },
    { id: "jubilee", label: "Jubilee", blurb: "Warm dark ground with celebration red and gold.", special: true },
    { id: "heritage", label: "Heritage", blurb: "Earth brown with turquoise and terracotta.", special: true },
    { id: "nightshade", label: "Nightshade", blurb: "Witching-hour purple with pumpkin orange.", special: true },
    { id: "gridiron", label: "Gridiron", blurb: "Night turf with pigskin brown and trophy gold.", special: true },
    { id: "pitch", label: "Pitch", blurb: "Floodlit emerald with golden trim.", special: true },
    { id: "podium", label: "Podium", blurb: "Stadium blue with gold medal shine.", special: true },
    { id: "pastel", label: "Pastel", blurb: "Soft lilac light with mint, for spring.", special: true },
  ];

  // ---- Cleaning (section 0): Bidi_Control, Default_Ignorable_Code_Point, C0 and C1 controls removed ----
  // Inclusive code point ranges from the Unicode Character Database (PropList.txt Bidi_Control and
  // DerivedCoreProperties.txt Default_Ignorable_Code_Point, Unicode 15.1), plus C0, DEL and C1.
  const CLEAN_RANGES = [
    [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c],
    [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
    [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
    [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
  ];
  function clean(value) {
    const s = value == null ? "" : String(value);
    let out = "";
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (!CLEAN_RANGES.some((r) => c >= r[0] && c <= r[1])) out += ch;
    }
    return out;
  }
  // Multi-line untrusted text (the sign-in banner, a seat request): each line cleaned, the line breaks kept.
  const cleanLines = (value) => String(value == null ? "" : value).split(/\r?\n/).map(clean).join("\n");

  // ---- DOM helpers ----
  const $ = (id) => document.getElementById(id);
  let uidN = 0;
  const uid = (p) => p + "-" + (++uidN);

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "style" || k.slice(0, 2).toLowerCase() === "on") throw new Error("refused attribute " + k);
        if (k === "class") n.className = v;
        else if (k === "hidden") n.hidden = true;
        else n.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const k of kids.flat(4)) {
      if (k == null || k === false) continue;
      n.append(k instanceof Node ? k : String(k));
    }
    return n;
  }
  // Untrusted text: cleaned and isolated.
  const u = (v) => el("bdi", null, clean(v == null ? "" : v));
  const code = (v) => el("code", null, clean(v == null ? "" : v));

  const PH = /<([a-z][a-z ]*)>/;
  // Words with <placeholders> become text nodes and bdi elements (values cleaned).
  function fill(tpl, vals) {
    const frag = document.createDocumentFragment();
    tpl.split(PH).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) frag.append(part);
        return;
      }
      const v = vals ? vals[part] : undefined;
      if (v instanceof Node) frag.append(v);
      else frag.append(u(v == null ? "" : v));
    });
    return frag;
  }
  // Words whose placeholders share a name ("Relay clock: <time>. Your browser: <time>."): values in order.
  function fillList(tpl, list) {
    const frag = document.createDocumentFragment();
    let at = 0;
    tpl.split(PH).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) frag.append(part);
        return;
      }
      const v = list[at++];
      frag.append(v instanceof Node ? v : u(v == null ? "" : v));
    });
    return frag;
  }
  function fillText(tpl, vals) {
    return tpl.split(PH).map((part, i) => (i % 2 === 0 ? part : clean(vals && vals[part] != null ? vals[part] : ""))).join("");
  }

  // ---- Times: the browser's locale, with the time zone named where there is a time of day ----
  const FMT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const DFMT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
  const PLAIN_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  // A time value as a Date, or null. Numbers (and digit strings) are milliseconds or seconds as `unit` says ("ms", "s",
  // or "any": milliseconds when large, else seconds); ISO date-time strings as written; a plain YYYY-MM-DD is that
  // calendar day, built as a local date so it does not move a day west of UTC.
  function dateOf(v, unit) {
    let d = null;
    if (typeof v === "number") d = new Date(unit === "s" || (unit === "any" && Math.abs(v) <= 1e12) ? v * 1000 : v);
    else if (typeof v === "string") {
      const s = v.trim();
      const day = PLAIN_DAY.exec(s);
      if (day) d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
      else if (/^\d+(?:\.\d+)?$/.test(s)) return dateOf(Number(s), unit);
      else if (DATE_TEXT.test(s)) d = new Date(s);
    }
    return d && Number.isFinite(d.getTime()) ? d : null;
  }
  // A value the page cannot read as a time is shown as its text, never thrown.
  function timeText(f, v, unit) {
    if (!v) return MSG.never;
    const d = dateOf(v, unit);
    if (!d) return clean(String(v));
    return (typeof v === "string" && PLAIN_DAY.test(v.trim()) ? DFMT : f).format(d);
  }
  const when = (ms) => timeText(FMT, ms, "ms");
  const whenSec = (s) => timeText(FMT, s, "s");
  const daySec = (s) => timeText(DFMT, s, "s");
  // Values whose unit the route does not name: milliseconds when large, else seconds; ISO text as written.
  const whenAny = (v) => timeText(FMT, v, "any");
  const dayAny = (v) => timeText(DFMT, v, "any");
  // Whether an argument is a time the page formats (a number, or an ISO date or date-time text).
  const isTime = (v) => typeof v === "number" || (typeof v === "string" && DATE_TEXT.test(v.trim()));
  function span(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d) parts.push(d + (d === 1 ? " day" : " days"));
    if (h || d) parts.push(h + (h === 1 ? " hour" : " hours"));
    if (!d) parts.push(m + (m === 1 ? " minute" : " minutes"));
    return parts.join(" ");
  }
  const yesNo = (b) => (b ? MSG.yes : MSG.no);
  const onOff = (b) => (b ? MSG.on : MSG.off);

  // ---- Base64url and WebAuthn ----
  function b64u(buf) {
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(s) {
    const t = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
    return Uint8Array.from(t, (c) => c.charCodeAt(0));
  }
  function credJSON(c) {
    const r = c.response;
    const out = { id: c.id, rawId: b64u(c.rawId), type: c.type, response: { clientDataJSON: b64u(r.clientDataJSON) } };
    if (r.attestationObject) out.response.attestationObject = b64u(r.attestationObject);
    if (r.authenticatorData) out.response.authenticatorData = b64u(r.authenticatorData);
    if (r.signature) out.response.signature = b64u(r.signature);
    if (r.userHandle && r.userHandle.byteLength) out.response.userHandle = b64u(r.userHandle);
    const ext = typeof c.getClientExtensionResults === "function" ? c.getClientExtensionResults() : {};
    out.clientExtensionResults = ext && ext.credProps ? { credProps: { rk: !!ext.credProps.rk } } : {};
    return out;
  }
  const getOptions = (pk) => ({ ...pk, challenge: unb64u(pk.challenge), allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })) });
  const createOptions = (pk) => ({
    ...pk,
    challenge: unb64u(pk.challenge),
    user: { ...pk.user, id: unb64u(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })),
    extensions: { ...(pk.extensions || {}), credProps: true },
  });
  async function passkeyGet(pk) {
    try {
      return await navigator.credentials.get({ publicKey: getOptions(pk) });
    } catch (e) {
      throw passkeyError(e);
    }
  }
  async function passkeyCreate(pk) {
    try {
      return await navigator.credentials.create({ publicKey: createOptions(pk) });
    } catch (e) {
      throw passkeyError(e);
    }
  }
  // AC-2a 3.9 "The key record": after a key is registered, this tab navigates (top level, so the CSP's connect-src
  // stays 'self') to the IDE plugin's or Hub app's loopback page with the public record the console answered. The port
  // comes only from the app's own record=<port>.<nonce>, the record only from the console's answer.
  const RECORD = /^([0-9]{1,5})\.([A-Za-z0-9_-]{22})$/;
  function recordPort(v) {
    const m = RECORD.exec(String(v || ""));
    if (!m) return null;
    const port = Number(m[1]);
    return port >= 1 && port <= 65535 ? port : null;
  }
  function keyRecordGo(r) {
    const port = recordPort(S.record);
    const rec = r && typeof r.keyRecord === "string" ? r.keyRecord : "";
    if (!port || !/^[A-Za-z0-9_-]{1,8192}$/.test(rec)) return false;
    S.record = null;
    location.assign("http://127.0.0.1:" + port + "/admin-console/key-record?r=" + rec);
    return true;
  }
  function passkeyError(e) {
    const err = new Error(e && (e.name === "NotAllowedError" || e.name === "AbortError") ? MSG.passkeyClosed : (e && e.message) || MSG.passkeyClosed);
    err.passkey = true;
    return err;
  }

  // ---- State ----
  const S = {
    me: null, overview: null, ovAt: 0, settings: null, gen: 0, timer: 0, idleTimer: 0, lastAct: 0, warned: false, locked: false,
    bannerOk: false, open: new Set(), dlg: null, code: null, searchTimer: 0, searchGen: 0, auditBroken: false,
    // Fleet console (AC-2a): px the relay a product page reads through the proxy (5.4), relays the registry rows,
    // pick the relay chosen per product group, enroll the code screen (shown once), setup the 12.3 steps.
    px: null, relays: null, relaysAt: 0, pick: {}, enroll: null, setup: null, fromSetup: false,
    // The key record handshake (3.9): "<port>.<nonce>" from #join=...&record= or #record=, kept in memory only.
    record: null,
    // The relay's own console: its 5.7 fleet link, for the fleet.managed banner and the Lucid Admin Console panel.
    link: null,
  };
  let RUN = [];
  const reg = (fn) => {
    RUN.push(fn);
    return String(RUN.length - 1);
  };
  const fleet = () => !!(S.me && S.me.product === "fleet");
  // On a fleet console a product page speaks for the relay it shows (S.px); elsewhere the console's own product.
  const product = () => (S.px ? S.px.product : (S.me && S.me.product) || "spokes");
  const profile = () => (S.me && S.me.profile === "standard" ? "standard" : "high");
  const me = () => (S.me && S.me.user) || null;
  const myEmail = () => (me() ? me().email : "");
  // Rights are the session's (2.3): under High an admin or user manager signed in without an attested method has viewer rights.
  const rights = () => {
    const x = me();
    return x && x.state === "active" ? x.rights || "viewer" : null;
  };
  const isAdmin = () => rights() === "admin";
  const isManager = () => rights() === "admin" || rights() === "user-manager";
  const locked = () => !fleet() && !!(S.me && (S.me.sections || []).includes("security"));
  const licState = () => (S.px ? S.px.lic : S.overview && S.overview.license ? S.overview.license.state : null);
  const twoOn = () => !!(S.settings && S.settings.twoPerson === "on");
  const minPassword = () => (profile() === "standard" ? 12 : 15);
  // Product writes need the product license in valid or grace (2.4); security actions work in every state.
  const canWrite = () => isAdmin() && !locked() && (licState() === "valid" || licState() === "grace");
  const canSecure = () => isAdmin();

  // ---- API (4.1) ----
  class ApiError extends Error {
    constructor(status, code, message, data) {
      super(message);
      this.status = status;
      this.code = code;
      this.data = data;
    }
  }
  // The phase 1 routes a fleet console reaches through /console/api/fleet/relays/<id>/p/<path> (5.4); anything else
  // (sign-in, account, approvals, settings, the fleet routes) is the console's own.
  const PROXIED = /^(?:(?:spokes|meet)\/|(?:overview|search|license|license\/install|logs|logs\/export|audit|audit\/export|audit\/verify|audit\/restart|requests|requests\/new|requests\/cancel)(?:\?|$))/;
  // The relay a call goes to: an explicit opts.relay, else the product page's relay; never for opts.direct.
  function proxyRelay(path, o) {
    if (!fleet() || (o && o.direct) || !PROXIED.test(path)) return null;
    return (o && o.relay) || (S.px ? S.px.relay : null);
  }
  async function api(method, path, body, opts) {
    const o = opts || {};
    const rid = proxyRelay(path, o);
    if (rid) {
      // Every proxied write carries a fleet step-up (4.6) over that relay's nonce. Writes whose phase 1 row has no
      // step-up binding of its own are bound to the route's action ("requests/new" is requests.new) and their id.
      if (method === "POST" && !(body && body.stepup) && !o.noStepup) {
        const st = await fleetStepup({ action: path.split("?")[0].replace(/\//g, "."), target: body && body.id != null ? body.id : "-", params: body || {} }, [rid]);
        body = Object.assign({}, body, { stepup: st });
      }
      path = "fleet/relays/" + encodeURIComponent(rid) + "/p/" + path;
    }
    const headers = {};
    if (o.activity !== false) headers["X-Lucid-Activity"] = "1";
    const init = { method, credentials: "same-origin", cache: "no-store", headers };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-Lucid-Console"] = "1";
      init.body = JSON.stringify(body || {});
    }
    let r;
    try {
      r = await fetch("/console/api/" + path, init);
    } catch (e) {
      // On a fleet console the browser only ever talks to the console.
      throw new ApiError(0, "network", fleet() ? MSG.noAnswerConsole : MSG.noAnswer, null);
    }
    if (o.raw && r.ok) {
      if (o.activity !== false && me()) touch();
      return r;
    }
    let data = null;
    try {
      data = await r.json();
    } catch (e) {
      data = null;
    }
    if (!r.ok || !data || data.ok === false) {
      const code = (data && data.code) || "";
      const said = !fleet() ? fillText(MSG.httpError, { status: r.status })
        : rid ? fillText(MSG.httpErrorRelay, { name: relayName(rid), status: r.status }) : fillText(MSG.httpErrorConsole, { status: r.status });
      const err = new ApiError(r.status, code, (data && data.error) || said, data);
      if (!o.noRedirect && ((r.status === 401 && code !== "stepup-needed") || code === "origin-session")) toSignIn(err.message);
      throw err;
    }
    // Only a person's own action counts as activity (3.4); the lock screen counts from the last one.
    if (o.activity !== false && me()) touch();
    return data;
  }
  // A step-up (3.6) for this action, target and parameters, then the route with the same body plus "stepup". Under
  // Standard an account without a passkey or security key confirms with its authenticator app code (stepup.totp).
  async function stepup(action, target, params) {
    const b = await api("POST", "stepup/begin", { action, target: target == null || target === "" ? "-" : String(target), params });
    const pk = b.publicKey || {};
    if (b.totp && !(pk.allowCredentials || []).length) return { ceremony: b.ceremony, totp: await askCode() };
    const cred = await passkeyGet(pk);
    return { ceremony: b.ceremony, credential: credJSON(cred) };
  }
  async function post(path, body, bind, opts) {
    if (!bind) return api("POST", path, body, opts);
    const rid = proxyRelay(path, opts);
    // A proxied write: the fleet step-up with the phase 1 action and target (4.6), or the requester's assertion of a
    // two-admin action (4.7) when the dialog says another admin must approve.
    const st = rid ? await fleetStepup({ action: bind.action, target: bind.target, params: bind.params || body }, [rid], S.dlg && S.dlg.asks ? "request" : "stepup")
      : await stepup(bind.action, bind.target, bind.params || body);
    return api("POST", path, Object.assign({}, body, { stepup: st }), opts);
  }
  // The fleet step-up (4.6): the console gathers one nonce per relay and the authenticator signs the binding. A
  // passkey or security key only: TOTP never authorizes a relay write (the console answers fleet-webauthn).
  async function fleetStepup(bind, relays, kind) {
    const target = bind.target == null || bind.target === "" ? "-" : String(bind.target);
    const b = await api("POST", "fleet/stepup/begin", { action: bind.action, target, params: bind.params || {}, relays, kind: kind || "stepup" }, { direct: true });
    const cred = await passkeyGet(b.publicKey || {});
    return { ceremony: b.ceremony, credential: credJSON(cred) };
  }
  // A fleet write: the fleet step-up over the named relays, then the console's own route with "stepup".
  async function fleetPost(path, body, bind, relays, kind) {
    const st = await fleetStepup(Object.assign({ params: body }, bind), relays, kind);
    return api("POST", path, Object.assign({}, body, { stepup: st }), { direct: true });
  }
  async function download(path, body, bind, fallbackName) {
    const r = await post(path, body, bind, { raw: true });
    const blob = await r.blob();
    const cd = r.headers.get("Content-Disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    const name = clean(m ? m[1] : fallbackName).replace(/[\\/]/g, "_");
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function loadMe() {
    S.me = await api("GET", "me", null, { noRedirect: true });
    return S.me;
  }
  async function loadSettings() {
    try {
      S.settings = await api("GET", "settings", null, { activity: false, noRedirect: true });
    } catch (e) {
      S.settings = null;
    }
    return S.settings;
  }
  async function loadOverview(force) {
    if (!force && S.overview && Date.now() - S.ovAt < 30000) return S.overview;
    try {
      S.overview = await api("GET", "overview", null, { activity: false, direct: true });
      S.ovAt = Date.now();
    } catch (e) {
      /* the page still renders; banners wait for the next load */
    }
    return S.overview;
  }

  function say(text) {
    $("status").textContent = text ? clean(text) : "";
    if (text) $("alert").textContent = "";
  }
  function fail(e) {
    const msg = e && e.message ? e.message : String(e);
    $("alert").textContent = clean(msg);
    if (msg) $("status").textContent = "";
  }
  // A field the page refuses (7.6): the sentence next to the field, tied to it with aria-describedby, and focus on it.
  // The words go away when the field changes.
  function invalid(input, text) {
    const box = (input.closest && input.closest(".field, fieldset")) || input.parentElement;
    let note = box ? box.querySelector(".field-error") : null;
    if (box && !note) {
      note = el("span", { class: "field-error", id: uid("err") });
      box.append(note);
    }
    if (note) {
      note.textContent = text;
      const ids = (input.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
      if (!ids.includes(note.id)) input.setAttribute("aria-describedby", ids.concat([note.id]).join(" "));
      input.setAttribute("aria-invalid", "true");
      const clear = () => {
        note.textContent = "";
        input.removeAttribute("aria-invalid");
      };
      input.addEventListener("input", clear, { once: true });
      input.addEventListener("change", clear, { once: true });
    } else fail(text);
    input.focus();
  }
  // Enter in a single-line field runs the action of its form (D-8: there are no <form> elements).
  function onEnter(input, run) {
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.isComposing) return;
      ev.preventDefault();
      Promise.resolve().then(run).catch(fail);
    });
    return input;
  }
  function clearMessages() {
    $("status").textContent = "";
    $("alert").textContent = "";
  }

  // ---- Routing (7.2) ----
  function parseHash() {
    const h = location.hash || "";
    if (!h.startsWith("#/")) return { parts: ["overview"], q: new URLSearchParams() };
    const at = h.indexOf("?");
    const p = at >= 0 ? h.slice(2, at) : h.slice(2);
    const qs = at >= 0 ? h.slice(at + 1) : "";
    const parts = p.split("/").filter(Boolean);
    return { parts: parts.length ? parts : ["overview"], q: new URLSearchParams(qs) };
  }
  function go(hash) {
    if (location.hash === hash) render({ focus: true });
    else location.hash = hash;
  }
  const safeGo = (g) => (typeof g === "string" && /^#\/[A-Za-z0-9/_?=&.%:@+-]*$/.test(g) ? g : null);
  // The relay console's routes that console-level attention items still name, as fleet routes (query kept).
  const FLEET_ALIAS = {
    "#/licenses": "#/license", "#/approvals": "#/security/approvals", "#/requests": "#/security/requests", "#/admins/audit": "#/security/audit",
    "#/admins/settings/security": "#/settings/console", "#/admins/settings/email": "#/email", "#/admins/settings": "#/settings/console",
    "#/admins/sessions": "#/settings/console", "#/admins/account": "#/settings/account", "#/admins": "#/people", "#/admins/people": "#/people",
  };
  function fleetGo(g) {
    if (!fleet() || typeof g !== "string") return g;
    const at = g.indexOf("?");
    const path = at >= 0 ? g.slice(0, at) : g;
    return (FLEET_ALIAS[path] || path) + (at >= 0 ? g.slice(at) : "");
  }
  function pagesFor(group) {
    if (isAdmin()) return PAGES[group];
    return (ROLE_PAGES[rights()] || ROLE_PAGES.viewer)[group] || [];
  }
  // Whether this session may open a page (for card and attention links).
  function canOpen(href) {
    if (fleet()) {
      const f = /^#\/([a-z-]+)(?:\/([a-z0-9_-]+))?/.exec(href || "");
      if (!f) return false;
      const g = fleetGroups().find((x) => x.route === f[1]);
      if (!g) return false;
      if (!f[2] || /^r_/.test(f[2])) return true;
      return g.pages.some(([id]) => id === f[2]) || f[2] === "account";
    }
    const m = /^#\/([a-z]+)(?:\/([a-z-]+))?/.exec(href || "");
    if (!m) return false;
    if (m[1] === "overview") return true;
    if (m[1] === "license") return isAdmin() || pagesFor(product()).includes("license");
    if (m[1] === "approvals" || m[1] === "security") return isAdmin();
    if (m[1] === "spokes" && m[2] === "nodes") return pagesFor("spokes").includes("hubs");
    if (PAGES[m[1]]) return pagesFor(m[1]).includes(m[2]);
    return false;
  }

  // ---- Header and navigation ----
  function setHeader() {
    const info = S.me;
    const signed = !!me();
    const host = info && info.relay ? info.relay.host : location.host;
    document.title = fillText(W["title.document"], { host });
    $("hdr-host").textContent = clean(host || "");
    const chip = $("hdr-product");
    const isFleet = fleet();
    // 12.4: a fleet console's product chip reads "All relays" with the count beside it.
    chip.textContent = info ? (isFleet ? FW["chip.fleet"] : W["product." + (info.product || "spokes")]) : "";
    chip.hidden = !info;
    const count = $("hdr-count");
    const total = isFleet && S.overview && S.overview.fleet && S.overview.fleet.relays ? S.overview.fleet.relays.total : null;
    count.textContent = signed && total != null ? fillText(FW["chip.count"], { n: total }) : "";
    count.hidden = !(signed && total != null);
    const prof = $("hdr-profile");
    prof.textContent = info ? (profile() === "standard" ? W["profile.chip.standard"] : W["profile.chip"]) : "";
    prof.hidden = !info;
    // A fleet console has no cross-relay search (5.3); each relay's search is a proxied people read.
    $("hdr-search").hidden = !signed || isFleet;
    $("search").setAttribute("placeholder", product() === "spokes" ? W["search.placeholder.spokes"] : W["search.placeholder"]);
    $("account-wrap").hidden = !signed;
    $("account-email").textContent = signed ? clean(myEmail()) : "";
    if (signed) $("account-btn").setAttribute("aria-label", W["account.menu"][0] + ": " + clean(myEmail()));
    else $("account-btn").removeAttribute("aria-label");
    $("hdr-approvals").hidden = !(signed && isAdmin() && (isFleet || (info.sections || []).includes("approvals")));
    $("hdr-approvals").setAttribute("href", isFleet ? "#/security/approvals" : "#/approvals");
    $("menu-btn").hidden = !signed;
    $("nav").hidden = !signed;
    $("shell").classList.toggle("bare", !signed);
    $("footer").textContent = isFleet ? MSG.footerFleet : W.footer;
    buildAccountMenu();
    buildThemeMenu();
  }
  function setApprovalsBadge(n) {
    const b = $("hdr-approvals-n");
    b.textContent = n ? String(n) : "";
    b.hidden = !n;
    $("hdr-approvals").setAttribute("aria-label", n ? W["nav.approvals"] + ": " + n : W["nav.approvals"]);
  }
  // The fleet nav groups and pages this session may open (12.4 role views).
  function fleetGroups() {
    const allow = isAdmin() ? null : FROLE[rights()] || FROLE.viewer;
    // A product group with no relay of that product shows its Relays page only (12.4).
    const none = (route) => (route === "spokes" || route === "meet") && Array.isArray(S.relays) && !S.relays.some((x) => x.product === route);
    return FNAV.filter((g) => !allow || allow[g.route]).map((g) => Object.assign({}, g, {
      pages: g.pages.filter(([id]) => (!allow || allow[g.route].includes(id)) && (!none(g.route) || id === "relays")),
    }));
  }
  const fleetHref = (group, page) => (group === "relays" && page === "list" ? "#/relays" : page ? "#/" + group + "/" + page : "#/" + group);
  function fleetNavTree() {
    const r = parseHash();
    const route = r.parts.join("/");
    const ul = el("ul", { class: "navlist" });
    const cur = (href) => {
      const path = href.slice(2);
      return route === path || (path === "relays" && /^relays\/r_/.test(route));
    };
    for (const g of fleetGroups()) {
      if (!g.pages.length) {
        ul.append(el("li", null, el("a", { href: fleetHref(g.route), "aria-current": cur(fleetHref(g.route)) ? "page" : null }, FW[g.id])));
        continue;
      }
      if (route === g.route || route.startsWith(g.route + "/")) S.open.add(g.route);
      const open = S.open.has(g.route);
      const sub = el("ul", { id: uid("grp"), hidden: !open });
      for (const [id, label] of g.pages) {
        const href = fleetHref(g.route, id);
        sub.append(el("li", null, el("a", { href, "aria-current": cur(href) ? "page" : null }, label)));
      }
      ul.append(el("li", null, el("button", { type: "button", class: "group-btn", "data-act": "nav-group", "data-group": g.route, "aria-expanded": open ? "true" : "false", "aria-controls": sub.id }, FW[g.id]), sub));
    }
    return ul;
  }
  function navTree() {
    if (fleet()) return fleetNavTree();
    const route = parseHash().parts.join("/");
    const ul = el("ul", { class: "navlist" });
    const link = (href, label, extra) => {
      const path = href.slice(2);
      const cur = route === path || (path === "license" && route.endsWith("/license") && locked());
      return el("a", { href, "aria-current": cur ? "page" : null }, label, extra || null);
    };
    for (const sec of S.me.sections || ["overview"]) {
      if (sec === "overview") ul.append(el("li", null, link("#/overview", W["nav.overview"])));
      else if (sec === "security") {
        if (isAdmin()) ul.append(el("li", null, link("#/security", W["nav.security"])));
      } else if (sec === "approvals") {
        if (isAdmin()) ul.append(el("li", null, link("#/approvals", W["nav.approvals"])));
      } else if (sec === "spokes" || sec === "meet") {
        if (locked()) {
          ul.append(el("li", null, link("#/license", W["nav." + sec]), el("span", { class: "locked-note" }, W["nav.locked"])));
        } else if (pagesFor(sec).length) ul.append(group(sec, W["nav." + sec], route));
      } else if (sec === "admins") ul.append(group("admins", W["nav.admins"], route));
    }
    function group(id, label, current) {
      const inside = current.startsWith(id + "/");
      if (inside) S.open.add(id);
      const open = S.open.has(id);
      const sub = el("ul", { id: uid("grp"), hidden: !open });
      for (const p of pagesFor(id)) sub.append(el("li", null, link("#/" + id + "/" + p, PAGE_LABEL[id][p])));
      const b = el("button", { type: "button", class: "group-btn", "data-act": "nav-group", "data-group": id, "aria-expanded": open ? "true" : "false", "aria-controls": sub.id }, label);
      return el("li", null, b, sub);
    }
    return ul;
  }
  function renderNav() {
    $("nav").replaceChildren(navTree());
    if ($("nav-sheet").open) $("nav-sheet-nav").replaceChildren(navTree());
  }

  // ---- Menus (menu button pattern: arrows, Home, End, Escape) ----
  function menuItems(menu) {
    return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')];
  }
  function openMenu(b, focusLast) {
    closeMenus();
    const menu = $(b.getAttribute("aria-controls"));
    if (!menu) return;
    menu.hidden = false;
    b.setAttribute("aria-expanded", "true");
    const items = menuItems(menu);
    const checked = items.find((i) => i.getAttribute("aria-checked") === "true");
    const first = focusLast ? items[items.length - 1] : checked || items[0];
    if (first) first.focus();
  }
  function closeMenus(except) {
    for (const b of document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]')) {
      if (b === except) continue;
      b.setAttribute("aria-expanded", "false");
      const m = $(b.getAttribute("aria-controls"));
      if (m) m.hidden = true;
    }
  }
  function menuKeys(ev) {
    const menu = ev.target.closest('[role="menu"]');
    if (!menu) return false;
    const items = menuItems(menu);
    const i = items.indexOf(document.activeElement);
    const opener = document.querySelector('[aria-controls="' + menu.id + '"]');
    const move = (j) => {
      ev.preventDefault();
      items[(j + items.length) % items.length].focus();
    };
    if (ev.key === "ArrowDown") move(i + 1);
    else if (ev.key === "ArrowUp") move(i - 1);
    else if (ev.key === "Home") move(0);
    else if (ev.key === "End") move(items.length - 1);
    else if (ev.key === "Escape") {
      ev.preventDefault();
      closeMenus();
      if (opener) opener.focus();
    } else if (ev.key === "Tab") closeMenus();
    else return false;
    return true;
  }
  function actionMenu(name, items) {
    const list = items.filter(Boolean);
    if (!list.length) return null;
    const id = uid("menu");
    const label = fillText(MSG.moreFor, { name });
    const b = el("button", { type: "button", "data-act": "menu", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": id, "aria-label": label }, MSG.more);
    const ul = el("ul", { class: "menu", role: "menu", id, "aria-label": label, hidden: true });
    for (const it of list) {
      ul.append(el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", tabindex: "-1", "data-act": "run", "data-k": reg(it.run) }, it.label)));
    }
    return el("div", { class: "menu-wrap" }, b, ul);
  }
  function buildAccountMenu() {
    const m = $("account-menu");
    const [account, helpWord, out] = W["account.menu"];
    m.replaceChildren(
      el("li", { role: "none" }, el("a", { role: "menuitem", tabindex: "-1", href: fleet() ? "#/settings/account" : "#/admins/account" }, account)),
      el("li", { role: "none" }, el("a", { role: "menuitem", tabindex: "-1", href: "#/help" }, helpWord)),
      el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", tabindex: "-1", "data-act": "signout" }, out)),
    );
  }
  function buildThemeMenu() {
    const m = $("theme-menu");
    const T = window.LucidConsoleTheme;
    const picked = T ? T.stored() || "lucid-dark" : "lucid-dark";
    const item = (id, label, blurb) => el("button", {
      type: "button", role: "menuitemradio", tabindex: "-1", "data-act": "theme", "data-id": id, "aria-checked": picked === id ? "true" : "false",
    }, el("span", null, label, blurb ? el("span", { class: "vh" }, ". " + blurb) : null));
    const groups = [[W["theme.groups"][0], THEMES.filter((t) => !t.special)], [W["theme.groups"][1], THEMES.filter((t) => t.special)]];
    const kids = [el("li", { role: "none" }, item("system", W["theme.system"]))];
    for (const [label, list] of groups) {
      const gid = uid("tg");
      kids.push(el("li", { role: "none", class: "group" },
        el("span", { id: gid, class: "group", "aria-hidden": "true" }, label),
        el("div", { role: "group", "aria-labelledby": gid }, list.map((t) => item(t.id, t.label, t.blurb)))));
    }
    m.replaceChildren(...kids);
  }

  // ---- Page scaffolding ----
  function head(title, ...tools) {
    return el("div", { class: "page-head" }, el("h2", { tabindex: "-1", id: "page-title" }, title), ...tools);
  }
  function help(...keys) {
    return el("details", { class: "help" }, el("summary", null, MSG.whatIsThis), keys.map((k) => el("p", null, W[k])));
  }
  function panel(title, ...kids) {
    return el("section", { class: "panel" }, title ? el("h3", null, title) : null, ...kids);
  }
  function section(id, title, ...kids) {
    return el("section", { class: "panel", "aria-labelledby": id }, el("h3", { id, tabindex: "-1" }, title), ...kids);
  }
  function sub(title, ...kids) {
    return el("div", { class: "subpanel" }, el("h4", null, title), ...kids);
  }
  function pairs(list) {
    const dl = el("dl", { class: "pairs" });
    for (const [k, v] of list) {
      if (v === undefined) continue;
      dl.append(el("dt", null, k), el("dd", null, v instanceof Node ? v : u(v == null ? "" : v)));
    }
    return dl;
  }
  function stateWord(s) {
    return String(s || "").replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
  function stChip(state, tone) {
    return el("span", { class: "st st-" + (tone || "none") }, stateWord(state));
  }
  function btn(label, run, cls, attrs) {
    return el("button", Object.assign({ type: "button", class: cls || null, "data-act": "run", "data-k": reg(run) }, attrs || {}), label);
  }
  function emptyLine(text) {
    return el("p", { class: "empty" }, text);
  }
  // A page that could not load keeps its own title and says why inside the page (D-1, D-10).
  function pageError(e) {
    return panel(null, el("p", { class: "dlg-error", role: "alert" }, clean(e && e.message ? e.message : String(e))));
  }
  function routeTitle(r) {
    const [a, b] = r.parts;
    if (a === "help") return MSG.help;
    if (fleet()) {
      const g = FNAV.find((x) => x.route === a);
      if (!g) return FW["nav.overview"];
      const p = g.pages.find((x) => x[0] === (a === "relays" && !b ? "list" : b));
      return p ? p[1] : FW[g.id];
    }
    if (PAGE_LABEL[a] && PAGE_LABEL[a][b]) return PAGE_LABEL[a][b];
    if (a === "security") return W["nav.security"];
    if (a === "approvals") return W["nav.approvals"];
    if (a === "license") return PAGE_LABEL[product()].license;
    return W["nav.overview"];
  }
  function banner(kind, tag, ...kids) {
    return el("div", { class: "banner " + kind, role: "status" }, el("span", { class: "tag" }, tag), el("span", null, ...kids));
  }
  // The service view's `why` code (4.7, R42-1) as its 8.1 license.why words.
  // `invalid` (4.2.1) carries the verifier's words: the banner's `verifier words` argument or the license view's `problem`.
  const WHY_CODES = W["license.why.codes"];
  const whyWords = (why, verifier) => (WHY_CODES.includes(why) ? fillText(W["license.why"][WHY_CODES.indexOf(why)], { "verifier words": verifier || "" }) : why || "");
  // The license banners of 7.2 (R42-1, R42-3, R42-4), with "Install a license" for admins.
  const LICENSE_BANNERS = ["banner.expiring", "banner.grace", "banner.expired", "banner.license-stopped", "banner.upgrade-period"];
  const installLink = () => (isAdmin() ? [" ", el("a", { href: "#/license" }, W["license.install"])] : []);
  // The license page's own banner from the license view's `service`, shown only when the relay's overview banners
  // do not already carry a license banner.
  function serviceBanner(view) {
    const svc = view && view.service;
    if (!svc || ((S.overview && S.overview.banners) || []).some((b) => b && LICENSE_BANNERS.includes(b.id))) return null;
    const lic = view.license;
    const args = argsOf({ date: lic && lic.exp ? lic.exp : null, "date and time": svc.stopsAt, why: svc.why, problem: view.problem });
    if (svc.state === "stopped") return banner("bad", MSG.sev.bad, fill(W["banner.license-stopped"], args), ...installLink());
    if (svc.state === "grace") return banner("warn", MSG.sev.warn, fill(W["banner.grace"], args), ...installLink());
    if (svc.state === "upgrade-period") return banner("warn", MSG.sev.warn, fill(W["banner.upgrade-period"], args), ...installLink());
    return null;
  }
  // Attention and banner arguments: dates and times formatted, n defaulting to days, `why` as its words.
  function argsOf(args) {
    const out = { product: PRODUCT_NAME[product()] };
    for (const [k, v] of Object.entries(args || {})) {
      if (k === "date" && isTime(v)) out[k] = dayAny(v);
      else if ((k === "time" || k === "date and time") && isTime(v)) out[k] = whenAny(v);
      else if (k === "why") out[k] = whyWords(v, args["verifier words"] || args.problem);
      else if (v != null) out[k] = v;
    }
    if (out.n == null && out.days != null) out.n = out.days;
    return out;
  }
  // The 7.2 banners under the header on every page: the relay's (overview "banners") and the session's reduced rights.
  const BANNER_TONE = { "banner.seats-over": "bad", "banner.license-stopped": "bad", "banner.expired": "bad", "breakglass.gate": "bad", "attention.clock-uncertain": "bad" };
  function bannerNodes() {
    const out = [];
    const why = me() ? me().rightsWhy : null;
    if (why === "not-attested") out.push(banner("warn", MSG.sev.warn, W["high.viewer-rights"]));
    if (why === "not-device-anchored") out.push(banner("warn", MSG.sev.warn, W["meet.viewer-rights"]));
    // AC-2a 2.1: an enrolled relay's own console says which Lucid Admin Console manages it.
    const managedBy = S.link && S.link.enrolled && S.link.console ? S.link.console.origin : null;
    if (!fleet() && managedBy) out.push(el("div", { class: "banner", role: "status" }, el("span", null, fill(FW["fleet.managed"], { origin: managedBy }))));
    for (const b of (S.overview && S.overview.banners) || []) {
      if (!b || b.id === "high.viewer-rights" || b.id === "meet.viewer-rights") continue;
      if (b.id === "fleet.managed" && managedBy) continue;
      const tpl = W[b.id] || FW[b.id];
      if (typeof tpl !== "string") continue;
      const tone = BANNER_TONE[b.id] || "warn";
      const extra = LICENSE_BANNERS.includes(b.id) ? installLink() : [];
      if (b.id === "banner.seats-over" && isAdmin()) extra.push(" ", btn(W["banner.seats-over.button"], () => go("#/meet/seats?request=1")));
      if (b.id === "attention.clock-uncertain" && isAdmin()) extra.push(" ", btn(W["clock.title.button"], () => confirmTime(null)));
      out.push(banner(tone, MSG.sev[tone], fill(tpl, argsOf(b.args)), ...extra));
    }
    return out;
  }

  // ---- Form fields (7.6: labels, paste allowed, password managers welcome) ----
  function textField(label, attrs, note) {
    const id = uid("f");
    const input = el("input", Object.assign({ id, type: "text", spellcheck: "false", autocomplete: "off" }, attrs || {}));
    const nid = note ? id + "-note" : null;
    if (nid) input.setAttribute("aria-describedby", nid);
    return { input, box: el("div", { class: "field" }, el("label", { for: id }, label), input, note ? el("span", { class: "note", id: nid }, note) : null) };
  }
  const currentPassword = (label) => textField(label, { type: "password", autocomplete: "current-password", maxlength: "1024" });
  const newPassword = (label, min) => textField(label, { type: "password", autocomplete: "new-password", minlength: String(min), maxlength: "1024" });
  const codeField = (label) => textField(label, { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}" });

  // ---- Tables (7.2): caption, th scope col, sortable header buttons with aria-sort, filters, count, Load more ----
  const PAGE_SIZE = 25;
  // A filter row, folded under "Filters" at phone width (7.2).
  function filterFold(kids) {
    const narrow = window.matchMedia && window.matchMedia("(max-width: 600px)").matches;
    return el("details", { class: "filters-fold", open: narrow ? null : true }, el("summary", null, MSG.filters), el("div", { class: "filters" }, kids));
  }
  function dataTable(o) {
    const st = { q: o.q || "", chip: o.chip || "", sel: o.sel || "", more: [], sort: o.sortKey || null, dir: o.sortDir || 1, shown: PAGE_SIZE };
    const root = el("div", { class: "datatable" });
    const out = el("div");
    let input = null, select = null;
    // More select filters (o.selects), each { label, options, of, value }: the fleet relay list filters by product,
    // health and site together (8.2).
    const extra = (o.selects || []).map((f, i) => {
      const id = uid("sel");
      const s = el("select", { id }, el("option", { value: "" }, MSG.all), f.options.map(([v, w]) => el("option", { value: v }, clean(w))));
      st.more[i] = f.value || "";
      s.value = st.more[i];
      s.addEventListener("change", () => {
        st.more[i] = s.value;
        st.shown = PAGE_SIZE;
        draw();
      });
      return { f, s, box: el("label", { for: id }, f.label, s) };
    });
    const chipBtns = [];
    const filterKids = [];
    if (o.text) {
      const id = uid("filter");
      input = el("input", { id, type: "search", autocomplete: "off", maxlength: "100" });
      input.value = st.q;
      input.addEventListener("input", () => {
        st.q = input.value;
        st.shown = PAGE_SIZE;
        draw();
      });
      filterKids.push(el("label", { for: id }, MSG.filterText, input));
    }
    if (o.chips) {
      const g = el("div", { class: "chips", role: "group", "aria-label": o.chips.label });
      for (const [value, word] of o.chips.options) {
        const b = btn(word, () => {
          st.chip = st.chip === value ? "" : value;
          st.shown = PAGE_SIZE;
          syncChips();
          draw();
        }, null, { "aria-pressed": st.chip === value ? "true" : "false", "data-v": value });
        chipBtns.push(b);
        g.append(b);
      }
      filterKids.push(el("div", { class: "chip-filter" }, el("span", { class: "note", "aria-hidden": "true" }, o.chips.label), g));
    }
    if (o.select) {
      const id = uid("sel");
      select = el("select", { id }, el("option", { value: "" }, MSG.all), o.select.options.map(([v, w]) => el("option", { value: v }, clean(w))));
      select.value = st.sel;
      select.addEventListener("change", () => {
        st.sel = select.value;
        st.shown = PAGE_SIZE;
        draw();
      });
      filterKids.push(el("label", { for: id }, o.select.label, select));
    }
    for (const x of extra) filterKids.push(x.box);
    function syncChips() {
      for (const b of chipBtns) b.setAttribute("aria-pressed", b.getAttribute("data-v") === st.chip ? "true" : "false");
    }
    if (filterKids.length) root.append(filterFold(filterKids));
    root.append(out);
    const active = () => !!(st.q || st.chip || st.sel || st.more.some(Boolean));
    function rows() {
      const q = st.q.trim().toLowerCase();
      let list = o.rows.filter((r) => (!q || (o.text ? o.text(r) : "").toLowerCase().includes(q))
        && (!st.chip || (o.chips && o.chips.of(r) === st.chip))
        && (!st.sel || (o.select && o.select.of(r) === st.sel))
        && extra.every((x, i) => !st.more[i] || x.f.of(r) === st.more[i]));
      const col = o.cols.find((c) => c.key === st.sort);
      if (col) {
        const key = col.sort || ((r) => r[col.key]);
        list = list.slice().sort((a, b) => {
          const x = key(a), y = key(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * st.dir;
        });
      }
      return list;
    }
    function cellOf(c, r) {
      const v = c.cell ? c.cell(r) : r[c.key];
      return v instanceof Node ? v : u(v == null ? "" : v);
    }
    function draw(focusSort) {
      if (!o.rows.length) {
        out.replaceChildren(emptyLine(o.empty));
        return;
      }
      const list = rows();
      if (!list.length) {
        out.replaceChildren(el("p", { class: "empty" }, W["empty.filtered"], " ", btn(W["empty.filtered.button"], () => {
          st.q = st.chip = st.sel = "";
          st.more = st.more.map(() => "");
          for (const x of extra) x.s.value = "";
          if (input) input.value = "";
          if (select) select.value = "";
          syncChips();
          draw();
          if (input) input.focus();
        }, "link")));
        return;
      }
      const vis = list.slice(0, st.shown);
      const table = el("table", null, el("caption", null, o.caption));
      const tr = el("tr");
      for (const c of o.cols) {
        const sorted = st.sort === c.key;
        const th = el("th", { scope: "col", "aria-sort": c.sortable === false ? null : sorted ? (st.dir > 0 ? "ascending" : "descending") : "none" });
        if (c.sortable === false) th.append(c.label);
        else th.append(btn(c.label, () => {
          st.dir = st.sort === c.key ? -st.dir : 1;
          st.sort = c.key;
          draw(c.key);
        }, "sort", { "data-sort": c.key }));
        tr.append(th);
      }
      if (o.actions) tr.append(el("th", { scope: "col" }, el("span", { class: "vh" }, MSG.more)));
      const tbody = el("tbody");
      const stack = el("div", { class: "stack" });
      for (const r of vis) {
        const row = el("tr");
        for (const c of o.cols) row.append(el("td", null, cellOf(c, r)));
        const name = o.name ? o.name(r) : "";
        if (o.actions) row.append(el("td", { class: "actions" }, actionMenu(name, o.actions(r))));
        tbody.append(row);
        const dl = el("dl");
        for (const c of o.cols) dl.append(el("dt", null, c.label), el("dd", null, cellOf(c, r)));
        stack.append(el("section", null, el("h4", null, u(name)), dl, o.actions ? actionMenu(name, o.actions(r)) : null));
      }
      table.append(el("thead", null, tr), tbody);
      const total = active() ? list.length : o.total != null ? Math.max(o.total, list.length) : list.length;
      const kids = [el("p", { class: "countline" }, fillText(MSG.showing, { n: vis.length, total })), el("div", { class: "table-wrap" }, table), stack];
      if (vis.length < list.length) {
        kids.push(btn(MSG.loadMore, () => {
          st.shown += PAGE_SIZE;
          draw("@more");
        }, "more", { "data-more": "1" }));
      } else if (o.more && !active()) {
        kids.push(btn(MSG.loadMore, async () => {
          try {
            const added = await o.more();
            if (added && added.length) {
              o.rows = o.rows.concat(added);
              st.shown += PAGE_SIZE;
            } else o.more = null;
            draw("@more");
          } catch (e) {
            fail(e);
          }
        }, "more", { "data-more": "1" }));
      }
      out.replaceChildren(...kids);
      if (focusSort === "@more") {
        const m = out.querySelector('[data-more="1"]');
        const line = out.querySelector(".countline");
        if (!m && line) line.setAttribute("tabindex", "-1");
        (m || line).focus();
      } else if (focusSort) {
        const b = [...out.querySelectorAll("[data-sort]")].find((x) => x.getAttribute("data-sort") === focusSort);
        if (b) b.focus();
      }
    }
    draw();
    return root;
  }

  // ---- Dialogs (7.5): showModal, focus on the heading, Escape or Cancel close with no change ----
  // o.two (a boolean or a function of the field values): a second-admin action of section 5. With two-person control on
  // it shows dialog.second and the "Ask for approval" button; off, dialog.single and the button that acts at once
  // (8.2, R3-L3). o.always: two admins in either case (turning two-person control off).
  function confirmDialog(o) {
    const d = $("confirm");
    if (d.open) return Promise.resolve(null);
    const vals = Object.assign({}, o.vals || {});
    const getters = {};
    const fieldsBox = $("confirm-fields");
    fieldsBox.replaceChildren();
    // A field with `when` shows only while when(values) holds (the Invite dialog's fields follow its Kind, D-12).
    const shown = [];
    for (const f of o.fields || []) {
      const box = field(f, getters, () => refresh());
      if (f.when) shown.push([f, box]);
      fieldsBox.append(box);
    }
    const goBtn = $("confirm-go");
    let asksNow = false;
    function refresh() {
      const cur = values();
      for (const [f, box] of shown) box.hidden = !f.when(cur);
      const spec = o.specFor ? o.specFor(cur) : o.spec || D[o.dlgFor ? o.dlgFor(cur) : o.dlg];
      const v = o.vals2 ? Object.assign({}, vals, o.vals2(cur)) : vals;
      $("confirm-title").replaceChildren(fill(spec.title, v));
      const lines = o.body ? o.body(v, cur) : spec.body.slice(0, 1).map((b) => fill(b, v));
      $("confirm-body").replaceChildren(...lines.filter(Boolean).map((l) => (l instanceof Node && l.nodeName === "P" ? l : el("p", null, l))), ...(o.extra ? o.extra(v, cur) : []));
      const two = typeof o.two === "function" ? !!o.two(cur) : !!o.two;
      const asks = two && (o.always || twoOn());
      const line = two ? (asks ? W["dialog.second"] : W["dialog.single"]) : "";
      $("confirm-second").textContent = line;
      $("confirm-second").hidden = !line;
      const list = spec.button;
      const label = asks ? list[list.length - 1] : spec.single || list[0];
      goBtn.replaceChildren(fill(label, v));
      goBtn.className = o.danger && !asks ? "danger" : "primary";
      asksNow = asks;
      if (S.dlg) S.dlg.asks = asks;
    }
    function values() {
      const out = {};
      for (const [k, g] of Object.entries(getters)) out[k] = g();
      return out;
    }
    const hasTarget = o.id != null && o.id !== "";
    $("confirm-target").hidden = !hasTarget;
    $("confirm-name").textContent = clean(o.name || "");
    $("confirm-name").parentElement.hidden = !o.name;
    $("confirm-id-label").textContent = W["dialog.id"];
    $("confirm-id").textContent = clean(o.id == null ? "" : o.id);
    const params = $("confirm-params");
    params.replaceChildren();
    // AC-2a 13.2: a change on relays lists the relays it reaches (a proxied page's relay, or o.reaches).
    const reaches = o.reaches || (fleet() && S.px ? [S.px.name] : null);
    const plist = (o.params || []).concat(reaches && reaches.length ? [[FMSG.cols.count, reaches.join(", ")]] : []);
    for (const [k, v] of plist) params.append(el("dt", null, k), el("dd", null, v instanceof Node ? v : u(v == null ? "" : v)));
    params.hidden = !plist.length;
    $("confirm-error").textContent = "";
    refresh();
    const opener = o.opener || document.activeElement;
    closeMenus();
    d.showModal();
    $("confirm-title").focus();
    return new Promise((resolve) => {
      S.dlg = { o, resolve, opener, values, busy: false, asks: asksNow };
    });
  }
  function field(f, getters, changed) {
    const id = uid("fld");
    if (f.kind === "reason") {
      const ta = el("textarea", { id, maxlength: "500", required: true, "aria-describedby": id + "-n" });
      const n = el("span", { class: "count-note", id: id + "-n" }, fillText(MSG.reasonCount, { n: 0 }));
      ta.addEventListener("input", () => {
        n.textContent = fillText(MSG.reasonCount, { n: [...ta.value].length });
      });
      getters[f.key || "reason"] = () => ta.value.trim();
      return el("div", { class: "field" }, el("label", { for: id }, f.label || MSG.reason), ta, n);
    }
    if (f.kind === "select") {
      const s = el("select", { id }, f.options.map(([v, w]) => el("option", { value: v }, clean(w))));
      if (f.value != null) s.value = f.value;
      s.addEventListener("change", changed);
      getters[f.key] = () => s.value;
      return el("div", { class: "field" }, el("label", { for: id }, f.label), s, f.note ? el("span", { class: "count-note" }, f.note) : null);
    }
    if (f.kind === "checks") {
      // A pick of several from a list (f.options [value, words]); the value is the list of picked values.
      const boxes = f.options.map(([v, w]) => {
        const cid = uid("chk");
        const c = el("input", { id: cid, type: "checkbox", value: v, checked: (f.value || []).includes(v) ? true : null });
        c.addEventListener("change", changed);
        return { c, v, label: el("label", { class: "inline", for: cid }, c, clean(w)) };
      });
      getters[f.key] = () => boxes.filter((b) => b.c.checked).map((b) => b.v);
      return el("fieldset", { class: "choice" }, el("legend", null, f.label), boxes.length ? boxes.map((b) => b.label) : el("span", { class: "count-note" }, MSG.noneYet),
        f.note ? el("span", { class: "count-note" }, f.note) : null);
    }
    if (f.kind === "password") {
      // Passwords are never trimmed; the browser's password manager may fill or save them.
      const p = f.current ? textField(f.label, { type: "password", autocomplete: "current-password", maxlength: "1024" }) : textField(f.label, { type: "password", autocomplete: "new-password", minlength: String(f.min || minPassword()), maxlength: "1024" });
      p.input.addEventListener("input", changed);
      getters[f.key] = () => p.input.value;
      return p.box;
    }
    const inp = el(f.kind === "textarea" ? "textarea" : "input", {
      id, type: f.kind === "textarea" ? null : f.type || "text", min: f.min, max: f.max, maxlength: f.maxlength, inputmode: f.inputmode,
      autocomplete: "off", spellcheck: "false", required: f.required ? true : null,
    });
    if (f.value != null) inp.value = String(f.value);
    inp.addEventListener("input", changed);
    getters[f.key] = () => (f.type === "number" ? Number(inp.value) : inp.value.trim());
    return el("div", { class: "field" }, el("label", { for: id }, f.label), inp, f.note ? el("span", { class: "count-note" }, f.note) : null);
  }
  async function dialogGo() {
    const s = S.dlg;
    if (!s || s.busy) return;
    const vals = s.values();
    const err = $("confirm-error");
    for (const f of s.o.fields || []) {
      if (f.kind === "reason") {
        const len = [...(vals[f.key || "reason"] || "")].length;
        if (len < 1 || len > 500) {
          err.textContent = MSG.reasonNeeded;
          return;
        }
      }
    }
    if (s.o.check) {
      const problem = s.o.check(vals);
      if (problem) {
        err.textContent = clean(problem);
        return;
      }
    }
    s.busy = true;
    err.textContent = "";
    const buttons = [...$("confirm").querySelectorAll(".dlg-actions button")];
    for (const b of buttons) b.disabled = true;
    try {
      const r = await s.o.run(vals);
      s.result = r;
      s.busy = false;
      $("confirm").close();
      afterAction(s.o.plain ? {} : r, s.o.done, r);
    } catch (e) {
      // AC-2a 4.2: a relay with confirm-here holds the change for its operator (202 fleet-confirm); the page says so.
      if (e && e.code === "fleet-confirm") {
        s.busy = false;
        $("confirm").close();
        say(fillText(FW["fleet.waiting-operator"], { id: (e.data && (e.data.id || e.data.confirm)) || "" }));
        render({ keepMessages: true });
        return;
      }
      err.textContent = clean(e && e.message ? e.message : String(e));
    } finally {
      s.busy = false;
      for (const b of buttons) b.disabled = false;
    }
  }
  function afterAction(r, done, raw) {
    if (r && r.approval) say(W["dialog.sent"]);
    else if (r && r.request) say(MSG.requestSent);
    else say(MSG.done);
    if (done) done(raw);
    else render({ keepMessages: true });
  }
  function dialogClosed() {
    const s = S.dlg;
    if (!s) return;
    S.dlg = null;
    // Typed values (credential material among them) leave the page with the dialog.
    $("confirm-fields").replaceChildren();
    if (s.opener && document.contains(s.opener)) s.opener.focus();
    else {
      const h = $("page-title");
      if (h) h.focus();
    }
    s.resolve(s.result || null);
  }
  // The TOTP step-up field (7.5, stepup.totp): a small modal over the confirmation, after the person confirmed.
  function askCode() {
    const d = $("code-dlg");
    $("code-title").textContent = MSG.confirm;
    $("code-body").textContent = W["stepup.totp"];
    $("code-label").textContent = W["stepup.totp.field"];
    $("code-go").textContent = MSG.confirm;
    $("code-error").textContent = "";
    $("code-input").value = "";
    d.showModal();
    $("code-input").focus();
    return new Promise((resolve, reject) => {
      S.code = { resolve, reject, value: null };
    });
  }
  function codeGo() {
    const v = $("code-input").value.trim();
    if (!/^[0-9]{6}$/.test(v)) {
      $("code-error").textContent = MSG.codeNeeded;
      return;
    }
    if (S.code) S.code.value = v;
    $("code-dlg").close();
  }
  function codeClosed() {
    const c = S.code;
    S.code = null;
    $("code-input").value = "";
    if (!c) return;
    if (c.value) c.resolve(c.value);
    else c.reject(new Error(MSG.codeClosed));
  }
  function linkPanel(link, expires, mailedTo) {
    return panel(MSG.shownOnce, el("p", null, MSG.linkOnce), mailedTo ? el("p", null, fill(MSG.linkMailed, { email: mailedTo })) : null,
      code(link), " ", copyButton(link), expires ? el("p", { class: "note" }, "Expires " + when(expires)) : null);
  }
  function copyButton(text, label) {
    return btn(label || MSG.copy, async () => {
      try {
        await navigator.clipboard.writeText(text);
        say(MSG.copied);
      } catch (e) {
        fail(e);
      }
    });
  }

  // ---- Sign-in, join, reset and lock screens (7.8) ----
  function gateTitle(text) {
    return el("h2", { tabindex: "-1", id: "page-title" }, text);
  }
  function showGate(...kids) {
    $("nav").replaceChildren();
    $("banner").replaceChildren();
    $("view").replaceChildren(el("div", { class: "gate" }, el("section", { class: "panel" }, ...kids)));
    const h = $("page-title");
    if (h) h.focus();
  }
  function toSignIn(message) {
    if (S.me) S.me.user = null;
    clearInterval(S.timer);
    clearInterval(S.idleTimer);
    hideWarn();
    S.settings = null;
    S.overview = null;
    if (S.dlg && $("confirm").open) $("confirm").close();
    if ($("code-dlg").open) $("code-dlg").close();
    setHeader();
    renderSignIn().then(() => {
      if (message) fail(message);
    });
  }
  async function renderSignIn() {
    const gen = ++S.gen;
    RUN = [];
    S.locked = false;
    let text = null;
    if (!S.bannerOk) {
      try {
        const b = await api("GET", "banner", null, { noRedirect: true, activity: false });
        text = b && b.banner ? String(b.banner) : null;
      } catch (e) {
        text = null;
      }
    }
    if (gen !== S.gen) return;
    if (text) {
      // AC-8: the notice first, alone; the sign-in form only after "I agree".
      showGate(gateTitle(W["banner.title"]), el("p", { class: "banner-text" }, cleanLines(text)),
        el("div", null, btn(W["banner.accept"], () => {
          S.bannerOk = true;
          return renderSignIn();
        }, "primary")));
      return;
    }
    signInForm();
  }
  function signInForm() {
    const email = textField(W["signin.email"], { type: "email", autocomplete: "username webauthn", maxlength: "254" }, W["signin.email-hint"]);
    const step = el("div", { class: "steps", id: "signin-step" });
    const kids = [gateTitle(W["signin.title"]), email.box,
      el("div", null, btn(W["signin.button"], () => keySignIn(email.input.value.trim(), step), "primary"))];
    let pw = null;
    // Enter in the email field signs in with the password when one is typed, else with a passkey.
    onEnter(email.input, () => (pw && pw.input.value ? passwordSignIn(email.input.value.trim(), pw.input.value, step) : keySignIn(email.input.value.trim(), step)));
    if (profile() === "standard") {
      pw = currentPassword(W["signin.password.field"]);
      onEnter(pw.input, () => passwordSignIn(email.input.value.trim(), pw.input.value, step));
      kids.push(el("div", { class: "subpanel" }, el("h3", null, W["signin.password"]), pw.box,
        el("div", null, btn(W["signin.password.button"], () => passwordSignIn(email.input.value.trim(), pw.input.value, step), "primary"))),
      el("p", null, btn(W["signin.forgot"], () => forgotForm(email.input.value.trim()), "link")));
    }
    kids.push(step, fleet() ? null : el("p", { class: "note" }, W["signin.none." + product()]));
    if (!window.PublicKeyCredential) kids.push(el("p", { class: "dlg-error" }, MSG.noPasskeys));
    showGate(...kids);
  }
  function stepFocus(step) {
    const f = step.querySelector("input");
    if (f) f.focus();
  }
  async function keySignIn(email, step) {
    clearMessages();
    try {
      const b = await api("POST", "login/begin", { email, banner: S.bannerOk }, { noRedirect: true });
      const cred = await passkeyGet(b.publicKey);
      const f = await api("POST", "login/finish", { ceremony: b.ceremony, credential: credJSON(cred) }, { noRedirect: true });
      if (f.next === "password") passwordStep(b.ceremony, step);
      else await signedIn();
    } catch (e) {
      fail(e);
    }
  }
  // Standard: password first, then the account's second factor (3.3 step 2).
  async function passwordSignIn(email, password, step) {
    clearMessages();
    try {
      const b = await api("POST", "login/begin", { email, banner: S.bannerOk }, { noRedirect: true });
      const r = await api("POST", "login/password", { ceremony: b.ceremony, password }, { noRedirect: true });
      if (r.next === "totp") totpStep(b.ceremony, step);
      else if (r.next === "webauthn") keyNextStep(b.ceremony, r.publicKey, step);
      else await signedIn();
    } catch (e) {
      fail(e);
    }
  }
  function keyNextStep(ceremony, publicKey, step) {
    step.replaceChildren(el("p", null, W["signin.key-next"]), el("div", null, btn(W["signin.password.button"], async () => {
      clearMessages();
      try {
        const cred = await passkeyGet(publicKey);
        await api("POST", "login/finish", { ceremony, credential: credJSON(cred) }, { noRedirect: true });
        await signedIn();
      } catch (e) {
        fail(e);
      }
    }, "primary")));
    const b = step.querySelector("button");
    if (b) b.focus();
  }
  function totpStep(ceremony, step) {
    const c = codeField(W["signin.totp.field"]);
    const submit = async () => {
      clearMessages();
      try {
        await api("POST", "login/totp", { ceremony, code: c.input.value.trim() }, { noRedirect: true });
        await signedIn();
      } catch (e) {
        fail(e);
      }
    };
    onEnter(c.input, submit);
    step.replaceChildren(el("p", null, W["signin.totp"]), c.box, el("div", null, btn(W["signin.totp.button"], submit, "primary")));
    stepFocus(step);
  }
  // High with requirePassword: the password after the WebAuthn assertion (3.3 step 3, R3-M1).
  function passwordStep(ceremony, step) {
    const pw = currentPassword(W["signin.password.field"]);
    const submit = async () => {
      clearMessages();
      try {
        const r = await api("POST", "login/password", { ceremony, password: pw.input.value }, { noRedirect: true });
        if (r.next === "set-password") setPasswordStep(ceremony, step);
        else await signedIn();
      } catch (e) {
        fail(e);
      }
    };
    onEnter(pw.input, submit);
    step.replaceChildren(pw.box, el("div", null, btn(W["signin.password.button"], submit, "primary")));
    stepFocus(step);
  }
  // The restricted setup session: only password.required and the join.password form (login/set-password).
  function setPasswordStep(ceremony, step) {
    const n = minPassword();
    const pw = newPassword(W["join.password.field"], n);
    const submit = async () => {
      clearMessages();
      try {
        await api("POST", "login/set-password", { ceremony, password: pw.input.value }, { noRedirect: true });
        await signedIn();
      } catch (e) {
        fail(e);
      }
    };
    onEnter(pw.input, submit);
    step.replaceChildren(el("p", null, W["password.required"]), el("h3", null, W["join.password"]),
      el("p", null, fill(W["join.password.body"], { n })), pw.box, el("div", null, btn(W["join.password.button"], submit, "primary")));
    stepFocus(step);
  }
  function forgotForm(prefill) {
    RUN = [];
    const email = textField(W["signin.forgot.field"], { type: "email", autocomplete: "username", maxlength: "254" });
    email.input.value = prefill || "";
    const result = el("div", { role: "status" });
    const send = async () => {
      clearMessages();
      const addr = email.input.value.trim();
      try {
        await api("POST", "recover/begin", { email: addr }, { noRedirect: true });
        result.replaceChildren(el("p", null, fill(W["signin.forgot-sent"], { email: addr })));
      } catch (e) {
        fail(e);
      }
    };
    onEnter(email.input, send);
    showGate(gateTitle(W["signin.forgot"]), email.box, el("div", null, btn(W["signin.forgot.button"], send, "primary"), " ", btn(W["signin.title"], () => renderSignIn())), result);
  }
  async function signedIn() {
    S.bannerOk = false;
    S.locked = false;
    await loadMe();
    if (!me()) {
      await renderSignIn();
      return;
    }
    S.settings = null;
    S.overview = null;
    S.link = null;
    touch();
    startIdle();
    setHeader();
    // AC-2a 12.3: after sign-in an admin of a fleet console lands on the first open setup step until none is open.
    if (fleet() && isAdmin()) {
      const step = await firstOpenStep();
      if (step && !/^#\/setup\//.test(location.hash)) {
        location.hash = "#/setup/" + step;
        return;
      }
    }
    await render({ focus: true });
  }

  // Join (#join=<token>): the steps the profile asks of that role, in order; the session starts after the last one.
  async function renderJoin(token) {
    setHeader();
    ++S.gen;
    RUN = [];
    let j;
    try {
      j = await api("POST", "join", { token }, { noRedirect: true });
    } catch (e) {
      showGate(gateTitle(W["join.title"]));
      fail(e);
      return;
    }
    const steps = el("div", { class: "steps" });
    showGate(gateTitle(W["join.title"]), j.reset ? el("p", null, W["join.reset"]) : null,
      el("p", null, fill(W["join.body"], { email: j.email, time: when(j.expires) })), steps);
    const methods = j.methods || [];
    let plan;
    if (methods.length > 1) plan = await chooseMethod(steps, methods);
    // A single method: the break-glass account's is "password-totp" (a password and an authenticator app, never a
    // passkey); otherwise a passkey or security key, after the password when the profile requires one.
    else if (methods[0] === "password-totp") plan = ["password", "totp"];
    else plan = (j.password === "required" ? ["password"] : []).concat(methods[0] === "security-key" ? ["security-key"] : ["passkey"]);
    let last = null;
    for (const s of plan) last = await joinStep(s, token, j, steps);
    if (last && last.state === "waiting") {
      steps.replaceChildren(el("p", { role: "status" }, W["join.waiting"]));
      return;
    }
    if (last && last.passkey === "waiting") {
      steps.replaceChildren(el("p", { role: "status" }, plan.includes("security-key") ? W["account.key-waiting"] : W["join.passkey-waiting"]));
      return;
    }
    location.hash = "#/overview";
    await signedIn();
  }
  function chooseMethod(steps, methods) {
    const opts = W["join.choose.options"];
    const index = { passkey: 0, "password-totp": 1, "password-passkey": 2 };
    const name = uid("choose");
    const radios = methods.filter((m) => index[m] != null).map((m, i) => {
      const id = uid("opt");
      const r = el("input", { type: "radio", id, name, value: m, checked: i === 0 ? true : null });
      return [r, el("label", { class: "inline", for: id }, r, opts[index[m]])];
    });
    return new Promise((resolve) => {
      steps.replaceChildren(el("fieldset", { class: "choice" }, el("legend", null, W["join.choose"]), radios.map((x) => x[1])),
        el("div", null, btn(W["signin.password.button"], () => {
          const pick = (radios.find((x) => x[0].checked) || radios[0])[0].value;
          resolve(pick === "password-totp" ? ["password", "totp"] : pick === "password-passkey" ? ["password", "passkey"] : ["passkey"]);
        }, "primary")));
      if (radios.length) radios[0][0].focus();
    });
  }
  function joinStep(kind, token, j, steps) {
    return new Promise((resolve) => {
      const run = (fn) => async () => {
        clearMessages();
        try {
          resolve(await fn());
        } catch (e) {
          fail(e);
        }
      };
      if (kind === "password") {
        const n = j.minLength || minPassword();
        const pw = newPassword(W["join.password.field"], n);
        steps.replaceChildren(el("h3", null, W["join.password"]), el("p", null, fill(W["join.password.body"], { n })), pw.box,
          el("div", null, btn(W["join.password.button"], run(() => api("POST", "join/password", { token, password: pw.input.value }, { noRedirect: true })), "primary")));
      } else if (kind === "totp") {
        const c = codeField(W["join.totp.field"]);
        const holder = el("div", { class: "qr-box" });
        steps.replaceChildren(el("h3", null, W["join.totp"]), el("p", null, W["join.totp.body"]), holder);
        api("POST", "join/totp/begin", { token }, { noRedirect: true }).then((t) => {
          holder.replaceChildren(totpBox(t, c, run(() => api("POST", "join/totp/finish", { token, enrollment: t.enrollment, code: c.input.value.trim() }, { noRedirect: true }))));
          c.input.focus();
        }).catch(fail);
        return;
      } else {
        const security = kind === "security-key";
        const lbl = textField(W["join.label"], { maxlength: "40" });
        lbl.input.value = security ? MSG.kinds["security-key"] : MSG.kinds.passkey;
        steps.replaceChildren(el("h3", null, security ? W["join.security-key"] : W["join.passkey"]),
          ...(security ? [el("p", null, W["join.security-key.body"])] : []), lbl.box,
          el("div", null, btn(security ? W["join.security-key.button"] : W["join.button"], run(async () => {
            const b = await api("POST", "register/begin", { token, kind }, { noRedirect: true });
            const cred = await passkeyCreate(b.publicKey);
            const body = { ceremony: b.ceremony, credential: credJSON(cred), label: lbl.input.value.trim() || MSG.kinds[kind] };
            if (S.record) body.record = S.record;
            const r = await api("POST", "register/finish", body, { noRedirect: true });
            keyRecordGo(r);
            return r;
          }), "primary")));
      }
      stepFocus(steps);
    });
  }
  // The authenticator app enrollment: QR code (qr.js), the key as text with Copy, and the Code field (7.8).
  function totpBox(t, c, finish) {
    const [copyWord, finishWord] = W["join.totp.buttons"];
    let picture = null;
    try {
      picture = window.LucidQR ? window.LucidQR.svg(t.uri, MSG.qrLabel) : null;
    } catch (e) {
      picture = null;
    }
    return el("div", null, picture ? el("div", { class: "qr-wrap" }, picture) : null,
      el("p", { class: "secret" }, el("span", { class: "note" }, MSG.key + " "), code(t.secret), " ", copyButton(t.secret, copyWord)),
      c.box, el("div", null, btn(finishWord, finish, "primary")));
  }
  // Viewer password reset (#reset=<token>): reset.title, the new password, then the sign-in screen.
  function renderReset(token) {
    setHeader();
    ++S.gen;
    RUN = [];
    const pw = newPassword(W["reset.title.field"], 12);
    const save = async () => {
      clearMessages();
      try {
        await api("POST", "recover/finish", { token, password: pw.input.value }, { noRedirect: true });
        await renderSignIn();
        say(MSG.done);
      } catch (e) {
        fail(e);
      }
    };
    onEnter(pw.input, save);
    showGate(gateTitle(W["reset.title"]), pw.box, el("div", null, btn(W["reset.title.button"], save, "primary")));
  }

  // Idle and lock (3.4, AC-11): lock.warn one minute before the idle limit, then every displayed value removed.
  const idleMs = () => Math.max(1, (S.me && S.me.idle && S.me.idle.minutes) || 15) * 60000;
  function touch() {
    S.lastAct = Date.now();
    if (S.warned) hideWarn();
  }
  function startIdle() {
    clearInterval(S.idleTimer);
    S.warned = false;
    S.idleTimer = setInterval(checkIdle, 5000);
  }
  function checkIdle() {
    if (S.locked || !me()) return;
    const left = S.lastAct + idleMs() - Date.now();
    if (left <= 0) lockScreen();
    else if (left <= 60000) showWarn();
  }
  function showWarn() {
    if (S.warned) return;
    S.warned = true;
    const box = $("idle-warn");
    box.replaceChildren(el("span", null, W["lock.warn"]), " ", el("button", { type: "button", "data-act": "stay" }, W["lock.warn.button"]));
    box.hidden = false;
  }
  function hideWarn() {
    S.warned = false;
    const box = $("idle-warn");
    box.hidden = true;
    box.replaceChildren();
  }
  // Removes every value the relay gave this page: content, banners, navigation, header values, dialogs, search.
  function wipe() {
    clearInterval(S.timer);
    clearInterval(S.idleTimer);
    clearTimeout(S.searchTimer);
    S.gen++;
    S.searchGen++;
    RUN = [];
    if (S.dlg && $("confirm").open) $("confirm").close();
    if ($("code-dlg").open) $("code-dlg").close();
    if ($("nav-sheet").open) $("nav-sheet").close();
    for (const id of ["confirm-title", "confirm-name", "confirm-id", "confirm-body", "confirm-second", "confirm-fields", "confirm-params",
      "confirm-error", "confirm-go", "code-error", "nav", "nav-sheet-nav", "banner", "view", "status", "alert", "idle-warn",
      "search-results", "hdr-host", "hdr-product", "hdr-count", "hdr-profile", "account-email", "account-menu", "hdr-approvals-n"]) $(id).replaceChildren();
    // Fleet values (AC-2a): the relay list, the code screen and the relay link go too.
    S.px = null;
    S.relays = null;
    S.enroll = null;
    S.setup = null;
    S.link = null;
    $("search").value = "";
    $("code-input").value = "";
    $("search-results").hidden = true;
    $("idle-warn").hidden = true;
    $("account-btn").removeAttribute("aria-label");
    $("hdr-approvals").removeAttribute("aria-label");
    for (const id of ["hdr-search", "account-wrap", "hdr-approvals", "menu-btn", "nav", "hdr-product", "hdr-count", "hdr-profile"]) $(id).hidden = true;
    $("shell").classList.add("bare");
    document.title = MSG.plainTitle;
    if (S.me) S.me.user = null;
    S.overview = null;
    S.settings = null;
    S.warned = false;
  }
  function lockScreen() {
    if (S.locked) return;
    const minutes = (S.me && S.me.idle && S.me.idle.minutes) || 15;
    wipe();
    S.locked = true;
    $("view").replaceChildren(el("div", { class: "gate" }, el("section", { class: "panel" }, gateTitle(W["lock.title"]),
      el("p", null, fillText(W["lock.body"], { n: minutes })),
      el("div", null, el("button", { type: "button", class: "primary", "data-act": "relock" }, W["lock.body.button"])))));
    $("page-title").focus();
  }

  // ---- Render ----
  async function render(opts) {
    const o = opts || {};
    closeMenus();
    clearInterval(S.timer);
    if (S.locked) return;
    if (!me()) {
      await renderSignIn();
      return;
    }
    if (!o.keepMessages) clearMessages();
    const gen = ++S.gen;
    RUN = [];
    const r = parseHash();
    const [a, b] = r.parts;
    S.px = null;
    if (isAdmin() && !S.settings) await loadSettings();
    if (a !== "overview" || fleet()) await loadOverview(false);
    if (!fleet() && isAdmin()) await loadLink(false);
    if (gen !== S.gen) return;
    if (fleet()) setHeader();
    renderNav();
    if ($("nav-sheet").open) $("nav-sheet").close();
    const ctx = { q: r.q, gen, user: o.auto !== true, sub: r.parts[2] || "" };
    let fn = pages.overview;
    if (fleet()) {
      try {
        fn = await fleetRoute(r, ctx);
      } catch (e) {
        if (gen !== S.gen || (e && e.status === 401)) return;
        fn = async () => [head(routeTitle(r)), pageError(e)];
      }
      if (gen !== S.gen) return;
    } else if (a === "overview") fn = pages.overview;
    else if (a === "security" && isAdmin()) fn = pages.security;
    else if (a === "approvals" && isAdmin()) fn = pages.approvals;
    else if (a === "license" && canOpen("#/license")) fn = pages.license;
    else if (a === "help") fn = pages.help;
    else if (a === "spokes" && product() === "spokes") {
      const id = b === "nodes" ? (r.q.get("role") === "hub" ? "hubs" : "spokes") : b;
      if (locked() && id !== "license") fn = canOpen("#/license") ? pages.license : pages.overview;
      else fn = pagesFor("spokes").includes(id) ? pages["spokes_" + id] || pages.overview : pages.overview;
    } else if (a === "meet" && product() === "meet") {
      if (locked() && b !== "license") fn = canOpen("#/license") ? pages.license : pages.overview;
      else fn = pagesFor("meet").includes(b) ? pages["meet_" + b] || pages.overview : pages.overview;
    } else if (a === "admins") {
      const allowed = pagesFor("admins");
      fn = pages["admins_" + (allowed.includes(b) ? b : allowed[0])];
    } else if (!["security", "approvals", "license"].includes(a)) fn = noPage(FMSG.notFound, FMSG.notFoundBody);
    let kids;
    try {
      kids = await fn(ctx);
    } catch (e) {
      if (gen !== S.gen) return;
      if (e && e.status === 401) return;
      kids = [head(routeTitle(r)), pageError(e)];
    }
    if (gen !== S.gen) return;
    $("banner").replaceChildren(...bannerNodes());
    $("view").replaceChildren(...[].concat(kids).flat().filter(Boolean));
    if (ctx.sub && $("sec-" + ctx.sub)) $("sec-" + ctx.sub).focus();
    else if (o.focus) {
      const h = $("page-title");
      if (h) h.focus();
    }
  }

  const pages = {};

  // ---- Overview (7.3) ----
  const CARD = {
    health: { title: "Health" },
    license: { title: "License", go: "#/license" },
    hubs: { title: "Hubs", go: "#/spokes/hubs", line: (c) => [c.n + " hubs", c.m ? c.m + " need a look" : null] },
    spokes: { title: "Spokes", go: "#/spokes/spokes", line: (c) => [c.n + " spokes", c.m != null ? c.m + " silent" : null] },
    seats: { title: "Seats", go: "#/spokes/seats", line: (c) => [c.n + " of " + (c.m || 0) + " licensed people in use"] },
    relays: { title: "Relays and revocation", go: "#/spokes/relays", line: (c) => ["Revocation list version " + (c.n || 0), c.m != null ? "Issued " + c.m + " days ago" : null] },
    people: { title: "People", go: "#/meet/people", line: (c) => [c.n + " online now", c.m != null ? c.m + " in all" : null] },
    approvals: { title: "Waiting approvals", go: "#/meet/enrollments", line: (c) => [c.n + " enrollments, renewals and seeds waiting"] },
    signer: { title: "Signer", go: "#/meet/signer", line: (c) => [c.n != null ? c.n + " days left" : null] },
    release: { title: "Release", go: "#/meet/releases", line: (c) => [c.n != null ? "Latest " + c.n : null, c.m != null ? "Minimum " + c.m : null] },
    push: { title: "Push", go: "#/meet/push", line: (c) => [c.n != null ? c.n + " failures in 24 hours" : null] },
  };
  function cardOf(c, o) {
    const def = CARD[c.id] || { title: stateWord(c.id) };
    const lines = [];
    if (c.id === "health") {
      const r = o.relay || {};
      lines.push("Version " + clean(r.version || ""), "Up for " + span(r.uptimeSeconds || 0), "FIPS mode " + (r.fips ? "on" : "off"));
    } else if (c.id === "license") {
      const l = o.license;
      if (!l || !l.state) lines.push(fillText(W["attention.license-none"], { product: PRODUCT_NAME[product()] }));
      else {
        lines.push(stateWord(l.state), l.used + " of " + l.users + " users");
        if (l.daysLeft != null) lines.push(l.daysLeft + " days left");
      }
    } else if (def.line) lines.push(...def.line(c).filter((x) => x != null));
    else if (c.n != null) lines.push(String(c.n));
    const tone = c.state === "bad" ? "bad" : c.state === "warn" ? "warn" : c.state === "ok" ? "ok" : "none";
    const kids = [el("span", { class: "card-title" }, def.title), c.state ? stChip(MSG.cardState[c.state] || c.state, tone) : null,
      lines.map((l) => el("span", { class: "card-line" }, clean(l)))];
    let href = def.go || null;
    if (c.id === "health" && isAdmin()) href = "#/" + product() + "/logs";
    if (href && locked() && href !== "#/license") href = null;
    if (href && !canOpen(href)) href = null;
    return href ? el("a", { class: "card", href }, kids) : el("div", { class: "card" }, kids);
  }
  function attentionList(list) {
    if (!list || !list.length) return emptyLine(W["attention.none"]);
    const ul = el("ul", { class: "attention" });
    for (const it of list.slice(0, 20)) {
      // AC-2a 8.1: the fleet's own kinds have fleet words; a relay's pushed item is an AC-1 kind (any other kind is
      // dropped), shown as "<relay name>: <words>" with the console's own name for the relay.
      // The console's relay-* kinds (revision 3.4 license items among them) name their relay in the words.
      const own = fleet() && (!it.relay || String(it.kind).startsWith("relay-")) ? FW["attention." + it.kind] || FMSG.cluster.attention[it.kind] : null;
      const tpl = own || W["attention." + it.kind];
      if (typeof tpl !== "string") continue;
      const sev = it.severity === "bad" ? "bad" : it.severity === "warn" ? "warn" : "info";
      const target = safeGo(fleetGo(it.go));
      const prefix = fleet() && it.relay && !own ? [u(relayName(it.relay)), ": "] : [];
      // A relay's pushed item may name the relay by its console name rather than its id.
      const row = it.relay ? (S.relays || []).find((r) => r.id === it.relay) || (S.relays || []).find((r) => r.name === it.relay) : null;
      const args = fleet() ? fleetArgs(Object.assign(it.relay ? { relay: it.relay, product: row ? row.product : "" } : {}, it.args)) : argsOf(it.args);
      ul.append(el("li", { class: "sev-" + sev }, el("span", { class: "st st-" + (sev === "info" ? "none" : sev) }, MSG.sev[sev]),
        el("span", { class: "words" }, ...prefix, fill(tpl, args)), target && canOpen(target) ? el("a", { href: target }, MSG.go) : null));
    }
    return ul;
  }
  function otherConsoles(links) {
    if (!links || !links.length) return null;
    const ul = el("ul", { class: "links-list" });
    for (const l of links) {
      let ok = false;
      try {
        const x = new URL(l.url);
        ok = x.protocol === "https:" && !!x.hostname;
      } catch (e) {
        ok = false;
      }
      if (ok) ul.append(el("li", null, el("a", { href: l.url, rel: "noopener noreferrer" }, u(l.label))));
    }
    return panel(W["settings.sections"][4], ul);
  }
  pages.overview = async (c) => {
    const o = await api("GET", "overview", null, { activity: c.user });
    S.overview = o;
    S.ovAt = Date.now();
    S.auditBroken = (o.attention || []).some((a) => a.kind === "audit-broken");
    setApprovalsBadge(o.approvals ? o.approvals.mine : 0);
    const cards = el("div", { class: "cards" });
    const att = el("div");
    const fillIn = (x) => {
      cards.replaceChildren(...[{ id: "health", state: null }, { id: "license", state: x.license ? (x.license.state === "valid" ? "ok" : x.license.state === "grace" ? "warn" : "bad") : "bad" }]
        .concat((x.cards || []).filter((k) => k.id !== "health" && k.id !== "license")).map((k) => {
          const given = (x.cards || []).find((y) => y.id === k.id);
          return cardOf(Object.assign({}, k, given || {}), x);
        }));
      att.replaceChildren(attentionList(x.attention));
    };
    fillIn(o);
    // Every 30 s while visible, without X-Lucid-Activity (3.4): only a person's own actions keep the session alive.
    S.timer = setInterval(async () => {
      if (document.hidden || c.gen !== S.gen) return;
      if (cards.contains(document.activeElement) || att.contains(document.activeElement)) return;
      try {
        const x = await api("GET", "overview", null, { activity: false });
        if (c.gen !== S.gen) return;
        S.overview = x;
        S.ovAt = Date.now();
        setApprovalsBadge(x.approvals ? x.approvals.mine : 0);
        fillIn(x);
        $("banner").replaceChildren(...bannerNodes());
      } catch (e) {
        /* the next tick tries again; a 401 already went to sign-in */
      }
    }, 30000);
    return [head(W["nav.overview"]), help("help.overview"), cards,
      el("section", { class: "panel", "aria-labelledby": "att-h" }, el("h3", { id: "att-h" }, W["attention.title"]), att),
      otherConsoles(o.links)];
  };

  // ---- License (4.7) ----
  function licenseToken(text) {
    const t = String(text || "").trim();
    const begin = "-----BEGIN LUCID RELAY LICENSE-----", end = "-----END LUCID RELAY LICENSE-----";
    if (!t.startsWith(begin)) return t;
    const inner = t.slice(begin.length);
    const at = inner.indexOf(end);
    return at < 0 ? "" : inner.slice(0, at).replace(/\s+/g, "");
  }
  function compactPayload(token) {
    const parts = String(token || "").trim().split(".");
    if (parts.length !== 2) return null;
    try {
      const p = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
      return p && typeof p === "object" ? p : null;
    } catch (e) {
      return null;
    }
  }
  const productOf = (features) => (Array.isArray(features) && features.includes("meet") ? W["nav.meet"] : W["nav.spokes"]);
  function licenseLine(tpl, l, prodName) {
    return fill(tpl, { product: prodName, edition: l.edition, users: l.users, relays: l.relays, date: daySec(l.exp), id: l.id });
  }
  async function readFileInto(input, area) {
    const f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 16777216) return;
    area.value = await f.text();
    area.dispatchEvent(new Event("input"));
  }
  function pasteOrFile(label, accept) {
    const aid = uid("paste"), fid = uid("file");
    const area = el("textarea", { id: aid, spellcheck: "false", autocomplete: "off" });
    const file = el("input", { id: fid, type: "file", accept });
    file.addEventListener("change", () => readFileInto(file, area));
    const box = el("div", null, el("div", { class: "field" }, el("label", { for: fid }, label + ": " + MSG.choose), file),
      el("div", { class: "field" }, el("label", { for: aid }, MSG.paste), area));
    return { box, area };
  }
  pages.license = async () => {
    const d = await api("GET", "license");
    const l = d.license;
    const kids = [head(locked() ? fillText(W["locked.title"], { product: PRODUCT_NAME[product()] }) : PAGE_LABEL[product()].license)];
    if (locked()) {
      kids.push(el("p", null, fill(W["locked.body"], { product: PRODUCT_NAME[product()] })));
      if (d.problem) kids.push(el("p", null, fill(W["locked.reason"], { problem: d.problem })));
    }
    kids.push(serviceBanner(d));
    if (l) {
      kids.push(panel(null, pairs([
        ["Organization", l.org], ["Product", l.product === "meet" ? W["nav.meet"] : W["nav.spokes"]], ["Edition", l.edition],
        ["Users", l.used + " of " + l.users], ["Relays", l.relays], ["State", stateWord(l.state)], ["Days left", l.daysLeft],
        ["Ends", daySec(l.exp)], ["Grace days", l.graceDays], [W["dialog.id"], code(l.id)], ["Development license", l.dev ? MSG.yes : undefined],
      ])));
    } else kids.push(panel(null, emptyLine(fillText(W["attention.license-none"], { product: PRODUCT_NAME[product()] }))));
    // Both products (4.7, R42-1): with no valid license the relay serves no one; the reminders sent (R42-3).
    const svc = d.service;
    if (svc) {
      kids.push(panel(null, pairs([[MSG.serviceLabel, MSG.service[svc.state] || stateWord(svc.state)],
        [MSG.serviceWhy, svc.state === "stopped" && svc.why ? whyWords(svc.why, d.problem) : undefined],
        [MSG.stopsAt, svc.stopsAt ? when(svc.stopsAt) : undefined],
        ["Upgrade period ends", svc.upgradePeriodEnds ? when(svc.upgradePeriodEnds) : undefined],
        [MSG.reminders, (svc.reminders || []).length ? svc.reminders.map((r) => (MSG.reminderKind[r.kind] || stateWord(r.kind)) + ", " + whenAny(r.at)).join("; ") : undefined]])));
    }
    if (isAdmin()) {
      const { box, area } = pasteOrFile(W["license.install.field"], ".lic,.txt");
      const install = btn(W["license.install.button"], () => installLicense(area.value, l, svc), "primary");
      // AC-2a 11.4: from the fleet console, installing works on a relay stopped for its license.
      const again = S.px && svc && svc.state === "stopped" ? el("p", { class: "note" }, FW["relay.license-install-stopped"]) : null;
      kids.push(panel(W["license.install"], again, box, install));
    }
    return kids;
  };
  // The grace a relay honors: min(token graceDays, 2), 2 when absent (2.4, R42-2).
  const honoredGrace = (p) => Math.min(p.graceDays != null ? p.graceDays : 2, 2);
  // The Meeting Hub lines of the license dialog (8.2, R3-L4, R3-M4): the upgrade period, the seat clock. `svc` is the
  // license answer's `service`.
  function meetLicenseLines(p, svc, seats) {
    const M = D.license.meet;
    const lines = [];
    const graceEnd = (p.exp || 0) + honoredGrace(p) * 86400;
    if (svc && svc.upgradePeriodEnds) {
      const ends = svc.upgradePeriodEnds / 1000;
      lines.push(fill(graceEnd >= ends ? M[0] : M[1], { date: daySec(ends) }));
    }
    if (seats) {
      const users = p.users || 0;
      const seated = seats.seated || 0;
      const vals = { seated, users, day: seats.clock ? seats.clock.day : 0 };
      if (seated > users) lines.push(fill(seats.clock ? M[3] : M[2], vals));
      else if (seats.clock) lines.push(fill(M[4], vals));
      if (seats.unseated > 0 && users > seated) lines.push(fill(M[5], { n: Math.min(seats.unseated, users - seated) }));
    }
    return lines;
  }
  async function installLicense(text, cur, svc) {
    const token = licenseToken(text);
    const p = compactPayload(token);
    if (!p) {
      fail(fillText(R["license-refused"], { reason: MSG.unreadable }));
      return;
    }
    const now = Date.now() / 1000;
    const grace = honoredGrace(p) * 86400;
    if (p.exp && p.exp + grace <= now) {
      fail(R["license-ended"]);
      return;
    }
    // 4.7: one admin for a first install or a renewal (same id, later end, no fewer users or relays, not in grace).
    const renewal = !cur || (cur.id === p.id && p.exp > cur.exp && p.users >= cur.users && p.relays >= cur.relays && p.edition === cur.edition);
    const two = !renewal || (p.exp && p.exp <= now);
    const newId = !!(cur && cur.id !== p.id);
    const prodName = productOf(p.features);
    const meet = product() === "meet";
    let seats = null;
    if (meet) {
      try {
        seats = await api("GET", "meet/seats");
      } catch (e) {
        seats = null;
      }
    }
    confirmDialog({
      dlg: "license", vals: { org: p.org }, name: p.org, id: p.id, two,
      params: [["Organization", p.org], ["Product", prodName], ["Edition", p.edition], ["Users", p.users], ["Relays", p.relays], ["Ends", daySec(p.exp)], [W["dialog.id"], code(p.id)]],
      body: () => [cur ? licenseLine(D.license.body[0], cur, PRODUCT_NAME[product()]) : null, licenseLine(D.license.body[1], p, prodName),
        svc && svc.state === "stopped" ? D.license.body[3] : null,
        p.graceDays > 2 ? fill(D.license.body[4], { n: p.graceDays }) : null,
        newId && !meet ? D.license.body[2] : null].concat(meet ? meetLicenseLines(p, svc, seats) : []).filter(Boolean),
      fields: [{ kind: "reason" }],
      run: (v) => post("license/install", { license: text.trim(), reason: v.reason }, { action: "license.install", target: p.id || "-" }),
      done: async () => {
        await loadMe();
        S.overview = null;
        setHeader();
        render({ keepMessages: true });
      },
    });
  }

  // ---- Requests (3.8) ----
  const REQ_KIND = {
    "rs.revoke": "Revoke", "rs.renew": "Renew", "rs.seat": "License seat",
    "meet.approve": "Approve or refuse", "meet.revoke": "Revoke a device", "meet.invite": "Invite", "meet.console-invite": "Console invite",
  };
  function requestSummary(r) {
    const t = r.target || {};
    const name = t.name || t.node || t.principal || t.email || t.id || "";
    const map = {
      "rs.revoke": ["request-revoke", { name }], "rs.renew": ["request-renew", { name }], "rs.seat": ["request-seat", { name }],
      "meet.revoke": ["request-revoke", { name: t.device ? t.principal + " " + t.device : name }],
      "meet.approve": [t.decision === "refuse" ? "request-refuse" : "request-approve", { name: t.principal || t.id, device: t.device || t.kind }],
      "meet.invite": ["request-invite", { name: t.name, email: t.email }],
      "meet.console-invite": ["invite-admin-meet", { email: t.principal }],
    };
    const [dlg, vals] = map[r.kind] || ["request-revoke", { name }];
    return fillText(D[dlg].title, vals).replace(/\?$/, "");
  }
  function targetText(t) {
    if (!t || typeof t !== "object") return clean(t == null ? "" : t);
    return Object.entries(t).map(([k, v]) => k + " " + clean(v)).join(", ");
  }
  pages.requests = async (c) => {
    const d = await api("GET", "requests?state=all");
    const prefix = product() === "spokes" ? "rs." : "meet.";
    const rows = (d.requests || []).filter((r) => String(r.kind).startsWith(prefix));
    const states = [["waiting", "Waiting"], ["done", "Done"], ["declined", "Declined"], ["cancelled", "Cancelled"], ["expired", "Expired"]];
    return [head(PAGE_LABEL[product()].requests), help("help.requests"), panel(null, dataTable({
      caption: PAGE_LABEL[product()].requests, rows, total: rows.length, empty: W["empty.requests"],
      text: (r) => [r.id, r.kind, targetText(r.target), r.reason, r.requested_by].join(" "),
      chips: { label: "State", options: states, of: (r) => r.state }, chip: c.q.get("state") || "",
      name: (r) => requestSummary(r),
      cols: [
        { key: "kind", label: "Kind", cell: (r) => REQ_KIND[r.kind] || r.kind },
        { key: "target", label: "Target", cell: (r) => u(targetText(r.target)), sort: (r) => targetText(r.target) },
        { key: "reason", label: "Reason" },
        { key: "requested_by", label: "Asked by" },
        { key: "requested_at", label: "Asked", cell: (r) => when(r.requested_at) },
        { key: "state", label: "State", cell: (r) => stChip(r.state, r.state === "done" ? "ok" : r.state === "waiting" ? "warn" : "none") },
        { key: "done_at", label: "Done", cell: (r) => (r.done_at ? when(r.done_at) : "") },
        { key: "id", label: W["dialog.id"], cell: (r) => code(r.id) },
      ],
      actions: (r) => (isAdmin() && r.state === "waiting" ? [{ label: D["cancel-request"].button[0], run: () => cancelRequest(r) }] : []),
    }))];
  };
  pages.spokes_requests = pages.requests;
  pages.meet_requests = pages.requests;
  function cancelRequest(r) {
    const mine = r.requested_by === myEmail();
    confirmDialog({
      dlg: "cancel-request", vals: { summary: requestSummary(r), email: r.requested_by }, name: requestSummary(r), id: r.id, danger: true, plain: true,
      run: () => post("requests/cancel", { id: r.id }, mine ? null : { action: "requests.cancel", target: r.id }),
    });
  }
  function newRequest(dlg, vals, name, id, kind, target, opts) {
    confirmDialog(Object.assign({
      dlg, vals, name, id,
      fields: [{ kind: "reason" }],
      run: (v) => api("POST", "requests/new", { kind, target, reason: v.reason }),
    }, opts || {}));
  }

  // ---- Blocks (4.8, 4.9) ----
  function blockDialog(name, id, run, opts) {
    confirmDialog(Object.assign({
      dlg: "block", vals: { name, n: 24 }, name, id, danger: true,
      fields: [{ kind: "text", type: "number", key: "hours", label: MSG.hours, value: 24, min: "1", max: "720", inputmode: "numeric" }, { kind: "reason" }],
      vals2: (v) => ({ n: v.hours || "", time: v.hours > 0 ? when(Date.now() + v.hours * 3600000) : "" }),
      body: (v) => [fill(D.block.body[0], v)],
      two: (v) => v.hours > 24,
      check: (v) => (!(Number.isInteger(v.hours) && v.hours >= 1 && v.hours <= 720) ? MSG.need.hours : ""),
      run,
    }, opts || {}));
  }
  function unblockDialog(name, id, blocked, run) {
    const mine = blocked && (blocked.by === myEmail() || blocked.placedBy === myEmail());
    confirmDialog({ dlg: "unblock", vals: { name }, name, id, two: !mine, fields: [{ kind: "reason" }], run });
  }

  // ---- Remote Spokes pages (7.4) ----
  const NODE_STATES = [["ok", "OK"], ["silent", "Silent"], ["expiring", "Expiring"], ["expired", "Expired"], ["revoked", "Revoked"], ["blocked", "Blocked"]];
  const nodeTone = (s) => (s === "ok" ? "ok" : s === "silent" || s === "expiring" ? "warn" : "bad");
  async function nodesPage(c, role) {
    const [d, seats] = await Promise.all([
      api("GET", "spokes/nodes?role=" + role + "&limit=500"),
      isAdmin() && role === "hub" ? api("GET", "spokes/seats").catch(() => null) : null,
    ]);
    const uncounted = new Set(((seats && seats.uncounted) || []).map((x) => x.node));
    const nodes = d.nodes || [];
    const nameOf = (n) => n.label || n.node;
    const title = role === "hub" ? PAGE_LABEL.spokes.hubs : PAGE_LABEL.spokes.spokes;
    const cols = [
      { key: "label", label: "Name", cell: (n) => u(nameOf(n)), sort: nameOf },
      { key: "node", label: "Node", cell: (n) => code(n.node) },
      isManager() ? { key: "email", label: "Person" } : null,
      { key: "exp", label: "Certificate ends", cell: (n) => daySec(n.exp) },
      { key: "lastSeenAt", label: "Last seen", cell: (n) => when(n.lastSeenAt) },
      { key: "state", label: "State", cell: (n) => stChip(NODE_STATES.find((s) => s[0] === n.state) ? NODE_STATES.find((s) => s[0] === n.state)[1] : n.state, nodeTone(n.state)) },
    ].filter(Boolean);
    const actions = (n) => {
      if (!isAdmin()) return [];
      const name = nameOf(n);
      return [
        !n.blocked && !n.revoked ? { label: "Block on this relay", run: () => blockDialog(name, n.node, (v) => post("spokes/block", { node: n.node, hours: v.hours, reason: v.reason }, { action: "spokes.block", target: n.node })) } : null,
        n.blocked ? { label: "Unblock", run: () => unblockDialog(name, n.node, n.blocked, (v) => post("spokes/unblock", { node: n.node, reason: v.reason }, { action: "spokes.unblock", target: n.node })) } : null,
        !n.revoked ? { label: "Ask the root to revoke", run: () => newRequest("request-revoke", { name }, name, n.node, "rs.revoke", { node: n.node, serial: n.serial }) } : null,
        canWrite() && !n.revoked ? { label: "Ask the root to renew", run: () => newRequest("request-renew", { name }, name, n.node, "rs.renew", { node: n.node, serial: n.serial }) } : null,
        canWrite() && role === "hub" && uncounted.has(n.node) ? { label: "Ask the root for a license seat", run: () => newRequest("request-seat", { name }, name, n.node, "rs.seat", { node: n.node, serial: n.serial }) } : null,
        role === "spoke" && n.logs > 0 ? { label: "Show logs", run: () => go("#/spokes/logs?source=" + encodeURIComponent(n.node)) } : null,
      ];
    };
    return [head(title), help("help.spokes-elsewhere", "help.blocks"), panel(null, dataTable({
      caption: title, rows: nodes, total: d.total, empty: role === "hub" ? W["empty.hubs"] : W["empty.spokes"],
      text: (n) => [n.label, n.node, n.email, n.serial].join(" "), q: c.q.get("q") || "",
      chips: { label: "State", options: NODE_STATES, of: (n) => n.state }, chip: c.q.get("state") || "",
      name: nameOf, cols, actions,
    }))];
  }
  pages.spokes_hubs = (c) => nodesPage(c, "hub");
  pages.spokes_spokes = (c) => nodesPage(c, "spoke");

  function crlUploadSpokes() {
    const { box, area } = pasteOrFile("Revocation list", ".crl,.txt,.json");
    const go2 = btn("Upload a revocation list", () => {
      let text = area.value.trim();
      try {
        const j = JSON.parse(text);
        if (j && typeof j.crl === "string") text = j.crl;
      } catch (e) {
        /* a bare token */
      }
      const p = compactPayload(text);
      if (!p) {
        fail(fillText(R["crl-refused"], { reason: MSG.unreadable }));
        return;
      }
      const n = Array.isArray(p.serials) ? p.serials.length : 0;
      confirmDialog({
        dlg: "crl", vals: { v: p.version, n }, params: [["Version", p.version], ["Certificates", n]],
        run: () => post("spokes/crl", { crl: text }, { action: "spokes.crl", target: "-" }),
      });
    }, "primary");
    return panel("Upload a revocation list", box, go2);
  }
  pages.spokes_relays = async () => {
    const d = await api("GET", "spokes/relays");
    const dir = d.directory || {};
    const crl = d.crl || {};
    const relays = el("ul", null, (dir.relays || []).map((r) => el("li", null, u(typeof r === "string" ? r : r.url || JSON.stringify(r)))));
    const kids = [head(PAGE_LABEL.spokes.relays), help("help.blocks"), panel(null, pairs([
      ["Relay directory version", dir.version || 0], ["Relays", relays], ["Revocation list version", crl.version || 0],
      ["Next update", crl.nextUpdate ? whenSec(crl.nextUpdate) : MSG.unknown],
    ]))];
    if (isAdmin()) {
      kids.push(crlUploadSpokes());
      if (canWrite()) {
        const { box, area } = pasteOrFile("Relay directory", ".json,.txt");
        kids.push(panel("Upload a relay directory", box, btn("Upload a relay directory", () => {
          let text = area.value.trim();
          try {
            const j = JSON.parse(text);
            if (j && typeof j.directory === "string") text = j.directory;
          } catch (e) {
            /* a bare token */
          }
          const p = compactPayload(text);
          if (!p) {
            fail(fillText(R["directory-refused"], { reason: MSG.unreadable }));
            return;
          }
          const n = Array.isArray(p.relays) ? p.relays.length : 0;
          confirmDialog({
            dlg: "directory", vals: { v: p.version, n }, params: [["Version", p.version], ["Relays", n]],
            run: () => post("spokes/directory", { directory: text }, { action: "spokes.directory", target: "-" }),
          });
        }, "primary")));
      }
    }
    return kids;
  };
  pages.spokes_seats = async () => {
    const d = await api("GET", "spokes/seats");
    const uncounted = d.uncounted || [];
    return [head(PAGE_LABEL.spokes.seats), panel(null, pairs([["Licensed people", d.used + " of " + d.users]])),
      panel(null, dataTable({
        caption: PAGE_LABEL.spokes.seats, rows: d.seats || [], empty: W["empty.seats"], text: (s) => [s.user, s.email].join(" "), name: (s) => s.email || s.user,
        cols: [{ key: "user", label: "User", cell: (s) => code(s.user) }, { key: "email", label: "Email" }, { key: "since", label: "Since", cell: (s) => daySec(s.since) },
          { key: "certificates", label: "Certificates" }, { key: "exp", label: "Latest certificate ends", cell: (s) => daySec(s.exp) }],
      })),
      uncounted.length ? panel(null, dataTable({
        caption: "Hubs refused for want of a seat in 7 days", rows: uncounted, empty: "", name: (x) => x.node,
        cols: [{ key: "node", label: "Node", cell: (x) => code(x.node) }, { key: "email", label: "Person" }, { key: "at", label: "Refused", cell: (x) => when(x.at) }],
        actions: (x) => (canWrite() ? [{ label: "Ask the root for a license seat", run: () => newRequest("request-seat", { name: x.node }, x.email || x.node, x.node, "rs.seat", { node: x.node, serial: x.serial || "" }) }] : []),
      })) : null];
  };
  pages.spokes_license = pages.license;
  pages.meet_license = pages.license;

  // ---- Logs (4.6) ----
  pages.logs = async (c) => {
    let sources = [["relay", "This relay"]];
    if (product() === "spokes") {
      try {
        const d = await api("GET", "spokes/nodes?role=spoke&limit=500");
        sources = sources.concat((d.nodes || []).filter((n) => n.logs > 0).map((n) => [n.node, (n.label || n.node) + " (" + n.logs + " lines)"]));
      } catch (e) {
        /* this relay's own lines still show */
      }
    }
    const mk = (label, options, value) => {
      const id = uid("lg");
      const s = el("select", { id }, options.map(([v, w]) => el("option", { value: v }, clean(w))));
      s.value = value;
      return [s, el("label", { for: id }, label, s)];
    };
    const [src, srcL] = mk("Source", sources, c.q.get("source") || "relay");
    if (!src.value) src.value = "relay";
    const [cat, catL] = mk("Category", [["all", "All"], ["security", "Security"], ["ops", "Ops"], ["perf", "Perf"]], "all");
    const [lvl, lvlL] = mk("Level at least", [["debug", "Debug"], ["info", "Info"], ["warn", "Warn"], ["error", "Error"]], "debug");
    const qid = uid("lq");
    const q = el("input", { id: qid, type: "search", maxlength: "100", autocomplete: "off" });
    const lines = el("div");
    const query = () => "source=" + encodeURIComponent(src.value) + "&cat=" + encodeURIComponent(cat.value) + "&level=" + encodeURIComponent(lvl.value);
    async function show() {
      try {
        const t = q.value.trim();
        const d = await api("GET", "logs?" + query() + "&limit=500" + (t.length >= 2 ? "&q=" + encodeURIComponent(t) : ""));
        const skip = new Set(["ts", "level", "cat", "event", "component"]);
        const detail = (l) => Object.entries(l).filter(([k]) => !skip.has(k)).map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join("  ");
        lines.replaceChildren(d.lines && d.lines.length
          ? el("div", null, el("p", { class: "countline" }, fillText(MSG.showing, { n: d.lines.length, total: d.total })),
            el("ul", { class: "loglines", "aria-label": PAGE_LABEL[product()].logs }, d.lines.map((l) => el("li", null,
              u([l.ts ? when(l.ts) : "", l.level, l.cat, l.event, detail(l)].join("  "))))))
          : emptyLine(W["empty.logs"]));
      } catch (e) {
        fail(e);
      }
    }
    const exp = btn(MSG.exportBtn, async () => {
      try {
        await download("logs/export", { source: src.value, cat: cat.value, level: lvl.value }, { action: "logs.export", target: src.value }, "lucid-console-logs.jsonl");
        say(MSG.done);
      } catch (e) {
        fail(e);
      }
    });
    onEnter(q, show);
    await show();
    return [head(PAGE_LABEL[product()].logs), panel(null, el("div", { class: "filters" }, srcL, catL, lvlL,
      el("label", { for: qid }, MSG.filterText, q), btn(MSG.show, show, "primary"), exp), lines)];
  };
  pages.spokes_logs = pages.logs;
  pages.meet_logs = pages.logs;

  // ---- The license view's service (4.7, R42-1) for the Seats page ----
  async function meetLicense() {
    try {
      return await api("GET", "license");
    } catch (e) {
      return null;
    }
  }
  const serviceStopped = (lic) => !!(lic && lic.service && lic.service.state === "stopped");
  // AC-2a 11.4: the invite controls of a Meeting Hub relay stopped for its license, disabled with the AC-1 words.
  // An admin is told to install a license, never to "Ask your admin" (D-13).
  function disabledAdd(label) {
    const id = uid("why");
    return el("span", { class: "disabled-add" }, el("button", { type: "button", "aria-disabled": "true", class: "is-disabled", "aria-describedby": id }, label),
      " ", el("span", { class: "note", id }, isAdmin() ? MSG.stoppedAdminHere : W["meet.license-inactive"]));
  }

  // ---- Meeting Hub pages (7.4) ----
  const PERSON_STATES = [["online", "Online"], ["joined", "Joined"], ["waiting", "Waiting"], ["approved", "Approved"], ["invited", "Invited"], ["expired", "Expired"]];
  const lastSeenOf = (p) => Math.max(0, ...(p.devices || []).map((d) => d.lastSeenAt || 0)) || null;
  pages.meet_people = async (c) => {
    const [d, orgs] = await Promise.all([api("GET", "meet/people?limit=500"), isAdmin() ? api("GET", "meet/organizations").catch(() => ({ organizations: [] })) : { organizations: [] }]);
    const people = d.people || [];
    const orgList = orgs.organizations || [];
    const side = el("div", { id: "person-panel" });
    const nameOf = (p) => p.name || p.principal;
    const orgOpts = [...new Map(people.filter((p) => p.org).map((p) => [p.org.id, p.org.label || p.org.id])).entries()];
    function showPerson(p) {
      const devs = p.devices || [];
      const deviceId = (dv) => p.principal + "/" + dv.device;
      side.replaceChildren(el("section", { class: "panel side", "aria-labelledby": "person-h" },
        el("h3", { id: "person-h", tabindex: "-1" }, u(nameOf(p))),
        el("p", { class: "id-line" }, el("span", { class: "id-label" }, W["dialog.id"]), code(p.principal)),
        el("div", { class: "page-head" },
          canWrite() ? btn("Put in an organization", () => orgSet(p, orgList)) : null,
          canWrite() && p.org ? btn(fillText("Take out of <org>", { org: p.org.label || p.org.id }), () => orgRemove(p)) : null),
        dataTable({
          caption: "Devices", rows: devs, empty: MSG.noneYet, name: (dv) => dv.label || dv.device,
          cols: [{ key: "label", label: "Device", cell: (dv) => u(dv.label || dv.device) }, { key: "serial", label: "Serial", cell: (dv) => code(dv.serial) },
            { key: "notAfter", label: "Ends", cell: (dv) => daySec(dv.notAfter) }, { key: "lastSeenAt", label: "Last seen", cell: (dv) => when(dv.lastSeenAt) },
            { key: "state", label: "State", cell: (dv) => (dv.revoked ? stChip("Revoked", "bad") : dv.blocked ? stChip("Blocked", "bad") : dv.online ? stChip("Online", "ok") : stChip("Offline")), sortable: false }],
          actions: (dv) => (!isAdmin() ? [] : [
            !dv.blocked && !dv.revoked ? { label: "Block this device on this relay", run: () => blockDialog(dv.label || dv.device, deviceId(dv), (v) => post("meet/block", { principal: p.principal, device: dv.device, hours: v.hours, reason: v.reason }, { action: "meet.block", target: deviceId(dv) })) } : null,
            dv.blocked ? { label: "Unblock", run: () => unblockDialog(dv.label || dv.device, deviceId(dv), dv.blocked, (v) => post("meet/unblock", { principal: p.principal, device: dv.device, reason: v.reason }, { action: "meet.unblock", target: deviceId(dv) })) } : null,
            !dv.revoked ? { label: "Ask an admin to revoke this device", run: () => newRequest("request-revoke", { name: dv.label || dv.device }, dv.label || dv.device, deviceId(dv), "meet.revoke", { principal: p.principal, device: dv.device }) } : null,
          ]),
        })));
      $("person-h").focus();
    }
    // An admin invites (the request goes to the Hub app, where the invite is made); through the fleet console a user
    // manager may ask for an invite too (AC-2a 11.2), and says so.
    const licOk = licState() === "valid" || licState() === "grace";
    const mayAsk = canWrite() || (fleet() && isManager() && licOk);
    const invite = mayAsk ? btn(isAdmin() ? MSG.invite : MSG.askInvite, () => {
      confirmDialog({
        dlg: "request-invite", vals: {},
        fields: [{ kind: "text", key: "name", label: "Name", maxlength: "80", required: true }, { kind: "text", type: "email", key: "email", label: "Email", maxlength: "254", required: true },
          { kind: "text", type: "number", key: "days", label: "Days the invite works", value: 7, min: "1", max: "30" }, { kind: "reason" }],
        vals2: (v) => ({ name: v.name, email: v.email }),
        check: (v) => (!v.name || !/^[^@\s]+@[^@\s]+$/.test(v.email) ? "Write a name and an email."
          : !(Number.isInteger(v.days) && v.days >= 1 && v.days <= 30) ? MSG.need.days : ""),
        run: (v) => api("POST", "requests/new", { kind: "meet.invite", target: { name: v.name, email: v.email, days: v.days || 7 }, reason: v.reason }),
      });
    }) : null;
    return [head(PAGE_LABEL.meet.people, invite), d.seats ? panel(null, el("p", null, fill(W["seats.summary"], { seated: d.seats.used, users: d.seats.users }))) : null,
      panel(null, dataTable({
        caption: PAGE_LABEL.meet.people, rows: people, total: d.total, empty: W["empty.people"],
        text: (p) => [p.name, p.principal, p.org ? p.org.label : ""].join(" "), q: c.q.get("q") || "",
        chips: { label: "State", options: PERSON_STATES, of: (p) => p.state }, chip: c.q.get("state") || "",
        select: orgOpts.length ? { label: "Organization", options: orgOpts, of: (p) => (p.org ? p.org.id : "") } : null, sel: c.q.get("org") || "",
        name: nameOf,
        cols: [{ key: "name", label: "Name", cell: (p) => u(nameOf(p)), sort: nameOf }, { key: "principal", label: "Email" },
          { key: "org", label: "Organization", cell: (p) => u(p.org ? p.org.label || p.org.id : ""), sort: (p) => (p.org ? p.org.label : null) },
          { key: "devices", label: "Devices", cell: (p) => String((p.devices || []).length), sort: (p) => (p.devices || []).length },
          { key: "state", label: "State", cell: (p) => stChip((PERSON_STATES.find((s) => s[0] === p.state) || [0, p.state])[1], p.state === "online" ? "ok" : p.state === "waiting" ? "warn" : "none") },
          { key: "lastSeen", label: "Last seen", cell: (p) => when(lastSeenOf(p)), sort: lastSeenOf }],
        actions: (p) => [{ label: "Show devices", run: () => showPerson(p) }],
      })), side];
  };
  function orgSet(p, orgList) {
    const name = p.name || p.principal;
    const opts = orgList.map((o) => [o.id, o.label || o.id]);
    const orgOf = (id) => orgList.find((o) => o.id === id);
    confirmDialog({
      dlg: "org-set", vals: { name, org: opts.length ? opts[0][1] : "" }, name, id: p.principal,
      fields: [opts.length ? { kind: "select", key: "id", label: "Organization", options: opts } : { kind: "text", key: "id", label: "Organization id", maxlength: "64", required: true },
        opts.length ? null : { kind: "text", key: "label", label: "Organization name", maxlength: "80" }, { kind: "reason" }].filter(Boolean),
      vals2: (v) => ({ org: orgOf(v.id) ? orgOf(v.id).label || v.id : v.label || v.id }),
      two: (v) => {
        const o = orgOf(v.id);
        return !!(p.org || !o || o.bridgesOn || o.orgAdmins > 0);
      },
      check: (v) => (!v.id ? "Choose an organization." : ""),
      run: (v) => {
        const o = orgOf(v.id);
        const label = o ? o.label || v.id : v.label || v.id;
        return post("meet/organizations", { principal: p.principal, id: v.id, label, reason: v.reason }, { action: "meet.org.set", target: p.principal });
      },
    });
  }
  function orgRemove(p) {
    const name = p.name || p.principal;
    const org = p.org.label || p.org.id;
    confirmDialog({
      dlg: "org-move", vals: { name, org }, name, id: p.principal, two: true, danger: true, fields: [{ kind: "reason" }],
      run: (v) => post("meet/organizations", { principal: p.principal, remove: true, reason: v.reason }, { action: "meet.org.set", target: p.principal }),
    });
  }

  // ---- Lucid Meet password accounts (ADR-0343) ----
  // The accounts are the fleet console's own, not a relay's: every call is direct, never through the relay proxy, and
  // the section shows above the relay picker whatever the relay page does.
  const MA = FMSG.accounts;
  const accountName = (x) => x.name || x.username || x.email;
  const meetAccountsApi = (path, body) => api("POST", "meet/accounts/" + path, body, { direct: true });
  function withMeetAccounts(fn) {
    return async (c) => {
      const [kids, acc] = await Promise.all([fn(c), meetAccounts()]);
      const list = [].concat(kids).filter(Boolean);
      list.splice(1, 0, acc);
      return list;
    };
  }
  // After a change the page reloads; focus goes to what the change produced, else to the section's heading.
  function accountsRefresh(result) {
    return render({ keepMessages: true }).then(() => {
      const out = $("meet-accounts-out");
      if (out && result) out.replaceChildren(...result());
      const h = $("meet-accounts-result-h") || $("meet-accounts-h");
      if (h) h.focus();
    });
  }
  async function meetAccounts() {
    let d;
    try {
      d = await api("GET", "meet/accounts", null, { direct: true });
    } catch (e) {
      if (e && e.status === 401) throw e;
      if (e && e.status === 403) return null;
      return section("meet-accounts-h", MA.title, el("p", { class: "dlg-error", role: "alert" }, clean(e && e.message ? e.message : String(e))));
    }
    if (!d.enabled) {
      return section("meet-accounts-h", MA.title, el("p", null, MA.off), el("p", null, MA.offHow, " ", el("code", { class: "cmd" }, MA.importCmd)),
        el("p", null, MA.offCheck, " ", el("code", { class: "cmd" }, MA.statusCmd)), brandingLink());
    }
    const admin = isAdmin();
    const relay = d.relay || {};
    const always = d.autoApprove || [];
    const auto = d.approval === "auto";
    const modeWord = (m) => (m === "auto" ? MA.auto : MA.queue);
    let approval = null;
    if (admin) {
      const group = uid("appr");
      // each hint sits under its own choice, so neither reads as the current behavior
      const radio = (value, label, note, on) => {
        const id = uid("appr");
        const r = el("input", { type: "radio", id, name: group, value, checked: on ? true : null });
        return [r, el("div", null, el("label", { class: "inline", for: id }, r, label), el("p", { class: "note" }, note))];
      };
      const queueR = radio("queue", MA.queue, MA.queueNote, !auto);
      const autoR = radio("auto", MA.auto, MA.autoNote, auto);
      approval = el("div", null, el("fieldset", { class: "choice" }, el("legend", null, MA.approval), queueR[1], autoR[1]),
        btn(MA.save, async () => {
          const r = await meetAccountsApi("approval", { mode: autoR[0].checked ? "auto" : "queue" });
          say(fillText(MA.saved, { mode: modeWord(r.approval) }));
          await accountsRefresh(null);
        }));
    }
    const stateOf = (x) => (!x.locked ? MA.active : x.locked_until ? fillText(MA.lockedUntil, { time: whenAny(x.locked_until) }) : MA.locked);
    return section("meet-accounts-h", MA.title,
      el("p", null, fill(MA.howSignIn, { org: code(d.org) })),
      pairs([[MA.signIn, onOff(true)], [MA.org, code(d.org)], [MA.relay, relay.configured ? relay.name : MA.relayNone],
        [MA.testflight, onOff(d.testflight && d.testflight.on)], [MA.always, always.length ? always.join(", ") : undefined],
        [MA.approval, admin ? undefined : modeWord(d.approval)]]),
      brandingLink(),
      approval,
      admin ? el("div", { class: "page-head" }, btn(MA.inviteBtn, inviteAccount, "primary")) : null,
      el("div", { id: "meet-accounts-out" }),
      dataTable({
        caption: MA.accounts, rows: d.accounts || [], empty: MA.noAccounts, name: accountName, text: (x) => [x.name, x.username, x.email].join(" "),
        cols: [{ key: "name", label: MA.cols.name, cell: (x) => u(x.name || ""), sort: accountName }, { key: "username", label: MA.cols.username, cell: (x) => code(x.username) },
          { key: "email", label: MA.cols.email }, { key: "last_signin", label: MA.cols.last, cell: (x) => whenAny(x.last_signin) },
          { key: "locked", label: MA.cols.state, cell: (x) => el("span", { class: "st st-" + (x.locked ? "bad" : "ok") }, stateOf(x)), sort: stateOf },
          { key: "by", label: MA.cols.by }],
        actions: admin ? (x) => [{ label: MA.resetBtn, run: () => resetAccount(x) },
          x.locked ? { label: MA.unlock, run: async () => {
            await meetAccountsApi("unlock", { username: x.username });
            say(fillText(MA.unlocked, { name: accountName(x) }));
            await accountsRefresh(null);
          } } : null,
          { label: MA.remove, run: () => removeAccount(x) }] : null,
      }),
      dataTable({
        caption: MA.invites, rows: d.invites || [], empty: MSG.noneYet, name: (i) => i.name || i.email,
        cols: [{ key: "name", label: MA.cols.name, cell: (i) => u(i.name || "") }, { key: "email", label: MA.cols.email },
          { key: "created", label: MA.cols.sent, cell: (i) => whenAny(i.created) }, { key: "expires", label: MA.cols.expires, cell: (i) => whenAny(i.expires) },
          { key: "reset", label: MA.cols.kind, cell: (i) => (i.reset ? MA.kindReset : MA.kindInvite), sort: (i) => (i.reset ? MA.kindReset : MA.kindInvite) }],
      }));
  }
  function inviteAccount() {
    confirmDialog({
      spec: MA.inviteDlg, vals: {}, plain: true,
      fields: [{ kind: "text", key: "name", label: MA.cols.name, maxlength: "80", required: true },
        { kind: "text", type: "email", key: "email", label: MA.cols.email, maxlength: "254", required: true }],
      check: (v) => (!v.name ? MSG.need.personName : !/^[^@\s]+@[^@\s]+$/.test(v.email) ? MSG.emailNeeded : ""),
      run: (v) => meetAccountsApi("invite", { name: v.name, email: v.email }),
      done: (r) => accountsRefresh(() => accountResult(r, "invite")),
    });
  }
  function resetAccount(x) {
    const name = accountName(x);
    confirmDialog({
      spec: MA.resetDlg, vals: { name, username: x.username }, name, id: x.username, plain: true,
      run: () => meetAccountsApi("reset", { username: x.username }),
      done: (r) => accountsRefresh(() => accountResult(r, "reset")),
    });
  }
  function removeAccount(x) {
    const name = accountName(x);
    confirmDialog({
      spec: MA.removeDlg, vals: { name }, name, id: x.username, danger: true, plain: true,
      run: () => meetAccountsApi("remove", { username: x.username }),
      done: () => accountsRefresh(null),
    });
  }
  // What an invite or reset did: the email sent, or its text to send by hand; TestFlight for an invite; the link's end.
  function accountResult(r, kind) {
    if (!r) return [];
    const draft = r.mail !== "sent" ? r.email_draft : null;
    const body = draft ? cleanLines(draft.body || "") : "";
    const mail = r.mail === "sent" ? MA.mailSent : r.mail === "failed" ? MA.mailFailed : MA.mailUnset;
    const tf = kind === "invite" && r.testflight ? MA.tf[r.testflight.status] : null;
    return [el("div", { class: "subpanel" },
      el("h4", { id: "meet-accounts-result-h", tabindex: "-1" }, fill(MA.result[kind], { name: r.name || r.username || r.email })),
      el("p", null, fill(mail, { email: r.email })),
      draft ? [pairs([[MA.to, draft.to], [MA.subject, draft.subject]]), el("p", { class: "note" }, MA.draft), el("pre", { class: "request-text" }, body),
        copyButton(body, MA.copyDraft)] : null,
      tf ? el("p", null, fill(tf, { email: r.email, message: r.testflight.message || "" })) : null,
      r.expires ? el("p", null, fill(MA.expires, { time: whenAny(r.expires) })) : null)];
  }

  // Seats (R4-2, 7.4): admins and user managers.
  pages.meet_seats = async (c) => {
    const [d, clockNow, lic] = await Promise.all([api("GET", "meet/seats"), isAdmin() ? api("GET", "meet/clock").catch(() => null) : null, meetLicense()]);
    const [sSeated, sPicked, sNone, sKeeps] = W["seats.state"];
    const [aGive, aKeep] = W["seats.actions"];
    const clock = d.clock;
    const over = Math.max(0, (d.seated || 0) - (d.users || 0));
    const unseatDate = clock ? dayAny(clock.unseatAt) : "";
    // R42-1: while service is stopped, seats.stopped instead of the summary.
    const summary = [el("p", null, d.service === "stopped" || serviceStopped(lic) ? W["seats.stopped"]
      : d.users != null ? fill(W["seats.summary"], { seated: d.seated, users: d.users }) : MSG.unknown)];
    const kids = [head(PAGE_LABEL.meet.seats), panel(null, ...summary,
      clock ? el("p", null, fill(W["attention.seats-over"], { used: d.seated, users: d.users, day: clock.day, n: over, date: unseatDate })) : null,
      clock ? el("p", null, W["help.seats"]) : null,
      d.held > 0 ? el("p", null, fill(W["attention.seats-held"], { n: d.held }), " ", isAdmin() ? btn(W["clock.title.button"], () => confirmTime(clockNow)) : null) : null,
      d.held > 0 ? null : clockHold(clockNow),
      d.migrated ? el("p", { class: "note" }, W["seats.migrated"]) : null)];
    if (!clock) kids.push(help("help.seats"));
    const nameOf = (p) => p.name || p.principal;
    // A held person (R4-M1) keeps the seat record but has no service until the time is confirmed: shown as "No seat"
    // with the time the hold began.
    const seatWord = (p) => (p.protected ? sKeeps : !p.seated || p.heldAt ? sNone : p.picked ? sPicked : sSeated);
    const pick = (p, on) => confirmDialog({
      dlg: on ? "seat-pick" : "seat-unpick", vals: { name: nameOf(p), date: unseatDate }, name: nameOf(p), id: p.principal, danger: on,
      body: (v) => [fill(D[on ? "seat-pick" : "seat-unpick"].body[0], v)],
      run: () => post("meet/seats/pick", { principal: p.principal, pick: on }, { action: "meet.seats.pick", target: p.principal }),
    });
    kids.push(panel(null, dataTable({
      caption: PAGE_LABEL.meet.seats, rows: d.people || [], empty: W["empty.seats-meet"], text: (p) => [p.name, p.principal].join(" "), name: nameOf,
      cols: [{ key: "name", label: "Name", cell: (p) => u(nameOf(p)), sort: nameOf }, { key: "principal", label: "Principal", cell: (p) => code(p.principal) },
        { key: "firstSeenAt", label: "First device seen", cell: (p) => when(p.firstSeenAt) },
        { key: "seat", label: "Seat", cell: (p) => stChip(seatWord(p), p.protected || (p.seated && !p.picked && !p.heldAt) ? "ok" : p.seated && !p.heldAt ? "warn" : "bad"), sort: seatWord },
        { key: "heldAt", label: MSG.held, cell: (p) => (p.heldAt ? when(p.heldAt) : "") }],
      actions: (p) => (isManager() && clock && p.seated && !p.protected ? [p.picked ? { label: aKeep, run: () => pick(p, false) } : { label: aGive, run: () => pick(p, true) }] : []),
    })));
    if (isAdmin()) {
      const w = textField(W["seats.request.field"], { type: "number", min: String((d.users || 0) + 1), max: "10000", inputmode: "numeric" });
      const out = el("div", { role: "status" });
      kids.push(panel(W["seats.request"], w.box, btn(W["seats.request.button"], () => {
        const n = Number(w.input.value);
        if (!(Number.isInteger(n) && n > (d.users || 0) && n <= 10000)) {
          invalid(w.input, fillText(MSG.wantedNeeded, { users: d.users || 0 }));
          return;
        }
        confirmDialog({
          dlg: "seat-request", vals: { n, address: d.requestTo || "", seated: d.seated }, plain: true,
          run: () => api("POST", "meet/seats/request", { wanted: n }),
          done: (r) => {
            if (!r) return;
            const text = cleanLines(r.text || "");
            out.replaceChildren(el("p", null, r.mailed ? fill(W["seats.request-sent"], { address: r.to }) : W["seats.request-copy"]),
              el("pre", { class: "request-text" }, text), copyButton(text, r.mailed ? W["seats.request-sent.button"] : W["seats.request-copy.button"]));
          },
        });
      }, "primary"), out));
      if (c.q.get("request")) setTimeout(() => w.input.focus(), 0);
    }
    return kids;
  };
  pages.meet_enrollments = async () => {
    const d = await api("GET", "meet/enrollments");
    const rows = d.waiting || [];
    const ask = (w, decision) => {
      const name = w.name || w.principal;
      newRequest(decision === "approve" ? "request-approve" : "request-refuse", { name, device: w.device, check: w.check }, name, w.id, "meet.approve",
        { kind: w.kind, id: w.id, csr_sha256: w.csr_sha256, decision },
        { params: [["Kind", w.kind], ["Check code", code(w.check)], ["CSR SHA-256", code(w.csr_sha256)]] });
    };
    return [head(PAGE_LABEL.meet.enrollments), banner("warn", MSG.sev.info, W["help.meet-signing"]), panel(null, dataTable({
      caption: PAGE_LABEL.meet.enrollments, rows, empty: W["empty.enrollments"], text: (w) => [w.name, w.principal, w.device, w.check].join(" "),
      name: (w) => (w.name || w.principal) + " " + (w.device || ""),
      cols: [{ key: "name", label: "Person", cell: (w) => u(w.name || w.principal) }, { key: "device", label: "Device" }, { key: "kind", label: "Kind", cell: (w) => stateWord(w.kind) },
        { key: "check", label: "Check code", cell: (w) => code(w.check) }, { key: "at", label: "Asked", cell: (w) => when(w.at) },
        { key: "request", label: "Request", cell: (w) => (w.request ? code(w.request) : "") }],
      actions: (w) => {
        if (w.request || !isAdmin()) return [];
        return canWrite() ? [{ label: "Ask an admin to approve", run: () => ask(w, "approve") }, { label: "Ask an admin to refuse", run: () => ask(w, "refuse") }] : [];
      },
    }))];
  };
  pages.meet_organizations = async () => {
    const d = await api("GET", "meet/organizations");
    return [head(PAGE_LABEL.meet.organizations), help("help.meet-policies"), panel(null, dataTable({
      caption: PAGE_LABEL.meet.organizations, rows: d.organizations || [], empty: W["empty.organizations"], text: (o) => [o.id, o.label].join(" "), name: (o) => o.label || o.id,
      cols: [{ key: "label", label: "Organization", cell: (o) => u(o.label || o.id) }, { key: "id", label: W["dialog.id"], cell: (o) => code(o.id) }, { key: "members", label: "Members" },
        { key: "bridgesOn", label: "Bridges", cell: (o) => onOff(o.bridgesOn) }, { key: "orgAdmins", label: "Org admins" },
        { key: "policy", label: "Policy", cell: (o) => (o.policy ? "Version " + o.policy.seq + ", " + clean(o.policy.issued) : MSG.no), sortable: false },
        { key: "watch", label: "Apple Watch", cell: (o) => (o.policy && o.policy.watch === "allow" ? "Allowed" : "Off"), sortable: false },
        { key: "lowering", label: "Pending lowering", cell: (o) => (o.policy && o.policy.pending_lowering ? u(clean(o.policy.pending_lowering.effective_at) + ": " + clean(o.policy.pending_lowering.reason)) : ""), sortable: false }],
    }))];
  };
  // ---- Relay answers as words: field names as labels, times formatted, lists and objects as text, never JSON ----
  const FIELD_WORDS = {
    version: "Version", started: "Started", uptime_s: "Up for", window_s: "Time window", window_ends: "Window ends", window_estimate: "Window is an estimate",
    configured: "Set up", healthy: "Healthy", error: "Error", state: "State", hint: "Note", since: "Since", days_left: "Days left",
    not_after: "Certificate ends", root_mode: "Root mode", intermediate_serial: "Intermediate serial", previous_serial: "Previous serial",
    previous_not_after: "Previous certificate ends", root_not_after: "Root certificate ends", root_crl_days_left: "Days left on the root revocation list",
    root_days_left: "Days left on the root revocation list", pending_key: "Key waiting", ledger_seq: "Ledger entry", ledger_head: "Ledger head",
    policy: "Policy", next_update: "Next update", published: "Published", vmid: "VM", node: "Proxmox node", people_online: "People online",
    devices_online: "Devices online", participants: "People in calls", online: "Online now", rooms: "Rooms", room: "Room", release: "Release",
    signer: "Signer", files: "Download server", relay: "Relay", enabled: "On", send: "Sent to partners", receive: "Taken from partners",
    partners: "Partners", file_max_mb: "Largest file (MB)", notice: "Notice", dms: "Direct messages", file_links: "File links",
    file_link_hours: "File links last (hours)", backfill_send: "Backfill sent (messages)", backfill_receive: "Backfill taken (messages)",
    ts: "Time", at: "Time", actor: "Actor", action: "Action", org: "Organization", platform: "Platform", kind: "Kind", serial: "Serial",
    subject: "Subject", principal: "Person", name: "Name", reason: "Reason", detail: "Detail", id: W["dialog.id"], seq: "Entry", result: "Result",
  };
  const TIME_KEY = /(?:^|_)(?:at|ts|time|since|started|published|updated|ends|until|after|update)$|(?:At|After|Until)$/;
  const fieldWord = (k) => FIELD_WORDS[k] || stateWord(String(k).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()).replace(/\bmb\b/gi, "MB").replace(/\bid\b/gi, "ID");
  function plainValue(k, v) {
    if (v == null || v === "") return "";
    if (typeof v === "boolean") return yesNo(v);
    if (Array.isArray(v)) {
      if (!v.length) return MSG.none;
      return v.map((x) => plainValue("", x)).join(v.some((x) => x && typeof x === "object") ? "; " : ", ");
    }
    if (typeof v === "object") {
      return Object.entries(v).filter(([, x]) => x != null && x !== "").map(([a, x]) => fieldWord(a) + ": " + plainValue(a, x)).join(", ");
    }
    if (typeof v === "number" && /_s$/.test(k)) return span(v);
    if (TIME_KEY.test(k) && (typeof v === "number" ? v > 1e8 : DATE_TEXT.test(String(v).trim())) && dateOf(v, "any")) return whenAny(v);
    return clean(String(v));
  }
  function genericTable(caption, rows, empty) {
    const keys = [...new Set(rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))].slice(0, 8);
    return dataTable({
      caption, rows, empty, text: (r) => keys.map((k) => plainValue(k, r[k])).join(" "), name: (r) => plainValue(keys[0], r[keys[0]]),
      cols: keys.map((k) => ({ key: k, label: fieldWord(k), cell: (r) => u(plainValue(k, r[k])), sort: (r) => (r[k] != null && typeof r[k] === "object" ? plainValue(k, r[k]) : r[k]) })),
    });
  }
  // Key and value pairs of an object; a nested object becomes its own pairs.
  function objPairs(o) {
    return pairs(Object.entries(o || {}).map(([k, v]) => [fieldWord(k), v && typeof v === "object" && !Array.isArray(v) ? objPairs(v) : plainValue(k, v)]));
  }
  function crlUploadMeet() {
    const { box, area } = pasteOrFile("Revocation list (PEM)", ".pem,.crl,.txt");
    return panel("Upload a revocation list", box, btn("Upload a revocation list", () => {
      const facts = crlFacts(area.value);
      if (!facts) {
        fail(fillText(R["crl-refused"], { reason: MSG.unreadable }));
        return;
      }
      confirmDialog({
        dlg: "crl", vals: { v: facts.version || MSG.unknown, n: facts.n }, params: [["Lists", facts.lists], ["Certificates", facts.n]],
        run: () => post("meet/crl", { crl_pem: area.value.trim() }, { action: "meet.crl", target: "-" }),
      });
    }, "primary"));
  }
  pages.meet_signer = async () => {
    const d = await api("GET", "meet/signer");
    const s = d.signer || {};
    return [head(PAGE_LABEL.meet.signer), panel("Signer", Object.keys(s).length ? objPairs(s) : emptyLine(MSG.notSet)), panel("Revocation", objPairs(d.crl)),
      isAdmin() ? crlUploadMeet() : null, panel(null, genericTable("Ledger, newest first", (d.ledger || []).slice(0, 100), MSG.noneYet))];
  };
  function policyLines(p) {
    return JSON.stringify(p || {}, null, 2).split("\n");
  }
  function lineDiff(a, b) {
    const ul = el("ul", { class: "diff" });
    const x = policyLines(a), y = policyLines(b);
    const setX = new Set(x), setY = new Set(y);
    for (const l of x) if (!setY.has(l)) ul.append(el("li", { class: "old" }, u(l)));
    for (const l of y) if (!setX.has(l)) ul.append(el("li", { class: "new" }, u(l)));
    return ul;
  }
  pages.meet_bridges = async () => {
    const [d, a, orgs] = await Promise.all([api("GET", "meet/bridge"), api("GET", "meet/bridge/audit?limit=100").catch(() => ({ rows: [] })),
      api("GET", "meet/organizations").catch(() => ({ organizations: [] }))]);
    const labels = Object.assign({ [BRIDGE_NONE]: BRIDGE_NONE_LABEL }, Object.fromEntries((orgs.organizations || []).map((o) => [o.id, o.label || o.id])));
    const all = d.policies || {};
    // Only bridges that are on are shown; an organization without one has the off policy, which says nothing.
    const on = Object.entries(all).filter(([, p]) => p && p.enabled);
    const add = canWrite() ? btn(BRIDGE_ADD, () => bridgeAdd(all, labels), "primary") : null;
    const kids = [head(PAGE_LABEL.meet.bridges, add), help("help.meet-policies")];
    if (!on.length) kids.push(panel(null, emptyLine(W["empty.bridges"])));
    for (const [org, p] of on) {
      const label = labels[org] || org;
      kids.push(panel(null, el("h3", null, u(label)), org === BRIDGE_NONE ? null : el("p", { class: "id-line" }, el("span", { class: "id-label" }, W["dialog.id"]), code(org)),
        bridgePairs(p, labels),
        el("div", { class: "page-head" },
          isAdmin() ? btn(MSG.turnOff, () => confirmDialog({
            dlg: "bridge-off", vals: { org: label, "platform list": bridgePartners(p, labels) }, name: label, id: org, danger: true, fields: [{ kind: "reason" }],
            run: (v) => post("meet/bridge", { org, policy: Object.assign({}, p, { enabled: false }), reason: v.reason }, { action: "meet.bridge.set", target: org }),
          })) : null,
          canWrite() ? btn("Change", () => bridgeChange(org, label, p)) : null)));
    }
    const rows = a.rows || a.audit || a.entries || [];
    kids.push(panel(null, genericTable("Bridge audit", rows, MSG.noEntries)));
    return kids;
  };
  // Bridges (BR-1): the org id of people with no organization, the kinds a policy carries, and its fields as words.
  const BRIDGE_NONE = "_none";
  const BRIDGE_NONE_LABEL = "People with no organization";
  const BRIDGE_ADD = "Add a bridge";
  const BRIDGE_KINDS = { text: "Messages", edits: "Edits", deletes: "Deletes", reactions: "Reactions", files: "Files", calls: "Calls" };
  // The relay's off policy (meet_bridge.rs off_policy): the starting point of a new bridge.
  const BRIDGE_OFF = { enabled: false, send: [], receive: [], partners: [], file_max_mb: 25, notice: "", dms: false, file_links: false, file_link_hours: 24,
    backfill_send: 0, backfill_receive: 0 };
  const bridgePartners = (p, labels, cap) => ((p.partners || []).includes("*") ? (cap ? "Any organization" : "any organization")
    : (p.partners || []).length ? p.partners.map((x) => labels[x] || x).join(", ") : cap ? MSG.none : "no one");
  function bridgePairs(p, labels) {
    const kinds = (list) => ((list || []).length ? list.map((k) => BRIDGE_KINDS[k] || stateWord(k)).join(", ") : MSG.none);
    return pairs([[FIELD_WORDS.send, kinds(p.send)], [FIELD_WORDS.receive, kinds(p.receive)], [FIELD_WORDS.partners, bridgePartners(p, labels, true)],
      [FIELD_WORDS.file_max_mb, p.file_max_mb != null ? String(p.file_max_mb) : undefined], [FIELD_WORDS.notice, p.notice || MSG.none],
      [FIELD_WORDS.dms, yesNo(p.dms)], [FIELD_WORDS.file_link_hours, p.file_links ? String(p.file_link_hours || 0) : MSG.off],
      [FIELD_WORDS.backfill_send, String(p.backfill_send || 0)], [FIELD_WORDS.backfill_receive, String(p.backfill_receive || 0)]]);
  }
  // Add a bridge: pick the organization, then the same change dialog with that organization's policy turned on.
  async function bridgeAdd(all, labels) {
    const opts = Object.keys(labels).filter((id) => !(all[id] && all[id].enabled)).map((id) => [id, labels[id]]);
    const r = await confirmDialog({
      spec: { title: BRIDGE_ADD, body: ["Choose the organization whose people the bridge serves. Next you set what it carries."], button: [FW["deploy.continue"]] },
      fields: [{ kind: "select", key: "org", label: FIELD_WORDS.org, options: opts, value: opts.length ? opts[0][0] : "" }],
      check: (v) => (!v.org ? "Choose an organization." : ""),
      plain: true,
      run: async (v) => ({ org: v.org }),
      done: () => clearMessages(),
    });
    if (!r || !r.org) return;
    const now = Object.assign({}, BRIDGE_OFF, all[r.org] || {});
    bridgeChange(r.org, labels[r.org] || r.org, now, Object.assign({}, now, { enabled: true }));
  }
  // `start` is the policy the text area opens with (a new bridge starts on); the diff is against `p`, the policy now.
  function bridgeChange(org, label, p, start) {
    confirmDialog({
      dlg: "bridge-change", vals: { org: label }, name: label, id: org, two: true,
      fields: [{ kind: "textarea", key: "policy", label: "Policy (JSON)", value: JSON.stringify(start || p, null, 2) }, { kind: "reason" }],
      body: (v, cur) => {
        let next = null;
        try {
          next = JSON.parse(cur.policy);
        } catch (e) {
          next = null;
        }
        return [el("p", null, fill(D["bridge-change"].body[0], { diff: next ? lineDiff(p, next) : u(MSG.unreadable) }))];
      },
      check: (v) => {
        try {
          JSON.parse(v.policy);
          return "";
        } catch (e) {
          return MSG.unreadable;
        }
      },
      run: (v) => post("meet/bridge", { org, policy: JSON.parse(v.policy), reason: v.reason }, { action: "meet.bridge.set", target: org }),
    });
  }
  function placeHold() {
    confirmDialog({
      dlg: "hold-place", vals: { n: 0 },
      fields: [{ kind: "select", key: "on", label: "Hold", options: [["people", "People"], ["conversations", "Conversations"]] },
        { kind: "textarea", key: "items", label: "One email or conversation id per line" }, { kind: "reason" }],
      vals2: (v) => ({ n: itemsOf(v.items).length }),
      two: (v) => itemsOf(v.items).length > 10,
      check: (v) => (!itemsOf(v.items).length ? "Name at least one person or conversation." : ""),
      run: (v) => {
        const items = itemsOf(v.items);
        const body = v.on === "people" ? { on: "people", principals: items, reason: v.reason } : { on: "conversations", cids: items, reason: v.reason };
        return post("meet/holds", body, { action: "meet.holds.place", target: "-" });
      },
    });
  }
  const itemsOf = (t) => [...new Set(String(t || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];
  pages.meet_holds = async () => {
    const d = await api("GET", "meet/holds");
    const holds = d.holds || [];
    const now = Date.now();
    return [head(PAGE_LABEL.meet.holds, isAdmin() ? btn("Place a hold", placeHold, "primary") : null), panel(null, dataTable({
      caption: PAGE_LABEL.meet.holds, rows: holds, empty: W["empty.holds"], text: (h) => [h.id, h.reason, h.by, (h.principals || []).join(" ")].join(" "), name: (h) => h.reason || h.id,
      cols: [{ key: "reason", label: "Reason" }, { key: "on", label: "On", cell: (h) => stateWord(h.on) },
        { key: "items", label: "Items", cell: (h) => String((h.principals || h.cids || []).length), sort: (h) => (h.principals || h.cids || []).length },
        { key: "placedBy", label: "Placed by", cell: (h) => u(h.placedBy || h.by) }, { key: "placedAt", label: "Placed", cell: (h) => (h.placedAt ? when(h.placedAt) : whenSec(h.placed)) },
        { key: "path", label: "How", cell: (h) => (h.path === "approved" ? "Two admins" : h.path === "single" ? "One admin" : "") },
        { key: "released", label: "Released", cell: (h) => (h.released ? whenSec(h.released) : "") }, { key: "id", label: W["dialog.id"], cell: (h) => code(h.id) }],
      actions: (h) => (canWrite() && !h.released ? [{
        label: "Release", run: () => {
          const placed = h.placedAt || (h.placed ? h.placed * 1000 : 0);
          const single = (h.placedBy || h.by) === myEmail() && h.path !== "approved" && now - placed < 86400000;
          confirmDialog({
            dlg: "hold-release", vals: { reason: h.reason }, name: h.reason, id: h.id, two: !single, fields: [{ kind: "reason" }],
            run: (v) => post("meet/holds/release", { id: h.id, reason: v.reason }, { action: "meet.holds.release", target: h.id }),
          });
        },
      }] : []),
    }))];
  };

  // Support (SE-1, src/meet_support.rs): tickets people's Meeting Hubs filed when their built-in support engineer
  // could not solve a problem. An admin reads the conversation, answers or closes it; the Hub shows the answer.
  const SUPPORT_STATE = { open: ["Waiting for you", "warn"], answered: ["Answered", "ok"], closed: ["Closed", "none"] };
  const supportWho = (t, m) => (m.by === "admin" ? (m.who || "Admin") : (t.name ? `${t.name} (${t.principal})` : t.principal));
  function answerTicket(t) {
    confirmDialog({
      dlg: "support-answer", vals: { title: t.title }, name: t.title, id: t.id,
      body: () => [fill(D["support-answer"].body[0], {}), ...(t.messages || []).map((m) => `${supportWho(t, m)}: ${m.text}`)],
      fields: [{ kind: "textarea", key: "text", label: "Your answer", maxlength: 20000 }],
      check: (v) => (!String(v.text || "").trim() ? "Write an answer first." : ""),
      run: (v) => post("meet/support/answer", { id: t.id, text: v.text }, { action: "meet.support.answer", target: t.id }),
    });
  }
  function closeTicket(t) {
    confirmDialog({
      dlg: "support-close", vals: { title: t.title }, name: t.title, id: t.id, plain: true,
      run: () => post("meet/support/close", { id: t.id }, { action: "meet.support.close", target: t.id }),
    });
  }
  pages.meet_support = async (c) => {
    const d = await api("GET", "meet/support?state=all");
    const rows = d.tickets || [];
    const last = (t) => (t.messages || [])[(t.messages || []).length - 1];
    return [head(PAGE_LABEL.meet.support), help("help.support"), panel(null, dataTable({
      caption: PAGE_LABEL.meet.support, rows, total: rows.length, empty: W["empty.support"],
      text: (t) => [t.id, t.title, t.principal, t.name, ...(t.messages || []).map((m) => m.text)].join(" "),
      chips: { label: "State", options: Object.entries(SUPPORT_STATE).map(([k, v]) => [k, v[0]]), of: (t) => t.state }, chip: (c && c.q && c.q.get("state")) || "open",
      name: (t) => t.title,
      cols: [
        { key: "title", label: "Ticket" },
        { key: "principal", label: "From", cell: (t) => u(t.name ? `${t.name} (${t.principal})` : t.principal) },
        { key: "last", label: "Last message", cell: (t) => { const m = last(t); return m ? `${m.by === "admin" ? "Answer: " : ""}${String(m.text).slice(0, 160)}` : ""; }, sortable: false },
        { key: "updated", label: "Updated", cell: (t) => when(t.updated) },
        { key: "state", label: "State", cell: (t) => el("span", { class: "st st-" + (SUPPORT_STATE[t.state] || ["", "none"])[1] }, (SUPPORT_STATE[t.state] || [t.state])[0]) },
        { key: "version", label: "Meeting Hub" },
        { key: "id", label: W["dialog.id"], cell: (t) => code(t.id) },
      ],
      actions: (t) => (isAdmin() && t.state !== "closed" ? [{ label: "Answer", run: () => answerTicket(t) }, { label: "Close", run: () => closeTicket(t) }] : []),
    }))];
  };

  // Settings > AI (AI-1 section 9): the staged save signed map first then policy, gateways and cards, usage, the hold
  // on a person and the archive by organization size. Every write goes through the relay, which re-checks it.
  const lines = (t) => [...new Set(String(t || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];
  const aiQ = (org) => (org ? "?org=" + encodeURIComponent(org) : "");
  function aiJSON(text) {
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  }
  function aiSettings(d) {
    const ai = d.ai || {};
    const map = d.map || {};
    const presetOptions = (d.presets || []).map((p) => [p.id, AIW.presets[p.id] || p.label]).concat([["advanced", AIW.presets.advanced]]);
    confirmDialog({
      spec: AIW.dlg.save, vals: { org: d.org }, name: d.org, id: d.org,
      fields: [
        { kind: "textarea", key: "groups", label: AIW.groups, value: ((ai.who || {}).groups || []).join("\n") },
        { kind: "textarea", key: "people", label: AIW.people, value: (map.who_principals || []).join("\n") },
        { kind: "select", key: "preset", label: AIW.preset, options: presetOptions, value: d.preset || d.default },
        { kind: "textarea", key: "ai", label: AIW.advancedAi, value: JSON.stringify(Object.assign({}, ai.v ? ai : {}), null, 2) },
        { kind: "textarea", key: "map", label: AIW.advancedMap, value: JSON.stringify({ channel_classes: map.channel_classes || {}, excluded_channels: map.excluded_channels || [] }, null, 2) },
      ],
      specFor: () => Object.assign({}, AIW.dlg.save, { button: [AIW.review] }),
      check: (v) => (v.preset === "advanced" && (!aiJSON(v.ai || "{}") || !aiJSON(v.map || "{}")) ? MSG.unreadable : ""),
      run: (v) => {
        const fields = v.preset === "advanced" ? aiJSON(v.ai || "{}") || {} : {};
        delete fields.map_sha256;
        fields.who = Object.assign({}, fields.who || ai.who || {}, { groups: lines(v.groups) });
        const mapFields = Object.assign(v.preset === "advanced" ? aiJSON(v.map || "{}") || {} : {}, { who_principals: lines(v.people) });
        return post("meet/ai/stage", { org: d.org, preset: v.preset, ai: fields, map: mapFields }, { action: "meet.ai.stage", target: d.org });
      },
    });
  }
  function aiSave(d) {
    const s = d.staged;
    confirmDialog({
      spec: AIW.dlg.save, vals: { org: d.org }, name: d.org, id: s.id, two: true, fields: [{ kind: "reason" }],
      params: [[AIW.preset, AIW.presets[s.preset] || s.preset], ["map_sha256", s.map_sha256]],
      body: () => [el("p", null, AIW.dlg.save.body[0]), lineDiff(d.ai, s.ai)],
      run: (v) => post("meet/ai/save", { org: d.org, stage: s.id, reason: v.reason }, { action: "meet.ai.save", target: d.org }),
    });
  }
  function aiEnroll(d) {
    confirmDialog({
      spec: AIW.dlg.enroll, vals: { org: d.org }, name: d.org, id: d.org,
      fields: [{ key: "url", label: AIW.url }, { key: "principal", label: "Principal (ai@apps.<domain>)" }, { key: "device", label: "Device (16 hex)" },
        { key: "spki", label: "SPKI SHA-256 (64 hex)" }, { key: "region", label: "Region (optional)" }, { kind: "reason" }],
      run: (v) => {
        const body = { org: d.org, url: v.url, principal: v.principal, device: v.device, spki: v.spki, reason: v.reason };
        if (v.region) body.region = v.region;
        return post("meet/ai/gateways", body, { action: "meet.ai.gateway", target: d.org });
      },
    });
  }
  function aiCardsPanel(d, c) {
    return panel(AIW.cards, dataTable({
      caption: AIW.cards, rows: c.cards || [], empty: MSG.noneYet, text: (r) => [r.card_id, r.tier, r.model, r.status].join(" "), name: (r) => r.card_id,
      cols: [{ key: "card_id", label: W["dialog.id"], cell: (r) => code(r.card_id) }, { key: "tier", label: "Tier" }, { key: "model", label: "Model", cell: (r) => u(r.model) },
        { key: "precision", label: "Precision", cell: (r) => u(JSON.stringify(r.precision || null)), sortable: false },
        { key: "hardware", label: "Hardware", cell: (r) => u(JSON.stringify(r.hardware || null)), sortable: false },
        { key: "throughput", label: "Tested throughput", cell: (r) => u(JSON.stringify(r.throughput || null)), sortable: false },
        { key: "quality", label: "Quality", cell: (r) => u(JSON.stringify(r.quality || null)), sortable: false },
        { key: "status", label: "Status", cell: (r) => stateWord(r.status) }, { key: "retire_after", label: "Retire after", cell: (r) => u(r.retire_after) }],
      actions: (r) => (isAdmin() ? [{
        label: AIW.bench, run: () => confirmDialog({
          spec: AIW.dlg.bench, vals: { card: r.card_id }, name: r.card_id, id: r.gateway,
          run: () => post("meet/ai/cards/bench", { org: d.org, gateway: r.gateway, card_id: r.card_id }, { action: "meet.ai.bench", target: r.card_id }),
        }),
      }].concat(r.approvable ? [{
        label: AIW.approve, run: () => confirmDialog({
          spec: AIW.dlg.approve, vals: { card: r.card_id }, name: r.card_id, id: r.gateway, two: true,
          fields: [{ kind: "textarea", key: "classes", label: "Classes (one per line)" }, { key: "override", label: "Retention override reason (optional)" }, { kind: "reason" }],
          run: (v) => {
            const body = { org: d.org, gateway: r.gateway, card_id: r.card_id, for_classes: lines(v.classes), reason: v.reason };
            if (v.override) body.retention_override = v.override;
            return post("meet/ai/cards/approve", body, { action: "meet.ai.approve", target: r.card_id });
          },
        }),
      }] : []) : []),
    }), (c.errors || []).map((e) => el("p", { class: "empty" }, u(e.gateway + ": " + e.error))));
  }
  function aiUsagePanel(g) {
    const sp = g.spend || {};
    const usd = (m) => "$" + (Number(m || 0) / 1e6).toFixed(2);
    const refusals = Object.entries(g.refusals || {}).map(([k, n]) => k + " " + n).join(", ");
    const missing = g.missing_rids == null ? "" : (g.missing_rids.length ? g.missing_rids.join(" ") : "0");
    return panel(AIW.usage, sp.warning ? banner("warn", MSG.sev.warn, u(sp.warning)) : null, pairs([
      [AIW.requests, String(g.requests || 0)], [AIW.refusals, refusals], [AIW.spend, usd(sp.month_usd_micro) + " / " + usd(sp.month_limit_usd_micro)],
      [AIW.budgets, JSON.stringify(g.budgets || null)], [AIW.health, (g.cards || []).map((c) => c.card_id + " " + (c.healthy ? "ok" : stateWord(c.status))).join(", ")],
      [AIW.missing, missing]]), aiAuditPart(g.audit));
  }
  // The devices' own audit lines (6.6): counts only, no content exists in them.
  function aiAuditPart(a) {
    if (!a) return null;
    const p = a.personal || {};
    const byProvider = Object.entries(p.by_provider || {}).map(([k, m]) => k + ": key " + (m.key || 0) + ", OAuth " + (m.oauth || 0)).join("; ");
    const plans = Object.entries(p.plans || {}).map(([k, m]) => k + ": business " + (m.business || 0) + ", not business " + (m.not_business || 0) + ", unknown " + (m.unknown || 0)).join("; ");
    const d = a.dropped || {};
    const reasons = Object.entries(d.by_reason || {}).map(([k, n]) => k + " " + n).join(", ");
    return [
      sub(AIW.personal, pairs([[AIW.requests, String(p.requests || 0)], [AIW.byProvider, byProvider], [AIW.plans, plans], [AIW.tokens, (p.tokens_in || 0) + " / " + (p.tokens_out || 0)]])),
      sub(AIW.dropped, pairs([[AIW.droppedCount, String(d.count || 0)], [AIW.reasons, reasons]]),
        (d.latest || []).length ? genericTable(AIW.droppedLatest, d.latest.slice().reverse(), MSG.noneYet) : null),
      a.partial ? el("p", { class: "empty" }, AIW.partial) : null,
    ];
  }
  function aiHold(d) {
    const reviewers = d.reviewers || [];
    confirmDialog({
      spec: AIW.dlg.hold, vals: { principal: "" }, vals2: (v) => ({ principal: v.principal || "" }),
      fields: [{ key: "principal", label: "Person (email)" }].concat(reviewers.length ? [{ kind: "select", key: "reviewer", label: AIW.reviewer, options: reviewers.map((r) => [r, r]) }] : []).concat([{ kind: "reason" }]),
      check: (v) => (!String(v.principal || "").includes("@") ? "Name the person (their email)." : ""),
      run: (v) => post("meet/ai/hold", { org: d.org, principal: v.principal, reviewer: v.reviewer || "", reason: v.reason }, { action: "meet.ai.hold", target: v.principal }),
    });
  }
  function aiArchivePanel(d, a) {
    const kids = [];
    if (a.lacks) kids.push(banner("warn", MSG.sev.warn, u(a.lacks)));
    if (a.error) kids.push(el("p", { class: "empty" }, u(a.error)));
    const state = a.state ? el("p", null, el("strong", null, a.state)) : null;
    const reviewers = d.reviewers || [];
    const reviewerField = reviewers.length ? [{ kind: "select", key: "reviewer", label: AIW.reviewer, options: reviewers.map((r) => [r, r]) }] : [{ key: "reviewer", label: AIW.reviewer }];
    const addArchive = () => confirmDialog({
      spec: AIW.dlg.archive, vals: { org: d.org }, name: d.org, id: d.org,
      fields: [{ key: "url", label: AIW.url }, { key: "spki", label: "SPKI SHA-256 (64 hex)" }, { kind: "reason" }],
      run: (v) => post("meet/ai/archive", { org: d.org, url: v.url, spki: v.spki, reason: v.reason }, { action: "meet.ai.archive", target: d.org }),
    });
    if (a.size === "big") {
      kids.push(state, sub(AIW.offlineCopy, objPairs(a.offline_copy || {}), isAdmin() ? btn(AIW.offlineCopy, () => confirmDialog({
        spec: AIW.dlg.copy, vals: { org: d.org }, name: d.org, id: d.org,
        fields: reviewerField.concat([{ kind: "textarea", key: "copy", label: "offline_copy (JSON)", value: JSON.stringify(a.offline_copy || { enabled: true, schedule: "daily", target: { type: "path", path: "" }, keep: 30 }, null, 2) }, { kind: "reason" }]),
        check: (v) => (aiJSON(v.copy) ? "" : MSG.unreadable),
        run: (v) => post("meet/ai/archive/copy", { org: d.org, reviewer: v.reviewer, offline_copy: aiJSON(v.copy), reason: v.reason }, { action: "meet.ai.archive.copy", target: d.org }),
      })) : null), sub(AIW.shares, genericTable(AIW.shares, a.shares || [], MSG.noneYet), el("p", null, u(a.note || ""))));
      if (!a.archive && isAdmin()) kids.push(btn(AIW.addArchive, addArchive, "primary"));
      return panel(AIW.archive, ...kids);
    }
    if (a.notice) {
      kids.push(el("p", null, a.notice));
      if (isAdmin()) kids.push(btn(AIW.addArchive, addArchive, "primary"));
      return panel(AIW.archive, ...kids);
    }
    kids.push(state);
    if (a.code) kids.push(banner("warn", MSG.sev.warn, AIW.codeOnce, " ", code(a.code)));
    const makeCode = () => confirmDialog({
      spec: AIW.dlg.code, vals: { org: d.org }, name: d.org, id: d.org, fields: reviewerField.concat([{ kind: "reason" }]),
      run: (v) => post("meet/ai/archive/code", { org: d.org, reviewer: v.reviewer, reason: v.reason }, { action: "meet.ai.archive.code", target: d.org }),
    });
    const sub2 = [pairs([[AIW.code, stateWord(a.recovery_code)]])];
    if (isAdmin()) {
      if (a.confirm) {
        sub2.push(btn(AIW.confirmCode, () => confirmDialog({
          spec: AIW.dlg.confirm, vals: { first: a.confirm.first, second: a.confirm.second }, name: d.org, id: d.org,
          fields: [{ key: "first", label: fillText(AIW.group, { n: a.confirm.first }) }, { key: "second", label: fillText(AIW.group, { n: a.confirm.second }) }],
          run: (v) => post("meet/ai/archive/code/confirm", { org: d.org, first: v.first, second: v.second }, { action: "meet.ai.archive.code.confirm", target: d.org }),
        }), "primary"));
      }
      sub2.push(btn(a.recovery_code === "none" ? AIW.makeCode : AIW.replaceCode, makeCode));
    }
    kids.push(sub(AIW.code, ...sub2));
    if (!a.archive && isAdmin()) kids.push(btn(AIW.addArchive, addArchive));
    return panel(AIW.archive, ...kids);
  }
  // Settings > AI > Tools (MCP) (r6 8.11): the servers with each gateway's state, the journal and whether each gateway
  // applied it, credentials (8.4) and tests (8.9). Adding or widening a server names a second admin, who must approve the
  // save that carries the attestation (8.1, 13); turning off reaches every gateway at once (8.2).
  const MCP = { tested: null, answers: null };
  const nl = (t) => [...new Set(String(t || "").split("\n").map((x) => x.trim()).filter(Boolean))];
  function mcpNewId() {
    const c = typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(8)) : null;
    return c ? "m_" + Array.from(c, (b) => b.toString(16).padStart(2, "0")).join("") : "";
  }
  function mcpServerFrom(v, id) {
    const auth = { type: v.auth };
    if (v.auth !== "mtls_only") Object.assign(auth, { issuer: v.issuer, client_id: v.client_id, scope: v.scope });
    if (v.auth === "oauth_private_key_jwt") {
      auth.kids = Object.fromEntries(nl(v.kids).map((l) => l.split("=").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
    }
    auth.expires = Math.floor(Date.parse(String(v.expires || "") + "T00:00:00Z") / 1000) || 0;
    if (v.ca) auth.ca_pem = v.ca;
    const server = { id, name: v.name, url: v.url, ceiling: v.ceiling, private_ok: v.private === "yes", groups: nl(v.groups), activities: lines(v.activities), auth,
      max_calls: Number(v.max_calls), args_max: Number(v.args_max), result_max: Number(v.result_max) };
    if (v.tools !== undefined) server.tools = JSON.parse(v.tools || "[]");
    return server;
  }
  function mcpFields(s, m, withTools) {
    const a = s.auth || {};
    const ends = a.expires ? new Date(a.expires * 1000).toISOString().slice(0, 10) : "";
    const ceilings = m.ceilings || ["public", "internal", "confidential", "cui"];
    return [
      { key: "name", label: FW["mcp.f-name"], value: s.name || "", maxlength: "64" },
      { key: "url", label: FW["mcp.f-url"], value: s.url || "", maxlength: "512" },
      { kind: "select", key: "ceiling", label: FW["mcp.f-ceiling"], options: ceilings.map((c) => [c, FW["api.ceiling-" + c] || c]), value: s.ceiling || "internal" },
      { kind: "select", key: "private", label: FW["mcp.f-private"], options: yesNoOptions(), value: s.private_ok ? "yes" : "no" },
      { kind: "textarea", key: "groups", label: FW["mcp.f-groups"], value: (s.groups || []).join("\n") },
      { key: "activities", label: FW["mcp.f-activities"], value: (s.activities || ["search"]).join(", ") },
      { kind: "select", key: "auth", label: FW["mcp.f-auth"], value: a.type || "oauth_private_key_jwt",
        options: [["oauth_private_key_jwt", FW["mcp.auth-jwt"]], ["oauth_mtls", FW["mcp.auth-mtls"]], ["mtls_only", FW["mcp.auth-mtls-only"]]] },
      { key: "issuer", label: FW["mcp.f-issuer"], value: a.issuer || "", maxlength: "512" },
      { key: "client_id", label: FW["mcp.f-client-id"], value: a.client_id || "", maxlength: "256" },
      { key: "scope", label: FW["mcp.f-scope"], value: a.scope || "", maxlength: "512" },
      { kind: "textarea", key: "kids", label: FW["mcp.f-kids"], value: Object.entries(a.kids || {}).map(([p, k]) => p + " = " + k).join("\n") },
      { key: "expires", label: FW["mcp.f-expires"], value: ends, maxlength: "10" },
      { kind: "textarea", key: "ca", label: FW["mcp.f-ca"], value: a.ca_pem || "" },
    ].concat(withTools ? [{ kind: "textarea", key: "tools", label: FW["mcp.f-tools"], value: JSON.stringify(s.tools || [], null, 2) }] : []).concat([
      { key: "max_calls", label: FW["mcp.f-max-calls"], value: s.max_calls || 4, inputmode: "numeric" },
      { key: "args_max", label: FW["mcp.f-args-max"], value: s.args_max || 4096, inputmode: "numeric" },
      { key: "result_max", label: FW["mcp.f-result-max"], value: s.result_max || 65536, inputmode: "numeric" },
    ]);
  }
  // The attestation the console pre-fills and the residual risk, live as the form changes (8.1, 8.6).
  function mcpAttestLines(body, cur) {
    const groups = nl(cur.groups).join(", ");
    const scope = cur.auth === "mtls_only" ? FW["mcp.scope-mtls"] : cur.scope || "";
    return [body, el("p", null, el("strong", null, FW["mcp.attest"] + ": "), fill(FW["mcp.statement"], { groups, scope, server: cur.name || "" })),
      FW["mcp.attest-help"], fill(FW["mcp.risk"], { server: cur.name || "", groups })];
  }
  function mcpCheck(v) {
    try {
      JSON.parse(v.tools || "[]");
      return "";
    } catch (e) {
      return MSG.unreadable;
    }
  }
  function mcpAdd(m, s) {
    const id = s.id || mcpNewId();
    confirmDialog({
      spec: { title: FW["mcp.dlg-add"], body: [FW["mcp.dlg-add-body"]], button: [FW["mcp.stage"]] }, vals: { server: s.name || "" }, vals2: (v) => ({ server: v.name || "" }),
      name: m.org, id: m.org,
      fields: [{ key: "id", label: FW["mcp.f-id"], value: id }].concat(mcpFields(s, m, true), [{ key: "second", label: FW["mcp.second"], note: FW["mcp.second-help"] }, { kind: "reason" }]),
      body: (vv, cur) => mcpAttestLines(FW["mcp.dlg-add-body"], cur),
      check: mcpCheck,
      run: (v) => post("meet/ai/mcp/servers", { org: m.org, server: mcpServerFrom(v, v.id), second: v.second, reason: v.reason }, { action: "meet.ai.mcp.server", target: m.org }),
    });
  }
  function mcpUpdate(m, s, tools) {
    confirmDialog({
      spec: { title: FW["mcp.dlg-update"], body: [FW["mcp.dlg-update-body"]], button: [FW["mcp.stage"]] }, vals: { server: s.name }, name: s.name, id: s.id,
      fields: mcpFields(tools ? Object.assign({}, s, { tools }) : s, m, true).concat([{ key: "second", label: FW["mcp.second"], note: FW["mcp.second-help"] },
        { kind: "textarea", key: "clear", label: FW["mcp.f-clear"] }, { kind: "reason" }]),
      body: (vv, cur) => mcpAttestLines(FW["mcp.dlg-update-body"], cur),
      check: mcpCheck,
      run: (v) => {
        const body = { org: m.org, server: mcpServerFrom(v, s.id), reason: v.reason };
        if (v.second) body.second = v.second;
        const clear = nl(v.clear);
        if (clear.length) body.clear = clear;
        return post("meet/ai/mcp/servers/update", body, { action: "meet.ai.mcp.update", target: m.org });
      },
      done: (r) => render({ keepMessages: true }).then(() => r && (r.journaled || []).length && say(fillText(FW["mcp.journaled"], { n: r.journaled.length }))),
    });
  }
  function mcpServerOff(m, s) {
    confirmDialog({
      spec: { title: FW["mcp.dlg-server-off"], body: [FW["mcp.dlg-server-off-body"]], button: [FW["mcp.server-off"]] }, vals: { server: s.name }, name: s.name, id: s.id,
      danger: true, fields: [{ kind: "reason" }],
      run: (v) => post("meet/ai/mcp/servers/off", { org: m.org, server: s.id, reason: v.reason }),
    });
  }
  function mcpOff(m) {
    confirmDialog({
      spec: { title: FW["mcp.dlg-off"], body: [FW["mcp.dlg-off-body"]], button: [FW["mcp.off"]] }, vals: { org: m.org }, name: m.org, id: m.org,
      danger: true, fields: [{ kind: "reason" }],
      run: (v) => post("meet/ai/mcp/off", { org: m.org, reason: v.reason }),
    });
  }
  function mcpCredential(m, s) {
    const gws = (m.gateways || []).map((g) => [g.url, g.url]);
    confirmDialog({
      spec: { title: FW["mcp.dlg-credential"], body: [FW["mcp.dlg-credential-body"]], button: [FW["mcp.credential"]] }, vals: { server: s.name || s.id || "" },
      vals2: (v) => ({ server: s.name || s.id || v.id || "" }), name: s.name || "", id: s.id || m.org,
      fields: (s.id ? [] : [{ key: "id", label: FW["mcp.f-id"], value: mcpNewId() }]).concat([
        { kind: "select", key: "op", label: FW["mcp.f-op"], options: [["key", FW["mcp.op-key"]], ["csr", FW["mcp.op-csr"]], ["cert", FW["mcp.op-cert"]]] },
        { kind: "select", key: "gateway", label: FW["mcp.col-gateway"], options: gws.length ? gws : [["", ""]] },
        { kind: "textarea", key: "cert", label: FW["mcp.f-cert"] }, { kind: "textarea", key: "chain", label: FW["mcp.f-chain"] }, { kind: "reason" }]),
      run: (v) => {
        const server = s.id || v.id;
        const body = { org: m.org, server, op: v.op, reason: v.reason };
        if (v.op === "cert") Object.assign(body, { cert_pem: v.cert, chain_pem: v.chain || "", gateway: v.gateway });
        return post("meet/ai/mcp/credential", body, { action: "meet.ai.mcp.credential", target: server });
      },
      done: (r) => {
        MCP.answers = r;
        render({ keepMessages: true });
      },
    });
  }
  // A test of a listed server, or of a new one from its form (`draft`); the tools come back with their hashes.
  function mcpTest(m, s) {
    const fresh = !s;
    const id = fresh ? mcpNewId() : s.id;
    confirmDialog({
      spec: { title: FW["mcp.dlg-test"], body: [FW["mcp.dlg-test-body"]], button: [FW["mcp.test"]] }, vals: { server: fresh ? "" : s.name }, vals2: (v) => ({ server: fresh ? v.name || "" : s.name }),
      name: fresh ? m.org : s.name, id: fresh ? m.org : s.id,
      fields: fresh ? [{ key: "id", label: FW["mcp.f-id"], value: id }].concat(mcpFields({}, m, false)) : [],
      run: (v) => {
        const body = { org: m.org, server: fresh ? v.id : s.id };
        if (fresh) body.draft = mcpServerFrom(v, v.id);
        MCP.draft = fresh ? body.draft : null;
        return post("meet/ai/mcp/test", body);
      },
      done: (r) => {
        const t = (r && r.test) || {};
        MCP.tested = { id: (r && r.server) || id, server: MCP.draft || s, tools: (t.tools || []).map((x) => ({ name: x.name, effect: "read", schema_sha256: x.schema_sha256 })), listed: t.tools || [] };
        render({ keepMessages: true });
      },
    });
  }
  function mcpAnswer(a) {
    const who = u(a.gateway + ": ");
    if (a.error) return el("p", null, who, fillText(FW["mcp.gateway-error"], { why: a.error }));
    const v = a.answer || {};
    if (v.jwk) return el("div", null, el("p", null, who, fillText(FW["mcp.answer-kid"], { kid: v.kid || "" })), el("pre", null, u(JSON.stringify(v.jwk, null, 2))), copyButton(JSON.stringify(v.jwk)));
    if (v.csr_pem) return el("div", null, el("p", null, who, FW["mcp.answer-csr"]), el("pre", null, u(v.csr_pem)), copyButton(v.csr_pem));
    return el("p", null, who, fillText(FW["mcp.answer-cert"], { date: v.not_after ? whenSec(v.not_after) : "" }));
  }
  // One gateway's view of a server: offered or why not, its credential, each tool offered or why not.
  function mcpGatewayLine(g, s) {
    if (!g.state) return fillText(FW["mcp.gateway-error"], { why: g.error || "" });
    const st = (g.state.servers || []).find((x) => x.id === s.id);
    if (!st) return fillText(FW["mcp.not-offered"], { why: "not-listed" });
    const head = st.offered ? FW["mcp.offered"] : fillText(FW["mcp.not-offered"], { why: st.error || "" });
    const c = st.credential || {};
    const cred = c.state ? [FW["mcp.col-credential"] + ": " + stateWord(c.state), c.kid || "", c.not_after ? whenSec(c.not_after) : ""].filter(Boolean).join(" ") : "";
    const tools = (st.tools || []).map((t) => t.name + " " + (t.offered ? FW["mcp.offered"] : fillText(FW["mcp.not-offered"], { why: t.why || "" }))).join(", ");
    return [head, cred, tools].filter(Boolean).join("; ");
  }
  function mcpServerBlock(m, s, signed) {
    const a = s.auth || {};
    const at = s.attest || {};
    const rows = [[FW["mcp.col-url"], u(s.url)], [FW["mcp.col-ceiling"], FW["api.ceiling-" + s.ceiling] || s.ceiling], [FW["mcp.col-groups"], (s.groups || []).join(", ")],
      [FW["mcp.col-activities"], (s.activities || []).join(", ")], [FW["mcp.col-tools"], (s.tools || []).map((t) => t.name).join(", ")],
      [FW["mcp.col-credential"], a.type || ""], [FW["mcp.col-ends"], a.expires ? whenSec(a.expires) : ""],
      [FW["mcp.attest"], at.by ? fillText(FW["mcp.attest-by"], { by: (at.by || []).join(", "), date: whenSec(at.at) }) + ". " + (at.statement || "") : ""]];
    if (signed) for (const g of m.gateways || []) rows.push([FW["mcp.col-gateway"] + " " + g.url, mcpGatewayLine(g, s)]);
    const acts = isAdmin() ? [btn(FW["mcp.update"], () => mcpUpdate(m, s)), btn(FW["mcp.credential"], () => mcpCredential(m, s)), btn(FW["mcp.test"], () => mcpTest(m, s)),
      signed ? btn(FW["mcp.server-off"], () => mcpServerOff(m, s), "danger") : null] : [];
    return sub(s.name + " (" + s.id + ")", pairs(rows), el("p", null, u(s.risk || "")), el("div", { class: "page-head" }, ...acts));
  }
  async function mcpPanel(d) {
    const m = await api("GET", "meet/ai/mcp" + aiQ(d.org)).catch((e) => ({ error: e.message }));
    m.org = m.org || d.org;
    const kids = [el("p", null, FW["mcp.help"])];
    if (m.error) kids.push(emptyLine(u(m.error)));
    if (m.readers) kids.push(banner("warn", MSG.sev.warn, fill(FW["mcp.readers"], { version: (m.minimums || {}).hub || "" }), " ", u(m.readers)));
    for (const w of m.warnings || []) {
      const sev = w.severity === "bad" ? "bad" : "warn";
      kids.push(banner(sev, MSG.sev[sev], fill(w.ended ? FW["mcp.expired"] : FW["mcp.expires-soon"], { server: w.name, days: String(w.days) })));
    }
    for (const c of m.changed || []) {
      const s = (m.servers || []).find((x) => x.id === c.server);
      const tools = s ? (s.tools || []).map((t) => (t.name === c.tool ? Object.assign({}, t, { schema_sha256: c.schema_sha256 }) : t)) : null;
      kids.push(banner("warn", MSG.sev.warn, fill(FW["mcp.tool-changed"], { tool: c.tool, server: c.name, gateway: c.gateway }), " ",
        isAdmin() && s ? btn(FW["mcp.tool-approve"], () => mcpUpdate(m, s, tools)) : null));
    }
    const signed = m.servers || [];
    kids.push(sub(FW["mcp.servers"], signed.length ? signed.map((s) => mcpServerBlock(m, s, true)) : emptyLine(FW["mcp.none"])));
    const staged = (m.staged || {}).servers || [];
    if (staged.length) kids.push(sub(FW["mcp.staged"], staged.map((s) => mcpServerBlock(m, s, false))));
    if (MCP.tested) {
      const t = MCP.tested;
      const known = signed.concat(staged).find((x) => x.id === t.id);
      kids.push(sub(FW["mcp.tested"], genericTable(FW["mcp.tested"], t.listed.map((x) => ({ name: x.name, description: x.description || "", schema_sha256: x.schema_sha256 })), MSG.noneYet),
        isAdmin() && t.tools.length ? btn(FW["mcp.use-tools"], () => (known ? mcpUpdate(m, known, t.tools) : mcpAdd(m, Object.assign({}, t.server || {}, { id: t.id, tools: t.tools })))) : null));
    }
    if (MCP.answers && MCP.answers.answers) kids.push(sub(FW["mcp.answers"], ...MCP.answers.answers.map(mcpAnswer)));
    kids.push(sub(FW["mcp.gateways"], pairs((m.gateways || []).map((g) => [u(g.url), g.applied ? FW["mcp.applied"] : fillText(FW["mcp.waiting"], { n: g.waiting || 0 })]))));
    kids.push(sub(FW["mcp.journal"], dataTable({
      caption: FW["mcp.journal"], rows: (m.journal || []).slice().reverse(), empty: FW["mcp.journal-none"], name: (e) => e.id, text: (e) => [e.id, e.action].join(" "),
      cols: [{ key: "id", label: W["dialog.id"], cell: (e) => code(e.id) }, { key: "action", label: FW["mcp.col-action"] },
        { key: "target", label: FW["mcp.col-target"], cell: (e) => u(typeof e.target === "string" ? e.target : JSON.stringify(e.target)), sortable: false },
        { key: "ts", label: FW["mcp.col-when"], cell: (e) => whenSec(e.ts) },
        { key: "state", label: FW["mcp.col-state"], sortable: false, cell: (e) => {
          const behind = (m.gateways || []).filter((g) => (g.ack || 0) < e.tseq).map((g) => g.url);
          return (e.state === "done" ? FW["mcp.done"] : FW["mcp.active"]) + (behind.length ? "; " + FW["mcp.not-applied"] + ": " + behind.join(", ") : "");
        } }],
    })));
    const head = isAdmin() ? el("div", { class: "page-head" }, btn(FW["mcp.add"], () => mcpAdd(m, {}), "primary"), btn(FW["mcp.test"], () => mcpTest(m, null)),
      btn(FW["mcp.credential"], () => mcpCredential(m, {})), btn(FW["mcp.off"], () => mcpOff(m), "danger")) : null;
    return panel(FW["mcp.title"], head, ...kids);
  }
  pages.meet_ai = async () => {
    const want = (location.hash.split("?org=")[1] || "").split("&")[0];
    const d = await api("GET", "meet/ai" + aiQ(decodeURIComponent(want)));
    const q = aiQ(d.org);
    const [c, g, a] = await Promise.all([api("GET", "meet/ai/cards" + q).catch((e) => ({ cards: [], errors: [{ gateway: "", error: e.message }] })),
      api("GET", "meet/ai/usage" + q).catch(() => ({})), api("GET", "meet/ai/archive" + q).catch((e) => ({ error: e.message }))]);
    const orgPick = (d.orgs || []).length > 1 ? el("nav", { class: "chips" }, d.orgs.map((o) => el("a", { href: "#/meet/ai?org=" + encodeURIComponent(o.id) }, u(o.label || o.id)))) : null;
    const ai = d.ai || {};
    const kids = [head(PAGE_LABEL.meet.ai, orgPick)];
    if (d.lacks) kids.push(banner("warn", MSG.sev.warn, u(d.lacks)));
    for (const s of d.saving || []) kids.push(banner("info", MSG.sev.info, fill(AIW.signing[s.step] || AIW.signing.map, { principal: s.principal })));
    kids.push(panel(AIW.who, pairs([[AIW.groups, ((ai.who || {}).groups || []).join(", ")], [AIW.people, ((d.map || {}).who_principals || []).join(", ")]])));
    kids.push(panel(AIW.routing, pairs([[AIW.preset, AIW.presets[d.preset] || AIW.presets.advanced], ["order", (ai.order || []).join(", ")], ["frontier.access", (ai.frontier || {}).access || ""]]),
      isAdmin() ? btn(AIW.review, () => aiSettings(d), "primary") : null));
    kids.push(panel(AIW.staged, d.staged ? [lineDiff(ai, d.staged.ai), isAdmin() ? btn(AIW.save, () => aiSave(d), "primary") : null] : emptyLine(AIW.noStage)));
    kids.push(panel(AIW.gateways, dataTable({
      caption: AIW.gateways, rows: d.gateways || [], empty: MSG.noneYet, text: (r) => [r.url, r.principal].join(" "), name: (r) => r.url,
      cols: [{ key: "url", label: "URL", cell: (r) => u(r.url) }, { key: "principal", label: "Principal", cell: (r) => u(r.principal) }, { key: "device", label: "Device", cell: (r) => code(r.device) },
        { key: "spki", label: "SPKI", cell: (r) => code(r.spki) }, { key: "region", label: "Region", cell: (r) => u(r.region || "") }],
      actions: (r) => (isAdmin() ? [{
        label: AIW.remove, run: () => confirmDialog({
          spec: AIW.dlg.enroll, vals: { org: d.org }, name: r.url, id: r.device, danger: true, fields: [{ kind: "reason" }],
          specFor: () => Object.assign({}, AIW.dlg.enroll, { button: [AIW.remove] }),
          run: (v) => post("meet/ai/gateways", { org: d.org, url: r.url, remove: true, reason: v.reason }, { action: "meet.ai.gateway", target: d.org }),
        }),
      }] : []),
    }), d.consoleSpki ? pairs([[AIW.consoleSpki, code(d.consoleSpki)]]) : null, isAdmin() ? btn(AIW.enroll, () => aiEnroll(d)) : null));
    kids.push(aiCardsPanel(d, c), aiUsagePanel(g));
    kids.push(panel(AIW.hold, isAdmin() ? btn(AIW.hold, () => aiHold(d), "primary") : null,
      genericTable(AIW.hold, (d.results || []).filter((r) => r.op === "hold").map((r) => ({ at: r.at, reviewer: r.reviewer, placed: r.placed ? "yes" : "no" })), MSG.noneYet)));
    kids.push(aiArchivePanel(d, a));
    kids.push(lmcpPanel(d));
    kids.push(await mcpPanel(d));
    return kids;
  };
  // Settings > AI > Local MCP (API-1c 10.6, 14.2): ai.local_mcp, staged and signed with the AI settings. Enterprise only
  // (decision O6): on a standard license the card says why and offers no change.
  const LOCAL_MCP_TOOLS = ["search", "read_conversation", "list_meetings", "read_meeting_notes", "draft_reply", "send_message"];
  function lmcpPanel(d) {
    const lm = (d.ai || {}).local_mcp || {};
    const standard = d.edition === "standard";
    return panel(FW["lmcp.title"], el("p", null, toneChip(FW["lmcp.enterprise"]), " ", FW["lmcp.help"]), standard ? banner("warn", MSG.sev.warn, FW["lmcp.standard"]) : null,
      pairs([[FW["lmcp.state"], onOff(!!lm.enabled)], [FW["lmcp.classes"], (lm.classes || []).join(", ")], [FW["lmcp.tools"], (lm.tools || []).join(", ")], [FW["lmcp.send"], yesNo(!!lm.send)]]),
      isAdmin() && !standard ? btn(FW["lmcp.change"], () => lmcpStage(d), "primary") : null);
  }
  function lmcpStage(d) {
    const ai = d.ai || {};
    const lm = ai.local_mcp || {};
    const cui = ai.cui_classes || [];
    confirmDialog({
      spec: fspec("local-mcp"), vals: { org: d.org }, name: d.org, id: d.org,
      fields: [{ kind: "select", key: "enabled", label: FW["lmcp.f-enabled"], options: [["off", MSG.off], ["on", MSG.on]], value: lm.enabled ? "on" : "off" },
        { kind: "checks", key: "classes", label: FW["lmcp.f-classes"], options: (ai.classes || []).filter((c) => !cui.includes(c)).map((c) => [c, c]), value: lm.classes || [] },
        { kind: "checks", key: "tools", label: FW["lmcp.f-tools"], options: LOCAL_MCP_TOOLS.map((t) => [t, t]), value: lm.tools || [] },
        { kind: "select", key: "send", label: FW["lmcp.f-send"], options: yesNoOptions(), value: lm.send ? "yes" : "no" }],
      check: (v) => (!v.tools.length || (v.send === "yes" && !v.tools.includes("send_message")) ? FW["lmcp.check"] : ""),
      run: (v) => post("meet/ai/stage", { org: d.org, preset: d.preset || "advanced",
        ai: { local_mcp: { enabled: v.enabled === "on", classes: v.classes, tools: v.tools, send: v.send === "yes" } } }, { action: "meet.ai.stage", target: d.org }),
    });
  }

  // Releases (4.9): one admin only for the same minimums, or raising one back to what a lowering in the last 24 h replaced.
  function vkey(v) {
    return String(v || "").split(".").map((x) => parseInt(x, 10) || 0);
  }
  function vcmp(a, b) {
    const x = vkey(a), y = vkey(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  function releaseNeedsSecond(minimum, now, history) {
    for (const app of ["hub", "ios"]) {
      const next = minimum[app] || "";
      const cur = (now || {})[app] || "";
      if (next === cur) continue;
      if (!next || (cur && vcmp(next, cur) < 0)) return true;
      const cut = Date.now() / 1000 - 86400;
      const h = history || [];
      let restored = false;
      for (let i = 1; i < h.length; i++) {
        const before = ((h[i - 1].minimum || {})[app]) || "";
        const after = ((h[i].minimum || {})[app]) || "";
        const day = dateOf(h[i].published, "any");
        const at = day ? day.getTime() / 1000 : 0;
        if (at >= cut && before && (!after || vcmp(after, before) < 0) && before === next) restored = true;
      }
      if (!restored) return true;
    }
    return false;
  }
  // Release platforms and minimum apps by their own names.
  const PLATFORM_WORDS = { windows: "Windows", macos: "macOS", ios: "iPhone", iphone: "iPhone", linux: "Linux", android: "Android" };
  const platformWord = (p) => PLATFORM_WORDS[String(p).toLowerCase()] || stateWord(p);
  const MIN_APP = { hub: "Hub", ios: "iPhone" };
  pages.meet_releases = async () => {
    const d = await api("GET", "meet/release");
    const rel = d.release || {};
    const mins = d.minimums || rel.minimum || {};
    const files = rel.files || {};
    const kids = [head(PAGE_LABEL.meet.releases), panel("Latest release", pairs([
      ["Version", rel.version || MSG.never], ["Published", rel.published ? whenAny(rel.published) : undefined],
      ...Object.entries(files).map(([plat, f]) => [platformWord(plat), u(clean(f.name) + ", SHA-256 " + clean(f.sha256) + ", " + f.size + " bytes")]),
      rel.ios && rel.ios.version ? ["iPhone", rel.ios.version + " (" + rel.ios.build + ", " + clean(rel.ios.channel) + ")"] : ["iPhone", undefined],
      ["Notes", rel.notes], ["Minimum Hub", mins.hub || ""], ["Minimum iPhone", mins.ios || ""],
    ])), panel(null, dataTable({
      caption: "Minimums, last 10 releases", rows: d.history || [], empty: MSG.noneYet, name: (h) => h.version,
      cols: [{ key: "version", label: "Version" }, { key: "minimum", label: "Minimums", cell: (h) => u(Object.entries(h.minimum || {}).map(([k, v]) => (MIN_APP[k] || k) + " " + v).join(", ")), sortable: false },
        { key: "published", label: "Published", cell: (h) => whenAny(h.published) },
        { key: "until", label: "Until", cell: (h) => (h.until ? whenAny(h.until) : "") }],
    }))];
    if (canWrite()) kids.push(releaseForm(rel, mins, d.history || []));
    return kids;
  };
  function releaseForm(rel, mins, history) {
    const f = {};
    const input = (key, label, attrs) => {
      const id = uid("rel");
      f[key] = el("input", Object.assign({ id, type: "text", autocomplete: "off", spellcheck: "false" }, attrs || {}));
      return el("div", { class: "field" }, el("label", { for: id }, label), f[key]);
    };
    const nid = uid("rel");
    f.notes = el("textarea", { id: nid, maxlength: "4000" });
    const cid = uid("rel");
    f.channel = el("select", { id: cid }, el("option", { value: "TestFlight" }, "TestFlight"), el("option", { value: "App Store" }, "App Store"));
    const who = el("p", { class: "note", role: "status" });
    const box = el("div", null,
      input("version", "Version"),
      el("h4", null, "Windows"), input("winName", "Installer name"), input("winSha", "SHA-256"), input("winSize", "Size in bytes", { inputmode: "numeric" }),
      el("h4", null, "macOS"), input("macName", "Installer name"), input("macSha", "SHA-256"), input("macSize", "Size in bytes", { inputmode: "numeric" }),
      el("h4", null, "iPhone"), input("iosVersion", "Version"), input("iosBuild", "Build", { inputmode: "numeric" }),
      el("div", { class: "field" }, el("label", { for: cid }, "Channel"), f.channel),
      el("div", { class: "field" }, el("label", { for: nid }, "Notes"), f.notes),
      el("h4", null, "Minimums"), input("minHub", "Minimum Hub version"), input("minIos", "Minimum iPhone version"), who);
    f.minHub.value = mins.hub || "";
    f.minIos.value = mins.ios || "";
    const manifest = () => {
      const files = {};
      const add = (plat, n, s, z) => {
        if (f[n].value.trim()) files[plat] = { name: f[n].value.trim(), sha256: f[s].value.trim().toLowerCase(), size: Number(f[z].value) };
      };
      add("windows", "winName", "winSha", "winSize");
      add("macos", "macName", "macSha", "macSize");
      const m = { version: f.version.value.trim(), files, notes: f.notes.value.trim() };
      if (f.iosVersion.value.trim()) m.ios = { version: f.iosVersion.value.trim(), build: Number(f.iosBuild.value), channel: f.channel.value };
      const minimum = {};
      if (f.minHub.value.trim()) minimum.hub = f.minHub.value.trim();
      if (f.minIos.value.trim()) minimum.ios = f.minIos.value.trim();
      m.minimum = minimum;
      return m;
    };
    // Under the minimums, whether one or two admins are needed (7.4); with two-person control off, always one.
    const update = () => {
      const second = releaseNeedsSecond(manifest().minimum, mins, history);
      who.textContent = second ? (twoOn() ? W["dialog.second"] : W["dialog.single"]) : MSG.sole;
    };
    box.addEventListener("input", update);
    update();
    const publish = btn("Publish a release", () => {
      const m = manifest();
      const two = releaseNeedsSecond(m.minimum, mins, history);
      const params = [["Version", m.version]];
      for (const [plat, x] of Object.entries(m.files)) params.push([platformWord(plat) + " installer", x.name], [platformWord(plat) + " SHA-256", code(x.sha256)], [platformWord(plat) + " size", x.size + " bytes"]);
      if (m.ios) params.push(["iPhone", m.ios.version + " (" + m.ios.build + ", " + m.ios.channel + ")"]);
      params.push(["Notes", m.notes], ["Minimum Hub", m.minimum.hub || ""], ["Minimum iPhone", m.minimum.ios || ""]);
      confirmDialog({
        dlg: "release", name: "Lucid Meeting Hub " + m.version, id: m.version, two, params,
        vals: { version: m.version, hub: m.minimum.hub || MSG.never, "hub now": mins.hub || MSG.never, ios: m.minimum.ios || MSG.never, "ios now": mins.ios || MSG.never },
        fields: [{ kind: "reason" }],
        run: (v) => post("meet/release", Object.assign({}, m, { reason: v.reason }), { action: "meet.release.set", target: m.version }),
      });
    }, "primary");
    return panel("Publish a release", box, publish);
  }

  // ---- Meet > Branding (contract TH-1 section 6) ----
  // The organization's name, accent color, mode, welcome text, help link and logo on the guest portal and the web
  // sign-in, and from a Lucid Admin Console on its account pages too. Without a brand every page shows the standard
  // Lucid theme. The preview is drawn on a canvas: this page sets no style, and the console's CSP takes no image data.
  const BRW = {
    intro: "Your organization's name, color and logo on the guest page, the web sign-in and the account pages. Without a brand every page shows the standard Lucid theme.",
    introFleet: "Saving here keeps this console's copy for its account pages, then sends the same change to every Meeting Hub relay, each with its own confirmation.",
    standard: "Standard Lucid theme",
    current: "Brand", changed: "Last change", by: "Changed by", edit: "Name and color",
    name: "Organization name", accent: "Accent color", mode: "Mode", welcome: "Welcome text on the guest setup page",
    support: "Help link: it must start with https:// or mailto:",
    modes: [["auto", "Follow the browser"], ["dark", "Dark"], ["light", "Light"]],
    save: "Save the branding",
    logo: "Logo", logoPick: "Logo file: PNG, JPEG or WebP, at most 256 KiB, 32 to 1024 pixels a side",
    logoNow: "Current logo: <type>, <w> by <h> pixels, <n> bytes.", logoNone: "No logo: the Lucid mark shows.",
    logoUpload: "Upload the logo", logoRemove: "Remove the logo",
    reset: "Reset to the Lucid theme", preview: "Preview of the guest setup card",
    previewJoin: "Join", previewPowered: "Powered by Lucid Meet", previewHelp: "Help",
    textOn: "Button text in <color>: <ratio>:1, and 4.5:1 is needed.", onDark: "The color on the dark background: <ratio>:1, and 3:1 is needed.",
    white: "white", dark: "near-black", passes: "Readable", fails: "Too faint",
    nameNeeded: "The name is 1 to 60 characters.", faint: "Choose a color with more contrast: both lines above must pass.",
    badSupport: "The help link must start with https:// or mailto:", tooBig: "The logo is larger than 256 KiB.",
    notImage: "Choose a PNG, JPEG or WebP image. SVG logos are refused.", pickFirst: "Choose a logo file first.",
    saveFirst: "Save the name and color before the logo.",
    consoleCopy: "Saved for this console's account pages.", relays: "Relays: <list>.", relayOk: "<name> saved",
    relayFailed: "<name> not saved (<words>)", noRelays: "No Meeting Hub relay is enrolled yet.",
    open: "Branding of the guest page, the web sign-in and the account pages",
    dlg: {
      save: { title: "Save the branding of <name>?", body: ["Guests and members see it the next time a page opens."], button: ["Save"] },
      logo: { title: "Upload this logo?", body: ["It replaces the Lucid mark in the page header."], button: ["Upload the logo"] },
      removeLogo: { title: "Remove the logo?", body: ["The Lucid mark shows again; the name and color stay."], button: ["Remove the logo"] },
      reset: { title: "Reset to the Lucid theme?", body: ["The brand and its logo are removed, and every page shows the standard Lucid theme."], button: ["Reset to the Lucid theme"] },
    },
  };
  const LOGO_MAX = 256 * 1024;
  const HEX6 = /^#[0-9a-f]{6}$/;
  const brandingLink = () => (isAdmin() ? el("p", null, el("a", { href: "#/meet/branding" }, BRW.open)) : null);
  // WCAG 2 relative luminance and contrast, as the relay checks them (TH-1 3).
  function luminanceOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  }
  function contrastOf(a, b) {
    const x = luminanceOf(a);
    const y = luminanceOf(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // The better of white and near-black text (white on a tie) must reach 4.5:1; the color itself 3:1 on #0a0b0f.
  function accentCheck(accent) {
    const white = contrastOf(accent, "#ffffff");
    const dark = contrastOf(accent, "#0a0b0f");
    const best = Math.max(white, dark);
    return { on: white >= dark ? "#ffffff" : "#0a0b0f", best, dark, ok: best >= 4.5 && dark >= 3 };
  }
  // Two decimals, rounded down, so a ratio just under a threshold never reads as reaching it.
  const ratioText = (x) => (Math.floor(x * 100) / 100).toFixed(2);
  // The logo's type by its magic bytes, as the relay reads it; "" for anything else (SVG among them).
  function sniffImage(b) {
    const ascii = (from, to) => String.fromCharCode.apply(null, Array.from(b.subarray(from, to)));
    if (b.length >= 24 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 16 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    return "";
  }
  function base64Of(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return btoa(s);
  }
  // The guest setup card in the chosen colors: the logo (or a mark in the accent), the name, the welcome text, the
  // Join button and the unbranded footer.
  function drawBrandPreview(canvas, v, bitmap) {
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return;
    const t = v.mode === "light" ? { bg: "#f5f6fa", panel: "#ffffff", line: "#b8c0d4", text: "#141826", muted: "#4a5268", link: "#0b6e80" }
      : { bg: "#0a0b0f", panel: "#0f1117", line: "#252a3a", text: "#edeff6", muted: "#aeb4c6", link: "#46c8dc" };
    const w = canvas.width;
    const h = canvas.height;
    const box = (x, y, bw, bh, r) => {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, r);
      else ctx.rect(x, y, bw, bh);
    };
    const font = (size, weight) => weight + " " + size + "px system-ui, sans-serif";
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, w, h);
    box(16, 16, w - 32, h - 32, 16);
    ctx.fillStyle = t.panel;
    ctx.fill();
    ctx.strokeStyle = t.line;
    ctx.stroke();
    if (bitmap) {
      const s = Math.min(160 / bitmap.width, 44 / bitmap.height);
      ctx.drawImage(bitmap, 36, 36, bitmap.width * s, bitmap.height * s);
    } else {
      box(36, 36, 44, 44, 10);
      ctx.fillStyle = v.accent;
      ctx.fill();
    }
    ctx.fillStyle = t.text;
    ctx.font = font(20, 650);
    ctx.fillText(v.name || "Lucid Meet", 36, 110, w - 72);
    ctx.fillStyle = t.muted;
    ctx.font = font(14, 400);
    const words = (v.welcome || "").split(" ");
    let line = "";
    let y = 136;
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (ctx.measureText(next).width > w - 72 && line) {
        ctx.fillText(line, 36, y);
        y += 20;
        line = word;
        if (y > 176) break;
      } else line = next;
    }
    if (line && y <= 176) ctx.fillText(line, 36, y);
    box(36, h - 116, w - 72, 44, 10);
    ctx.fillStyle = v.accent;
    ctx.fill();
    ctx.fillStyle = v.on;
    ctx.font = font(16, 650);
    ctx.textAlign = "center";
    ctx.fillText(BRW.previewJoin, w / 2, h - 88);
    ctx.textAlign = "left";
    ctx.fillStyle = t.muted;
    ctx.font = font(12, 400);
    ctx.fillText(BRW.previewPowered, 36, h - 44);
    if (v.support) {
      ctx.fillStyle = t.link;
      ctx.textAlign = "right";
      ctx.fillText(BRW.previewHelp, w - 36, h - 44);
      ctx.textAlign = "left";
    }
  }
  // One Branding page: view is GET's {brand, public}; o.save, o.logo and o.reset take the body and run the write;
  // o.canSave, o.canReset; o.intro an extra line; o.done after a write.
  function brandingPage(view, o) {
    const b = view && view.brand ? view.brand : null;
    const id = () => uid("brand");
    const f = {};
    const ids = { name: id(), accent: id(), mode: id(), welcome: id(), support: id(), logo: id() };
    f.name = el("input", { id: ids.name, type: "text", maxlength: "60", autocomplete: "organization", spellcheck: "false" });
    f.accent = el("input", { id: ids.accent, type: "color", "aria-describedby": ids.accent + "-c" });
    f.mode = el("select", { id: ids.mode }, BRW.modes.map(([v, w]) => el("option", { value: v }, w)));
    f.welcome = el("textarea", { id: ids.welcome, maxlength: "200" });
    f.support = el("input", { id: ids.support, type: "url", maxlength: "300", autocomplete: "off", spellcheck: "false" });
    f.logo = el("input", { id: ids.logo, type: "file", accept: "image/png,image/jpeg,image/webp" });
    f.name.value = b ? b.name : "";
    f.accent.value = b ? b.accent : "#c64bd6";
    f.mode.value = b ? b.mode : "auto";
    f.welcome.value = (b && b.welcome) || "";
    f.support.value = (b && b.support) || "";
    const contrastLine = el("p", { id: ids.accent + "-c", class: "note", role: "status" });
    const canvas = el("canvas", { class: "brand-preview", width: "420", height: "300", role: "img", "aria-label": BRW.preview });
    let bitmap = null;
    let picked = null;
    const values = () => ({ name: f.name.value.trim(), accent: f.accent.value.toLowerCase(), mode: f.mode.value, welcome: f.welcome.value.trim(), support: f.support.value.trim() });
    const modeWord = (m) => (BRW.modes.find(([v]) => v === m) || ["", m])[1];
    function update() {
      const v = values();
      const c = HEX6.test(v.accent) ? accentCheck(v.accent) : null;
      contrastLine.replaceChildren(...(c ? [fill(BRW.textOn, { color: c.on === "#ffffff" ? BRW.white : BRW.dark, ratio: ratioText(c.best) }), " ",
        fill(BRW.onDark, { ratio: ratioText(c.dark) }), " ", stChip(c.ok ? BRW.passes : BRW.fails, c.ok ? "ok" : "bad")] : []));
      drawBrandPreview(canvas, Object.assign(v, { on: c ? c.on : "#ffffff" }), bitmap);
    }
    for (const x of [f.name, f.accent, f.mode, f.welcome, f.support]) {
      x.addEventListener("input", update);
      x.addEventListener("change", update);
    }
    f.logo.addEventListener("change", () => {
      picked = null;
      bitmap = null;
      const file = f.logo.files && f.logo.files[0];
      if (!file) return update();
      (async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = sniffImage(bytes);
        if (bytes.length > LOGO_MAX) return invalid(f.logo, BRW.tooBig);
        if (!type) return invalid(f.logo, BRW.notImage);
        picked = { type, data: base64Of(bytes) };
        try {
          bitmap = await createImageBitmap(file);
        } catch (e) {
          bitmap = null;
        }
      })().then(update, fail);
    });
    const save = btn(BRW.save, () => {
      const v = values();
      if (!v.name || [...v.name].length > 60) return invalid(f.name, BRW.nameNeeded);
      if (!HEX6.test(v.accent) || !accentCheck(v.accent).ok) return invalid(f.accent, BRW.faint);
      if (v.support && !/^(https:\/\/|mailto:)/.test(v.support)) return invalid(f.support, BRW.badSupport);
      confirmDialog({
        spec: BRW.dlg.save, vals: { name: v.name }, name: v.name,
        params: [[BRW.name, v.name], [BRW.accent, code(v.accent)], [BRW.mode, modeWord(v.mode)], [BRW.welcome, v.welcome], [BRW.support, v.support]],
        fields: [{ kind: "reason" }],
        run: (d) => o.save(Object.assign({}, v, { reason: d.reason })), done: o.done,
      });
    }, "primary");
    const upload = btn(BRW.logoUpload, () => {
      if (!picked) return invalid(f.logo, BRW.pickFirst);
      if (!b) return invalid(f.logo, BRW.saveFirst);
      const body = picked;
      confirmDialog({ spec: BRW.dlg.logo, vals: {}, params: [[BRW.logo, body.type]], run: () => o.logo(body), done: o.done });
    });
    const removeLogo = b && b.logo ? btn(BRW.logoRemove, () => confirmDialog({ spec: BRW.dlg.removeLogo, vals: {}, danger: true, run: () => o.logo({ remove: true }), done: o.done })) : null;
    const reset = b && o.canReset ? btn(BRW.reset, () => confirmDialog({
      spec: BRW.dlg.reset, vals: {}, danger: true, fields: [{ kind: "reason" }], run: (d) => o.reset({ reason: d.reason }), done: o.done,
    }), "danger") : null;
    const logoNow = b && b.logo ? fillText(BRW.logoNow, { type: b.logo.type, w: b.logo.w, h: b.logo.h, n: b.logo.bytes }) : BRW.logoNone;
    const field = (fid, label, input, ...more) => el("div", { class: "field" }, el("label", { for: fid }, label), input, ...more);
    const kids = [head(PAGE_LABEL.meet.branding), el("p", null, BRW.intro), o.intro ? el("p", null, o.intro) : null,
      panel(null, pairs([[BRW.current, b ? b.name : BRW.standard], [BRW.changed, b ? whenAny(b.updated) : undefined], [BRW.by, b ? b.by : undefined], [BRW.logo, logoNow]]))];
    if (o.canSave) {
      kids.push(panel(BRW.edit,
        field(ids.name, BRW.name, f.name),
        field(ids.accent, BRW.accent, f.accent, contrastLine),
        field(ids.mode, BRW.mode, f.mode),
        field(ids.welcome, BRW.welcome, f.welcome),
        field(ids.support, BRW.support, f.support),
        sub(BRW.preview, canvas),
        save));
      kids.push(panel(BRW.logo, el("p", { class: "note" }, logoNow), field(ids.logo, BRW.logoPick, f.logo), el("div", { class: "page-head" }, upload, removeLogo)));
    }
    if (reset) kids.push(panel(null, reset));
    update();
    return kids.filter(Boolean);
  }
  // The relay's own console: the relay's brand, which its guest and web ports serve.
  pages.meet_branding = async () => {
    const d = await api("GET", "meet/brand");
    const write = (path, action) => (body) => post(path, body, { action, target: "-" });
    return brandingPage(d, { save: write("meet/brand", "meet.brand.set"), logo: write("meet/brand/logo", "meet.brand.logo"), reset: write("meet/brand/reset", "meet.brand.reset"),
      canSave: canWrite(), canReset: isAdmin() });
  };
  // A Lucid Admin Console: its own copy for the account pages first, then the same change on every Meeting Hub relay
  // through the proxy (6), each with its own fleet confirmation; the page says which relays took it.
  pages.fleetBranding = async () => {
    const [d, all] = await Promise.all([api("GET", "meet/accounts/brand", null, { direct: true }), fleetRelays()]);
    const relays = all.filter((x) => x.product === "meet" && x.state === "active").sort(byName);
    let said = "";
    const both = (path, action) => async (body) => {
      const r = await post("meet/accounts/" + path, body, { action, target: "-" }, { direct: true });
      const list = [];
      for (const x of relays) {
        try {
          await post("meet/" + path, body, { action, target: "-" }, { relay: x.id });
          list.push(fillText(BRW.relayOk, { name: x.name }));
        } catch (e) {
          if (e && e.status === 401) throw e;
          list.push(fillText(BRW.relayFailed, { name: x.name, words: e && e.message ? e.message : String(e) }));
        }
      }
      said = BRW.consoleCopy + " " + (relays.length ? fillText(BRW.relays, { list: list.join("; ") }) : BRW.noRelays);
      return r;
    };
    return brandingPage(d, {
      save: both("brand", "meet.brand.set"), logo: both("brand/logo", "meet.brand.logo"), reset: both("brand/reset", "meet.brand.reset"),
      canSave: isAdmin(), canReset: isAdmin(), intro: BRW.introFleet,
      done: () => render({ keepMessages: true }).then(() => say(said)),
    });
  };

  pages.meet_push = async () => {
    const d = await api("GET", "meet/push");
    const failed = Object.entries(d.failed24h || {}).map(([reason, n]) => ({ reason, n }));
    return [head(PAGE_LABEL.meet.push), help("help.push"), panel(null, pairs([
      ["Push", onOff(d.enabled)], ["Calls (VoIP)", onOff(d.voip)], ["Environment", d.environment], ["Message previews", onOff(d.notify_previews)],
      ["Devices with alerts", d.devices ? d.devices.alert : 0], ["Devices with calls", d.devices ? d.devices.voip : 0], ["Sent in 24 hours", d.sent24h],
    ])), panel(null, dataTable({ caption: "Failures in 24 hours", rows: failed, empty: MSG.noneYet, name: (x) => x.reason, cols: [{ key: "reason", label: "Reason" }, { key: "n", label: "Count" }] }))];
  };
  pages.meet_identity = async () => {
    const d = await api("GET", "meet/identity");
    if (!d.available) return [head(PAGE_LABEL.meet.identity), panel(null, el("p", null, W["help.id1-none"]))];
    return [head(PAGE_LABEL.meet.identity), help("help.id1"), banner("warn", MSG.sev.info, W["help.id1"]),
      panel(null, genericTable("Providers", d.providers || [], MSG.noneYet)), panel(null, genericTable("Proposals waiting", d.proposals || [], MSG.noneYet)),
      panel(null, pairs([["Suspended people", d.suspended || 0]])), panel(null, genericTable("Pending lowerings", d.pending_lowerings || [], MSG.noneYet))];
  };
  // Calls and links: the relay, signer, download server and release in words, who is online and in which rooms, then
  // each call link's quality over the relay's window (`links` is { window_s, rows, rooms }).
  const listText = (list, n) => (list.length ? list.slice(0, n).join(", ") + (list.length > n ? fillText(", and <n> more", { n: list.length - n }) : "") : MSG.none);
  const oneDecimal = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 10) / 10) : "");
  pages.meet_calls = async () => {
    const d = await api("GET", "meet/calls");
    const s = d.summary || {};
    const links = d.links || {};
    const rows = Array.isArray(links) ? links : Array.isArray(links.rows) ? links.rows : [];
    const rooms = Array.isArray(s.rooms) ? s.rooms : [];
    const online = Array.isArray(s.online) ? s.online : [];
    const relay = s.relay || {};
    const sg = s.signer;
    const files = s.files;
    const rel = s.release;
    const signerText = !sg ? undefined : !sg.configured ? "No certificate server is set up; the issuer's PC signs."
      : (sg.healthy ? "Healthy" : "Not answering") + (sg.days_left != null ? ", " + sg.days_left + " days left" : "") + (sg.error ? ". " + clean(sg.error) : "");
    const filesText = !files ? undefined : files.configured === false ? "Not set up." + (files.hint ? " " + clean(files.hint) : "")
      : stateWord(files.state) + (files.window_ends ? ", until " + whenAny(files.window_ends) : "") + (files.error ? ". " + clean(files.error) : "");
    const person = (r) => r.name || r.principal || (r.person != null ? "Person " + r.person : "");
    const roomList = rooms.map((r) => clean(r.room) + " (" + ((r.participants || []).length) + ")");
    const summary = pairs([
      ["Relay version", relay.version || MSG.unknown], ["Up for", typeof relay.uptime_s === "number" ? span(relay.uptime_s) : undefined],
      ["People online", s.people_online != null ? String(s.people_online) : String(online.length)],
      ["Devices online", s.devices_online != null ? String(s.devices_online) : undefined],
      ["People in calls", s.participants != null ? String(s.participants) : undefined],
      ["Rooms with calls", listText(roomList, 20)],
      ["Online now", !Array.isArray(s.online) ? undefined : listText(online.map((p) => clean(p.name || p.principal || "")), 20)],
      ["Signer", signerText], ["Download server", filesText],
      ["Release", rel && rel.version ? rel.version + (rel.published ? ", published " + whenAny(rel.published) : "") : MSG.none],
    ]);
    const caption = typeof links.window_s === "number" ? fillText("Call links in the last <time>", { time: span(links.window_s) }) : "Call links";
    return [head(PAGE_LABEL.meet.calls), panel("Summary", summary), panel(null, dataTable({
      caption, rows, empty: MSG.noneYet, name: (r) => person(r) + " " + (r.room || ""),
      text: (r) => [r.room, person(r), r.level, r.path].join(" "),
      cols: [{ key: "room", label: "Room" }, { key: "name", label: "Person", cell: (r) => u(person(r)), sort: person },
        { key: "level", label: "Quality", cell: (r) => stateWord(r.level) }, { key: "reason", label: "Why", cell: (r) => stateWord(r.reason) },
        { key: "rtt_ms", label: "Round trip (ms)", cell: (r) => oneDecimal(r.rtt_ms) }, { key: "loss_pct", label: "Loss (%)", cell: (r) => oneDecimal(r.loss_pct) },
        { key: "out_kbps", label: "Sending (kbps)", cell: (r) => oneDecimal(r.out_kbps) },
        { key: "path", label: "Path", cell: (r) => [r.path, r.proto].filter(Boolean).map(clean).join(", ") },
        { key: "live", label: "In a call now", cell: (r) => (r.live == null ? "" : yesNo(r.live)) },
        { key: "updated", label: "Updated", cell: (r) => whenAny(r.updated) }],
    }))];
  };
  pages.meet_servers = async () => {
    const d = await api("GET", "meet/servers");
    const s = d.signer || {};
    const files = d.files;
    return [head(PAGE_LABEL.meet.servers),
      panel("Signer", pairs([["Healthy", yesNo(s.healthy)], ["Days left", s.days_left]])),
      panel("Download server", files ? pairs([["State", stateWord(files.state)], ["Since", files.since ? whenAny(files.since) : ""]]) : emptyLine(MSG.unknown),
        files && canWrite() && files.state !== "running" ? btn(D["files-start"].button[0], () => confirmDialog({
          dlg: "files-start", run: () => post("meet/files/start", {}, { action: "meet.files.start", target: "-" }),
        }), "primary") : null)];
  };

  // ---- Security (7.4, M2): the doors that close in every license state ----
  pages.security = async () => {
    const kids = [head(W["nav.security"]), help("help.security")];
    if (!canSecure()) return kids;
    const f = {};
    const input = (key, label) => {
      const id = uid("sec");
      f[key] = el("input", { id, type: "text", autocomplete: "off", spellcheck: "false" });
      return el("div", { class: "field" }, el("label", { for: id }, label), f[key]);
    };
    if (product() === "spokes") {
      kids.push(panel("Block or unblock a hub or spoke", input("node", "Node id"), el("div", { class: "page-head" },
        btn("Block on this relay", () => {
          const node = f.node.value.trim();
          if (node) blockDialog(node, node, (v) => post("spokes/block", { node, hours: v.hours, reason: v.reason }, { action: "spokes.block", target: node }));
        }, "danger"),
        btn("Unblock", () => {
          const node = f.node.value.trim();
          if (node) unblockDialog(node, node, null, (v) => post("spokes/unblock", { node, reason: v.reason }, { action: "spokes.unblock", target: node }));
        }))));
      kids.push(crlUploadSpokes());
      kids.push(panel("Ask the root to revoke a certificate", input("rnode", "Node id"), input("serial", "Certificate serial"),
        btn("Ask the root to revoke", () => {
          const node = f.rnode.value.trim(), serial = f.serial.value.trim();
          if (node && serial) newRequest("request-revoke", { name: node }, node, serial, "rs.revoke", { node, serial });
        }, "primary")));
    } else {
      const dev = () => ({ principal: f.principal.value.trim(), device: f.device.value.trim() });
      kids.push(panel("Block or unblock a device", input("principal", "Principal (email)"), input("device", "Device id"), el("div", { class: "page-head" },
        btn("Block this device on this relay", () => {
          const x = dev();
          if (x.principal && x.device) blockDialog(x.device, x.principal + "/" + x.device, (v) => post("meet/block", Object.assign({}, x, { hours: v.hours, reason: v.reason }), { action: "meet.block", target: x.principal + "/" + x.device }));
        }, "danger"),
        btn("Unblock", () => {
          const x = dev();
          if (x.principal && x.device) unblockDialog(x.device, x.principal + "/" + x.device, null, (v) => post("meet/unblock", Object.assign({}, x, { reason: v.reason }), { action: "meet.unblock", target: x.principal + "/" + x.device }));
        }),
        btn("Ask an admin to revoke this device", () => {
          const x = dev();
          if (x.principal && x.device) newRequest("request-revoke", { name: x.device }, x.device, x.principal + "/" + x.device, "meet.revoke", x);
        }))));
      kids.push(crlUploadMeet());
      kids.push(panel("Legal holds", btn("Place a hold", placeHold, "primary")));
    }
    kids.push(panel(null, el("ul", { class: "links-list" }, el("li", null, el("a", { href: "#/admins/sessions" }, PAGE_LABEL.admins.sessions)),
      el("li", null, el("a", { href: "#/admins/people" }, PAGE_LABEL.admins.people)))));
    return kids;
  };

  // ---- Approvals (3.7, 7.4) ----
  function fieldsOf(a) {
    const f = a.fields;
    if (Array.isArray(f)) {
      return f.map((x) => {
        if (x && typeof x === "object") {
          const name = x.name || x.label || x.field || "";
          if (Array.isArray(x.lines)) return [name, el("ul", { class: "diff" }, x.lines.map((l) => el("li", { class: /^-/.test(l) ? "old" : /^\+/.test(l) ? "new" : null }, u(String(l).replace(/^[-+] ?/, "")))))];
          if ("old" in x || "new" in x) return [name, el("span", null, u(x.old == null ? "" : typeof x.old === "object" ? JSON.stringify(x.old) : x.old), " \u2192 ", u(x.new == null ? "" : typeof x.new === "object" ? JSON.stringify(x.new) : x.new))];
          return [name, typeof x.value === "object" && x.value !== null ? JSON.stringify(x.value) : x.value];
        }
        return [String(x), ""];
      });
    }
    const src = f && typeof f === "object" ? f : a.params || {};
    return Object.entries(src).map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : v]);
  }
  const summaryOf = (a) => clean(a.summary || a.action).replace(/\?$/, "");
  function approve(a) {
    const isInvite = product() === "spokes" && a.action === "admins.invite" && a.params && a.params.role === "admin";
    confirmDialog({
      dlg: "approve-approval", vals: { summary: summaryOf(a), email: a.requested_by, time: when(a.requested_at), reason: (a.params || {}).reason || "", requester: a.requested_by },
      name: a.target, id: a.id, params: fieldsOf(a),
      body: (v) => [fill(D["approve-approval"].body[0], v), isInvite ? fill(D["approve-approval"].body[2], v) : null, D["approve-approval"].body[1]].filter(Boolean),
      plain: true,
      // AC-2a 4.7: an approval of a change on relays is a fleet step-up over those relays' fresh nonces.
      reaches: fleet() && Array.isArray(a.relays) && a.relays.length ? a.relays.map(relayName) : null,
      run: () => (fleet() && Array.isArray(a.relays) && a.relays.length
        ? fleetPost("approvals/approve", { id: a.id }, { action: "approvals.approve", target: a.id,
          params: { action: a.action, target: a.target, params: a.params || {}, requestedBy: a.requested_by, requestedAt: a.requested_at } }, a.relays)
        : post("approvals/approve", { id: a.id }, { action: "approvals.approve", target: a.id, params: a.params || {} })),
    });
  }
  function refuse(a) {
    confirmDialog({
      dlg: "refuse-approval", vals: { summary: summaryOf(a) }, name: a.target, id: a.id, danger: true, fields: [{ kind: "reason" }], plain: true,
      run: (v) => post("approvals/refuse", { id: a.id, reason: v.reason }, { action: "approvals.refuse", target: a.id }),
    });
  }
  function approvalCard(a) {
    const mine = a.requested_by === myEmail();
    const waiting = a.state === "waiting";
    const aboutMe = a.target === myEmail();
    const actions = el("div", { class: "row-actions" },
      waiting && !mine && !aboutMe ? btn(MSG.approve, () => approve(a), "primary") : null,
      waiting && !mine && !aboutMe ? btn(MSG.refuse, () => refuse(a), "danger") : null,
      waiting && mine ? btn(MSG.cancelApproval.button[0], () => confirmDialog({
        spec: MSG.cancelApproval, vals: { summary: summaryOf(a) }, name: a.target, id: a.id, danger: true, plain: true,
        run: () => api("POST", "approvals/cancel", { id: a.id }),
      })) : null);
    const link = mine && a.result && typeof a.result === "object" && a.result.link ? a.result.link : null;
    return el("section", { class: "panel approval", "aria-label": summaryOf(a) },
      el("h3", null, u(summaryOf(a))),
      pairs([["Asked by", a.requested_by], ["Asked", when(a.requested_at)], [MSG.reason, (a.params || {}).reason || ""], ["Expires", when(a.expires_at)],
        ["State", stateWord(a.state)], ["Decided by", a.decided_by ? a.decided_by : undefined], [W["dialog.id"], code(a.id)]]),
      el("h4", null, "Every detail"), pairs(fieldsOf(a)),
      link ? el("div", null, el("p", null, MSG.linkOnce), code(link), copyButton(link)) : null,
      actions);
  }
  pages.approvals = async (c) => {
    const tab = c.q.get("tab") === "all" ? "all" : "mine";
    const d = await api("GET", "approvals?state=" + (tab === "all" ? "all" : "waiting"));
    let list = d.approvals || [];
    if (tab === "mine") list = list.filter((a) => a.state === "waiting" && a.requested_by !== myEmail() && a.target !== myEmail());
    const base = fleet() ? "#/security/approvals" : "#/approvals";
    const t1 = el("a", { href: base, "aria-current": tab === "mine" ? "page" : null, class: "btn" }, MSG.waitingFor);
    const t2 = el("a", { href: base + "?tab=all", "aria-current": tab === "all" ? "page" : null, class: "btn" }, MSG.allApprovals);
    return [head(W["nav.approvals"]), help("help.approvals"), el("nav", { class: "tabs", "aria-label": W["nav.approvals"] }, t1, t2),
      el("div", null, list.length ? list.map(approvalCard) : panel(null, emptyLine(W["empty.approvals"])))];
  };

  // ---- Admins and audit: People (admins and user managers, 7.4) ----
  const methodKinds = (m) => {
    const x = m || {};
    const words = [];
    for (const k of x.webauthn || []) if (k.state === "working") words.push(MSG.kinds[k.kind] || MSG.kinds.passkey);
    if (x.password) words.push(MSG.password);
    if (x.totp) words.push(W["account.methods.app"]);
    return [...new Set(words)].join(", ");
  };
  const manageable = (p) => p.role === "viewer" || p.role === "user-manager";
  // The row actions on a console account ({email, role, state}), the same on Admins and audit > People and on the
  // fleet People page (D-2): user managers suspend viewers and user managers; admins change roles, sign out, reset.
  function accountActions(p, activeAdmins) {
    if (p.email === myEmail()) return [];
    if (!isAdmin()) {
      if (!manageable(p)) return [];
      return [
        p.state === "active" ? { label: "Suspend", run: () => suspendDialog(p, activeAdmins) } : null,
        p.state === "suspended" ? { label: "Unsuspend", run: () => unsuspendDialog(p) } : null,
      ];
    }
    return [
      p.role !== "admin" && p.state === "active" ? { label: "Make an admin", run: () => roleDialog(p, "admin") } : null,
      p.role !== "user-manager" && p.state === "active" ? { label: "Make a user manager", run: () => roleDialog(p, "user-manager") } : null,
      p.role !== "viewer" ? { label: "Make a viewer", run: () => roleDialog(p, "viewer") } : null,
      p.state === "active" ? { label: "Suspend", run: () => suspendDialog(p, activeAdmins) } : null,
      p.state === "suspended" ? { label: "Unsuspend", run: () => unsuspendDialog(p) } : null,
      { label: "Sign out everywhere", run: () => confirmDialog({ dlg: "end-sessions", vals: { email: p.email }, name: p.email, id: p.email, danger: true, run: () => post("sessions/end-all", { email: p.email }, { action: "sessions.end-all", target: p.email }) }) },
      { label: "Reset sign-in", run: () => resetDialog(p) },
      { label: MSG.remove, run: () => removeDialog(p) },
    ];
  }
  pages.admins_people = async () => {
    const d = await api("GET", "admins");
    const people = d.people || [];
    const admin = isAdmin();
    const activeAdmins = people.filter((p) => p.role === "admin" && p.state === "active").length;
    const notes = (p) => el("span", null,
      p.breakGlass ? el("span", { class: "note" }, W["admins.break-glass"], " ") : null,
      admin && p.invitedBy && p.verifiedByHub === false ? el("span", { class: "note" }, fill(W["admins.unverified"], { email: p.invitedBy })) : null,
      p.unproven ? el("span", { class: "st st-warn" }, " " + W["admins.unproven"]) : null,
      p.suspendReason ? el("span", null, " ", u(p.suspendReason)) : null);
    const actions = (p) => accountActions(p, activeAdmins);
    const kids = [head(PAGE_LABEL.admins.people, btn(MSG.inviteSomeone, inviteDialog, "primary")),
      panel(null, dataTable({
        caption: PAGE_LABEL.admins.people, rows: people, empty: W["empty.people"], text: (p) => [p.email, p.role, p.state].join(" "), name: (p) => p.email,
        chips: { label: "State", options: [["active", "Active"], ["suspended", "Suspended"], ["revoked", "Revoked"]], of: (p) => p.state },
        select: { label: "Role", options: [["admin", ROLE_WORD.admin], ["user-manager", ROLE_WORD["user-manager"]], ["viewer", ROLE_WORD.viewer]], of: (p) => p.role },
        cols: [{ key: "email", label: "Email" }, { key: "role", label: "Role", cell: (p) => ROLE_WORD[p.role] || p.role },
          { key: "state", label: "State", cell: (p) => stChip(p.state, p.state === "active" ? "ok" : p.state === "suspended" ? "warn" : "bad") },
          { key: "methods", label: W["account.methods"], cell: (p) => methodKinds(p.methods), sortable: false },
          { key: "lastSignInAt", label: "Last sign-in", cell: (p) => when(p.lastSignInAt) },
          { key: "notes", label: "Notes", cell: notes, sortable: false }],
        actions,
      }))];
    if (admin) {
      const waitingKeys = people.flatMap((p) => ((p.methods && p.methods.webauthn) || []).filter((k) => k.state === "waiting").map((k) => Object.assign({ email: p.email }, k)));
      kids.push(panel(null, dataTable({
        caption: "Waiting joiners", rows: d.waiting || [], empty: W["empty.approvals"], name: (w) => w.email,
        cols: [{ key: "email", label: "Email" }, { key: "joinedFrom", label: "Joined from", cell: (w) => code(w.joinedFrom) }, { key: "at", label: "Joined", cell: (w) => when(w.at) }, { key: "expires", label: "Expires", cell: (w) => when(w.expires) }],
        actions: (w) => [
          { label: MSG.approve, run: () => confirmDialog({ dlg: "approve-joiner", vals: { email: w.email, "hub or device": w.joinedFrom }, name: w.email, id: w.email, run: () => post("admins/approve-join", { email: w.email }, { action: "admins.approve-join", target: w.email }) }) },
          { label: MSG.discard, run: () => confirmDialog({ dlg: "remove-viewer", vals: { email: w.email }, name: w.email, id: w.email, danger: true, run: () => api("POST", "admins/remove", { email: w.email }) }) },
        ],
      })));
      kids.push(panel(null, dataTable({
        caption: "Waiting passkeys and security keys", rows: waitingKeys, empty: W["empty.approvals"], name: (k) => k.email + " " + (k.label || ""),
        cols: [{ key: "email", label: "Email" }, { key: "label", label: "Name" }, { key: "kind", label: "Kind", cell: (k) => MSG.kinds[k.kind] || k.kind },
          { key: "anchor", label: "Added from", cell: (k) => code(k.anchor) }, { key: "hint", label: W["dialog.id"], cell: (k) => code(k.hint) }],
        actions: (k) => (k.email !== myEmail() ? [{
          label: MSG.approve, run: () => confirmDialog({
            dlg: "approve-passkey", vals: { email: k.email, "hub or device": k.anchor, time: when(k.createdAt) }, name: k.email, id: k.hint,
            run: () => post("admins/approve-passkey", { email: k.email, hint: k.hint }, { action: "admins.approve-passkey", target: k.email }),
          }),
        }] : []),
      })));
    }
    const invites = (d.invites || []).filter((i) => admin || i.role === "viewer" || i.role === "user-manager");
    kids.push(panel(null, dataTable({
      caption: "Open invites", rows: invites, empty: MSG.noneYet, name: (i) => i.email,
      cols: [{ key: "email", label: "Email" }, { key: "role", label: "Role", cell: (i) => ROLE_WORD[i.role] || i.role }, { key: "expires", label: "Expires", cell: (i) => when(i.expires) },
        { key: "by", label: "By" }, { key: "mailed", label: "Mailed", cell: (i) => yesNo(i.mailed) }],
      actions: (i) => [
        { label: MSG.resend, run: () => confirmDialog({
          dlg: "resend-invite", vals: { email: i.email }, name: i.email, id: i.email,
          run: () => post("invites/resend", { email: i.email }, { action: "invites.resend", target: i.email }),
          done: (r) => showLink(r, i.email),
        }) },
        { label: MSG.cancelInvite, run: () => confirmDialog({
          spec: MSG.cancelInviteDlg, vals: { email: i.email }, name: i.email, id: i.email, danger: true, plain: true,
          run: () => api("POST", "invites/revoke", { email: i.email }),
        }) },
      ],
    })));
    return kids;
  };
  function showLink(r, email) {
    render({ keepMessages: true }).then(() => {
      if (r && r.link) $("view").prepend(linkPanel(r.link, r.expires, r.mailed ? email : null));
    });
  }
  function roleDialog(p, role) {
    const fromAdmin = p.role === "admin";
    let dlg = "role-admin";
    if (role === "user-manager") dlg = "role-user-manager";
    else if (role === "viewer") dlg = fromAdmin ? "role-viewer" : "user-manager-viewer";
    confirmDialog({
      dlg, vals: { email: p.email }, name: p.email, id: p.email, two: role === "admin" || fromAdmin, danger: role !== "admin",
      fields: [{ kind: "reason" }],
      run: (v) => post("admins/role", { email: p.email, role, reason: v.reason }, { action: "admins.role", target: p.email }),
    });
  }
  function removeDialog(p) {
    const admin = p.role === "admin";
    confirmDialog({
      dlg: admin ? "remove-admin" : "remove-viewer", vals: { email: p.email }, name: p.email, id: p.email, two: admin, danger: true,
      fields: [{ kind: "reason" }],
      run: (v) => post("admins/remove", { email: p.email, reason: v.reason }, { action: "admins.remove", target: p.email }),
    });
  }
  function suspendDialog(p, activeAdmins) {
    const after = activeAdmins - (p.role === "admin" && p.state === "active" ? 1 : 0);
    confirmDialog({
      dlg: "suspend", vals: { email: p.email }, name: p.email, id: p.email, two: p.role === "admin" && after < 2, danger: true, fields: [{ kind: "reason" }],
      run: (v) => post("admins/suspend", { email: p.email, reason: v.reason }, { action: "admins.suspend", target: p.email }),
    });
  }
  function unsuspendDialog(p) {
    confirmDialog({ dlg: "unsuspend", vals: { email: p.email }, name: p.email, id: p.email, run: () => post("admins/unsuspend", { email: p.email }, { action: "admins.unsuspend", target: p.email }) });
  }
  // Reset sign-in (3.3 "Recovery"): the link is shown to the admin to pass on, never mailed (R3-L2).
  function resetDialog(p) {
    confirmDialog({
      dlg: "reset-sign-in", vals: { email: p.email }, name: p.email, id: p.email, two: p.role === "admin" || p.role === "user-manager", danger: true,
      fields: [{ kind: "reason" }],
      run: (v) => post("admins/reset-sign-in", { email: p.email, reason: v.reason }, { action: "admins.reset-sign-in", target: p.email }),
      done: (r) => showLink(r, null),
    });
  }
  function inviteDialog() {
    const meet = product() === "meet";
    const roles = [["viewer", ROLE_WORD.viewer], ["user-manager", ROLE_WORD["user-manager"]]].concat(isAdmin() ? [["admin", ROLE_WORD.admin]] : []);
    // The invite dialogs of 8.2 follow the chosen role.
    confirmDialog({
      dlg: "invite-viewer", vals: { email: "" },
      dlgFor: (v) => (v.role === "admin" ? (meet ? "invite-admin-meet" : "invite-admin-spokes") : v.role === "user-manager" ? "invite-user-manager" : "invite-viewer"),
      fields: [{ kind: "text", type: "email", key: "email", label: "Email", maxlength: "254", required: true },
        { kind: "select", key: "role", label: "Role", options: roles, value: "viewer" }],
      vals2: (v) => ({ email: v.email }),
      two: (v) => v.role === "admin" && !meet,
      check: (v) => (!/^[^@\s]+@[^@\s]+$/.test(v.email) ? MSG.emailNeeded : ""),
      run: (v) => post("admins/invite", { email: v.email, role: v.role }, { action: "admins.invite", target: v.email }),
      done: (r) => showLink(r, r && r.mailed ? r.email || null : null),
    });
  }
  pages.admins_sessions = async () => {
    const d = await api("GET", "sessions");
    const list = d.sessions || [];
    return [head(PAGE_LABEL.admins.sessions), panel(null, dataTable({
      caption: PAGE_LABEL.admins.sessions, rows: list, empty: MSG.noneYet, text: (s) => [s.email, s.ip, s.agent].join(" "), name: (s) => s.email + " " + s.id_hint,
      cols: [{ key: "email", label: "Email" }, { key: "createdAt", label: "Started", cell: (s) => when(s.createdAt) }, { key: "lastAt", label: "Last active", cell: (s) => when(s.lastAt) },
        { key: "ip", label: "Address" }, { key: "agent", label: "Browser" }, { key: "current", label: MSG.thisSession, cell: (s) => (s.current ? MSG.yes : "") }, { key: "id_hint", label: W["dialog.id"], cell: (s) => code(s.id_hint) }],
      actions: (s) => (s.email === myEmail() ? [{ label: MSG.endSession, run: () => endSession(s) }] : []),
    }))];
  };
  // Ending the current session signs this browser out, and the dialog says so (D-7).
  function endSession(s) {
    confirmDialog({
      spec: s.current ? MSG.endThis : MSG.endOther, name: [s.agent, s.ip].filter(Boolean).join(", ") || s.id_hint, id: s.id_hint, danger: true, plain: true,
      run: () => api("POST", "sessions/end", { id_hint: s.id_hint }),
      done: s.current ? () => toSignIn(MSG.signedOut) : null,
    });
  }
  pages.admins_audit = async (c) => {
    const f = { actor: c.q.get("actor") || "", action: c.q.get("action") || "", result: c.q.get("result") || "", q: c.q.get("q") || "" };
    const qs = () => Object.entries(f).filter(([k, v]) => v && (k !== "q" || v.length >= 2)).map(([k, v]) => "&" + k + "=" + encodeURIComponent(v)).join("");
    const d = await api("GET", "audit?limit=100" + qs());
    const entries = d.entries || [];
    const fld = (key, label) => {
      const id = uid("au");
      const i = el("input", { id, type: "search", maxlength: "100", autocomplete: "off" });
      i.value = f[key];
      return [i, el("label", { for: id }, label, i)];
    };
    const [actor, actorL] = fld("actor", "Actor");
    const [action, actionL] = fld("action", "Action");
    const [q, qL] = fld("q", MSG.filterText);
    const rid = uid("au");
    const result = el("select", { id: rid }, el("option", { value: "" }, MSG.all), ["ok", "waiting", "refused", "failed", "summary"].map((r) => el("option", { value: r }, stateWord(r))));
    result.value = f.result;
    const apply = () => {
      const p = new URLSearchParams();
      if (actor.value.trim()) p.set("actor", actor.value.trim());
      if (action.value.trim()) p.set("action", action.value.trim());
      if (result.value) p.set("result", result.value);
      if (q.value.trim()) p.set("q", q.value.trim());
      const s = p.toString();
      go((fleet() ? "#/security/audit" : "#/admins/audit") + (s ? "?" + s : ""));
    };
    for (const i of [actor, action, q]) onEnter(i, apply);
    const filtered = Object.values(f).some(Boolean);
    const head2 = d.head || {};
    const from0 = (d.exportedThrough || 0) + 1 <= (head2.seq || 0) ? (d.exportedThrough || 0) + 1 : 1;
    const exportBtn = btn(MSG.exportBtn, () => confirmDialog({
      dlg: "export", vals: { from: from0, to: head2.seq || 0 },
      fields: [{ kind: "text", type: "number", key: "from", label: "From entry", value: from0, min: "1" }, { kind: "text", type: "number", key: "to", label: "To entry", value: head2.seq || 0, min: "1" }],
      vals2: (v) => ({ from: v.from, to: v.to }),
      check: (v) => (!(v.from >= 1 && v.to >= v.from && v.to - v.from < 100000) ? "Choose entries from 1 up to the latest, at most 100,000." : ""),
      run: async (v) => {
        await download("audit/export", { from: v.from, to: v.to }, { action: "audit.export", target: v.from + "-" + v.to }, "lucid-console-audit.jsonl");
        return {};
      },
    }));
    const verify = btn(MSG.check, async () => {
      try {
        const r = await api("GET", "audit/verify");
        say(r.verified ? fillText(MSG.chainOk, { n: r.through }) : fillText(MSG.chainBad, { n: r.broken_at }));
      } catch (e) {
        fail(e);
      }
    });
    const restart = S.auditBroken ? btn(W["audit.restart"], () => confirmDialog({
      dlg: "audit-restart", danger: true, run: () => post("audit/restart", {}, { action: "audit.restart", target: "-" }),
    }), "danger") : null;
    let after = entries.length ? entries[entries.length - 1].seq : null;
    const table = dataTable({
      caption: PAGE_LABEL.admins.audit, rows: entries, total: d.total, empty: filtered ? W["empty.audit"] : MSG.noEntries, name: (e) => "#" + e.seq + " " + e.action,
      cols: [{ key: "seq", label: "Entry" }, { key: "ts", label: "Time", cell: (e) => when(e.ts) }, { key: "actor", label: "Actor" }, { key: "role", label: "Role" },
        { key: "ip", label: "Address" }, { key: "action", label: "Action" }, { key: "target", label: "Target" },
        { key: "result", label: "Result", cell: (e) => stChip(e.result, e.result === "ok" ? "ok" : e.result === "refused" || e.result === "failed" ? "bad" : "none") },
        { key: "approval", label: "Approval", cell: (e) => (e.approval ? code(e.approval) : "") }, { key: "stepup", label: "Step-up", cell: (e) => yesNo(e.stepup) },
        { key: "detail", label: "Detail", cell: (e) => u(e.detail ? plainValue("detail", e.detail) : ""), sortable: false }],
      more: entries.length < (d.total || 0) ? async () => {
        const x = await api("GET", "audit?limit=100&after=" + encodeURIComponent(after) + qs());
        const got = x.entries || [];
        if (got.length) after = got[got.length - 1].seq;
        return got;
      } : null,
    });
    return [head(PAGE_LABEL.admins.audit, exportBtn, verify, restart), help("help.audit"),
      panel(null, pairs([["Latest entry", head2.seq || 0], ["Exported through", d.exportedThrough || 0],
        ["Dropped by rotation", d.dropped ? "through entry " + d.dropped.through_seq : MSG.no]])),
      panel(null, el("div", { class: "filters" }, actorL, actionL, el("label", { for: rid }, "Result", result), qL, btn(MSG.show, apply, "primary")), table)];
  };

  // ---- Settings (7.4, admins): Security, Sign-in and sessions, Email, License (Meeting Hub), Other consoles ----
  const settingsDone = async () => {
    S.settings = null;
    S.overview = null;
    await loadMe();
    setHeader();
    render({ keepMessages: true });
  };
  pages.admins_settings = async () => {
    const d = await api("GET", "settings");
    S.settings = d;
    const meet = product() === "meet";
    const clock = meet ? await api("GET", "meet/clock").catch(() => null) : null;
    const [tSec, tSign, tMail, tLic, tOther] = W["settings.sections"];
    const link = await loadLink(true);
    return [head(PAGE_LABEL.admins.settings), settingsSecurity(d, tSec, clock), settingsSignIn(d, tSign), settingsEmail(d, tMail),
      meet ? settingsLicense(d, tLic) : null, settingsLinks(d, tOther), localFleetPanel(link)];
  };
  function settingsSecurity(d, title, clock) {
    const high = d.profile !== "standard";
    const on = d.twoPerson === "on";
    const bannerArea = el("textarea", { id: uid("bn"), maxlength: "2000", spellcheck: "true" });
    bannerArea.value = d.banner || "";
    const keys = d.aaguids || [];
    const addKey = textField(MSG.aaguid, { maxlength: "36" });
    const [addWord, removeWord] = W["settings.aaguids.buttons"];
    const mds = d.mds || {};
    const blob = pasteOrFile(MSG.metadataFile, ".jwt,.txt");
    const bg = d.breakGlass;
    const seal = d.seal || {};
    const saveKeys = (list, dlg, model, danger) => confirmDialog({
      dlg, vals: { model }, name: model, id: model, two: true, danger, fields: [{ kind: "reason" }],
      body: (v) => [fill((dlg === "key-approve" && !high ? D[dlg].bodyStandard : D[dlg].body)[0], v)],
      run: (v) => post("settings/aaguids", { aaguids: list, reason: v.reason }, { action: "settings.aaguids", target: "-" }),
      done: settingsDone,
    });
    return section("sec-security", title,
      sub(W["settings.profile"], el("p", null, high ? W["settings.profile.high"] : W["settings.profile.standard"]),
        btn(W["settings.profile.button"], () => confirmDialog({
          dlg: high ? "profile-standard" : "profile-high", two: high, danger: high, fields: [{ kind: "reason" }],
          run: (v) => policyPost("settings/profile", { profile: high ? "standard" : "high", reason: v.reason }, { action: "settings.profile", target: "-" }),
          done: settingsDone,
        }))),
      sub(W["settings.two-person"], el("p", null, stChip(on ? MSG.on : MSG.off, on ? "ok" : "warn")), el("p", { class: "note" }, W["help.two-person"]),
        btn(on ? MSG.turnOff : MSG.turnOn, () => confirmDialog({
          dlg: on ? "two-person-off" : "two-person-on", two: on, always: on, danger: on, fields: [{ kind: "reason" }],
          run: (v) => policyPost("settings/two-person", { twoPerson: on ? "off" : "on", reason: v.reason }, { action: "settings.two-person", target: "-" }),
          done: settingsDone,
        }))),
      sub(W["settings.banner"], el("p", { class: "note" }, W["help.banner"]),
        el("div", { class: "field" }, el("label", { for: bannerArea.id }, W["settings.banner"]), bannerArea),
        btn(MSG.save, () => confirmDialog({
          dlg: "banner",
          run: () => post("settings/banner", { text: bannerArea.value }, { action: "settings.banner", target: "-" }),
          done: settingsDone,
        }))),
      sub(W["settings.aaguids"], el("p", { class: "note" }, high ? W["help.aaguids"] : W["help.aaguids.standard"]),
        dataTable({
          caption: W["settings.aaguids"], rows: keys, empty: MSG.noneYet, name: (k) => k.description || k.aaguid,
          cols: [{ key: "description", label: MSG.model }, { key: "aaguid", label: MSG.aaguid, cell: (k) => code(k.aaguid) }],
          actions: (k) => [{ label: removeWord, run: () => saveKeys(keys.filter((x) => x.aaguid !== k.aaguid).map((x) => x.aaguid), "key-remove", k.description || k.aaguid, true) }],
        }),
        addKey.box, btn(addWord, () => {
          const a = addKey.input.value.trim().toLowerCase();
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a)) {
            invalid(addKey.input, MSG.need.aaguid);
            return;
          }
          saveKeys(keys.map((x) => x.aaguid).concat([a]), "key-approve", a, false);
        })),
      sub(W["settings.mds.button"], el("p", null, fill(W["settings.mds"], { no: mds.no, date: dayAny(mds.nextUpdate) })), el("p", { class: "note" }, W["help.mds"]),
        blob.box, btn(W["settings.mds.button"], () => {
          const text = blob.area.value.trim();
          const parts = text.split(".");
          let p = null;
          try {
            p = parts.length === 3 ? JSON.parse(new TextDecoder().decode(unb64u(parts[1]))) : null;
          } catch (e) {
            p = null;
          }
          if (!p || p.no == null) {
            fail(fillText(R["mds-refused"], { reason: MSG.unreadable }));
            return;
          }
          confirmDialog({
            dlg: "metadata", vals: { no: p.no, date: p.nextUpdate ? dayAny(p.nextUpdate) : MSG.unknown },
            run: () => post("settings/mds", { blob: text }, { action: "settings.mds", target: "-" }),
            done: settingsDone,
          });
        })),
      el("p", null, bg ? fill(W["breakglass.set"], { email: bg.email, "time or never": bg.lastUsedAt ? when(bg.lastUsedAt) : MSG.never }) : W["breakglass.none"]),
      sealLines(seal),
      clock ? sub(W["clock.title"], el("p", null, fillList(W["clock.title.line"], [when(clock.wall), when(Date.now())])),
        clockHold(clock), btn(W["clock.title.button"], () => confirmTime(clock)), el("p", { class: "note" }, W["clock.title.note"])) : null);
  }
  // While the relay's time is uncertain: the hours left before the 72-hour hold (R4-M1, R5-L1; never an absolute time).
  function clockHold(clock) {
    if (!clock || !clock.uncertain) return null;
    const n = Math.max(0, Math.ceil(72 - (clock.uncertainRunningMs || 0) / 3600000));
    return el("p", { class: "note" }, fill(W["attention.clock-uncertain"], { n }));
  }
  // The secrets provider in use and each provider refused with its reason (8.1 seal.provider; R4-H2, R4-M2, R5-M1).
  const SEAL_WHY = ["not-service-account", "container", "record-missing", "record-null-key", "record-not-root", "credential-missing", "credential-mismatch"];
  function sealName(provider, keyMode) {
    const names = W["seal.provider.names"];
    if (provider === "dpapi-service") return names[0];
    if (provider === "dpapi-machine") return names[1];
    if (provider === "systemd-credential") return fill(names[2], { "key mode": keyMode || "" });
    if (provider === "key-file") return names[3];
    return provider ? u(provider) : null;
  }
  function sealLines(seal) {
    const out = [];
    const inUse = sealName(seal.provider, seal.keyMode);
    if (inUse) out.push(el("p", null, fill(W["seal.provider"], { provider: inUse })));
    for (const r of seal.refused || []) {
      const at = SEAL_WHY.indexOf(r.why);
      out.push(el("p", { class: "note" }, fill(W["seal.provider.refused"], {
        provider: sealName(r.provider, null) || "", why: at >= 0 ? W["seal.provider.why"][at] : r.why,
      })));
    }
    return out;
  }
  // Confirm the relay's time (2.4 "Trusted time", R3-M3): a second admin when it moves the effective time back.
  async function confirmTime(clock) {
    let k = clock;
    try {
      if (!k) k = await api("GET", "meet/clock");
    } catch (e) {
      fail(e);
      return;
    }
    confirmDialog({
      dlg: "confirm-time", two: k.wall < k.highWater, fields: [{ kind: "reason" }],
      body: () => [fillList(D["confirm-time"].body[0], [when(k.wall), when(Date.now())])],
      run: (v) => post("meet/clock/confirm", { browserTime: Date.now(), reason: v.reason }, { action: "meet.clock.confirm", target: "-" }),
      done: settingsDone,
    });
  }
  function settingsSignIn(d, title) {
    const high = d.profile !== "standard";
    const si = d.signIn || {};
    const rpId = uid("rp");
    const rp = el("input", { id: rpId, type: "checkbox", checked: si.requirePassword ? true : null });
    const idle = el("input", { type: "number", min: "5", max: "60", inputmode: "numeric", "aria-label": MSG.minutes, class: "num" });
    const max = el("input", { type: "number", min: "1", max: "24", inputmode: "numeric", "aria-label": MSG.maxHours, class: "num" });
    idle.value = String(si.idleMinutes || 15);
    max.value = String(si.maxHours || 12);
    const next = () => ({ requirePassword: rp.checked, idleMinutes: high ? 15 : Number(idle.value), maxHours: high ? 12 : Number(max.value) });
    const diff = (n) => {
      const ul = el("ul", { class: "plain" });
      const add = (name, a, b) => {
        if (a !== b) ul.append(el("li", null, fillText(MSG.changed, { name, old: a, new: b })));
      };
      add(W["settings.require-password"], onOff(si.requirePassword), onOff(n.requirePassword));
      add(MSG.minutes, String(si.idleMinutes), String(n.idleMinutes));
      add(MSG.maxHours, String(si.maxHours), String(n.maxHours));
      return ul;
    };
    return section("sec-sign-in", title,
      high ? el("label", { class: "inline", for: rpId }, rp, W["settings.require-password"]) : null,
      high ? el("p", null, W["settings.sessions-fixed"]) : el("p", { class: "sentence" }, fill(W["settings.sessions"], { n: idle, h: max })),
      btn(MSG.save, () => {
        const n = next();
        if (!high && !(n.idleMinutes >= 5 && n.idleMinutes <= 60 && n.maxHours >= 1 && n.maxHours <= 24)) {
          invalid(n.idleMinutes >= 5 && n.idleMinutes <= 60 ? max : idle, MSG.need.sessions);
          return;
        }
        const loosen = (si.requirePassword && !n.requirePassword) || n.idleMinutes > si.idleMinutes || n.maxHours > si.maxHours;
        confirmDialog({
          dlg: "sign-in-settings", two: loosen, fields: [{ kind: "reason" }],
          body: () => [fill(D["sign-in-settings"].body[0], { diff: diff(n) })],
          run: (v) => post("settings/sign-in", Object.assign({}, n, { reason: v.reason }), { action: "settings.sign-in", target: "-" }),
          done: settingsDone,
        });
      }, "primary"));
  }
  function settingsEmail(d, title) {
    const m = d.email || {};
    const smtp = m.smtp || {};
    const graph = m.graph || {};
    const sel = (label, options, value) => {
      const id = uid("em");
      const s = el("select", { id }, options.map(([v, w]) => el("option", { value: v }, w)));
      s.value = value;
      return { input: s, box: el("div", { class: "field" }, el("label", { for: id }, label), s) };
    };
    const area = (label, value) => {
      const id = uid("em");
      const a = el("textarea", { id, spellcheck: "false", autocomplete: "off" });
      a.value = value || "";
      return { input: a, box: el("div", { class: "field" }, el("label", { for: id }, label), a) };
    };
    const saved = (isSet) => (isSet ? W["settings.email.saved"] : null);
    const [mOff, mSmtp, mGraph] = W["settings.email.modes"];
    const mode = sel(W["settings.email"], [["off", mOff], ["smtp", mSmtp], ["graph", mGraph]], m.mode || "off");
    const from = textField(W["settings.email.from"], { type: "email", maxlength: "254" });
    from.input.value = m.from || "";
    const host = textField(W["settings.email.host"], { maxlength: "253" });
    host.input.value = smtp.host || "";
    const port = textField(W["settings.email.port"], { type: "number", min: "1", max: "65535", inputmode: "numeric" });
    port.input.value = String(smtp.port || 587);
    const [tStart, tTls] = W["settings.email.tls-modes"];
    const tls = sel(W["settings.email.tls"], [["starttls", tStart], ["implicit", tTls]], smtp.tls || "starttls");
    const user = textField(W["settings.email.username"], { maxlength: "254" });
    user.input.value = smtp.username || "";
    const pass = textField(W["settings.email.password"], { type: "password", autocomplete: "new-password", maxlength: "1024" }, saved(smtp.passwordSet));
    const ca = area(W["settings.email.ca"], smtp.caPem);
    const [c1, c2, c3] = W["settings.email.clouds"];
    const cloud = sel(W["settings.email.cloud"], [["commercial", c1], ["usgov", c2], ["usgov-dod", c3]], graph.cloud || "commercial");
    const tenant = textField(W["settings.email.tenant"], { maxlength: "100" });
    tenant.input.value = graph.tenant || "";
    const client = textField(W["settings.email.client"], { maxlength: "100" });
    client.input.value = graph.clientId || "";
    const mailbox = textField(W["settings.email.mailbox"], { type: "email", maxlength: "254" });
    mailbox.input.value = graph.mailbox || "";
    const [kCert, kSecret] = W["settings.email.credentials"];
    const cred = sel(W["settings.email.credential"], [["certificate", kCert], ["secret", kSecret]], graph.credential || "certificate");
    const certPem = area(MSG.certificate, "");
    const keyPem = textField(MSG.privateKey, { type: "password", autocomplete: "new-password", maxlength: "16384" }, saved(graph.credentialSet));
    const secret = textField(MSG.secret, { type: "password", autocomplete: "new-password", maxlength: "1024" }, saved(graph.credentialSet));
    const smtpBox = el("div", { class: "subpanel" }, host.box, port.box, tls.box, user.box, pass.box, ca.box);
    const graphBox = el("div", { class: "subpanel" }, cloud.box, tenant.box, client.box, mailbox.box, cred.box, certPem.box, keyPem.box, secret.box);
    const sync = () => {
      smtpBox.hidden = mode.input.value !== "smtp";
      graphBox.hidden = mode.input.value !== "graph";
      const certificate = cred.input.value === "certificate";
      certPem.box.hidden = !certificate;
      keyPem.box.hidden = !certificate;
      secret.box.hidden = certificate;
    };
    mode.input.addEventListener("change", sync);
    cred.input.addEventListener("change", sync);
    sync();
    const body = () => {
      const k = mode.input.value;
      return {
        mode: k, from: from.input.value.trim(),
        smtp: k === "smtp" ? { host: host.input.value.trim(), port: Number(port.input.value), tls: tls.input.value, username: user.input.value.trim(), password: pass.input.value, caPem: ca.input.value.trim() } : null,
        graph: k === "graph" ? {
          cloud: cloud.input.value, tenant: tenant.input.value.trim(), clientId: client.input.value.trim(), mailbox: mailbox.input.value.trim(), credential: cred.input.value,
          certificatePem: cred.input.value === "certificate" ? certPem.input.value.trim() : "", keyPem: cred.input.value === "certificate" ? keyPem.input.value : "",
          secret: cred.input.value === "secret" ? secret.input.value : "",
        } : null,
      };
    };
    const [saveWord, testWord] = W["settings.email.buttons"];
    const modeWord = { off: mOff, smtp: mSmtp, graph: mGraph };
    return section("sec-email", title, mode.box, from.box, smtpBox, graphBox,
      el("div", { class: "page-head" },
        btn(saveWord, () => {
          const b = body();
          const off = b.mode === "off";
          confirmDialog({
            dlg: off ? "email-off" : "email", vals: { mode: modeWord[b.mode], from: b.from }, two: off, danger: off, fields: [{ kind: "reason" }],
            run: (v) => post("settings/email", Object.assign({}, b, { reason: v.reason }), { action: "settings.email", target: "-" }),
            done: settingsDone,
          });
        }, "primary"),
        btn(testWord, async () => {
          try {
            const r = await api("POST", "settings/email/test", {});
            say(fillText(W["settings.email-sent"], { email: r.to }));
          } catch (e) {
            fail(e);
          }
        })));
  }
  function settingsLicense(d, title) {
    const to = textField(W["settings.license-request-to"], { type: "email", maxlength: "254" });
    to.input.value = d.licenseRequestTo || "";
    return section("sec-license", title, to.box, btn(MSG.save, () => {
      const address = to.input.value.trim();
      confirmDialog({
        dlg: "seat-request-address", vals: { address },
        run: () => post("settings/license-request-to", { address }, { action: "settings.license-request-to", target: "-" }),
        done: settingsDone,
      });
    }, "primary"));
  }
  function settingsLinks(d, title) {
    const rows = (d.links || []).map((l) => ({ label: l.label, url: l.url }));
    const box = el("div");
    function draw() {
      box.replaceChildren(...rows.map((r, i) => {
        const lid = uid("ln"), uidd = uid("ln");
        const li = el("input", { id: lid, type: "text", maxlength: "60", autocomplete: "off" });
        const ui = el("input", { id: uidd, type: "url", maxlength: "300", autocomplete: "off", spellcheck: "false" });
        li.value = r.label || "";
        ui.value = r.url || "";
        li.addEventListener("input", () => { r.label = li.value; });
        ui.addEventListener("input", () => { r.url = ui.value; });
        return el("div", { class: "filters" }, el("label", { for: lid }, "Label", li), el("label", { for: uidd }, "Address", ui),
          btn(MSG.remove, () => { rows.splice(i, 1); draw(); }, null, { "aria-label": MSG.remove + " " + (i + 1) }));
      }), rows.length < 4 ? btn(MSG.add, () => { rows.push({ label: "", url: "" }); draw(); }) : null);
    }
    draw();
    const save = btn(MSG.save, async () => {
      const links = rows.map((r) => ({ label: r.label.trim(), url: r.url.trim() })).filter((r) => r.label || r.url);
      for (const l of links) {
        let ok = false;
        try {
          const x = new URL(l.url);
          ok = x.protocol === "https:" && !!x.hostname;
        } catch (e) {
          ok = false;
        }
        if (!ok) {
          fail(R["bad-url"]);
          return;
        }
      }
      try {
        await post("settings/links", { links }, { action: "settings.links", target: "-" });
        say(MSG.done);
      } catch (e) {
        fail(e);
      }
    }, "primary");
    return section("sec-other", title, box, save);
  }

  // ---- Your account (7.4): sign-in methods, sessions, and for admins "Email me about" ----
  pages.admins_account = async () => {
    const info = await loadMe();
    const user = info.user;
    let sessions = [];
    try {
      sessions = ((await api("GET", "sessions")).sessions || []).filter((s) => s.email === user.email);
    } catch (e) {
      sessions = [];
    }
    const m = user.methods || { webauthn: [], password: false, totp: false };
    const keys = m.webauthn || [];
    const working = keys.filter((k) => k.state === "working").length;
    const standard = profile() === "standard";
    const [bPasskey, bKey, bSetPw, bChangePw, bTotp, bRemove] = W["account.methods.buttons"];
    const approved = (a) => !!a && (a.fips && a.hardwareKey ? true : standard && a.listed);
    const kindCell = (k) => el("span", null, MSG.kinds[k.kind] || k.kind, approved(k.attested) ? el("span", { class: "note" }, " ", fill(W["account.methods.key"], { model: k.attested.description })) : null);
    const renameRow = (k) => confirmDialog({
      spec: { title: MSG.renameTitle, body: [], button: [MSG.rename] }, vals: { label: k.label }, name: k.label, id: k.hint,
      fields: [{ kind: "text", key: "label", label: W["join.label"], value: k.label, maxlength: "40" }],
      check: (v) => (!v.label ? MSG.need.passkeyName : ""),
      plain: true,
      run: (v) => api("POST", "passkeys/rename", { hint: k.hint, label: v.label }),
    });
    const kids = [head(PAGE_LABEL.admins.account),
      panel(null, pairs([["Email", user.email], ["Role", ROLE_WORD[user.role] || user.role], ["State", stateWord(user.state)]])),
      el("section", { class: "panel", "aria-labelledby": "methods-h" }, el("h3", { id: "methods-h" }, W["account.methods"]),
        el("div", { class: "page-head" }, btn(bPasskey, addPasskey, "primary"), btn(bKey, addSecurityKey),
          btn(m.password ? bChangePw : bSetPw, () => setPassword(m.password)), standard && !m.totp ? btn(bTotp, setupTotp) : null),
        el("div", { id: "totp-box" }),
        dataTable({
          caption: W["account.methods"], rows: keys, empty: MSG.noneYet, name: (k) => k.label || k.hint,
          cols: [{ key: "label", label: "Name" }, { key: "kind", label: "Kind", cell: kindCell },
            { key: "state", label: "State", cell: (k) => stChip(k.state, k.state === "working" ? "ok" : k.state === "waiting" ? "warn" : "bad") },
            { key: "createdAt", label: "Added", cell: (k) => when(k.createdAt) }, { key: "lastUsedAt", label: "Last used", cell: (k) => when(k.lastUsedAt) }, { key: "hint", label: W["dialog.id"], cell: (k) => code(k.hint) }],
          actions: (k) => [
            k.state === "waiting" && working > 0 ? { label: MSG.confirm, run: () => confirmDialog({ dlg: "confirm-passkey", vals: { label: k.label }, name: k.label, id: k.hint, run: () => post("passkeys/confirm", { hint: k.hint }, { action: "passkeys.confirm", target: k.hint }) }) } : null,
            { label: MSG.rename, run: () => renameRow(k) },
            // AC-2a 3.9: a key added later is recorded in the IDE plugin or the Hub app after a step-up with that key.
            fleet() && k.state === "working" ? { label: FW["account.record-key"], run: () => recordKey(k) } : null,
            { label: bRemove, run: () => confirmDialog({ dlg: "remove-passkey", vals: { label: k.label }, name: k.label, id: k.hint, danger: true, run: () => post("passkeys/remove", { hint: k.hint }, { action: "passkeys.remove", target: k.hint }) }) },
          ],
        }),
        pairs([[MSG.password, m.password ? MSG.set : MSG.notSet], [W["account.methods.app"], el("span", null, m.totp ? MSG.set : MSG.notSet, " ",
          m.totp ? btn(bRemove, () => confirmDialog({ dlg: "totp-remove", danger: true, run: () => post("account/totp/remove", {}, { action: "account.totp-remove", target: "-" }) })) : null)]])),
      panel(null, dataTable({
        caption: PAGE_LABEL.admins.sessions, rows: sessions, empty: MSG.noneYet, name: (s) => s.id_hint,
        cols: [{ key: "createdAt", label: "Started", cell: (s) => when(s.createdAt) }, { key: "lastAt", label: "Last active", cell: (s) => when(s.lastAt) }, { key: "ip", label: "Address" },
          { key: "agent", label: "Browser" }, { key: "current", label: MSG.thisSession, cell: (s) => (s.current ? MSG.yes : "") }],
        actions: (s) => [{ label: MSG.endSession, run: () => endSession(s) }],
      }))];
    if (fleet()) kids.push(await keyFingerprints(working));
    if (isAdmin()) kids.push(mailChoices(user.mail || []));
    return kids;
  };
  function mailChoices(chosen) {
    const boxes = [];
    const groups = MAIL_GROUPS.map(([heading, kinds]) => {
      const mine = kinds.filter((x) => x[2] !== "fleet" || fleet()).map(([k, words]) => {
        const id = uid("mk");
        const c = el("input", { id, type: "checkbox", value: k, checked: chosen.includes(k) ? true : null });
        boxes.push([c]);
        return el("label", { class: "inline", for: id }, c, words);
      });
      return el("fieldset", { class: "choice grid" }, el("legend", null, heading), mine);
    });
    return el("section", { class: "panel", "aria-labelledby": "mail-h" }, el("h3", { id: "mail-h" }, W["account.mail"]), groups,
      btn(MSG.save, async () => {
        try {
          await api("POST", "account/mail", { kinds: boxes.filter((x) => x[0].checked).map((x) => x[0].value) });
          say(MSG.done);
        } catch (e) {
          fail(e);
        }
      }, "primary"));
  }
  // A WebAuthn method added through passkeys.add or account.security-key; under High from a session without
  // privileged rights the method waits for another admin (R3-H1) and the page says so.
  function enrolled(r, security) {
    const waiting = r && r.method && r.method.state === "waiting";
    render({ keepMessages: true }).then(() => {
      if (waiting) say(security ? W["account.key-waiting"] : W["join.passkey-waiting"]);
    });
  }
  function addPasskey() {
    const word = W["account.methods.buttons"][0];
    confirmDialog({
      spec: { title: word, body: [MSG.addPasskeyBody], button: [word] },
      fields: [{ kind: "text", key: "label", label: W["join.label"], value: MSG.kinds.passkey, maxlength: "40" }],
      run: async (v) => {
        const st = await stepup("passkeys.add", "-", {});
        const b = await api("POST", "passkeys/add/begin", { stepup: st });
        const cred = await passkeyCreate(b.publicKey);
        const r = await api("POST", "passkeys/add/finish", Object.assign({ ceremony: b.ceremony, credential: credJSON(cred), label: v.label || MSG.kinds.passkey }, S.record ? { record: S.record } : {}));
        keyRecordGo(r);
        return r;
      },
      plain: true,
      done: (r) => enrolled(r, false),
    });
  }
  function addSecurityKey() {
    confirmDialog({
      dlg: "add-security-key",
      fields: [{ kind: "text", key: "label", label: W["join.label"], value: MSG.kinds["security-key"], maxlength: "40" }],
      run: async (v) => {
        const st = await stepup("account.security-key", "-", {});
        const b = await api("POST", "account/security-key/begin", { stepup: st });
        const cred = await passkeyCreate(b.publicKey);
        const r = await api("POST", "account/security-key/finish", Object.assign({ ceremony: b.ceremony, credential: credJSON(cred), label: v.label || MSG.kinds["security-key"] }, S.record ? { record: S.record } : {}));
        keyRecordGo(r);
        return r;
      },
      plain: true,
      done: (r) => enrolled(r, true),
    });
  }
  function setPassword(has) {
    const [fCurrent, fNew] = W["account.methods.fields"];
    confirmDialog({
      dlg: "set-password",
      fields: (has ? [{ kind: "password", key: "current", label: fCurrent, current: true }] : []).concat([{ kind: "password", key: "password", label: fNew }]),
      check: (v) => ([...(v.password || "")].length < minPassword() ? fillText(W["join.password.body"], { n: minPassword() }) : ""),
      run: (v) => post("account/password", { current: has ? v.current : "", password: v.password }, { action: "account.password", target: "-" }),
    });
  }
  function setupTotp() {
    confirmDialog({
      dlg: "totp-setup",
      run: async () => {
        const st = await stepup("account.totp", "-", {});
        return api("POST", "account/totp/begin", { stepup: st });
      },
      plain: true,
      done: (t) => {
        const box = $("totp-box");
        if (!box || !t) return;
        const c = codeField(W["join.totp.field"]);
        box.replaceChildren(el("div", { class: "subpanel" }, el("h4", null, W["join.totp"]), el("p", null, W["join.totp.body"]),
          totpBox(t, c, async () => {
            try {
              await api("POST", "account/totp/finish", { enrollment: t.enrollment, code: c.input.value.trim() });
              say(MSG.done);
              render({ keepMessages: true });
            } catch (e) {
              fail(e);
            }
          })));
        c.input.focus();
      },
    });
  }

  // Consistent help (WCAG 3.2.6): every help text of the console in one place, from the account menu.
  pages.help = async () => {
    // A fleet console: what each part of the console does, under headings; the relay's own help texts speak of "this
    // relay" and stay on the relay's console.
    if (fleet()) {
      return [head(MSG.help), ...FMSG.help.map(([title, words], i) => section("help-" + i, title, el("p", null, words))),
        panel(null, el("p", null, MSG.helpGuideFleet))];
    }
    const keys = ["help.overview", "help.approvals", "help.requests", "help.audit", "help.blocks", "help.security", "help.two-person", "help.banner",
      profile() === "standard" ? "help.aaguids.standard" : "help.aaguids", "help.mds"]
      .concat(product() === "spokes" ? ["help.spokes-elsewhere"] : ["help.seats", "help.meet-signing", "help.meet-policies", "help.id1", "help.push"]);
    return [head(MSG.help), panel(null, keys.map((k) => el("p", null, W[k])), el("p", null, MSG.helpGuide))];
  };

  // ---- Meet CRL facts (version and count) from PEM, read with a small DER walker (display only) ----
  function crlFacts(text) {
    const blocks = [...String(text || "").matchAll(/-----BEGIN X509 CRL-----([\s\S]*?)-----END X509 CRL-----/g)];
    if (!blocks.length) return null;
    let n = 0, version = null;
    try {
      for (const b of blocks) {
        const der = Uint8Array.from(atob(b[1].replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
        const read = (at) => {
          let len = der[at + 1], hdr = 2;
          if (len & 0x80) {
            const k = len & 0x7f;
            len = 0;
            for (let i = 0; i < k; i++) len = len * 256 + der[at + 2 + i];
            hdr = 2 + k;
          }
          return { tag: der[at], start: at + hdr, end: at + hdr + len };
        };
        const kids = (node) => {
          const out = [];
          for (let p = node.start; p < node.end;) {
            const x = read(p);
            out.push(x);
            p = x.end;
          }
          return out;
        };
        const tbs = kids(read(0))[0];
        const parts = kids(tbs);
        let i = parts[0].tag === 0x02 ? 4 : 3;
        if (parts[i] && (parts[i].tag === 0x17 || parts[i].tag === 0x18)) i++;
        if (parts[i] && parts[i].tag === 0x30) n += kids(parts[i]).length;
        const ext = parts.find((p) => p.tag === 0xa0);
        if (ext && version == null) {
          for (const e of kids(kids(ext)[0])) {
            const f = kids(e);
            const oid = der.slice(f[0].start, f[0].end);
            if (oid.length === 3 && oid[0] === 0x55 && oid[1] === 0x1d && oid[2] === 0x14) {
              const int = read(f[f.length - 1].start);
              let v = 0n;
              for (let k = int.start; k < int.end; k++) v = v * 256n + BigInt(der[k]);
              version = v.toString();
            }
          }
        }
      }
    } catch (e) {
      return null;
    }
    return { version, n, lists: blocks.length };
  }

  // =================================================================================================================
  // ---- Fleet console (contract AC-2a): routing, Overview, Relays and locations, health charts, product pages through
  // the proxy, People, License, Security and audit, Settings, the setup wizard, and the relay's own Lucid Admin Console
  // panel (5.7). Relay names, sites and every value a relay sends are cleaned and written as text (AC-1 0). ----
  // Refusal words the page shows before asking the console (13.3, exact).
  const FR = {
    "fleet-scope-needs-people": "Logs and audit name people, so they need the People scope too.",
    "fleet-scope-required": "Health and status is always given.",
    "csv-limit": "A CSV can have at most 500 rows and 256 KiB.",
    // AC-2b-D 13.3: checked on the page before the mint, the import and the root are posted.
    "deploy-product": "Choose Meeting Hub or Remote Spokes.",
    "deploy-env": "Choose where the relay runs.",
    "deploy-host": "Enter a DNS name of letters, digits, dots and dashes, or an IP address where allowed.",
    "deploy-clients": "Enter networks as addresses with a prefix, such as 203.0.113.0/24.",
    "meet-ca-confirm": "Confirm that no High Meeting Hub relay anywhere trusts this CA.",
    "meet-ca-key": "That key does not belong to that CA certificate, or it is not a P-256 CA valid for 120 more days.",
    "meet-ca-signer": "Enter the certificate server as https:// and its host name.",
    "spokes-root-key": "That is not a P-256 public key. Upload root.pub, never the private key.",
  };
  const NAME_RE = /^[A-Za-z0-9 .\-_()]{1,64}$/;
  const SITE_RE = /^[A-Za-z0-9 .\-_()]{0,64}$/;
  const scopeWord = (s) => FW["scope." + s] || stateWord(s);
  const scopesText = (list) => (list || []).map(scopeWord).join(", ");
  const healthWord = (h) => FW["health." + h] || stateWord(h);
  const healthTone = (h) => (h === "ok" ? "ok" : h === "warn" ? "warn" : h === "bad" ? "bad" : "none");
  // The registry's "active" reads as live ("Connected") beside a relay that does not answer, so lists say Enrolled and
  // leave liveness to Health (D-9).
  const relayStateWord = (s) => (s === "active" ? FMSG.stateActive : FW["state." + s] || stateWord(s));
  const productWord = (p) => FMSG.product[p] || stateWord(p);
  const toneChip = (word, tone) => el("span", { class: "st st-" + (tone || "none") }, word);
  const readable = (x) => x.state === "active" || x.state === "unconfirmed";
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
  function pageLabel(group, id) {
    const g = FNAV.find((x) => x.route === group);
    const p = g && g.pages.find((x) => x[0] === id);
    return p ? p[1] : g ? FW[g.id] : FW["nav.overview"];
  }
  // The registry rows (8.2), kept 30 s for the picker, relay names and the nav.
  async function fleetRelays(force) {
    if (!force && S.relays && Date.now() - S.relaysAt < 30000) return S.relays;
    const d = await api("GET", "fleet/relays", null, { direct: true, activity: false });
    S.relays = d.relays || [];
    S.relaysAt = Date.now();
    return S.relays;
  }
  // The console's own name for a relay (13.1: never a relay-supplied string).
  function relayName(id) {
    const x = (S.relays || []).find((r) => r.id === id);
    return x ? x.name : String(id == null ? "" : id);
  }
  function relaysChanged() {
    S.relays = null;
    S.overview = null;
    render({ keepMessages: true });
  }
  // Fleet attention arguments: <relay> is the console's name for the relay id, dates and times formatted.
  function fleetArgs(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (k === "relay") out.relay = relayName(v);
      else if (k === "product") out.product = FMSG.product[v] || v;
      else if (k === "date" && isTime(v)) out.date = dayAny(v);
      else if ((k === "time" || k === "date and time") && isTime(v)) out[k] = whenAny(v);
      else if (k === "stopsAt" && isTime(v)) out["date and time"] = whenAny(v);
      else out[k] = v;
    }
    return out;
  }

  // ---- Routing (12.4 hash routes; AC-1's link routes kept) ----
  // An address with no page, or a page this role cannot open, says so with a way back (D-10).
  const noPage = (title, why) => async () => [head(title), panel(null, el("p", null, why), el("p", null, el("a", { href: "#/overview" }, FMSG.toOverview)))];
  async function fleetRoute(r) {
    let [a, b] = r.parts;
    // The relay console's routes (old links, attention items, bookmarks) open their fleet page; the query stays.
    const alias = FLEET_ALIAS["#/" + r.parts.join("/")] || (a === "admins" ? "#/settings/account" : null);
    if (alias) [a, b] = alias.slice(2).split("/");
    if (a === "spokes" && b === "nodes") b = r.q.get("role") === "hub" ? "hubs" : "spokes";
    if (a === "meet") b = { enrollments: "approvals", releases: "release", servers: "signer" }[b] || b;
    if (a === "relays" && b === "list") b = undefined;
    // The enrollment code is shown once (3.1): it leaves memory as soon as its screen is left.
    if (!((a === "relays" && b === "add") || (a === "setup" && b === "relay"))) S.enroll = null;
    if (a === "overview") return pages.fleetOverview;
    if (a === "help") return pages.help;
    if (a === "setup") return isAdmin() ? (c) => setupPage(b || "signin", c) : noPage(FMSG.notFound, FMSG.notAllowed);
    // AC-2b-D 3.7: the Meeting Hub organization CA page (admin).
    if (a === "license" && b === "meet-ca") return isAdmin() ? pages.fleetMeetCa : noPage(FW["meet-ca.title"], FMSG.notAllowed);
    // TH-1 6: Branding (admin), linked from the Lucid Meet accounts section: the console's copy and every Meeting Hub relay
    if (a === "meet" && b === "branding") return isAdmin() ? pages.fleetBranding : noPage(PAGE_LABEL.meet.branding, FMSG.notAllowed);
    const g = FNAV.find((x) => x.route === a);
    if (!g || (b && !g.pages.some(([id]) => id === b) && !(a === "relays" && /^r_[A-Za-z0-9]+$/.test(b)))) return noPage(FMSG.notFound, FMSG.notFoundBody);
    const href = a === "relays" && (!b || /^r_/.test(b)) ? "#/relays" : "#/" + a + (b ? "/" + b : "");
    if (!canOpen(href)) return noPage(routeTitle({ parts: [a, b].filter(Boolean) }), FMSG.notAllowed);
    if (a === "people") return pages.fleetPeople;
    if (a === "meet" && b === "people") return withMeetAccounts(await fleetProduct(a, b, r));
    if (a === "spokes" || a === "meet") return fleetProduct(a, b || "relays", r);
    if (a === "relays") {
      if (!b) return pages.fleetRelays;
      if (b === "locations") return pages.fleetLocations;
      if (b === "health") return pages.fleetHealth;
      if (b === "add") return pages.fleetAdd;
      return (c) => relayDetail(b, c);
    }
    if (a === "license") return r.q.get("relay") && isAdmin() ? fleetProduct("license", "relay", r) : pages.fleetLicense;
    if (a === "sign-in") return pages.fleetSignIn;
    if (a === "email") return pages.fleetEmail;
    if (a === "security") {
      if (b === "requests") return fleetProduct("security", "requests", r);
      return { approvals: pages.approvals, audit: pages.admins_audit, settings: pages.fleetSecurity, exports: pages.fleetExports, api: pages.fleetApi, compliance: pages.fleetCompliance }[b] || pages.approvals;
    }
    if (a === "settings") {
      return { console: pages.fleetConsole, setup: pages.fleetSetup, consoles: pages.fleetConsoles, account: pages.admins_account }[b] || pages.admins_account;
    }
    return pages.fleetOverview;
  }

  // ---- Product pages through the proxy (8.3): a relay picker, then the phase 1 page for that relay ----
  async function fleetProduct(group, pg, r) {
    const all = await fleetRelays();
    const own = group === "spokes" || group === "meet";
    const mine = all.filter((x) => (!own || x.product === group) && readable(x)).sort(byName);
    if (own && (pg === "relays" || !mine.length)) return (c) => productRelays(group, all, c);
    const base = group === "license" ? "#/license" : "#/" + group + "/" + pg;
    // U-1: the page is titled as its place in the nav, not with the relay console's longer name.
    const title = group === "license" ? FW["nav.license"] : pageLabel(group, pg);
    if (!mine.length) return async () => [head(title), panel(null, emptyLine(MSG.noneYet))];
    const key = group + "/" + pg;
    const asked = r.q.get("relay");
    const allowAll = group === "spokes" && (pg === "hubs" || pg === "spokes");
    // D-4: a link to a relay that cannot be read now (pending, left, removed, or unknown) says so and shows no other relay.
    if (asked && !(asked === "all" && allowAll) && !mine.some((x) => x.id === asked)) {
      const x = all.find((y) => y.id === asked);
      return async () => [head(title), relayPicker(base, mine, "", allowAll),
        panel(null, el("p", { role: "status" }, fill(FMSG.notReadable, { name: x ? x.name : asked, state: x ? relayStateWord(x.state) : FMSG.notFound })))];
    }
    const want = asked || S.pick[key] || S.pick[group];
    S.pick[key] = want === "all" && allowAll ? "all" : null;
    if (allowAll && want === "all") return (c) => allNodes(pg === "hubs" ? "hub" : "spoke", mine, base, c);
    const row = mine.find((x) => x.id === want) || mine[0];
    S.pick[key] = row.id;
    S.pick[group] = row.id;
    S.px = { relay: row.id, product: row.product, name: row.name, lic: row.license ? row.license.state : null };
    const fn = productPageFn(group, pg);
    return async (c) => {
      const pick = relayPicker(base, mine, row.id, allowAll);
      try {
        const kids = [].concat(await fn(c)).filter(Boolean);
        const h = kids[0] && kids[0].querySelector ? kids[0].querySelector("h2") : null;
        if (h) h.textContent = title;
        kids.splice(1, 0, pick);
        return kids;
      } catch (e) {
        if (e && e.status === 401) throw e;
        // A page whose scope the relay did not give shows fleet.scope-missing (8.3); any other failure stays inside
        // the page, under its title and the picker, so another relay is one choice away (D-1).
        if (e && e.code === "fleet-scope") return [head(title), pick, scopeMissing(group, pg, row, e)];
        return [head(title), pick, pageError(e)];
      }
    };
  }
  function productPageFn(group, pg) {
    const blocks = async (c) => {
      const k = await pages.security(c);
      k[0] = head(pageLabel("spokes", "blocks"));
      return k.slice(0, -1);
    };
    // Signer and servers: the signer page, then the download server (meet_servers' own Signer panel repeats it, U-9).
    const signer = async (c) => (await pages.meet_signer(c)).concat((await pages.meet_servers(c)).slice(2));
    const map = {
      spokes: { hubs: pages.spokes_hubs, spokes: pages.spokes_spokes, seats: pages.spokes_seats, revocation: pages.spokes_relays, blocks, logs: pages.logs },
      meet: { people: pages.meet_people, seats: pages.meet_seats, calls: pages.meet_calls, approvals: pages.meet_enrollments, organizations: pages.meet_organizations,
        bridges: pages.meet_bridges, holds: pages.meet_holds, release: pages.meet_releases, signer, push: pages.meet_push, logs: pages.logs },
      security: { requests: pages.requests },
      license: { relay: pages.license },
    };
    return (map[group] && map[group][pg]) || (async () => [head(pageLabel(group, pg))]);
  }
  function scopeMissing(group, pg, row, e) {
    const scope = (e.data && e.data.scope) || (PAGE_SCOPE[group] || {})[pg] || "people";
    return panel(null, el("p", null, fill(FW["fleet.scope-missing"], { scope: scopeWord(scope) })),
      isAdmin() ? el("p", null, el("a", { href: "#/relays/" + encodeURIComponent(row.id) + "?tab=scopes" }, FW["fleet.scope-ask"])) : null);
  }
  // The relay a product page reads, remembered in the hash; "All relays" where the page is a list. Choosing a relay
  // loads its page; the note beside the select says so before it is used (WCAG 3.2.2). With no current relay the
  // first option asks for one, so any choice is a change.
  function relayPicker(base, rows, cur, allowAll) {
    const id = uid("pick");
    const nid = id + "-n";
    const known = cur === "all" ? allowAll : rows.some((x) => x.id === cur);
    const opts = (known ? [] : [["", FMSG.pickerNone]]).concat(allowAll ? [["all", FW["fleet.all"]]] : [], rows.map((x) => [x.id, x.name]));
    const s = el("select", { id, "aria-describedby": nid }, opts.map(([v, w]) => el("option", { value: v }, clean(w))));
    s.value = known ? cur : "";
    s.addEventListener("change", () => {
      if (s.value) go(base + (base.includes("?") ? "&" : "?") + "relay=" + encodeURIComponent(s.value));
    });
    return el("div", { class: "picker" }, el("label", { for: id }, FMSG.cols.relay, s), el("span", { class: "note", id: nid }, FMSG.pickerNote));
  }
  // Calls one phase 1 read on every relay, at most 8 at once (8.3), each answer labeled with its relay and time.
  async function eachRelay(rows, path) {
    const out = [];
    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const x = rows[i++];
        try {
          out.push({ relay: x, at: Date.now(), d: await api("GET", path, null, { relay: x.id, activity: false }) });
        } catch (e) {
          out.push({ relay: x, error: e });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, rows.length) }, worker));
    return out;
  }
  function missingLine(names) {
    // one span: the banner is a flex row, and loose text pieces would each get the flex gap
    return names.length ? el("p", { class: "banner warn", role: "status" }, el("span", null, fill(FW["fleet.missing"], { names: names.join(", ") }))) : null;
  }
  function asOfLines(answers) {
    return el("ul", { class: "plain asof" }, answers.filter((x) => !x.error).map((x) => el("li", null, u(x.relay.name), ": ", fill(FW["fleet.as-of"], { time: when(x.at) }))));
  }
  async function allNodes(role, rows, base, c) {
    const got = await eachRelay(rows, "spokes/nodes?role=" + role + "&limit=500");
    const list = got.filter((x) => !x.error).flatMap((x) => (x.d.nodes || []).map((n) => Object.assign({ _relay: x.relay.name }, n)));
    const title = role === "hub" ? pageLabel("spokes", "hubs") : pageLabel("spokes", "spokes");
    const nameOf = (n) => n.label || n.node;
    return [head(title), relayPicker(base, rows, "all", true), missingLine(got.filter((x) => x.error).map((x) => x.relay.name)), asOfLines(got),
      panel(null, dataTable({
        caption: title, rows: list, empty: role === "hub" ? W["empty.hubs"] : W["empty.spokes"], name: nameOf, q: c.q.get("q") || "",
        text: (n) => [n._relay, n.label, n.node, n.email].join(" "),
        cols: [{ key: "_relay", label: FMSG.cols.relay }, { key: "label", label: FMSG.cols.name, cell: (n) => u(nameOf(n)), sort: nameOf }, { key: "node", label: "Node", cell: (n) => code(n.node) },
          isManager() ? { key: "email", label: "Person" } : null, { key: "lastSeenAt", label: "Last seen", cell: (n) => when(n.lastSeenAt) },
          { key: "state", label: FMSG.cols.state, cell: (n) => stChip(n.state, nodeTone(n.state)) }].filter(Boolean),
      }))];
  }

  // ---- Relays and locations (8.2) ----
  // A relay's license `service` (revision 3.4, AC-1 4.7): on the 8.2 rows inside `license`, on fleet/licenses beside it.
  const serviceOf = (r) => (r && (r.service || (r.license && r.license.service))) || null;
  function serviceText(r) {
    const s = serviceOf(r);
    if (!s) return null;
    if (s.state === "stopped") return FW["relay.license-stopped"];
    if (s.state === "grace") return fillText(FW["relay.license-grace"], { "date and time": whenAny(s.stopsAt) });
    if (s.state === "upgrade-period") return fillText(FW["relay.license-upgrade-period"], { "date and time": whenAny(s.stopsAt) });
    return null;
  }
  function licenseCell(r) {
    const said = serviceText(r);
    if (said) return said;
    const l = r.license || {};
    if (!l.state) return MSG.unknown;
    return stateWord(l.state) + (l.daysLeft != null ? ", " + l.daysLeft + " " + FMSG.daysWord : "");
  }
  // The `why` of a stopped relay as its 13.1 words.
  const relayWhy = (s) => (s && s.why && FW["relay.license-why-" + s.why]) || null;
  // The reminder steps (AC-1 R42-3): 30, 14, 7, 3 and 1 days before `exp`, at `exp`, then every 12 hours until the stop.
  function nextReminder(exp, s, sent) {
    if (!s || s.state === "stopped") return null;
    const now = Date.now();
    const last = Math.max(0, ...(sent || []).map((r) => (r.at > 1e12 ? r.at : r.at * 1000) || 0));
    const expMs = exp ? (exp > 1e12 ? exp : exp * 1000) : null;
    const stop = s.stopsAt ? (s.stopsAt > 1e12 ? s.stopsAt : s.stopsAt * 1000) : null;
    if (s.state === "grace" || s.state === "upgrade-period") {
      const at = last ? last + 12 * 3600000 : now;
      return stop && at >= stop ? stop : at;
    }
    if (!expMs) return null;
    const steps = [30, 14, 7, 3, 1].map((n) => expMs - n * 86400000).concat([expMs]);
    return steps.find((t) => t > now) || null;
  }
  // relay.license-reminders: the reminders sent ("30 days (Nov 1, 2026, ...)", separated by semicolons because the
  // times hold commas) and the next one. The words end in their own period, so "none yet" carries none.
  function reminderLine(sent, next) {
    const list = sent.map((r) => (MSG.reminderKind[r.kind] || stateWord(r.kind)) + " (" + whenAny(r.at) + ")").join("; ");
    return fill(FW["relay.license-reminders"], { list: list || MSG.noneSent, date: next ? when(next) : MSG.never.toLowerCase() });
  }
  // The License part of the relay detail (8.2): the service state, why, the stop time, the reminders sent and next,
  // and "Install a license", which works on a stopped relay (11.4).
  function relayLicense(d, l) {
    const s = serviceOf(d) || serviceOf(l);
    const sent = (l && l.reminders) || (s && s.reminders) || [];
    const exp = l && l.license ? l.license.exp : d.license ? d.license.exp : null;
    const next = nextReminder(exp, s, sent);
    return panel(FMSG.cols.license, pairs([[FMSG.cols.license, licenseCell(d)],
      [MSG.serviceWhy, s && s.state === "stopped" ? relayWhy(s) || undefined : undefined]]),
      sent.length || next ? el("p", null, reminderLine(sent, next)) : null,
      s && s.state === "stopped" ? el("p", { class: "note" }, FW["relay.license-install-stopped"]) : null,
      isAdmin() && d.state === "active" ? el("a", { class: "btn", href: "#/license?relay=" + encodeURIComponent(d.id) }, W["license.install"]) : null);
  }
  function relayChips(r) {
    return el("span", { class: "chip-row" },
      r.readOnly ? el("span", { class: "chip" }, FW["fleet.read-only"]) : null,
      r.state === "unconfirmed" ? el("span", { class: "chip warn" }, FW["state.unconfirmed"]) : null,
      (r.confirm || []).length ? el("span", { class: "chip" }, FW["fleet.confirm-here"]) : null);
  }
  function relayActions(r) {
    if (!isAdmin()) return [];
    const live = r.state !== "removed";
    // The name links to the relay, so the menu holds only the actions.
    return [
      r.state === "unconfirmed" ? { label: FD["confirm-relay"].button, run: () => confirmRelay(r.id) } : null,
      live ? { label: FMSG.rename, run: () => labelDialog(r) } : null,
      live ? { label: FMSG.scopes, run: () => go("#/relays/" + encodeURIComponent(r.id) + "?tab=scopes") } : null,
      ...clusterActions(r),
      { label: FMSG.replace, run: () => go("#/relays/add?replaces=" + encodeURIComponent(r.id)) },
      live ? { label: FMSG.remove, run: () => removeRelayDialog(r) } : null,
    ];
  }
  // MR-1 4: what a Meeting Hub relay reports of its cluster (r.cluster, null outside one), and the role changes an
  // admin makes on it through the relay's console routes.
  const CLUSTER_TONE = { active: "ok", standby: "none", fenced: "warn" };
  const numText = (v) => (v == null ? undefined : String(v));
  function clusterRole(c) {
    return c.role ? toneChip(FMSG.cluster.roles[c.role] || stateWord(c.role), CLUSTER_TONE[c.role]) : MSG.unknown;
  }
  const lagText = (c) => (c.lagS == null ? undefined : fillText(FMSG.cluster.seconds, { n: String(Math.round(c.lagS)) }));
  function clusterCell(r) {
    const c = r.cluster;
    if (!c) return "";
    const lag = lagText(c);
    return el("span", null, u(c.node), " ", clusterRole(c), " ", fillText(FMSG.cluster.short, { epoch: numText(c.epoch), generation: numText(c.generation) }),
      lag ? ", " + fillText(FMSG.cluster.lagShort, { lag }) : null);
  }
  function clusterPairs(c) {
    if (!c) return [];
    const yn = (b) => (b == null ? undefined : yesNo(b));
    const dir = c.directoryVersion == null ? undefined
      : fillText(FMSG.cluster.directoryShort, { version: String(c.directoryVersion), time: c.directoryExpires ? when(c.directoryExpires) : MSG.unknown });
    return [[FMSG.cluster.id, numText(c.cluster)], [FMSG.cluster.node, numText(c.node)], [FMSG.cluster.role, clusterRole(c)],
      [FMSG.cluster.epoch, numText(c.epoch)], [FMSG.cluster.generation, numText(c.generation)], [FMSG.cluster.lag, lagText(c)],
      [FMSG.cluster.peer, numText(c.peer)], [FMSG.cluster.witness, yn(c.witness)], [FMSG.cluster.autoPromote, yn(c.autoPromote)], [FMSG.cluster.directory, dir]];
  }
  // A standby or fenced relay can be promoted; the active one made a standby or handed over (contract 2.5).
  function clusterActions(r) {
    const c = r.cluster;
    if (!isAdmin() || r.state !== "active" || !c || !c.role) return [];
    const act = (k) => ({ label: FMSG.cluster[k], run: () => clusterDialog(r, k) });
    return c.role === "active" ? [act("demote"), act("handover")] : [act("promote")];
  }
  function clusterDialog(r, k) {
    const force = k === "promote" ? [{ kind: "select", key: "force", label: FMSG.cluster.force, options: yesNoOptions(), value: "no" }] : [];
    confirmDialog({
      spec: FMSG.cluster.dlg[k], vals: { name: r.name, cluster: r.cluster.cluster || "" }, name: r.name, id: r.id, danger: true, reaches: [r.name],
      fields: force.concat([{ kind: "reason" }]),
      run: (v) => post("meet/cluster/" + k, k === "promote" ? { force: v.force === "yes", reason: v.reason } : { reason: v.reason },
        { action: "meet.cluster." + k, target: "-" }, { relay: r.id }),
      done: relaysChanged,
    });
  }
  function relaysTable(rows, caption, productFixed, c) {
    const q = c ? c.q : new URLSearchParams();
    const sites = [...new Set(rows.map((r) => r.site).filter(Boolean))].sort();
    return dataTable({
      caption, rows: rows.slice().sort(byName), empty: productFixed ? FW["fleet.no-relays-" + productFixed] : MSG.noneYet, name: (r) => r.name,
      text: (r) => [r.name, r.site, r.version, r.id].join(" "), q: q.get("q") || "",
      selects: [productFixed ? null : { label: FMSG.cols.product, options: [["spokes", productWord("spokes")], ["meet", productWord("meet")]], of: (r) => r.product, value: q.get("product") || "" },
        { label: FMSG.cols.health, options: ["ok", "warn", "bad", "silent"].map((h) => [h, healthWord(h)]), of: (r) => r.health, value: q.get("health") || "" },
        sites.length ? { label: FMSG.cols.site, options: sites.map((s) => [s, s]), of: (r) => r.site || "", value: q.get("site") || "" } : null].filter(Boolean),
      cols: [
        { key: "name", label: FMSG.cols.name, cell: (r) => el("a", { href: "#/relays/" + encodeURIComponent(r.id) }, u(r.name)), sort: (r) => r.name },
        productFixed ? null : { key: "product", label: FMSG.cols.product, cell: (r) => productWord(r.product) },
        { key: "site", label: FMSG.cols.site },
        { key: "version", label: FMSG.cols.version },
        { key: "license", label: FMSG.cols.license, cell: licenseCell, sort: (r) => (r.license ? r.license.state : "") },
        rows.some((r) => r.cluster) ? { key: "cluster", label: FMSG.cluster.col, cell: clusterCell, sortable: false } : null,
        { key: "health", label: FMSG.cols.health, cell: (r) => toneChip(healthWord(r.health), healthTone(r.health)) },
        { key: "lastContactAt", label: FMSG.cols.contact, cell: (r) => when(r.lastContactAt) },
        { key: "state", label: FMSG.cols.state, cell: (r) => el("span", null, relayStateWord(r.state), " ", relayChips(r)), sortable: false },
      ].filter(Boolean),
      actions: relayActions,
    });
  }
  function addLink() {
    return isAdmin() ? el("a", { href: "#/relays/add", class: "btn primary" }, FW["enroll.title"]) : null;
  }
  pages.fleetRelays = async (c) => {
    const rows = await fleetRelays(true);
    return [head(pageLabel("relays", "list"), addLink()), panel(null, relaysTable(rows, pageLabel("relays", "list"), null, c))];
  };
  async function productRelays(group, all, c) {
    const rows = all.filter((x) => x.product === group);
    const title = pageLabel(group, "relays");
    if (!rows.length) return [head(title), panel(null, el("p", null, FW["fleet.no-relays-" + group]), addLink())];
    return [head(title, addLink()), panel(null, relaysTable(rows, title, group, c)), ...(group === "meet" ? await directoryPanels(rows) : [])];
  }
  // MR-1 4: each cluster's signed relay directory, read from its active relay (admins: version, dates and nodes) or as
  // its relays report it (version and end date).
  async function directoryPanels(rows) {
    const pick = new Map();
    for (const r of rows.filter((x) => x.cluster && x.cluster.cluster && x.state !== "removed")) {
      const cur = pick.get(r.cluster.cluster);
      if (!cur || (r.cluster.role === "active" && cur.cluster.role !== "active")) pick.set(r.cluster.cluster, r);
    }
    const keys = [...pick.keys()].sort();
    return Promise.all(keys.map((k) => directoryPanel(fill(FMSG.cluster.dir.title, { cluster: k }), pick.get(k))));
  }
  async function directoryPanel(title, r) {
    const c = r.cluster;
    const D = FMSG.cluster.dir;
    const from = el("p", { class: "note" }, fill(D.from, { relay: r.name }));
    if (!isAdmin() || r.state !== "active") {
      return panel(title, pairs([[D.version, numText(c.directoryVersion) || MSG.unknown], [D.expires, c.directoryExpires ? when(c.directoryExpires) : MSG.unknown]]), from);
    }
    let wire;
    try {
      wire = (await api("GET", "meet/cluster/directory", null, { relay: r.id, activity: false })).directory;
    } catch (e) {
      return panel(title, el("p", { role: "status" }, fill(D.unreadable, { relay: r.name, message: e.message })));
    }
    const d = wire && typeof wire === "object" ? wire.directory : null;
    if (!d || typeof d !== "object") return panel(title, el("p", null, fill(D.none, { relay: r.name })));
    return panel(title, pairs([[D.version, numText(d.version)], [D.issued, whenAny(d.issued)], [D.expires, whenAny(d.expires)]]),
      dataTable({
        caption: D.nodes, rows: Array.isArray(d.nodes) ? d.nodes.filter((n) => n && typeof n === "object") : [], empty: MSG.noneYet, name: (n) => clean(n.id),
        cols: [{ key: "id", label: FMSG.cluster.node, cell: (n) => code(n.id) }, { key: "server", label: D.server, cell: (n) => code(n.server) },
          { key: "address", label: D.address, cell: (n) => (n.address ? code(n.address) : "") }, { key: "port", label: D.port },
          { key: "region", label: D.region }, { key: "priority", label: D.priority }],
      }),
      from);
  }
  // Locations: the relays grouped by site or region, with counts and the worst health per group (the map is phase 4).
  const HEALTH_RANK = { ok: 0, warn: 1, silent: 2, bad: 3 };
  pages.fleetLocations = async () => {
    const rows = await fleetRelays(true);
    const groups = new Map();
    for (const r of rows.filter((x) => x.state !== "removed")) {
      const k = r.site || "";
      const g = groups.get(k) || { site: k, n: 0, worst: "ok" };
      g.n++;
      if ((HEALTH_RANK[r.health] || 0) > (HEALTH_RANK[g.worst] || 0)) g.worst = r.health;
      groups.set(k, g);
    }
    const title = pageLabel("relays", "locations");
    return [head(title), panel(null, dataTable({
      caption: title, rows: [...groups.values()].sort((a, b) => a.site.localeCompare(b.site)), empty: MSG.noneYet, name: (g) => g.site || MSG.unknown,
      cols: [{ key: "site", label: FMSG.cols.site, cell: (g) => (g.site ? el("a", { href: "#/relays?site=" + encodeURIComponent(g.site) }, u(g.site)) : MSG.unknown) },
        { key: "n", label: FMSG.cols.count }, { key: "worst", label: FMSG.cols.worst, cell: (g) => toneChip(healthWord(g.worst), healthTone(g.worst)), sort: (g) => HEALTH_RANK[g.worst] }],
    }))];
  };

  // Row actions and their 13.2 dialogs. Console-local rows use AC-1 step-up; changes that reach a relay list it.
  async function confirmRelay(id) {
    let d;
    try {
      d = (await api("GET", "fleet/relays/" + encodeURIComponent(id), null, { direct: true })).relay || {};
    } catch (e) {
      fail(e);
      return;
    }
    confirmDialog({
      spec: fspec("confirm-relay"), vals: { name: d.name, fingerprint: d.fingerprint || "" }, name: d.name, id,
      body: (v) => [fill(FD["confirm-relay"].body, v), el("p", { class: "note" }, FW["enroll.confirm-help"])],
      fields: [{ kind: "text", key: "fingerprint", label: FW["enroll.fingerprint"], maxlength: "160", required: true }],
      check: (v) => (!v.fingerprint ? MSG.need.fingerprint : ""),
      run: (v) => post("fleet/relays/confirm", { relay: id, fingerprint: v.fingerprint }, { action: "fleet.relay.confirm", target: id }),
      done: relaysChanged,
    });
  }
  function labelDialog(r) {
    confirmDialog({
      spec: fspec("label"), vals: { name: r.name }, name: r.name, id: r.id,
      fields: [{ kind: "text", key: "name", label: FW["enroll.name"], value: r.name, maxlength: "64", required: true },
        { kind: "text", key: "site", label: FW["enroll.site"], value: r.site || "", maxlength: "64" }],
      check: (v) => (!NAME_RE.test(v.name) ? MSG.need.name : !SITE_RE.test(v.site) ? MSG.need.site : ""),
      run: (v) => post("fleet/relays/label", { relay: r.id, name: v.name, site: v.site }, { action: "fleet.relay.label", target: r.id }),
      done: relaysChanged,
    });
  }
  function removeRelayDialog(r) {
    confirmDialog({
      spec: fspec("remove-relay"), vals: { name: r.name }, name: r.name, id: r.id, danger: true, reaches: [r.name], fields: [{ kind: "reason" }],
      run: (v) => post("fleet/relays/remove", { relay: r.id, reason: v.reason }, { action: "fleet.relay.remove", target: r.id }),
      done: () => {
        S.relays = null;
        go("#/relays");
      },
    });
  }
  // Scopes (4.1): narrowing applies at once; widening is a request the relay's operator accepts. People out takes
  // Logs and audit with it; Logs and audit needs People.
  function scopesDialog(d, next) {
    const cur = d.scopes || [];
    if (next.includes("read-logs") && !next.includes("people")) {
      fail(FR["fleet-scope-needs-people"]);
      return;
    }
    const removed = cur.filter((s) => !next.includes(s));
    const added = next.filter((s) => !cur.includes(s));
    if (!removed.length && !added.length) return;
    const k = removed.length ? "narrow-scopes" : "widen-scopes";
    confirmDialog({
      spec: fspec(k), vals: { name: d.name, scopes: scopesText(removed.length ? removed : added) }, name: d.name, id: d.id, reaches: [d.name], fields: [{ kind: "reason" }],
      danger: !!removed.length,
      body: (v) => [fill(FD[k].body, v), removed.length && added.length ? el("p", null, fill(FD["widen-scopes"].title, { name: d.name, scopes: scopesText(added) }), " ", FD["widen-scopes"].body) : null],
      run: (v) => post("fleet/relays/scopes", { relay: d.id, scopes: next, reason: v.reason }, { action: "fleet.relay.scopes", target: d.id }),
      done: relaysChanged,
    });
  }

  // ---- The relay detail panel (8.2): Summary, Trust, Health, Scopes and controls, Attention, product pages ----
  async function relayDetail(id, c) {
    await fleetRelays();
    const d = (await api("GET", "fleet/relays/" + encodeURIComponent(id), null, { direct: true })).relay || {};
    d.id = d.id || id;
    const admin = isAdmin();
    const tabs = [["summary", FMSG.tabs.summary], admin ? ["trust", FW["trust.title"]] : null, ["health", FMSG.tabs.health], ["scopes", FMSG.tabs.scopes],
      ["attention", FMSG.tabs.attention], ["pages", FMSG.tabs.pages]].filter(Boolean);
    const want = c.q.get("tab");
    const tab = tabs.some((t) => t[0] === want) ? want : "summary";
    const base = "#/relays/" + encodeURIComponent(id);
    const nav = el("nav", { class: "tabs", "aria-label": d.name || id }, tabs.map(([k, w]) => el("a", { class: "btn", href: base + "?tab=" + k, "aria-current": k === tab ? "page" : null }, w)));
    const tools = admin ? [d.state === "unconfirmed" ? btn(FD["confirm-relay"].button, () => confirmRelay(id), "primary") : null,
      d.state !== "removed" ? btn(FMSG.rename, () => labelDialog(d)) : null, ...clusterActions(d).map((a) => btn(a.label, a.run)),
      btn(FMSG.replace, () => go("#/relays/add?replaces=" + encodeURIComponent(id))),
      d.state !== "removed" ? btn(FMSG.remove, () => removeRelayDialog(d), "danger") : null] : [];
    const kids = [head(u(d.name || id), ...tools), nav];
    if (d.state === "unconfirmed") kids.push(banner("warn", MSG.sev.warn, FW["fleet.unconfirmed"]));
    if (tab === "summary") {
      const lics = await api("GET", "fleet/licenses", null, { direct: true }).catch(() => null);
      kids.push(relaySummary(d), relayLicense(d, ((lics && lics.relays) || []).find((x) => x.relay === d.id) || null));
    } else if (tab === "trust") kids.push(await relayTrust(d));
    else if (tab === "health") kids.push(rangeButtons(base + "?tab=health", rangeOf(c)), await relayCharts(d, rangeOf(c)));
    else if (tab === "scopes") kids.push(relayScopes(d));
    else if (tab === "attention") kids.push(panel(FMSG.tabs.attention, attentionList(Array.isArray(d.attention) ? d.attention : [])));
    else kids.push(relayPages(d));
    return kids;
  }
  function relaySummary(d) {
    const nodes = d.nodes;
    const svc = d.services;
    const leave = d.product === "meet" ? "lucid-relay meet fleet leave --config <relay.json>" : "lucid-relay fleet leave --state <folder>";
    return panel(null, pairs([
      [FMSG.cols.name, d.name], [FMSG.cols.product, productWord(d.product)], [FMSG.cols.site, d.site || ""],
      [FMSG.cols.state, el("span", null, relayStateWord(d.state), " ", relayChips(d))],
      [FMSG.cols.health, toneChip(healthWord(d.health), healthTone(d.health))], [FMSG.cols.version, d.version || ""], ["OS", d.os || ""],
      ["FIPS mode", yesNo(d.fips)], [W["settings.profile"], d.profile ? FMSG.profileWords[d.profile] || d.profile : ""],
      [FMSG.cols.license, licenseCell(d)], [FMSG.cols.contact, when(d.lastContactAt)], [FMSG.certEnds, d.certNotAfter ? when(d.certNotAfter) : MSG.unknown],
      ...clusterPairs(d.cluster),
      nodes ? [FMSG.nodes, [nodes.hubsOnline + " of " + nodes.hubs + " hubs online", nodes.spokesOnline + " of " + nodes.spokes + " spokes online", nodes.spokesSilent + " silent"].join(", ")] : [FMSG.nodes, undefined],
      svc ? [FMSG.services, [svc.signer ? FMSG.signer + " " + (svc.signer.healthy ? MSG.yes : MSG.no).toLowerCase() + (svc.signer.daysLeft != null ? ", " + svc.signer.daysLeft + " " + FMSG.daysWord : "") : null,
        svc.push ? FMSG.push + " " + onOff(svc.push.enabled).toLowerCase() + ", " + fillText(FMSG.failures24h, { n: svc.push.failed24h || 0 }) : null].filter(Boolean).join("; ")] : [FMSG.services, undefined],
      [FW["enroll.fingerprint"], d.fingerprint ? el("code", { class: "fingerprint" }, clean(d.fingerprint)) : undefined],
      [FMSG.enrolledBy, d.enrolledBy || undefined], [FMSG.enrolled, d.enrolledAt ? when(d.enrolledAt) : undefined],
      [W["dialog.id"], code(d.id)],
      [FMSG.leaveCmd, el("code", { class: "cmd" }, leave)],
    ]));
  }
  // The Trust tab (8.2): the relay's bootstrap state as it reports it, which first-roster entries are anchored and how,
  // held and unattested keys, CA pins and the trust list number it holds.
  async function relayTrust(d) {
    const [roster, trust] = await Promise.all([api("GET", "fleet/roster", null, { direct: true }).catch(() => null), api("GET", "fleet/trust", null, { direct: true }).catch(() => null)]);
    const rr = ((roster && roster.relays) || []).find((x) => x.relay === d.id) || {};
    const tr = ((trust && trust.relays) || []).find((x) => x.relay === d.id) || {};
    const bRaw = d.bootstrap || rr.bootstrap || {};
    const bs = typeof bRaw === "string" ? { state: bRaw } : bRaw;
    const held = d.held || rr.held || [];
    const unattested = d.unattested || rr.unattested || [];
    const pins = d.pins || tr.pins || [];
    const entries = bs.entries || [];
    return section("trust-h", FW["trust.title"],
      el("p", null, toneChip(bs.state === "done" ? FW["bootstrap.done"] : FW["bootstrap.pending"], bs.state === "done" ? "ok" : "warn")),
      el("p", { class: "note" }, FW["bootstrap.how-to-anchor"]),
      entries.length ? dataTable({
        caption: FMSG.keys, rows: entries, empty: MSG.noneYet, name: (e) => e.email + " " + (e.hint || ""),
        cols: [{ key: "email", label: FMSG.cols.email }, { key: "role", label: FMSG.cols.role, cell: (e) => ROLE_WORD[e.role] || stateWord(e.role) },
          { key: "hint", label: W["dialog.id"], cell: (e) => code(e.hint || "") },
          { key: "via", label: FMSG.anchor, cell: (e) => FMSG.anchored[e.via] || FMSG.anchored.none }],
      }) : null,
      sub(FMSG.held, held.length ? el("ul", { class: "plain" }, held.map((h) => el("li", null, code(h), " ",
        btn(FD["roster-cancel"].button, () => rosterCancel(d, h), "danger", { "aria-label": FD["roster-cancel"].button + " " + clean(h) })))) : emptyLine(MSG.noneYet)),
      sub(FMSG.unattested, unattested.length ? el("ul", { class: "plain" }, unattested.map((h) => el("li", null, code(h)))) : emptyLine(MSG.noneYet)),
      sub(FMSG.pins, pins.length ? el("ul", { class: "plain" }, pins.map((p) => el("li", null, FMSG.generation + " " + clean(p.generation) + ": " + stateWord(p.state)))) : emptyLine(MSG.noneYet),
        el("p", null, FMSG.manifest + ": " + clean(d.manifestSeq != null ? d.manifestSeq : tr.manifestSeq != null ? tr.manifestSeq : MSG.unknown))));
  }
  // Cancel a held key (4.4): best effort, a fleet step-up over that relay's nonce.
  function rosterCancel(d, hint) {
    confirmDialog({
      spec: fspec("roster-cancel"), vals: { hint, relay: d.name }, name: hint, id: hint, danger: true, reaches: [d.name],
      run: () => fleetPost("fleet/roster/cancel", { relay: d.id, hint }, { action: "fleet.roster.cancel", target: hint }, [d.id]),
    });
  }
  // Scopes and controls (8.2), with the scope request waiting for the operator.
  function relayScopes(d) {
    const cur = d.scopes || [];
    const req = d.scopeRequest || null;
    const pending = req ? req.requestedScopes || [] : d.pendingScopes || [];
    const waiting = d.waiting || [];
    const boxes = SCOPES.map((s) => {
      const id = uid("sc");
      const required = s === "read-health";
      const cb = el("input", { id, type: "checkbox", value: s, checked: cur.includes(s) || required ? true : null, disabled: required ? true : null,
        "aria-describedby": required ? id + "-n" : null });
      return [cb, el("label", { class: "inline", for: id }, cb, scopeWord(s), required ? el("span", { class: "note", id: id + "-n" }, " ", FR["fleet-scope-required"]) : null)];
    });
    return el("div", null,
      panel(FMSG.tabs.scopes, pairs([[FMSG.scopesNow, scopesText(cur)], [FMSG.readOnlyRelay, yesNo(d.readOnly)], [FMSG.confirmHere, (d.confirm || []).length ? scopesText(d.confirm) : MSG.no]]),
        pending.length ? sub(FMSG.pending, el("p", null, scopesText(pending)), el("p", { class: "note" }, FD["widen-scopes"].body),
          req && req.requestId ? el("p", null, FMSG.acceptCmd, " ", el("code", { class: "cmd" }, "lucid-relay fleet accept-scopes " + clean(req.requestId))) : null) : null,
        waiting.length ? sub(FMSG.waitingChanges, el("ul", { class: "plain" }, waiting.map((w) => el("li", null,
          fill(w.result === "unknown" ? FW["fleet.confirm-unknown"] : FW["fleet.waiting-operator"], { id: w.id }), w.summary ? [" ", u(w.summary)] : null)))) : null,
        isAdmin() && d.state !== "removed" && d.state !== "left" ? el("div", null,
          el("fieldset", { class: "choice" }, el("legend", null, FW["enroll.scopes"]), boxes.map((x) => x[1])),
          btn(FMSG.scopes, () => scopesDialog(d, boxes.filter((x) => x[0].checked || x[0].value === "read-health").map((x) => x[0].value)), "primary")) : null));
  }
  function relayPages(d) {
    const g = FNAV.find((x) => x.route === d.product);
    const links = g ? g.pages.filter(([id]) => id !== "relays").map(([id, label]) => ["#/" + d.product + "/" + id + "?relay=" + encodeURIComponent(d.id), label]).filter(([h]) => canOpen(h)) : [];
    return panel(FMSG.tabs.pages, el("ul", { class: "links-list" }, links.map(([h, w]) => el("li", null, el("a", { href: h }, w)))));
  }

  // ---- Deploy a relay (AC-2b-D 3; AC-2a 3.1, 8.2): product, where it runs, details and the code, join and confirm ----
  // S.enroll holds the page's state in memory only: a reload before minting starts over (3.1). After minting,
  // #/relays/add/<enrollmentId> reopens step 4 from the server. The code leaves memory when step 4 opens (shown once).
  const DEPLOY_ENVS = ["linux", "proxmox", "docker", "installed"];
  const NEXT_ENVS = ["azure", "aws", "gcp", "windows"];
  const ENROLLMENT_RE = /^en_[0-9a-f]{16}$/;
  const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
  const dnsOk = (s) => s.length >= 1 && s.length <= 253 && s.split(".").every((l) => LABEL_RE.test(l));
  // An IPv6 literal, checked by the URL parser's host rules (a non-special scheme, so nothing is fetched or named).
  function ipv6Ok(s) {
    if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return false;
    try {
      new URL("lucid://[" + s + "]/");
      return true;
    } catch (e) {
      return false;
    }
  }
  const addressOk = (s) => IPV4_RE.test(s) || ipv6Ok(s);
  function cidrOk(s) {
    const m = /^([^/]+)\/([0-9]{1,3})$/.exec(s);
    if (!m) return false;
    const n = Number(m[2]);
    return IPV4_RE.test(m[1]) ? n <= 32 : ipv6Ok(m[1]) ? n <= 128 : false;
  }
  // <host> and <port> of deploy.need-console from the console's fleetUrl (an IPv6 literal keeps its brackets).
  function consoleHostPort(url) {
    try {
      const x = new URL(String(url || ""));
      return { host: x.hostname, port: x.port || "443" };
    } catch (e) {
      return { host: "", port: "" };
    }
  }
  const deployHigh = (opts) => (opts && opts.profile ? opts.profile === "high" : profile() === "high");
  // `pki: console` is offered only with a usable CA under Standard (3.4, 8.7).
  const caUsable = (opts) => !deployHigh(opts) && !!(opts && opts.meetCa && opts.meetCa.state === "ok");
  const redrawDeploy = () => render({ keepMessages: true });
  // deploy.binary: <sha256> is not a placeholder name the page's filler reads, so the digest goes in as <digest>.
  const binaryLine = (b) => fill(FW["deploy.binary"].replace("<sha256>", "<digest>"), { version: b.version || "", arch: b.arch || "", digest: b.sha256 || "" });

  pages.fleetAdd = async (c) => [head(FW["deploy.title"]), ...(await deployPanel(c))];
  async function deployPanel(c) {
    const wizard = /^#\/setup\//.test(location.hash);
    const reopen = !wizard && c && ENROLLMENT_RE.test(c.sub || "") ? c.sub : null;
    if (reopen && (!S.enroll || S.enroll.id !== reopen)) S.enroll = { step: 4, id: reopen, product: null, env: null, f: {} };
    if (!S.enroll) S.enroll = { step: 1, id: null, product: null, env: null, f: {} };
    const st = S.enroll;
    if (st.step === 4) return [el("p", { class: "step-line" }, fillText(FW["deploy.step"], { n: 4 })), ...deployWait(st, c, wizard)];
    const opts = await api("GET", "fleet/deploy/options", null, { direct: true });
    // ?replaces=<relayId> preselects that relay's product, name and site: an explicit choice (3.1).
    const wanted = c && c.q.get("replaces");
    if (wanted && !st.replacesSeen) {
      st.replacesSeen = true;
      const x = (await fleetRelays()).find((y) => y.id === wanted && y.state !== "removed");
      if (x) {
        st.product = x.product;
        st.f.replaces = x.id;
        st.f.name = x.name;
        st.f.site = x.site || "";
      }
    }
    const line = el("p", { class: "step-line" }, fillText(FW["deploy.step"], { n: st.step }));
    if (st.step === 2) return [line, ...deployWhere(st, opts)];
    if (st.step === 3) return [line, ...(await deployDetails(st, opts, wizard))];
    return [line, ...deployProduct(st)];
  }
  // "Continue" stays disabled until the step's choice is made (3.2, 3.3).
  function setEnabled(b, on) {
    b.disabled = !on;
    if (on) b.removeAttribute("disabled");
    else b.setAttribute("disabled", "");
  }
  // A card as a radio button; a card that is not offered is disabled and names its reason.
  function choiceCard(group, value, checked, title, lines, why, pick) {
    const id = uid("card");
    const wid = why ? id + "-why" : null;
    const r = el("input", { id, type: "radio", name: group, value, checked: checked ? true : null, disabled: why ? true : null, "aria-describedby": wid });
    if (why) r.disabled = true;
    r.addEventListener("change", () => {
      if (r.checked && !why) pick(value);
    });
    return el("label", { class: "deploy-card" + (why ? " is-disabled" : "") + (checked ? " is-picked" : ""), for: id }, r,
      el("span", { class: "card-title" }, title), ...lines.map((l) => (l instanceof Node ? l : el("span", { class: "card-line" }, l))),
      why ? el("span", { class: "card-why", id: wid }, why) : null);
  }
  // Step 1 (3.2): two cards, none selected; no product is ever assumed.
  function deployProduct(st) {
    const group = uid("product");
    const noneId = uid("none");
    const none = el("p", { class: "note", id: noneId }, FW["deploy.product-none"]);
    const cont = btn(FW["deploy.continue"], () => {
      if (!st.product) {
        fail(FR["deploy-product"]);
        return;
      }
      st.step = 2;
      redrawDeploy();
    }, "primary", { "aria-describedby": noneId });
    const sync = () => {
      setEnabled(cont, !!st.product);
      none.hidden = !!st.product;
    };
    const cards = ["meet", "spokes"].map((p) => choiceCard(group, p, st.product === p, productWord(p), [FW["deploy.product-" + p + "-help"]], null, (v) => {
      if (st.product !== v) st.env = null;
      st.product = v;
      sync();
    }));
    sync();
    return [el("fieldset", { class: "deploy-cards" }, el("legend", null, FW["deploy.product-h"]), cards), none,
      el("div", { class: "wizard-actions" }, cont, cancelDeploy(st))];
  }
  // Cancel on every step (U-4): the page's state and any code leave memory; outside the setup wizard it goes back to
  // the relay list, inside it the deploy starts over (the wizard has its own Back and Skip).
  function cancelDeploy(st) {
    const wizard = /^#\/setup\//.test(location.hash);
    if (wizard && st.step === 1) return null;
    return btn(MSG.cancel, () => {
      S.enroll = null;
      if (wizard) redrawDeploy();
      else go("#/relays");
    });
  }
  // The prerequisites of a card (3.3), by word id.
  function deployNeeds(st, opts, env) {
    if (env === "installed") return [FW["deploy.env-installed-help"]];
    const p = st.product;
    const arch = (opts.binary && opts.binary.arch) || (opts.console && opts.console.arch) || "";
    const out = [];
    if (env === "proxmox") out.push(FW["deploy.need-proxmox"]);
    if (env === "docker") out.push(FW["deploy.need-docker"]);
    if (env !== "docker") out.push(fillText(FW["deploy.need-os"], { arch }));
    out.push(FW["deploy.need-size-" + p], FW["deploy.need-dns-" + p], FW["deploy.need-ports-" + p], fillText(FW["deploy.need-console"], consoleHostPort(opts.fleetUrl)));
    if (p === "meet") {
      const own = !caUsable(opts) || st.f.pki === "own";
      out.push(own ? FW["deploy.need-tls-meet-own"] : FW["deploy.need-tls-meet"]);
      if (!own && opts.meetCa.signerUrl) out.push(fillText(FW["deploy.need-signer"], { url: opts.meetCa.signerUrl }));
    } else {
      out.push(FW["deploy.need-tls-spokes"]);
      if (deployHigh(opts) || !opts.spokesRoot) out.push(FW["deploy.need-root-spokes"]);
    }
    out.push(FW["deploy.need-sudo"]);
    if (env === "docker" && p === "meet") out.push(FW["deploy.docker-turn-note"]);
    return out;
  }
  // Why a card is not offered: Docker under High, or a console that cannot hand out the Linux program (3.3).
  function envWhy(opts, env, row) {
    if (env === "installed") return null;
    if (env === "docker" && deployHigh(opts)) return FW["deploy.env-docker-high"];
    if (row && row.offered) return null;
    if (row && (row.why === "high" || row.why === "deploy-high")) return FW["deploy.env-docker-high"];
    return fillText(FW["deploy.env-os-mismatch"], { why: (row && row.why) || "" });
  }
  // Step 2 (3.3): where it runs; Azure, AWS, Google Cloud and Windows Server are shown as coming next.
  function deployWhere(st, opts) {
    const rows = opts.envs || [];
    const group = uid("env");
    const cont = btn(FW["deploy.continue"], () => {
      if (!st.env) {
        fail(FR["deploy-env"]);
        return;
      }
      st.step = 3;
      redrawDeploy();
    }, "primary");
    const cards = [];
    for (const env of DEPLOY_ENVS) {
      const row = rows.find((x) => x.id === env);
      if (row && Array.isArray(row.products) && !row.products.includes(st.product)) continue;
      const why = envWhy(opts, env, row);
      if (why && st.env === env) st.env = null;
      const needs = el("div", { class: "card-needs" }, el("span", { class: "card-line" }, FW["deploy.needs"]),
        el("ul", { class: "plain" }, deployNeeds(st, opts, env).map((w) => el("li", null, w))));
      cards.push(choiceCard(group, env, st.env === env, FW["deploy.env-" + env], [env === "installed" ? null : FW["deploy.env-" + env + "-help"], needs].filter(Boolean), why, (v) => {
        st.env = v;
        setEnabled(cont, true);
      }));
    }
    for (const env of NEXT_ENVS) cards.push(choiceCard(group, env, false, FW["deploy.env-" + env], [], FW["deploy.env-next"], () => {}));
    setEnabled(cont, !!st.env);
    return [el("fieldset", { class: "deploy-cards" }, el("legend", null, FW["deploy.where-h"]), cards),
      el("div", { class: "wizard-actions" }, btn(FW["setup.back"], () => {
        st.step = 1;
        redrawDeploy();
      }), cont, cancelDeploy(st))];
  }
  // Step 3 (3.4): the relay's details, then the code and the command. No admins field: the script asks on the host.
  async function deployDetails(st, opts, wizard) {
    if (st.minted) return deployCode(st, opts, wizard);
    const f = st.f;
    const p = st.product;
    const env = st.env;
    const installed = env === "installed";
    const high = deployHigh(opts);
    const keep = (k, input) => input.addEventListener("input", () => {
      f[k] = input.value;
    });
    const rows = (await fleetRelays()).filter((x) => x.state !== "removed").sort(byName);
    const name = textField(FW["enroll.name"], { maxlength: "64", required: true });
    name.input.value = f.name || "";
    keep("name", name.input);
    const site = textField(FW["enroll.site"], { maxlength: "64" });
    site.input.value = f.site || "";
    keep("site", site.input);
    if (!f.scopes) f.scopes = SCOPES.slice();
    const boxes = SCOPES.map((s) => {
      const id = uid("sc");
      const required = s === "read-health";
      const cb = el("input", { id, type: "checkbox", value: s, checked: required || f.scopes.includes(s) ? true : null, disabled: required ? true : null, "aria-describedby": required ? id + "-n" : null });
      cb.addEventListener("change", () => {
        f.scopes = boxes.filter((x) => x[0].checked || x[0].value === "read-health").map((x) => x[0].value);
      });
      return [cb, el("label", { class: "inline", for: id }, cb, scopeWord(s), required ? el("span", { class: "note", id: id + "-n" }, " ", FR["fleet-scope-required"]) : null)];
    });
    const rid = uid("en");
    const replaces = el("select", { id: rid }, el("option", { value: "" }, MSG.none), rows.filter((x) => x.product === p).map((x) => el("option", { value: x.id }, clean(x.name))));
    replaces.value = f.replaces || "";
    replaces.addEventListener("change", () => {
      f.replaces = replaces.value;
    });
    const kids = [name.box, site.box, el("fieldset", { class: "choice" }, el("legend", null, FW["enroll.scopes"]), boxes.map((x) => x[1])),
      el("div", { class: "field" }, el("label", { for: rid }, FMSG.replaces), replaces)];
    let host = null, turn = null, clients = null, pkiGroup = null, pkiBox = null, lic = null;
    if (!installed) {
      host = textField(FW["deploy.host"], { maxlength: "253", required: true, autocapitalize: "none" }, FW["deploy.host-help"]);
      host.input.value = f.host || "";
      keep("host", host.input);
      kids.push(host.box);
      if (p === "meet") {
        turn = textField(FW["deploy.turn-host"], { maxlength: "253", autocapitalize: "none" }, FW["deploy.turn-host-help"]);
        turn.input.value = f.turnHost || "";
        keep("turnHost", turn.input);
        kids.push(turn.box);
        // The certificate: from the console's CA only with a usable CA under Standard; otherwise bring it (3.4, 8.7).
        const ca = caUsable(opts);
        if (!ca) f.pki = "own";
        pkiGroup = uid("pki");
        const choices = (ca ? ["console", "own"] : ["own"]).map((v) => {
          const id = uid("pk");
          const r = el("input", { id, type: "radio", name: pkiGroup, value: v, checked: f.pki === v ? true : null });
          r.addEventListener("change", () => {
            if (r.checked) f.pki = v;
          });
          return el("label", { class: "inline", for: id }, r, FW["deploy.pki-" + v]);
        });
        pkiBox = el("fieldset", { class: "choice" }, el("legend", null, FW["deploy.pki"]), choices,
          ca ? null : el("p", { class: "note" }, high ? FW["meet-ca.high"] : FW["deploy.pki-ca-missing"]));
        kids.push(pkiBox);
      } else {
        clients = textField(FW["deploy.clients"], { maxlength: "1024", autocapitalize: "none" }, FW["deploy.clients-help"]);
        clients.input.value = f.clients != null ? f.clients : "0.0.0.0/0, ::/0";
        keep("clients", clients.input);
        kids.push(clients.box);
      }
      const lid = uid("lic");
      const library = (opts.library || []).filter((l) => l.product === p);
      lic = el("select", { id: lid, "aria-describedby": lid + "-n" }, el("option", { value: "" }, FW["deploy.license-none"]),
        library.map((l) => el("option", { value: l.id }, clean([l.id, l.edition, l.users != null ? l.users + " users" : "", dayAny(l.exp)].filter(Boolean).join(", ")))));
      lic.value = f.license || "";
      lic.addEventListener("change", () => {
        f.license = lic.value;
      });
      kids.push(el("div", { class: "field" }, el("label", { for: lid }, FW["deploy.license"]), lic, el("span", { class: "note", id: lid + "-n" }, FW["deploy.license-help"])));
      if (p === "meet") kids.push(el("p", { class: "note" }, FW["deploy.admins-note"]));
    }
    const make = btn(FW["deploy.make"], () => {
      const body = { product: p, name: name.input.value.trim(), site: site.input.value.trim(),
        scopes: boxes.filter((x) => x[0].checked || x[0].value === "read-health").map((x) => x[0].value), replaces: replaces.value || null, env };
      if (!p) {
        fail(FR["deploy-product"]);
        return;
      }
      // D-6: each refusal is a sentence next to its field, and the field takes focus.
      if (!NAME_RE.test(body.name)) {
        invalid(name.input, MSG.need.name);
        return;
      }
      if (!SITE_RE.test(body.site)) {
        invalid(site.input, MSG.need.site);
        return;
      }
      if (body.scopes.includes("read-logs") && !body.scopes.includes("people")) {
        invalid(boxes.find((x) => x[0].value === "read-logs")[0], FR["fleet-scope-needs-people"]);
        return;
      }
      if (!installed) {
        const h = host.input.value.trim().toLowerCase();
        if (!(dnsOk(h) || (p === "spokes" && addressOk(h)))) {
          invalid(host.input, FR["deploy-host"]);
          return;
        }
        const d = { host: h, turnHost: null, clients: null, pki: null, license: lic.value || null };
        if (p === "meet") {
          const t = turn.input.value.trim().toLowerCase();
          if (t && !dnsOk(t) && !addressOk(t)) {
            invalid(turn.input, FR["deploy-host"]);
            return;
          }
          d.turnHost = t || null;
          if (f.pki !== "console" && f.pki !== "own") {
            invalid(pkiBox.querySelector("input"), MSG.need.pki);
            return;
          }
          d.pki = f.pki;
        } else {
          const list = clients.input.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
          if (!list.length || list.length > 16 || !list.every(cidrOk)) {
            invalid(clients.input, FR["deploy-clients"]);
            return;
          }
          d.clients = list;
        }
        body.deploy = d;
      }
      const params = [[FW["enroll.scopes"], scopesText(body.scopes)], [FW["deploy.where-h"], FW["deploy.env-" + env]]];
      if (body.deploy) params.push([FW["deploy.host"], body.deploy.host]);
      confirmDialog({
        spec: fspec("enroll"), vals: { name: body.name, product: productWord(p) }, name: body.name, id: body.replaces || body.name, params,
        run: () => post("fleet/enroll", body, { action: "fleet.enroll.code", target: body.name }),
        plain: true,
        done: (r) => {
          // The fields as minted, so step 4 names the relay and "Make a new code" keeps them (3.6).
          Object.assign(f, { name: body.name, site: body.site, scopes: body.scopes, replaces: body.replaces || "" });
          st.minted = r || {};
          st.id = (r && r.id) || null;
          S.relays = null;
          redrawDeploy();
        },
      });
    }, "primary");
    return [section("deploy-details-h", FW["deploy.details-h"], ...kids),
      el("div", { class: "wizard-actions" }, btn(FW["setup.back"], () => {
        st.step = 2;
        redrawDeploy();
      }), make, cancelDeploy(st))];
  }
  // The answer of the mint (3.4): the code block (once, Copy, expiry), the Install block (3.5), the anchor note, and
  // Continue. The code and the command are never on one line, and the command never contains the code (A1-M1).
  function deployCode(st, opts, wizard) {
    const r = st.minted;
    const high = deployHigh(opts);
    const ins = r.install || null;
    const block = (words, cmd) => (cmd ? [el("p", null, words), el("code", { class: "cmd" }, clean(cmd)), el("div", null, copyButton(cmd, FMSG.commandsCopy))] : []);
    const install = [];
    if (st.env === "installed" || !ins) {
      const cmd = r.commands && typeof r.commands[st.product] === "string" ? r.commands[st.product] : "";
      const local = r.commands && typeof r.commands.local === "string" ? r.commands.local : "";
      install.push(...block(FW["enroll.commands"], cmd), el("p", { class: "note" }, FW["enroll.no-code-in-command"]),
        el("p", null, FW["enroll.local"]), local ? el("code", { class: "cmd" }, clean(local)) : null);
    } else {
      const steps = Array.isArray(ins.steps) ? ins.steps.map(String).join("\n") : "";
      if (high) install.push(...block(FW["deploy.install-high"], steps || ins.command || ""));
      else if (st.env === "proxmox") install.push(...block(FW["deploy.install-proxmox"], steps), ...block(FW["deploy.install-proxmox-then"], ins.command || ""));
      else install.push(...block(st.env === "docker" ? FW["deploy.install-docker"] : FW["deploy.install-linux"], ins.command || ""));
      install.push(el("p", { class: "note" }, FW["enroll.no-code-in-command"]));
      if (!high && ins.command) install.push(el("p", { class: "note" }, FW["deploy.pin-note"]));
      if (ins.binary) install.push(el("p", { class: "note" }, binaryLine(ins.binary)));
      if (ins.uninstall) install.push(el("p", null, FW["deploy.uninstall"]), el("code", { class: "cmd" }, clean(ins.uninstall)));
      if (ins.offlineUninstall) install.push(el("p", null, FW["deploy.uninstall-offline"]), el("code", { class: "cmd" }, clean(ins.offlineUninstall)));
    }
    // C-prime (7, decision 12, approved for Standard): the keys the script offers, by hint; never under High.
    const offered = !high && Array.isArray(r.offered) ? r.offered : [];
    return [section("enroll-code-h", FW["enroll.code-title"],
      el("p", null, FW["enroll.code-once"]),
      el("code", { class: "code-once" }, clean(r.code)), el("div", null, copyButton(String(r.code || ""), FMSG.codeCopy)),
      r.expires ? el("p", { class: "note" }, fill(FMSG.expires, { time: when(r.expires) })) : null),
    section("deploy-install-h", FW["deploy.install-h"], ...install),
    panel(null, el("p", null, FW["deploy.anchor-note"]), offered.map((k) => el("p", null, fill(FW["deploy.offered-key"], { hint: (k && k.hint) || "" }))),
      el("p", null, el("a", { href: "#/settings/account" }, FW["account.fingerprints"]))),
    el("div", { class: "wizard-actions" }, btn(FW["deploy.continue"], () => {
      // The code leaves the page and memory here (3.1).
      st.minted = null;
      st.step = 4;
      if (wizard || !st.id) redrawDeploy();
      else go("#/relays/add/" + encodeURIComponent(st.id));
    }, "primary"), cancelDeploy(st))];
  }
  // Step 4 (3.6): polls the enrollment every 3 s while visible and shows where the join is.
  function deployWait(st, c, wizard) {
    const box = el("div", { class: "deploy-wait", "aria-live": "polite" });
    const actions = el("div", { class: "wizard-actions" });
    let shown = "";
    let active = false;
    const leave = async () => {
      S.enroll = null;
      if (wizard) {
        if (active) {
          try {
            await api("POST", "setup/step", { step: "relay", state: "done" }, { direct: true });
          } catch (e) {
            fail(e);
          }
        }
        S.setup = null;
        S.overview = null;
        redrawDeploy();
      } else go("#/relays");
    };
    const again = () => {
      st.step = 3;
      st.id = null;
      st.minted = null;
      if (wizard || !/^#\/relays\/add\//.test(location.hash)) redrawDeploy();
      else go("#/relays/add");
    };
    const draw = (e) => {
      const rel = (e && e.relay) || null;
      const key = JSON.stringify([e && e.state, rel && rel.state, rel && rel.fingerprint, rel && rel.bootstrap, rel && rel.license]);
      if (key === shown) return;
      shown = key;
      // The console's name for the relay: its registry row, else the enrollment's name, else the name as minted; the id last.
      const name = (rel && (S.relays || []).some((x) => x.id === rel.id) ? relayName(rel.id) : (e && e.name) || st.f.name) || (rel && rel.id) || "";
      const kids = [];
      const ended = !e || e.state === "expired" || e.state === "cancelled" || (e.state !== "open" && !rel);
      active = !!(rel && rel.state === "active");
      if (ended) kids.push(el("p", null, FW["deploy.expired"]), el("div", null, btn(FW["deploy.new-code"], again, "primary")));
      else if (e.state === "open") kids.push(el("p", null, FW["deploy.wait-code"]), e.expires ? el("p", { class: "note" }, fill(FMSG.expires, { time: when(e.expires) })) : null);
      else if (rel.state === "pending") kids.push(el("p", null, FW["deploy.wait-start"]));
      else if (rel.state === "unconfirmed") {
        const fp = String(rel.fingerprint || "");
        kids.push(el("p", null, fill(FW["deploy.wait-connected"], { name })), el("p", null, FW["deploy.compare"]),
          el("p", null, el("span", { class: "card-line" }, FW["enroll.fingerprint"])), el("code", { class: "fingerprint fingerprint-big" }, clean(fp)),
          el("p", { class: "note" }, FW["enroll.confirm-help"]),
          el("div", null, btn(FMSG.deploy.confirmRelay, () => confirmDialog({
            spec: fspec("confirm-relay"), vals: { name, fingerprint: fp }, name, id: rel.id,
            run: () => post("fleet/relays/confirm", { relay: rel.id, fingerprint: fp }, { action: "fleet.relay.confirm", target: rel.id }),
            done: () => {
              S.relays = null;
              S.overview = null;
              shown = "";
              tick();
            },
          }), "primary")));
      } else if (rel.state === "active") {
        const bRaw = rel.bootstrap || {};
        const bs = typeof bRaw === "string" ? { state: bRaw } : bRaw;
        const anchored = typeof bs.anchored === "number" ? bs.anchored : (bs.entries || []).filter((x) => x && (x.state === "anchored" || (x.via && x.via !== "none"))).length;
        const svc = (rel.license && rel.license.service) || null;
        const stopped = !!(svc && svc.state === "stopped");
        kids.push(el("p", null, fill(FW["deploy.confirmed"], { name })), el("p", null, fillText(FW["deploy.anchors"], { n: anchored })),
          anchored ? null : el("p", { class: "note" }, FW["deploy.anchor-none"]),
          stopped ? el("p", null, toneChip(FW["relay.license-stopped"], "bad"), " ", el("a", { href: "#/license?relay=" + encodeURIComponent(rel.id) }, FMSG.deploy.installLicense))
            : el("p", null, toneChip(FW["deploy.service-on"], "ok")));
      } else kids.push(el("p", null, relayStateWord(rel.state)));
      box.replaceChildren(...kids.filter(Boolean));
    };
    const tick = async () => {
      try {
        const d = await api("GET", "fleet/enrollments/" + encodeURIComponent(st.id), null, { direct: true, activity: false });
        if (c && c.gen !== S.gen) return;
        draw(d.enrollment || null);
      } catch (e) {
        if (e && e.status === 404) draw(null);
        else if (e && e.status !== 401) fail(e);
      }
    };
    actions.append(btn(FW["deploy.done"], leave));
    if (!st.id) draw(null);
    else {
      tick();
      clearInterval(S.timer);
      S.timer = setInterval(() => {
        if (document.hidden || (c && c.gen !== S.gen)) return;
        tick();
      }, 3000);
    }
    return [section("deploy-wait-h", FW["deploy.wait-h"], box), actions];
  }

  // ---- Health charts (9.5, 9.6) ----
  const RANGE_MS = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  const rangeOf = (c) => (RANGE_MS[c.q.get("range")] ? c.q.get("range") : "24h");
  function rangeButtons(base, cur) {
    const sep = base.includes("?") ? "&" : "?";
    return el("div", { class: "chips", role: "group", "aria-label": FMSG.range },
      RANGES.map(([v, k]) => el("a", { class: "btn", href: base + sep + "range=" + v, "aria-current": v === cur ? "true" : null }, FW[k])));
  }
  // The 9.5 query: at most 8 names per call, so longer lists are asked in parts.
  async function metricsQuery(relays, names, range, aggregate) {
    const series = [];
    let step = 0;
    for (let i = 0; i < names.length; i += 8) {
      const d = await api("GET", "fleet/metrics?relays=" + encodeURIComponent(relays).replace(/%2C/g, ",") + "&names=" + names.slice(i, i + 8).join(",") +
        "&range=" + range + "&aggregate=" + (aggregate ? 1 : 0), null, { direct: true, activity: false });
      series.push(...(d.series || []));
      step = Number(d.step) || step;
    }
    return { series, step };
  }
  const pointsOf = (m, name, relay) => {
    const s = m ? m.series.find((x) => x.name === name && (relay == null || x.relay === relay)) : null;
    return s && Array.isArray(s.points) ? s.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0])) : [];
  };
  const fmtN = (v) => (Number.isFinite(v) ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 })) : "");
  const fmtPct = (v) => fmtN(v) + " %";
  const fmtMs = (v) => fmtN(v) + " ms";
  function fmtBytes(v) {
    if (!Number.isFinite(v)) return "";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0, x = Math.abs(v);
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    return (v < 0 ? "-" : "") + x.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " " + units[i];
  }
  const timeLabel = (range) => (t) => new Date(t).toLocaleString(undefined, range === "1h" || range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit" });
  function chartBox(titleKey, ...nodes) {
    return el("section", null, el("h4", null, FW[titleKey]), ...nodes);
  }
  // A box with two charts names each one above it (L-8), so the second is not a chart without a title.
  const subChart = (title, chart) => el("div", null, el("p", { class: "chart-heat-label" }, title), chart);
  const LC = () => window.LucidCharts;
  const lineOf = (title, series, opts) => LC().lineChart(series, Object.assign({ title }, opts || {}));
  function barsOf(title, points, range, opts) {
    return LC().barChart(points.map(([t, v]) => ({ label: t, values: [v] })), Object.assign({ title, keys: [{ name: title }], labelFormat: timeLabel(range), labelHeader: FMSG.time }, opts || {}));
  }
  // The relays with the highest recent value of a metric (the CPU, memory and latency charts show the top 5).
  function topRelays(m, name, rows, n) {
    const last = (id) => {
      const vs = pointsOf(m, name, id).map((p) => p[1]).filter(Number.isFinite);
      return vs.length ? vs.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, vs.length) : -1;
    };
    return rows.map((x) => [x, last(x.id)]).filter((p) => p[1] >= 0).sort((a, b) => b[1] - a[1]).slice(0, n).map((p) => p[0]);
  }
  // The metrics a health cell is judged from (8.2 rules that a snapshot can show); an hour with no snapshot is silent.
  const HEALTH_NAMES = ["cpu_host", "mem_host_used", "latency_console", "cert_tls_days", "cert_mgmt_days", "license_days", "license_state"];
  function levelOf(name, v) {
    if (name === "cpu_host") return v > 90 ? 2 : v > 75 ? 1 : 0;
    if (name === "mem_host_used") return v > 95 ? 2 : v > 85 ? 1 : 0;
    if (name === "latency_console") return v > 500 ? 1 : 0;
    if (name === "cert_tls_days" || name === "cert_mgmt_days") return v <= 0 ? 2 : v <= 21 ? 1 : 0;
    if (name === "license_days") return v <= 30 ? 1 : 0;
    if (name === "license_state") return v === 3 || v === 4 ? 2 : v === 2 ? 1 : 0;
    return 0;
  }
  function healthCells(m, relay, range) {
    const now = Date.now();
    const H = 3600000;
    const cells = [];
    for (let h = Math.floor((now - RANGE_MS[range]) / H) * H; h <= now; h += H) {
      let seen = false, worst = 0;
      for (const name of HEALTH_NAMES) {
        for (const [t, v] of pointsOf(m, name, relay)) {
          if (t < h || t >= h + H || !Number.isFinite(v)) continue;
          seen = true;
          worst = Math.max(worst, levelOf(name, v));
        }
      }
      const k = !seen ? "silent" : ["ok", "warn", "bad"][worst];
      cells.push({ t: h, tone: k === "silent" ? "muted" : k === "bad" ? "danger" : k, word: healthWord(k) });
    }
    return cells;
  }
  function expiryChart(rows, title) {
    const items = rows.filter((x) => Number.isFinite(x.daysLeft)).sort((a, b) => a.daysLeft - b.daysLeft).map((x) => {
      const k = x.daysLeft <= 7 ? "bad" : x.daysLeft <= 30 ? "warn" : "ok";
      return { label: relayName(x.relay) + ": " + (FMSG.kinds[x.kind] || stateWord(x.kind)), values: [x.daysLeft], tone: k === "bad" ? "danger" : k, word: healthWord(k) };
    });
    return LC().barChart(items, { title, horizontal: true, keys: [{ name: FMSG.cols.days }], labelHeader: FMSG.cols.relay });
  }
  const perMinute = (pts, step) => pts.map(([t, v]) => [t, Number.isFinite(v) ? v / Math.max(1, (step || 60000) / 60000) : null]);
  pages.fleetHealth = async (c) => {
    const range = rangeOf(c);
    const all = (await fleetRelays(true)).filter(readable).sort(byName);
    const sp = all.filter((x) => x.product === "spokes").slice(0, 20).map((x) => x.id);
    const mt = all.filter((x) => x.product === "meet").slice(0, 20).map((x) => x.id);
    const rows = all.slice(0, 20);
    const ids = rows.map((x) => x.id);
    const [aSp, aMt, aAll, per, exp] = await Promise.all([
      sp.length ? metricsQuery(sp.join(","), ["people_online", "spokes_busy", "spokes_online", "lanes_busy", "lanes_total"], range, true) : null,
      mt.length ? metricsQuery(mt.join(","), ["people_online", "calls_active", "call_minutes"], range, true) : null,
      ids.length ? metricsQuery("all", ["messages", "net_in", "net_out"], range, true) : null,
      ids.length ? metricsQuery(ids.join(","), HEALTH_NAMES, range, false) : null,
      api("GET", "fleet/expiry", null, { direct: true, activity: false }).catch(() => ({ rows: [] })),
    ]);
    const F = "fleet";
    const kids = [];
    kids.push(chartBox("charts.people", lineOf(FW["charts.people"], [sp.length ? { name: productWord("spokes"), points: pointsOf(aSp, "people_online", F) } : null,
      mt.length ? { name: productWord("meet"), points: pointsOf(aMt, "people_online", F) } : null].filter(Boolean))));
    if (mt.length) {
      kids.push(chartBox("charts.calls", subChart(FMSG.metric.call_minutes, barsOf(FMSG.metric.call_minutes, pointsOf(aMt, "call_minutes", F), range)),
        subChart(FMSG.metric.calls_active, lineOf(FMSG.metric.calls_active, [{ name: FMSG.metric.calls_active, points: pointsOf(aMt, "calls_active", F) }]))));
    }
    kids.push(chartBox("charts.messages", barsOf(FW["charts.messages"], pointsOf(aAll, "messages", F), range)));
    if (sp.length) {
      kids.push(chartBox("charts.spokes", lineOf(FW["charts.spokes"], ["spokes_busy", "spokes_online", "lanes_busy", "lanes_total"].map((k) => ({ name: FMSG.metric[k], points: pointsOf(aSp, k, F) })))));
    }
    const top = (name) => topRelays(per, name, rows, 5).map((x) => ({ name: x.name, points: pointsOf(per, name, x.id) }));
    kids.push(chartBox("charts.cpu", lineOf(FW["charts.cpu"], top("cpu_host"), { yMax: 100, yFormat: fmtPct })));
    kids.push(chartBox("charts.memory", lineOf(FW["charts.memory"], top("mem_host_used"), { yMax: 100, yFormat: fmtPct })));
    kids.push(chartBox("charts.network", lineOf(FW["charts.network"], [{ name: FMSG.metric.net_in, points: perMinute(pointsOf(aAll, "net_in", F), aAll && aAll.step) },
      { name: FMSG.metric.net_out, points: perMinute(pointsOf(aAll, "net_out", F), aAll && aAll.step) }], { area: true, yFormat: fmtBytes })));
    kids.push(chartBox("charts.latency", lineOf(FW["charts.latency"], top("latency_console"), { yFormat: fmtMs })));
    kids.push(chartBox("charts.expiry", expiryChart(exp.rows || [], FW["charts.expiry"])));
    kids.push(chartBox("charts.health", ...rows.map((x) => LC().heatStrip(healthCells(per, x.id, range), { title: FW["charts.health"] + ": " + clean(x.name), label: clean(x.name) }))));
    return [head(pageLabel("relays", "health")), rangeButtons("#/relays/health", range), el("div", { class: "charts-grid" }, kids)];
  };
  // One relay's Health tab: the same charts for that relay alone, memory also in MiB.
  async function relayCharts(d, range) {
    const id = d.id;
    const names = ["people_online", "messages", "cpu_host", "cpu_process", "mem_host_used", "mem_process", "net_in", "net_out", "latency_console"]
      .concat(d.product === "meet" ? ["calls_active", "call_minutes"] : ["spokes_busy", "spokes_online", "lanes_busy", "lanes_total"]);
    const [m, h, exp] = await Promise.all([metricsQuery(id, names, range, false), metricsQuery(id, HEALTH_NAMES, range, false),
      api("GET", "fleet/expiry", null, { direct: true, activity: false }).catch(() => ({ rows: [] }))]);
    const p = (k) => pointsOf(m, k, id);
    const kids = [chartBox("charts.people", lineOf(FW["charts.people"], [{ name: FW["charts.people"], points: p("people_online") }]))];
    if (d.product === "meet") {
      kids.push(chartBox("charts.calls", subChart(FMSG.metric.call_minutes, barsOf(FMSG.metric.call_minutes, p("call_minutes"), range)),
        subChart(FMSG.metric.calls_active, lineOf(FMSG.metric.calls_active, [{ name: FMSG.metric.calls_active, points: p("calls_active") }]))));
    }
    kids.push(chartBox("charts.messages", barsOf(FW["charts.messages"], p("messages"), range)));
    if (d.product !== "meet") kids.push(chartBox("charts.spokes", lineOf(FW["charts.spokes"], ["spokes_busy", "spokes_online", "lanes_busy", "lanes_total"].map((k) => ({ name: FMSG.metric[k], points: p(k) })))));
    kids.push(chartBox("charts.cpu", lineOf(FW["charts.cpu"], [{ name: FMSG.metric.cpu_host, points: p("cpu_host") }, { name: FMSG.metric.cpu_process, points: p("cpu_process") }], { yMax: 100, yFormat: fmtPct })));
    kids.push(chartBox("charts.memory", subChart(FMSG.metric.mem_host_used, lineOf(FW["charts.memory"], [{ name: FMSG.metric.mem_host_used, points: p("mem_host_used") }], { yMax: 100, yFormat: fmtPct })),
      subChart(FMSG.metric.mem_process, lineOf(FMSG.metric.mem_process, [{ name: FMSG.metric.mem_process, points: p("mem_process").map(([t, v]) => [t, Number.isFinite(v) ? v / 1048576 : null]) }], { yFormat: (v) => fmtN(v) + " MiB" }))));
    kids.push(chartBox("charts.network", lineOf(FW["charts.network"], [{ name: FMSG.metric.net_in, points: perMinute(p("net_in"), m.step) },
      { name: FMSG.metric.net_out, points: perMinute(p("net_out"), m.step) }], { area: true, yFormat: fmtBytes })));
    kids.push(chartBox("charts.latency", lineOf(FW["charts.latency"], [{ name: FW["charts.latency"], points: p("latency_console") }], { yFormat: fmtMs })));
    kids.push(chartBox("charts.expiry", expiryChart((exp.rows || []).filter((x) => x.relay === id), FW["charts.expiry"])));
    kids.push(chartBox("charts.health", LC().heatStrip(healthCells(h, id, range), { title: FW["charts.health"] })));
    return el("div", { class: "charts-grid" }, kids);
  }

  // ---- Overview (8.1): KPI tiles with 24-hour sparklines (9.6), cards, the Finish setup checklist, attention ----
  const FCARD = {
    "spokes-busy": { title: FMSG.cards.spokes, go: "#/spokes/relays" },
    licenses: { title: FMSG.cards.licenses, go: "#/license" },
    certificates: { title: FMSG.cards.certificates, go: "#/relays/health" },
    approvals: { title: FMSG.cards.approvals, go: "#/security/approvals" },
    requests: { title: FMSG.cards.requests, go: "#/security/requests" },
  };
  function kpiTiles(x) {
    const f = x.fleet || {};
    const k = f.kpis || {};
    const r = f.relays || {};
    const rh = k.relaysHealthy || {};
    const n = rh.n != null ? rh.n : r.ok;
    const total = rh.total != null ? rh.total : r.total;
    const relays = LC().kpi(FW["kpi.relays"], n != null && total != null ? n + " of " + total : null, { tone: n === total ? "ok" : "warn", spark: rh.spark });
    relays.append(el("a", { href: "#/relays" }, FW["nav.relays"]));
    const num = (o, alt) => (o && o.n != null ? o.n : alt);
    return [relays,
      LC().kpi(FW["kpi.people"], num(k.peopleOnline, f.people ? f.people.online : null), { spark: k.peopleOnline && k.peopleOnline.spark }),
      LC().kpi(FW["kpi.calls"], num(k.callsNow, f.calls ? f.calls.active : null), { spark: k.callsNow && k.callsNow.spark }),
      LC().kpi(FW["kpi.messages"], num(k.messagesToday, null), { spark: k.messagesToday && k.messagesToday.spark })];
  }
  function fleetCards(x) {
    return (x.cards || []).filter((c) => FCARD[c.id] && (isAdmin() || (c.id !== "approvals" && c.id !== "requests"))).map((c) => {
      const def = FCARD[c.id];
      const line = c.id === "certificates" ? (c.n != null ? c.n + " " + FMSG.daysWord : MSG.unknown) : c.id === "licenses" ? stateWord(c.worst || c.state || "") : (c.n != null ? String(c.n) : "") + (c.m != null ? " of " + c.m : "");
      const tone = c.state === "bad" ? "bad" : c.state === "warn" ? "warn" : c.state === "ok" ? "ok" : "none";
      const kids = [el("span", { class: "card-title" }, def.title), c.state ? stChip(MSG.cardState[c.state] || c.state, tone) : null, el("span", { class: "card-line" }, clean(line))];
      return canOpen(def.go) ? el("a", { class: "card", href: def.go }, kids) : el("div", { class: "card" }, kids);
    });
  }
  pages.fleetOverview = async (c) => {
    const [o] = await Promise.all([api("GET", "overview", null, { activity: c.user, direct: true }), fleetRelays().catch(() => [])]);
    S.overview = o;
    S.ovAt = Date.now();
    setHeader();
    setApprovalsBadge(o.approvals ? o.approvals.mine : 0);
    const tiles = el("div", { class: "kpis" });
    const cards = el("div", { class: "cards" });
    const att = el("div");
    const fillIn = (x) => {
      tiles.replaceChildren(...kpiTiles(x));
      cards.replaceChildren(...fleetCards(x));
      att.replaceChildren(attentionList(x.attention));
    };
    fillIn(o);
    // Every 30 s while visible, without X-Lucid-Activity (AC-1 7.3).
    S.timer = setInterval(async () => {
      if (document.hidden || c.gen !== S.gen) return;
      if (tiles.contains(document.activeElement) || cards.contains(document.activeElement) || att.contains(document.activeElement)) return;
      try {
        const x = await api("GET", "overview", null, { activity: false, direct: true });
        if (c.gen !== S.gen) return;
        S.overview = x;
        S.ovAt = Date.now();
        setApprovalsBadge(x.approvals ? x.approvals.mine : 0);
        fillIn(x);
      } catch (e) {
        /* the next tick tries again */
      }
    }, 30000);
    return [head(FW["nav.overview"]), isAdmin() ? await setupChecklist() : null, tiles, cards,
      el("section", { class: "panel", "aria-labelledby": "att-h" }, el("h3", { id: "att-h" }, W["attention.title"]), att), otherConsoles(o.links)];
  };

  // ---- People across the fleet (11) ----
  const PEOPLE_FILTERS = ["product", "relay", "role", "state", "source", "q"];
  const personName = (p) => p.name || p.id;
  pages.fleetPeople = async (c) => {
    const relays = (await fleetRelays()).sort(byName);
    const qs = PEOPLE_FILTERS.filter((k) => c.q.get(k) && (k !== "q" || c.q.get(k).length >= 2)).map((k) => "&" + k + "=" + encodeURIComponent(c.q.get(k))).join("");
    const d = await api("GET", "fleet/people?limit=200" + qs, null, { direct: true });
    const rows = d.rows || d.people || [];
    const admin = isAdmin();
    const consoleAdmins = rows.filter((p) => p.kind === "console" && p.role === "admin" && p.state === "active").length;
    const mrel = relays.filter((x) => x.product === "meet" && readable(x));
    // AC-2a 11.4 (revision 3.4): a Meeting Hub relay stopped for its license takes no invites.
    const stopped = (id) => {
      const s = serviceOf(relays.find((y) => y.id === id));
      return !!(s && s.state === "stopped");
    };
    // Filters (11.1 exact query names), applied on the console with Show.
    const f = {};
    const sel = (key, label, options) => {
      const id = uid("pf");
      f[key] = el("select", { id }, el("option", { value: "" }, MSG.all), options.map(([v, w]) => el("option", { value: v }, clean(w))));
      f[key].value = c.q.get(key) || "";
      return el("label", { for: id }, label, f[key]);
    };
    const qid = uid("pf");
    f.q = el("input", { id: qid, type: "search", maxlength: "100", autocomplete: "off" });
    f.q.value = c.q.get("q") || "";
    const apply = () => {
      const p = new URLSearchParams();
      for (const k of PEOPLE_FILTERS) if (f[k].value.trim()) p.set(k, f[k].value.trim());
      const s = p.toString();
      go("#/people" + (s ? "?" + s : ""));
    };
    onEnter(f.q, apply);
    const show = btn(MSG.show, apply, "primary");
    // The one filter row of this page (the console filters every relay's people; the table adds no second box).
    const filters = filterFold([
      sel("product", FMSG.cols.kind, [["console", FW["people.kind-console"]], ["meet", FW["people.kind-meet"]], ["spokes", FW["people.kind-spokes"]]]),
      sel("relay", FMSG.cols.relay, relays.map((x) => [x.id, x.name])),
      sel("role", FMSG.cols.role, [["admin", ROLE_WORD.admin], ["user-manager", ROLE_WORD["user-manager"]], ["viewer", ROLE_WORD.viewer], ["relay-admin", FMSG.roles["relay-admin"]], ["member", FMSG.roles.member], ["hub-user", FMSG.roles["hub-user"]]]),
      sel("state", FMSG.cols.state, ["active", "suspended", "invited", "waiting", "silent", "blocked", "revoked", "unseated"].map((s) => [s, stateWord(s)])),
      sel("source", FMSG.cols.source, ["invite", "operator", "app", "request", "hub", "sso", "scim"].map((s) => [s, stateWord(s)])),
      el("label", { for: qid }, MSG.filterText, f.q), show]);
    const kindWord = (p) => FW["people.kind-" + p.kind] || stateWord(p.kind);
    const roleWord = (p) => ROLE_WORD[p.role] || FMSG.roles[p.role] || stateWord(p.role);
    const actions = (p) => {
      const relay = p.relay ? relays.find((x) => x.id === p.relay) || { id: p.relay, name: relayName(p.relay) } : null;
      // A console account has the same actions here as on the relay console's Admins page (D-2).
      if (p.kind === "console") return accountActions({ email: p.id, role: p.role, state: p.state }, consoleAdmins);
      const out = [];
      if (p.kind === "meet" && p.request && isManager()) {
        out.push({ label: FW["people.remind"], run: async () => {
          try {
            await api("POST", "fleet/people/remind", { relay: p.relay, request: p.request }, { direct: true });
            say(MSG.done);
          } catch (e) {
            fail(e);
          }
        } });
        out.push({ label: FMSG.cancelRequest, run: () => confirmDialog({
          dlg: "cancel-request", vals: { summary: personName(p), email: myEmail() }, name: personName(p), id: p.request, danger: true, plain: true, reaches: [relay.name],
          run: () => api("POST", "requests/cancel", { id: p.request }, { relay: p.relay }),
        }) });
      }
      if (p.kind === "meet" && isManager() && p.seated != null) out.push({ label: FMSG.pick, run: () => go("#/meet/seats?relay=" + encodeURIComponent(p.relay)) });
      if (admin && (p.kind === "meet" || p.kind === "spokes")) {
        if (p.state !== "blocked") out.push({ label: FW["people.suspend"], run: () => personOp("suspend", p, relay) });
        if (p.state === "blocked") out.push({ label: FW["people.unsuspend"], run: () => personOp("unsuspend", p, relay) });
        if (p.kind === "meet") out.push({ label: FW["people.remove"], run: () => personOp("remove", p, relay) });
      }
      return out;
    };
    const missing = (d.missing || []).map((m) => (m && m.name) || relayName(m.relay || m));
    const asOf = [...new Map(rows.filter((p) => p.relay && p.asOf).map((p) => [p.relay, p.asOf])).entries()];
    const kids = [head(FW["people.title"], isManager() ? btn(FW["people.invite"], () => inviteFleet(relays, stopped), "primary") : null),
      missingLine(missing),
      asOf.length ? el("ul", { class: "plain asof" }, asOf.map(([id, t]) => el("li", null, u(relayName(id)), ": ", fill(FW["fleet.as-of"], { time: when(t) })))) : null,
      panel(null, filters, dataTable({
        caption: FW["people.title"], rows, total: d.total, empty: MSG.noneYet, name: personName,
        cols: [{ key: "kind", label: FMSG.cols.kind, cell: kindWord }, { key: "name", label: FMSG.cols.name, cell: (p) => u(personName(p)), sort: personName },
          { key: "id", label: W["dialog.id"], cell: (p) => code(p.id) }, { key: "relay", label: FMSG.cols.relay, cell: (p) => (p.relay ? u(relayName(p.relay)) : "") },
          { key: "role", label: FMSG.cols.role, cell: roleWord }, { key: "state", label: FMSG.cols.state, cell: (p) => el("span", null, stateWord(p.state), p.request ? el("span", { class: "note" }, " ", FW["people.request-waiting"]) : null) },
          { key: "source", label: FMSG.cols.source, cell: (p) => stateWord(p.source) },
          { key: "devices", label: FMSG.devices, cell: (p) => (p.devices != null ? p.devices : p.hubs != null ? p.hubs : "") },
          { key: "seated", label: FMSG.seated, cell: (p) => (p.seated == null ? "" : yesNo(p.seated)) }],
        actions,
        more: d.after || (rows.length && rows.length < (d.total || 0)) ? async () => {
          const x = await api("GET", "fleet/people?limit=200&after=" + encodeURIComponent(d.after || rows[rows.length - 1].id) + qs, null, { direct: true });
          d.after = x.after || null;
          return x.rows || x.people || [];
        } : null,
      }))];
    // API-1 revision 4 13.2: one Directory card per organization the console holds an API map for.
    kids.push(...(await directoryCards()));
    if (isManager()) kids.push(await seatStrips(mrel, stopped), csvPanel());
    if (admin) kids.push(...(await pages.admins_people()).slice(2));
    return kids;
  };
  // The 11.2 people ops on one relay: one fleet step-up covers the op, its params the body without stepup.
  function personOp(op, p, relay) {
    const k = op === "remove" ? "remove-person" : op;
    const n = p.devices != null ? p.devices : p.hubs != null ? p.hubs : 0;
    const vals = { name: personName(p), relay: relay.name, n, hours: 24 };
    const fields = op === "suspend" ? [{ kind: "text", type: "number", key: "hours", label: MSG.hours, value: 24, min: "1", max: "720", inputmode: "numeric" }, { kind: "reason" }] : [{ kind: "reason" }];
    confirmDialog({
      spec: fspec(k), vals, name: personName(p), id: p.id, danger: op !== "unsuspend", reaches: [relay.name], fields,
      vals2: (v) => ({ hours: v.hours || "" }),
      check: (v) => (op === "suspend" && !(Number.isInteger(v.hours) && v.hours >= 1 && v.hours <= 720) ? MSG.need.hours : ""),
      run: (v) => {
        const body = Object.assign({ kind: p.kind, relay: relay.id, id: p.id, reason: v.reason }, op === "suspend" ? { hours: v.hours } : {});
        return fleetPost("fleet/people/" + op, body, { action: "people." + op, target: p.id }, [relay.id]);
      },
    });
  }
  // Invite (11.2): a console account (AC-1 invite, AC-1 step-up) or a Meeting Hub invite request on one relay (fleet
  // step-up). A Meeting Hub relay stopped for its license (revision 3.4) takes no invite, and the dialog says why.
  function inviteFleet(relays, stopped) {
    const meet = relays.filter((x) => x.product === "meet" && x.state === "active");
    const roles = [["viewer", ROLE_WORD.viewer], ["user-manager", ROLE_WORD["user-manager"]]].concat(isAdmin() ? [["admin", ROLE_WORD.admin]] : []);
    confirmDialog({
      dlg: "invite-viewer", vals: { email: "" },
      specFor: (v) => (v.product === "meet" ? fspec("invite-meet") : D[v.role === "admin" ? "invite-admin-spokes" : v.role === "user-manager" ? "invite-user-manager" : "invite-viewer"]),
      fields: [{ kind: "select", key: "product", label: FMSG.cols.kind, options: [["console", FW["people.kind-console"]]].concat(meet.length ? [["meet", FW["people.kind-meet"]]] : []), value: "console" },
        { kind: "text", type: "email", key: "email", label: FMSG.cols.email, maxlength: "254", required: true },
        // D-12: a console account takes a role; a Meeting Hub invite takes a relay, a name and days. Each shows only
        // for its Kind.
        { kind: "select", key: "role", label: FMSG.cols.role, options: roles, value: "viewer", when: (v) => v.product !== "meet" },
        meet.length ? { kind: "select", key: "relay", label: FMSG.cols.relay, options: meet.map((x) => [x.id, x.name]), value: meet[0].id, when: (v) => v.product === "meet" } : null,
        { kind: "text", key: "name", label: FMSG.cols.name, maxlength: "80", when: (v) => v.product === "meet" },
        { kind: "text", type: "number", key: "days", label: FMSG.daysInvite, value: 7, min: "1", max: "30", inputmode: "numeric", when: (v) => v.product === "meet" }].filter(Boolean),
      vals2: (v) => ({ email: v.email, relay: v.product === "meet" ? relayName(v.relay) : "" }),
      two: (v) => v.product !== "meet" && v.role === "admin",
      check: (v) => (!/^[^@\s]+@[^@\s]+$/.test(v.email) ? MSG.emailNeeded
        // D-13: the relay's own "Ask your admin" words are for people who are not admins.
        : v.product === "meet" && stopped(v.relay) ? (isAdmin() ? fillText(MSG.stoppedAdmin, { relay: relayName(v.relay) }) : W["meet.license-inactive"])
          : v.product === "meet" && !v.name ? MSG.need.personName
            : v.product === "meet" && !(Number.isInteger(v.days) && v.days >= 1 && v.days <= 30) ? MSG.need.days : ""),
      run: (v) => (v.product === "meet"
        ? fleetPost("fleet/people/invite", { product: "meet", relay: v.relay, email: v.email, name: v.name, role: "member", days: v.days }, { action: "people.invite", target: v.email }, [v.relay])
        // Console accounts are AC-1's `admins/invite` with the console's own step-up (fleet/people/invite takes only
        // Meeting Hub people, with a fleet step-up).
        : post("admins/invite", { email: v.email, role: v.role }, { action: "admins.invite", target: v.email })),
      done: (r) => showLink(r, r && r.mailed ? r.email || null : null),
    });
  }
  // A Seats strip per Meeting Hub relay (11.4): seated of the license's users (no total without a license), the clock
  // while over, and, while the relay is stopped for its license, seats.stopped with the invite disabled. The numbers
  // are each relay's own `meet/seats` (`people` scope): the read-health counts carry no licensed user count.
  async function seatStrips(mrel, stopped) {
    if (!mrel.length) return null;
    const views = await Promise.all(mrel.map((x) => api("GET", "meet/seats", null, { relay: x.id, activity: false }).catch(() => null)));
    return panel(W["nav.meet.pages"][1], el("ul", { class: "checklist" }, mrel.map((x, i) => {
      const s = views[i] || {};
      const users = s.users;
      const line = stopped(x.id) ? W["seats.stopped"] : s.seated != null && users != null ? fillText(W["seats.summary"], { seated: s.seated, users }) : MSG.unknown;
      const clock = s.clock ? fillText(W["attention.seats-over"], { used: s.seated, users, day: s.clock.day, n: s.overage || Math.max(0, (s.seated || 0) - (users || 0)), date: dayAny(s.clock.unseatAt) }) : "";
      return el("li", null, el("span", { class: "words" }, u(x.name), ": ", line, clock ? [" ", clock] : null),
        el("a", { href: "#/meet/seats?relay=" + encodeURIComponent(x.id) }, FMSG.pick),
        isAdmin() ? el("a", { href: "#/meet/seats?relay=" + encodeURIComponent(x.id) + "&request=1" }, W["seats.request"]) : null,
        stopped(x.id) ? disabledAdd(FW["people.invite"]) : null);
    })));
  }
  // CSV import (11.3): check (no step-up), then send with one step-up; values stay text.
  function csvPanel() {
    const { box, area } = pasteOrFile(FMSG.csvFile, ".csv,.txt");
    const result = el("div");
    const check = btn(FW["people.import-check"], async () => {
      const csv = area.value;
      if (new TextEncoder().encode(csv).length > 262144) {
        fail(FR["csv-limit"]);
        return;
      }
      try {
        const r = await api("POST", "fleet/people/import/check", { csv }, { direct: true });
        result.replaceChildren(csvResult(r));
      } catch (e) {
        fail(e);
      }
    }, "primary");
    return section("csv-h", FW["people.import"], box, check, result);
  }
  function csvResult(r) {
    const rows = r.rows || [];
    const ok = rows.filter((x) => (x.result || x.status || (x.problem ? "" : "ok")) === "ok");
    const c = ok.filter((x) => x.product === "console").length;
    const m = ok.length - c;
    const relays = r.relays || [];
    const send = ok.length ? btn(fillText(FW["people.import-run"], { n: ok.length }), () => confirmDialog({
      spec: fspec("import"), vals: { n: ok.length, c, m, r: relays.length }, name: fillText(FW["people.import-run"], { n: ok.length }), id: r.importId,
      reaches: relays.map(relayName),
      run: () => (m > 0
        ? fleetPost("fleet/people/import", { importId: r.importId, digest: r.digest }, { action: "people.import", target: r.importId }, relays)
        : post("fleet/people/import", { importId: r.importId, digest: r.digest }, { action: "people.import", target: r.importId })),
    }), "primary") : null;
    return el("div", null, dataTable({
      caption: FW["people.import-check"], rows, empty: MSG.noneYet, name: (x) => x.email || "",
      cols: [{ key: "line", label: "#", cell: (x) => (x.line != null ? x.line : x.row != null ? x.row : "") }, { key: "email", label: FMSG.cols.email }, { key: "name", label: FMSG.cols.name },
        { key: "product", label: FMSG.cols.kind, cell: (x) => FW["people.kind-" + x.product] || clean(x.product) }, { key: "relay", label: FMSG.cols.relay, cell: (x) => (x.relay ? u(relayName(x.relay)) : "") },
        { key: "problem", label: FMSG.csvProblem, cell: (x) => (x.problem ? toneChip(stateWord(x.problem), "bad") : toneChip(FMSG.csvOk, "ok")) }],
    }), send);
  }

  // ---- License (11.4): every relay's license and service state, its reminders, the library, install per relay ----
  pages.fleetLicense = async () => {
    const d = await api("GET", "fleet/licenses", null, { direct: true });
    await fleetRelays();
    const rows = d.relays || [];
    const admin = isAdmin();
    // The licensed user count shows only when fleet/licenses carries it (`license.users`); a relay row without it would
    // leave the column empty (L-6).
    const users = (x) => (x.license && x.license.users != null ? (x.license.used != null ? x.license.used : (x.seats || {}).seated || 0) + " of " + x.license.users : "");
    const withUsers = rows.some((x) => users(x) !== "");
    return [head(FW["nav.license"]), panel(null, dataTable({
      caption: FW["nav.license"], rows, empty: MSG.noneYet, name: (x) => relayName(x.relay),
      cols: [{ key: "relay", label: FMSG.cols.relay, cell: (x) => u(relayName(x.relay)) }, { key: "product", label: FMSG.cols.product, cell: (x) => productWord(x.product) },
        { key: "state", label: FMSG.cols.state, cell: (x) => stateWord((x.license || {}).state || "none"), sort: (x) => (x.license || {}).state },
        withUsers ? { key: "users", label: "Users", cell: users, sort: (x) => (x.license || {}).users } : null,
        { key: "days", label: FMSG.cols.days, cell: (x) => (x.license && x.license.daysLeft != null ? x.license.daysLeft : "") },
        { key: "service", label: MSG.serviceLabel, cell: (x) => {
          const s = serviceOf(x);
          if (!s) return "";
          const said = serviceText(x);
          return el("span", null, said ? toneChip(said, s.state === "stopped" ? "bad" : "warn") : MSG.service[s.state] || stateWord(s.state),
            s.state === "stopped" && relayWhy(s) ? [" ", relayWhy(s)] : null);
        }, sort: (x) => (serviceOf(x) || {}).state },
        { key: "reminders", label: MSG.reminders, sortable: false, cell: (x) => {
          const sent = x.reminders || [];
          const next = nextReminder(x.license ? x.license.exp : null, serviceOf(x), sent);
          return sent.length || next ? el("span", null, reminderLine(sent, next)) : "";
        } }].filter(Boolean),
      // Install works on a stopped relay (11.4): the channel and the `license` scope keep working.
      actions: (x) => (admin ? [{ label: FMSG.install, run: () => go("#/license?relay=" + encodeURIComponent(x.relay)) }] : []),
    })), libraryPanel(d.library || []), ...(admin ? await orgRootPanels() : [])];
  };
  // ---- AC-2b-D 3.7, 3.8, 12: the License page's Meeting Hub organization CA and Remote Spokes organization root ----
  // A PEM block's DER, or null.
  function pemDer(text, label) {
    const m = new RegExp("-----BEGIN " + label + "-----([\\s\\S]*?)-----END " + label + "-----").exec(String(text || ""));
    if (!m) return null;
    try {
      return Uint8Array.from(atob(m[1].replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
    } catch (e) {
      return null;
    }
  }
  function derAt(der, at) {
    let len = der[at + 1], hdr = 2;
    if (len & 0x80) {
      const k = len & 0x7f;
      len = 0;
      for (let i = 0; i < k; i++) len = len * 256 + der[at + 2 + i];
      hdr = 2 + k;
    }
    if (at + hdr + len > der.length) throw new Error("short");
    return { tag: der[at], at, start: at + hdr, end: at + hdr + len };
  }
  function derKids(der, node) {
    const out = [];
    for (let p = node.start; p < node.end;) {
      const x = derAt(der, p);
      out.push(x);
      p = x.end;
    }
    return out;
  }
  // The SubjectPublicKeyInfo of a certificate (display only; the console checks the certificate itself).
  function certSpki(der) {
    try {
      const tbs = derKids(der, derAt(der, 0))[0];
      const parts = derKids(der, tbs);
      const x = parts[parts[0].tag === 0xa0 ? 6 : 5];
      return x && x.tag === 0x30 ? der.slice(x.at, x.end) : null;
    } catch (e) {
      return null;
    }
  }
  // Whether a SubjectPublicKeyInfo names the P-256 curve (OID 1.2.840.10045.3.1.7).
  function p256Spki(spki) {
    const oid = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
    for (let i = 0; spki && i + oid.length <= spki.length; i++) if (oid.every((b, k) => spki[i + k] === b)) return true;
    return false;
  }
  // `m_` (license::meet_root_id) or `n_` (identity::node_id_of) and the first 32 hex of the SPKI's SHA-256, for the
  // dialog title; empty where the browser has no SubtleCrypto.
  async function spkiId(prefix, spki) {
    try {
      const h = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
      return prefix + [...h].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    } catch (e) {
      return "";
    }
  }
  // A file field whose text stays in memory and is never shown (a CA key must never be displayed, 8.2).
  function fileText(label, accept) {
    const id = uid("file");
    const input = el("input", { id, type: "file", accept });
    const got = { text: "" };
    input.addEventListener("change", async () => {
      const f = input.files && input.files[0];
      got.text = f && f.size <= 1048576 ? await f.text() : "";
    });
    return { box: el("div", { class: "field" }, el("label", { for: id }, label), input), got, input };
  }
  async function orgRootPanels() {
    const high = profile() === "high";
    // The section says whether the console holds a CA, then links to its page (the title is not repeated as the link, L-6).
    let held = null;
    if (!high) held = await api("GET", "fleet/meet-ca", null, { direct: true, activity: false }).catch(() => null);
    const state = !held ? null : held.ca ? pairs([[FW["meet-ca.id"], code(held.ca.id || "")], [FW["meet-ca.ends"], held.ca.notAfter ? dayAny(held.ca.notAfter) : MSG.unknown]])
      : el("p", null, FW["meet-ca.none"]);
    const ca = section("meet-ca-h", FW["meet-ca.title"], high ? el("p", null, FW["meet-ca.high"]) : [state, el("p", null, el("a", { href: "#/license/meet-ca" }, FMSG.caOpen))]);
    // Under High a delivered root is never used (6.7), so the Remote Spokes root section is hidden (12).
    return high ? [ca] : [ca, await spokesRootPanel()];
  }
  async function spokesRootPanel() {
    const d = await api("GET", "fleet/spokes-root", null, { direct: true }).catch(() => ({ root: null }));
    const file = fileText(FMSG.deploy.rootFile, ".pub,.pem");
    const save = btn(FW["spokes-root.set"], async () => {
      const text = file.got.text;
      const der = /PRIVATE KEY/.test(text) ? null : pemDer(text, "PUBLIC KEY");
      if (!der || !p256Spki(der)) {
        fail(FR["spokes-root-key"]);
        return;
      }
      const id = await spkiId("n_", der);
      confirmDialog({
        spec: fspec("spokes-root"), vals: { id }, name: id, id,
        run: () => post("fleet/spokes-root", { pem: text }, { action: "fleet.spokes-root.set", target: "-" }),
      });
    }, "primary");
    return section("spokes-root-h", FW["spokes-root.title"], el("p", null, FW["spokes-root.help"]),
      d && d.root ? pairs([[FMSG.deploy.savedRoot, code(d.root.id)]]) : null, file.box, el("div", null, save));
  }
  // The latest date the final revocation list must cover (8.6): 120 days on, or the last issued certificate's end.
  const caFinalEnds = (ca) => Math.max(Date.now() + 120 * 86400000, ...((ca.issued || []).map((x) => (x.notAfter > 1e12 ? x.notAfter : (x.notAfter || 0) * 1000))));
  pages.fleetMeetCa = async () => {
    const kids = [head(FW["meet-ca.title"])];
    if (profile() === "high") return kids.concat(panel(null, el("p", null, FW["meet-ca.high"])));
    const d = await api("GET", "fleet/meet-ca", null, { direct: true });
    kids.push(banner("warn", MSG.sev.warn, FW["meet-ca.warn"]));
    if (!d.ca) return kids.concat(caImportPanel(d));
    await fleetRelays();
    return kids.concat(caHeldPanels(d.ca));
  };
  // With no CA (3.7, 8.2): Import our CA, and Create shown disabled as coming next (8.1).
  function caImportPanel(d) {
    const crt = fileText(FMSG.deploy.caFile, ".crt,.pem");
    const key = fileText(FMSG.deploy.keyFile, ".key,.pem");
    const issued = fileText(FMSG.deploy.issuedFile, ".json");
    const crl = fileText(FMSG.deploy.crlFile, ".pem,.crl");
    const signer = textField(FW["meet-ca.signer"], { maxlength: "253", autocapitalize: "none", inputmode: "url" }, FW["meet-ca.signer-help"]);
    const cid = uid("nohigh");
    const noHigh = el("input", { id: cid, type: "checkbox", required: true });
    const allowed = d.allowed !== false;
    const importBtn = btn(FW["meet-ca.import"], async () => {
      const caPem = crt.got.text, keyPem = key.got.text;
      const der = pemDer(caPem, "CERTIFICATE");
      const spki = der ? certSpki(der) : null;
      if (!spki || !p256Spki(spki) || !/-----BEGIN (?:EC )?PRIVATE KEY-----/.test(keyPem)) {
        fail(FR["meet-ca-key"]);
        return;
      }
      const url = signer.input.value.trim();
      if (url && !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s]*)?$/.test(url)) {
        fail(FR["meet-ca-signer"]);
        signer.input.focus();
        return;
      }
      if (!noHigh.checked) {
        fail(FR["meet-ca-confirm"]);
        noHigh.focus();
        return;
      }
      const id = await spkiId("m_", spki);
      confirmDialog({
        spec: fspec("meet-ca-import"), vals: { id }, name: id, id, two: true, danger: true, fields: [{ kind: "reason" }],
        run: (v) => post("fleet/meet-ca/import", { caPem, keyPem, issuedJson: issued.got.text || null, crlPem: crl.got.text || null, signerUrl: url || null,
          noHighRelay: true, maxLifetimeDays: 400, reason: v.reason },
          // The key never goes into the step-up binding (8.2: no route or log ever carries it).
          { action: "fleet.meet-ca.import", target: "-", params: { signerUrl: url || null, noHighRelay: true, maxLifetimeDays: 400 } }),
      });
    }, "primary");
    if (!allowed) setEnabled(importBtn, false);
    const createId = uid("next");
    return [panel(null, el("p", null, FW["meet-ca.none"])),
      section("meet-ca-import-h", FW["meet-ca.import"], el("p", null, FW["meet-ca.import-help"]), crt.box, key.box, issued.box, crl.box, signer.box,
        el("label", { class: "inline", for: cid }, noHigh, FW["meet-ca.confirm-no-high"]),
        !allowed && d.why ? el("p", { class: "note" }, u(d.why)) : null, el("div", null, importBtn)),
      panel(null, el("button", { type: "button", "aria-disabled": "true", class: "is-disabled", "aria-describedby": createId }, FW["meet-ca.create-next"]),
        el("p", { class: "note", id: createId }, FW["deploy.env-next"]))];
  }
  // A generic step-up dialog for the CA page's controls that have no 13.2 dialog of their own.
  const caSpec = (title, body, button) => ({ title, body: [body], button: [button] });
  function caHeldPanels(ca) {
    const crl = ca.crl || {};
    const issued = ca.issued || [];
    const out = [];
    if (ca.state === "lost") out.push(banner("bad", MSG.sev.bad, fill(FW["meet-ca.lost"], { date: dayAny(crl.nextUpdate) })));
    if (ca.state === "unreadable") out.push(banner("bad", MSG.sev.bad, FW["meet-ca.unreadable"]));
    if (ca.diverged) {
      out.push(banner("warn", MSG.sev.warn, fill(FW["meet-ca.diverged"], { relay: relayName(ca.diverged.relayId) }), " ",
        btn(FMSG.deploy.dismiss, async () => {
          try {
            await api("POST", "fleet/meet-ca/dismiss-diverged", {}, { direct: true });
            render({ keepMessages: true });
          } catch (e) {
            fail(e);
          }
        })));
    }
    out.push(section("meet-ca-held-h", FW["meet-ca.title"], pairs([[FW["meet-ca.id"], code(ca.id)], [FMSG.deploy.subject, u(ca.subject || "")],
      [FW["meet-ca.ends"], dayAny(ca.notAfter)], [FMSG.cols.state, FMSG.deploy.caState[ca.state] || stateWord(ca.state)],
      [FW["meet-ca.signer"], ca.signerUrl ? u(ca.signerUrl) : undefined]]),
      el("p", null, fill(FW["meet-ca.crl"], { number: crl.number != null ? String(crl.number) : "", date: dayAny(crl.nextUpdate) })),
      el("p", null, fillText(FW["meet-ca.issued"], { n: issued.length })),
      (ca.notPushed || []).map((x) => el("p", { class: "note" }, fill(FW["meet-ca.crl-not-pushed"], { relay: relayName(x.relay), why: x.why === "fixed" ? FW["meet-ca.crl-fixed"] : FW["meet-ca.crl-none"] }))),
      dataTable({
        caption: FW["meet-ca.issued"].replace(": <n>", ""), rows: issued, empty: MSG.noneYet, name: (x) => x.serial,
        cols: [{ key: "relay", label: FMSG.cols.relay, cell: (x) => u(relayName(x.relay)) }, { key: "kind", label: FMSG.cols.kind, cell: (x) => FMSG.deploy.kind[x.kind] || stateWord(x.kind) },
          { key: "names", label: FMSG.deploy.names, cell: (x) => u((x.names || []).join(", ")), sortable: false }, { key: "notAfter", label: FW["meet-ca.ends"], cell: (x) => dayAny(x.notAfter) },
          { key: "state", label: FMSG.cols.state, cell: (x) => stateWord(x.state) }],
        actions: (x) => (x.state !== "revoked" ? [{ label: FW["meet-ca.revoke"], run: () => caRevoke(x.serial) }] : []),
      })));
    // The list's entries; "Remove from the list" on those with no known end (8.5).
    const revoked = crl.revoked || [];
    out.push(section("meet-ca-crl-h", FMSG.deploy.revokedList, dataTable({
      caption: FMSG.deploy.revokedList, rows: revoked, empty: MSG.noneYet, name: (x) => x.serial,
      cols: [{ key: "serial", label: FMSG.deploy.serial, cell: (x) => code(x.serial) }, { key: "at", label: FMSG.deploy.at, cell: (x) => dayAny(x.at) },
        { key: "notAfter", label: FW["meet-ca.ends"], cell: (x) => (x.notAfter ? dayAny(x.notAfter) : MSG.unknown) }],
      actions: (x) => (x.notAfter ? [] : [{ label: FW["meet-ca.prune"], run: () => caPrune(x.serial, ca) }]),
    }), el("div", null, btn(FW["meet-ca.revoke"], () => caRevoke(null)))));
    // Longest lifetime (8.2, R5-M2), step-up and a second admin under two-person.
    const days = textField(FW["meet-ca.max-lifetime"], { type: "number", min: "1", max: "3650", inputmode: "numeric" });
    days.input.value = String(ca.maxLifetimeDays || 400);
    const kids = [days.box, el("div", null, btn(FMSG.deploy.saveDays, () => {
      const n = Number(days.input.value);
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        fail(FW["meet-ca.max-lifetime"]);
        return;
      }
      confirmDialog({
        spec: caSpec(FW["meet-ca.max-lifetime"], String(n), FMSG.deploy.saveDays), name: ca.id, id: ca.id, two: true, fields: [{ kind: "reason" }],
        run: (v) => post("fleet/meet-ca/max-lifetime", { days: n, reason: v.reason }, { action: "fleet.meet-ca.max-lifetime", target: "-" }),
      });
    }))];
    // The certificate server's revocation check (8.4, R4-M1), with the relays that confirm or disagree.
    if (ca.signerUrl) {
      const sid = uid("enf");
      const on = el("input", { id: sid, type: "checkbox", checked: ca.signerEnforced ? true : null, "aria-describedby": sid + "-n" });
      on.addEventListener("change", () => {
        const want = !!on.checked;
        on.checked = !want;
        confirmDialog({
          spec: caSpec(FW["meet-ca.signer-enforced"], FW["meet-ca.signer-enforced-help"], FMSG.deploy.saveDays), name: ca.signerUrl, id: ca.id, fields: [{ kind: "reason" }],
          run: (v) => post("fleet/meet-ca/signer-enforced", { on: want, reason: v.reason }, { action: "fleet.meet-ca.signer-enforced", target: "-" }),
        });
      });
      kids.push(el("label", { class: "inline", for: sid }, on, FW["meet-ca.signer-enforced"]), el("p", { class: "note", id: sid + "-n" }, FW["meet-ca.signer-enforced-help"]),
        pairs([[FMSG.deploy.confirms, (ca.confirmedBy || []).map(relayName).join(", ") || MSG.noneYet], [FMSG.deploy.disagrees, (ca.mismatch || []).map(relayName).join(", ") || MSG.noneYet]]));
    }
    // Remove (8.6): the admin confirms signing elsewhere when relays still hold its certificates.
    const finalEnds = caFinalEnds(ca);
    const eid = uid("else");
    const elsewhere = el("input", { id: eid, type: "checkbox" });
    kids.push(el("label", { class: "inline", for: eid }, elsewhere, fillText(FW["meet-ca.remove-elsewhere"], { date: dayAny(finalEnds) })),
      el("div", null, btn(FW["meet-ca.remove"], () => confirmDialog({
        spec: fspec("meet-ca-remove"), vals: { date: dayAny(finalEnds) }, name: ca.id, id: ca.id, two: true, danger: true, fields: [{ kind: "reason" }],
        run: (v) => post("fleet/meet-ca/remove", { elsewhere: !!elsewhere.checked, reason: v.reason }, { action: "fleet.meet-ca.remove", target: "-" }),
      }), "danger")));
    out.push(panel(null, ...kids));
    return out;
  }
  // Revoke a certificate (8.5): the serial from the row, or typed.
  function caRevoke(serial) {
    confirmDialog({
      spec: fspec("meet-ca-revoke"), vals: { serial: serial || "" }, vals2: (v) => ({ serial: serial || v.serial || "" }), name: serial || "", id: serial || "", danger: true,
      fields: (serial ? [] : [{ kind: "text", key: "serial", label: FMSG.deploy.serial, maxlength: "64", required: true }]).concat([{ kind: "reason" }]),
      check: (v) => (!serial && !/^[0-9a-fA-F]{2,64}$/.test(v.serial || "") ? MSG.need.serial : ""),
      run: (v) => {
        const s = (serial || v.serial).toLowerCase();
        return post("fleet/meet-ca/revoke", { serial: s, reason: v.reason }, { action: "fleet.meet-ca.revoke", target: s });
      },
    });
  }
  // Remove from the list (8.5): the ended certificate itself, checked by the console; a second admin under two-person.
  function caPrune(serial, ca) {
    confirmDialog({
      spec: caSpec(FW["meet-ca.prune"], fillText(FW["meet-ca.prune-help"], { days: ca.maxLifetimeDays || 400 }), FW["meet-ca.prune"]), name: serial, id: serial, two: true,
      fields: [{ kind: "textarea", key: "certPem", label: FMSG.deploy.certPem, required: true }, { kind: "reason" }],
      check: (v) => (!pemDer(v.certPem, "CERTIFICATE") ? MSG.need.certPem : ""),
      run: (v) => post("fleet/meet-ca/prune", { certPem: v.certPem, reason: v.reason }, { action: "fleet.meet-ca.prune", target: "-" }),
    });
  }
  // The license library (5.3): licenses kept on the console for installing on relays.
  function libraryPanel(lib) {
    const admin = isAdmin();
    const kids = [dataTable({
      caption: FMSG.library, rows: lib, empty: MSG.noneYet, name: (l) => l.id,
      cols: [{ key: "id", label: W["dialog.id"], cell: (l) => code(l.id) }, { key: "product", label: FMSG.cols.product, cell: (l) => productWord(l.product) },
        { key: "edition", label: "Edition" }, { key: "users", label: "Users" }, { key: "relays", label: FMSG.cols.count },
        { key: "exp", label: FMSG.cols.ends, cell: (l) => dayAny(l.exp) }, { key: "root", label: "Root", cell: (l) => code(l.root || "") }],
      actions: (l) => (admin ? [{ label: MSG.remove, run: () => confirmDialog({
        spec: MSG.removeLicense, vals: { id: l.id }, name: [productWord(l.product), l.edition].filter(Boolean).join(", "), id: l.id, danger: true, plain: true,
        run: () => post("fleet/licenses/library", { remove: l.id }, { action: "fleet.license.library", target: l.id }),
      }) }] : []),
    })];
    if (admin) {
      const { box, area } = pasteOrFile(W["license.install.field"], ".lic,.txt");
      kids.push(box, btn(FD["library-add"].button, () => {
        const text = area.value.trim();
        const p = compactPayload(licenseToken(text));
        if (!p) {
          fail(fillText(R["license-refused"], { reason: MSG.unreadable }));
          return;
        }
        confirmDialog({
          spec: fspec("library-add"), vals: { id: p.id, product: productOf(p.features), edition: p.edition, users: p.users, date: daySec(p.exp) }, name: p.org, id: p.id,
          run: () => post("fleet/licenses/library", { license: text }, { action: "fleet.license.library", target: p.id || "-" }),
        });
      }, "primary"));
    }
    return section("lib-h", FMSG.library, ...kids);
  }

  // ---- Security and audit: trust and CA screens (3.10, 3.11), admin keys (4.4), Exports (10) ----
  pages.fleetSecurity = async () => {
    const [trust, roster] = await Promise.all([api("GET", "fleet/trust", null, { direct: true }), api("GET", "fleet/roster", null, { direct: true })]);
    await fleetRelays();
    const gens = trust.caGenerations || [];
    const next = gens.filter((g) => g.state === "pending" || g.state === "next");
    const top = gens.reduce((a, g) => Math.max(a, Number(g.generation) || 0), 0);
    const man = trust.manifest || {};
    const waiting = roster.waiting || [];
    const rrel = roster.relays || [];
    const kids = [head(pageLabel("security", "settings"))];
    const mine = me() && me().methods ? (me().methods.webauthn || []).some((k) => k.state === "working") : true;
    if (!mine) kids.push(banner("warn", MSG.sev.warn, FW["fleet.webauthn-only"]));
    kids.push(section("trust-h", FW["trust.title"],
      next.map((g) => banner("warn", MSG.sev.warn, fill(FW["trust.ca-new"], { generation: g.generation, fingerprint: g.fingerprint }))),
      dataTable({
        caption: FMSG.caGenerations, rows: gens, empty: MSG.noneYet, name: (g) => FMSG.generation + " " + g.generation,
        cols: [{ key: "generation", label: FMSG.generation }, { key: "fingerprint", label: FW["enroll.fingerprint"], cell: (g) => el("code", { class: "fingerprint" }, clean(g.fingerprint)), sortable: false },
          { key: "state", label: FMSG.cols.state, cell: (g) => stateWord(g.state) }, { key: "notAfter", label: FMSG.cols.ends, cell: (g) => dayAny(g.notAfter) }],
      }),
      pairs([[FMSG.manifest, man.seq != null ? man.seq : MSG.unknown], [FMSG.issued, man.issuedAt ? when(man.issuedAt) : MSG.unknown],
        [FMSG.leaves, (man.leaves || []).length], [FMSG.revoked, (man.revoked || []).length]]),
      dataTable({
        caption: FMSG.relaysTrust, rows: trust.relays || [], empty: MSG.noneYet, name: (x) => relayName(x.relay),
        cols: [{ key: "relay", label: FMSG.cols.relay, cell: (x) => u(relayName(x.relay)) },
          { key: "pins", label: FMSG.pins, cell: (x) => (x.pins || []).map((p) => FMSG.generation + " " + clean(p.generation) + ": " + stateWord(p.state)).join(", "), sortable: false },
          { key: "manifestSeq", label: FMSG.manifest }],
      }),
      isAdmin() ? el("div", { class: "wizard-actions" },
        btn(FW["trust.server-revoke"], () => confirmDialog({
          spec: fspec("server-revoke"), danger: true, fields: [{ kind: "reason" }], reaches: (S.relays || []).filter(readable).map((x) => x.name),
          run: (v) => post("fleet/trust/server-revoke", { reason: v.reason }, { action: "fleet.server-revoke", target: "-" }),
        }), "danger"),
        btn(FW["trust.ca-rollover"], () => confirmDialog({
          spec: fspec("ca-rollover"), vals: { generation: top + 1 }, two: true, fields: [{ kind: "reason" }], reaches: (S.relays || []).filter(readable).map((x) => x.name),
          run: (v) => post("fleet/trust/ca-rollover", { reason: v.reason }, { action: "fleet.ca.rollover", target: "-" }),
          done: (r) => render({ keepMessages: true }).then(() => {
            if (r && r.fingerprint) say(fillText(FW["trust.ca-new"], { generation: r.generation, fingerprint: r.fingerprint }));
          }),
        }))) : null));
    kids.push(section("keys-h", FMSG.keys,
      waiting.length ? el("div", null, el("p", null, fill(FW["fleet.roster-waiting"], { n: waiting.length })),
        isAdmin() ? btn(FW["fleet.endorse"], () => endorseKeys(roster), "primary") : null) : null,
      dataTable({
        caption: FMSG.keys, rows: roster.entries || [], empty: MSG.noneYet, name: (e) => e.email + " " + (e.hint || ""),
        cols: [{ key: "email", label: FMSG.cols.email }, { key: "role", label: FMSG.cols.role, cell: (e) => ROLE_WORD[e.role] || stateWord(e.role) },
          { key: "hint", label: W["dialog.id"], cell: (e) => code(e.hint || "") },
          { key: "fingerprint", label: FW["enroll.fingerprint"], cell: (e) => el("code", { class: "fingerprint" }, clean(e.fingerprint || "")), sortable: false },
          { key: "evidence", label: FMSG.evidence, cell: (e) => yesNo(e.evidence) }],
      }),
      waiting.length ? dataTable({
        caption: FMSG.waitingKeys, rows: waiting, empty: MSG.noneYet, name: (e) => e.email + " " + (e.hint || ""),
        cols: [{ key: "email", label: FMSG.cols.email }, { key: "role", label: FMSG.cols.role, cell: (e) => ROLE_WORD[e.role] || stateWord(e.role) }, { key: "hint", label: W["dialog.id"], cell: (e) => code(e.hint || "") }],
      }) : null,
      dataTable({
        caption: FMSG.relaysTrust, rows: rrel, empty: MSG.noneYet, name: (x) => relayName(x.relay),
        cols: [{ key: "relay", label: FMSG.cols.relay, cell: (x) => el("a", { href: "#/relays/" + encodeURIComponent(x.relay) + "?tab=trust" }, u(relayName(x.relay))) },
          { key: "seq", label: FMSG.rosterSeq },
          { key: "bootstrap", label: FMSG.cols.state, cell: (x) => ((typeof x.bootstrap === "string" ? x.bootstrap : (x.bootstrap || {}).state) === "done" ? FW["bootstrap.done"] : FW["bootstrap.pending"]) },
          { key: "held", label: FMSG.held, cell: (x) => (x.held || []).length }, { key: "unattested", label: FMSG.unattested, cell: (x) => (x.unattested || []).length }],
      })));
    return kids;
  };
  // Confirm the new keys (4.4): one fleet step-up of kind "roster" over every relay that must learn them.
  function endorseKeys(roster) {
    const relays = (roster.relays || []).map((x) => x.relay);
    // fleet/roster says where the key list is now; the endorsement names the position the waiting keys will take.
    const next = (Number(roster.seq) || 0) + 1;
    confirmDialog({
      spec: fspec("endorse"), vals: { n: (roster.waiting || []).length, m: relays.length }, name: FMSG.waitingKeys, id: String(next), two: true,
      reaches: relays.map(relayName),
      run: () => fleetPost("fleet/roster/endorse", { seq: next }, { action: "fleet.roster.endorse", target: String(next) }, relays, "roster"),
    });
  }
  pages.fleetExports = async () => {
    const d = await api("GET", "settings/exports", null, { direct: true });
    const relays = (await fleetRelays()).sort(byName);
    const siem = d.siem || null;
    const tokens = d.tokens || [];
    const relaysWord = (v) => (v === "all" || !v ? FMSG.relaysAll : [].concat(v).map(relayName).join(", "));
    const tokenBox = el("div");
    const newToken = btn(FW["exports.token-new"], () => confirmDialog({
      spec: fspec("token"), vals: { label: "", relays: FMSG.relaysAll, days: 90 },
      fields: [{ kind: "text", key: "label", label: FMSG.label, maxlength: "64", required: true },
        { kind: "select", key: "relays", label: FMSG.cols.count, options: [["all", FMSG.relaysAll]].concat(relays.map((x) => [x.id, x.name])), value: "all" },
        { kind: "text", type: "number", key: "days", label: FMSG.daysField, value: 90, min: "30", max: "90", inputmode: "numeric" }],
      vals2: (v) => ({ label: v.label, relays: relaysWord(v.relays), days: v.days }),
      check: (v) => (!v.label || v.label.length > 64 ? MSG.need.label : !(Number.isInteger(v.days) && v.days >= 30 && v.days <= 90) ? MSG.need.tokenDays : ""),
      run: (v) => post("settings/exports/token", { label: v.label, relays: v.relays === "all" ? "all" : [v.relays], days: v.days }, { action: "exports.token.create", target: v.label }),
      plain: true,
      // The token is shown once, here, and never again (10.1).
      done: (r) => render({ keepMessages: true }).then(() => {
        const box = $("token-once");
        if (box && r && r.token) box.replaceChildren(panel(null, el("p", null, FW["exports.token-once"]), el("code", { class: "code-once" }, clean(r.token)), copyButton(r.token)));
      }),
    }), "primary");
    tokenBox.append(el("div", { id: "token-once" }), dataTable({
      caption: FMSG.tokens, rows: tokens, empty: MSG.noneYet, name: (t) => t.label,
      cols: [{ key: "label", label: FMSG.label }, { key: "hint", label: W["dialog.id"], cell: (t) => code(t.hint) }, { key: "relays", label: FMSG.cols.count, cell: (t) => relaysWord(t.relays), sortable: false },
        { key: "createdBy", label: FMSG.enrolledBy }, { key: "createdAt", label: FMSG.created, cell: (t) => when(t.createdAt) },
        { key: "expires", label: FMSG.cols.ends, cell: (t) => (t.olderThan90 ? el("span", { title: FMSG.olderToken }, when(t.expires), " ", el("small", null, FMSG.olderToken)) : when(t.expires)) },
        { key: "lastUsedAt", label: "Last used", cell: (t) => when(t.lastUsedAt) }],
      actions: (t) => [{ label: FMSG.revoke, run: () => confirmDialog({
        spec: MSG.revokeToken, vals: { label: t.label }, name: t.label, id: t.hint, danger: true, plain: true,
        run: () => api("POST", "settings/exports/token/revoke", { hint: t.hint }, { direct: true }),
      }) }],
    }));
    // SIEM (10.2): staged save behind a test message; turning it off needs a second admin with two-person on.
    const host = textField(FMSG.siemHost, { maxlength: "253" });
    host.input.value = siem ? siem.host || "" : "";
    const port = textField(FMSG.siemPort, { type: "number", min: "1", max: "65535", inputmode: "numeric" });
    port.input.value = String(siem && siem.port ? siem.port : 6514);
    const area = (label, set) => {
      const id = uid("si");
      const a = el("textarea", { id, spellcheck: "false", autocomplete: "off" });
      return { input: a, box: el("div", { class: "field" }, el("label", { for: id }, label), a, set ? el("span", { class: "note" }, W["settings.email.saved"]) : null) };
    };
    const ca = area(FMSG.siemCa, siem && siem.caSet);
    const cert = area(FMSG.siemCert, siem && siem.clientCertSet);
    const key = area(FMSG.siemKey, siem && siem.clientCertSet);
    const events = ["audit", "security", "relays"].map((k) => {
      const id = uid("ev");
      const cb = el("input", { id, type: "checkbox", value: k, checked: (siem ? siem.events || [] : ["audit", "security"]).includes(k) ? true : null });
      return [cb, el("label", { class: "inline", for: id }, cb, FMSG.siemEventNames[k])];
    });
    const rid = uid("si");
    const reasons = el("input", { id: rid, type: "checkbox", checked: siem && siem.includeReasons ? true : null });
    const body = () => ({ host: host.input.value.trim(), port: Number(port.input.value), caPem: ca.input.value.trim(), clientCertPem: cert.input.value.trim(),
      clientKeyPem: key.input.value, events: events.filter((x) => x[0].checked).map((x) => x[0].value), includeReasons: reasons.checked });
    return [head(FW["exports.title"]),
      section("tok-h", FMSG.tokens, el("div", { class: "page-head" }, newToken), tokenBox),
      section("siem-h", FW["exports.siem"],
        siem ? pairs([[FMSG.cols.state, stateWord(siem.state)], [FMSG.lastError, siem.lastError || MSG.no], [FMSG.spooled, siem.spooled || 0], [FMSG.dropped, siem.dropped || 0]]) : null,
        host.box, port.box, ca.box, cert.box, key.box,
        el("fieldset", { class: "choice" }, el("legend", null, FMSG.siemEvents), events.map((x) => x[1])),
        el("label", { class: "inline", for: rid }, reasons, FW["exports.siem-reasons"]),
        el("div", { class: "wizard-actions" },
          btn(MSG.save, () => {
            const b = body();
            confirmDialog({
              spec: fspec("siem-on"), vals: { host: b.host, port: b.port }, name: b.host, id: b.host + ":" + b.port, fields: [{ kind: "reason" }],
              run: (v) => post("settings/exports/siem", Object.assign({}, b, { reason: v.reason }), { action: "exports.siem", target: "-" }),
            });
          }, "primary"),
          siem ? btn(FW["exports.siem-test"], async () => {
            try {
              await api("POST", "settings/exports/siem/test", {}, { direct: true });
              say(MSG.done);
            } catch (e) {
              fail(e);
            }
          }) : null,
          siem ? btn(FMSG.turnOff, () => confirmDialog({
            spec: fspec("siem-off"), name: siem.host, id: siem.host + ":" + siem.port, danger: true, two: true, fields: [{ kind: "reason" }],
            run: (v) => post("settings/exports/siem", { off: true, reason: v.reason }, { action: "exports.siem", target: "-" }),
          }), "danger") : null)),
      exportsApi(d)];
  };

  // ---- Settings > API access and the API destinations of Exports (API-1 4, 6.2, 6.6, 7.3, 11, 12.3; API-1a6) ----
  // Every change is staged per organization: removals apply on relays at once (the journal) and the rest waits for the
  // staged save, which a second admin approves where 6.6 says so and the admin's own Hub device signs (meet.api.sign).
  // A secret or token is shown once, in its own dialog, and kept nowhere else.
  const CEILINGS = ["public", "internal", "confidential", "cui"];
  const ceilingWord = (c) => FW["api.ceiling-" + c] || stateWord(c);
  const yesNoOptions = () => [["no", MSG.no], ["yes", MSG.yes]];
  const commaList = (t) => [...new Set(String(t || "").split(",").map((x) => x.trim()).filter(Boolean))];
  const wholeIn = (v, lo, hi) => /^[0-9]{1,9}$/.test(String(v == null ? "" : v).trim()) && Number(v) >= lo && Number(v) <= hi;
  const nowSec = () => Math.floor(Date.now() / 1000);
  function jsonList(t) {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  }
  // Rows without a step-up post as they are; step-up rows bind the action to the organization (target "org").
  const apiPost = (path, body) => api("POST", path, body, { direct: true });
  const apiStep = (path, body, action) => post(path, body, { action, target: body.org });
  const relaysText = (list) => ((list || []).includes("*") || !(list || []).length ? FMSG.relaysAll : list.map(relayName).join(", "));
  // The organization's relays as {id, synced}: the API view lists objects, the exports view ids.
  const orgRelays = (list) => (list || []).map((x) => (typeof x === "string" ? { id: x, synced: true } : x)).filter((x) => x && x.id);

  // The one-time reveal: the value lives in this dialog only, and the dialog leaves the page when it closes.
  function revealOnce(title, id, sentence, value) {
    const d = el("dialog", { class: "confirm reveal", "aria-labelledby": "reveal-title" });
    let held = String(value || "");
    const copy = el("button", { type: "button" }, MSG.copy);
    const close = el("button", { type: "button", class: "primary" }, FW["api.close"]);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(held);
        say(MSG.copied);
      } catch (e) {
        fail(e);
      }
    });
    close.addEventListener("click", () => d.close());
    d.addEventListener("close", () => {
      held = "";
      d.remove();
      const h = $("page-title");
      if (h) h.focus();
    });
    d.append(el("h2", { id: "reveal-title", tabindex: "-1" }, title),
      el("div", { class: "target" }, el("p", { class: "id-line" }, el("span", { class: "id-label" }, W["dialog.id"]), " ", code(id))),
      el("p", null, sentence), el("p", null, el("code", { class: "code-once" }, clean(held))), el("div", { class: "dlg-actions" }, copy, close));
    document.body.append(d);
    d.showModal();
    $("reveal-title").focus();
  }

  // The staged changes of one organization, shared by API access and Exports, with the signing state and Save.
  function apiStaged(o) {
    const s = o.staged;
    const sg = o.signing;
    const kids = [];
    if (sg && sg.state === "waiting") {
      const relay = relayName(sg.relay || "");
      kids.push(banner("info", MSG.sev.info, sg.by && sg.by !== myEmail() ? fill(FW["api.signing-waiting-other"], { email: sg.by, relay }) : fill(FW["api.signing-waiting"], { relay }),
        " ", code(sg.request || "")));
    } else if (sg && sg.state === "sending") kids.push(banner("info", MSG.sev.info, FW["api.signing-sending"]));
    else if (sg && sg.state === "done") kids.push(banner("info", MSG.sev.info, FW["api.signing-done"]));
    else if (sg && sg.state === "failed") kids.push(banner("bad", MSG.sev.bad, fill(FW["api.signing-failed"], { why: sg.error || "" })));
    // One signing at a time per organization: while one is in flight, Cancel signing takes the place of Save.
    const inFlight = !!sg && (sg.state === "waiting" || sg.state === "sending");
    if (inFlight && isAdmin()) {
      kids.push(el("div", { class: "wizard-actions" }, btn(FW["api.signing-cancel"], () => confirmDialog({
        spec: fspec("api-signing-cancel"), vals: { org: o.org }, name: o.org, id: sg.request || o.org, danger: true,
        run: () => apiPost("settings/api/signing/cancel", { org: o.org }),
      }), "danger")));
    }
    if (!s) return section(uid("api-h"), FW["api.staged"], ...kids, emptyLine(FW["api.staged-none"]));
    const names = o.names || {};
    kids.push(el("p", null, fill(FW["api.staged-by"], { email: s.by || "", time: when(s.expires_at) })), el("ul", null, (s.changes || []).map((c) => el("li", null, u(c)))));
    if (s.two_person) kids.push(el("p", null, FW["api.two-person"]), el("ul", null, (s.two_person_reasons || []).map((c) => el("li", null, u(c)))));
    if ((s.tests_needed || []).length) kids.push(el("p", null, FW["api.tests-needed"]), el("ul", null, s.tests_needed.map((id) => el("li", null, u(names[id] || id), " ", code(id)))));
    if (isAdmin()) {
      kids.push(el("div", { class: "wizard-actions" }, inFlight ? null : btn(MSG.save, () => apiSave(o), "primary"), btn(FW["api.discard"], () => confirmDialog({
        spec: fspec("api-discard"), vals: { org: o.org }, name: o.org, id: s.id, danger: true,
        run: () => apiPost("settings/api/discard", { org: o.org }),
      }))));
    }
    return section(uid("api-h"), FW["api.staged"], ...kids);
  }
  // Save: two-person when the stage says so (6.6); the Hub devices of the chosen relay see the signing request.
  function apiSave(o) {
    const s = o.staged;
    const relays = orgRelays(o.relays);
    const first = (relays.find((x) => x.synced) || relays[0] || {}).id;
    const pick = relays.length > 1 ? [{ kind: "select", key: "relay", label: FW["api.f-sign-relay"], options: relays.map((x) => [x.id, relayName(x.id)]), value: first }] : [];
    confirmDialog({
      spec: fspec("api-save"), vals: { org: o.org }, name: o.org, id: s.id, two: !!s.two_person, fields: pick.concat([{ kind: "reason" }]),
      params: [[FW["api.staged"], (s.changes || []).join("; ")]],
      run: (v) => apiPost("settings/api/save", Object.assign({ org: o.org, stage: s.id, reason: v.reason }, v.relay ? { relay: v.relay } : {})),
    });
  }

  pages.fleetApi = async (c) => {
    const [d] = await Promise.all([api("GET", "settings/api", null, { direct: true }), fleetRelays().catch(() => [])]);
    const orgs = d.orgs || [];
    if (!orgs.length) return [head(FW["api.title"]), panel(null, emptyLine(FW["api.no-orgs"]))];
    const want = c && c.q ? c.q.get("org") : null;
    const o = orgs.find((x) => x.org === want) || orgs[0];
    const pick = orgs.length > 1 ? el("nav", { class: "chips", "aria-label": FW["api.org"] },
      orgs.map((x) => el("a", { href: "#/security/api?org=" + encodeURIComponent(x.org), "aria-current": x.org === o.org ? "page" : null }, u(x.org)))) : null;
    const map = o.map;
    const view = o.draft || map || {};
    const admin = isAdmin();
    const state = o.state || "none";
    const stopped = ["off", "expired", "set-aside"].includes(state);
    const lim = o.limits || {};
    const kids = [head(FW["api.title"], pick), banner(stopped ? "bad" : "info", stopped ? MSG.sev.bad : MSG.sev.info, FW["api.state-" + state] || stateWord(state))];
    if (o.edition && o.edition !== "enterprise") kids.push(banner("warn", MSG.sev.warn, FW["api.edition"]));
    kids.push(panel(null, el("p", { class: "id-line" }, el("span", { class: "id-label" }, FW["api.org"]), " ", code(o.org)),
      map ? el("p", null, fill(FW["api.map"], { seq: map.seq, issued: whenSec(map.issued), expires: whenSec(map.expires) })) : null,
      el("p", { class: "note" }, fill(FW["api.limits"], { clients: lim.clients, destinations: lim.destinations, tokens: lim.scrape_tokens }))));
    // Revision 4 2.3: a relay of the org's set lacking what the map needs closes saves until it is updated or retired.
    if ((o.relay_set || []).some((x) => (x.lacks || []).length)) kids.push(banner("bad", MSG.sev.bad, FW["api.outdated"]));
    // Revision 6 7.14: the tabs Clients and settings, Agents (with Tasks) and Remote Spokes.
    const tab = c && c.q ? c.q.get("tab") || "" : "";
    const tabLink = (t, w) => el("a", { href: "#/security/api?org=" + encodeURIComponent(o.org) + (t ? "&tab=" + t : ""), "aria-current": tab === t ? "page" : null }, w);
    kids.push(el("nav", { class: "chips", "aria-label": FW["api.tabs"] }, tabLink("", FW["api.tab-general"]), tabLink("agents", FW["api.tab-agents"]), tabLink("spokes", FW["api.tab-spokes"])));
    const staged = apiStaged({ org: o.org, staged: o.staged, signing: o.signing, relays: o.relays });
    if (tab === "agents") return kids.concat([staged], await apiAgentsTab(o, view, admin, c.q));
    if (tab === "spokes") return kids.concat([staged], await apiSpokesTab(o, admin));
    // Revision 5 14.2: the content and delegated clients' people and approvals, read per client.
    const people = await apiPeopleOf(o, view);
    kids.push(staged, apiClients(o, view, admin), apiBlocks(o, view, admin, map, d.meet_ca),
      apiContent(o, view, admin, people), apiPartners(o, view, admin), apiRevokes(o, view, admin), apiConnectors(o, view, admin), apiIdps(o, view, admin), apiProviders(o, view, admin),
      apiScrape(o, view, admin), apiGrace(o, view, admin), apiOrigins(o, view, admin), apiRelaySet(o, admin));
    if (admin) kids.push(apiKill(o, state));
    kids.push(apiJournal(o, admin), apiExplain(o, view));
    return kids;
  };

  // API clients (4.1 to 4.3): the hints of their credentials only; a new secret is shown once.
  const SHOWN_TONE = { active: "ok", suspended: "warn", expired: "bad", "owner-gone": "bad" };
  const credHints = (list) => (list || []).map((x) => x.type + " " + (x.hint || "") + (x.expires ? " (" + daySec(x.expires) + ")" : "")).join("; ");
  function apiClients(o, view, admin) {
    const org = o.org;
    const ctx = { o, view };
    const add = admin ? btn(FW["api.client-add"], () => confirmDialog({
      spec: fspec("api-client"), vals: { name: "" }, vals2: (v) => ({ name: v.name }), fields: clientFields(null, ctx),
      check: (v) => clientCheck(v, null),
      run: (v) => apiStep("settings/api/clients", { org, client: clientBody(v, null, ctx) }, "api.client.stage"),
    }), "primary") : null;
    return section(uid("api-h"), FW["api.clients"], add ? el("div", { class: "page-head" }, add) : null, dataTable({
      caption: FW["api.clients"], rows: view.clients || [], empty: MSG.noneYet, name: (x) => x.name, text: (x) => [x.name, x.owner, x.id].join(" "),
      cols: [{ key: "name", label: FMSG.cols.name, cell: (x) => u(x.name) }, { key: "kind", label: FMSG.cols.kind, cell: (x) => kindWord(x.kind) },
        { key: "owner", label: FW["api.col-owner"], cell: (x) => u(x.owner) }, { key: "scopes", label: FW["api.col-scopes"], cell: (x) => (x.scopes || []).join(", "), sortable: false },
        { key: "ceiling", label: FW["api.col-ceiling"], cell: (x) => ceilingWord(x.ceiling) }, { key: "relays", label: FMSG.cols.count, cell: (x) => relaysText(x.relays), sortable: false },
        { key: "shown_state", label: FMSG.cols.state, cell: (x) => toneChip(FW["api.shown-" + x.shown_state] || stateWord(x.shown_state || x.state), SHOWN_TONE[x.shown_state]) },
        { key: "credentials", label: FW["api.col-credentials"], cell: (x) => credHints(x.credentials), sortable: false },
        { key: "expires", label: FMSG.cols.ends, cell: (x) => whenSec(x.expires) }],
      actions: (x) => (admin ? clientActions(org, x, ctx) : []),
    }));
  }
  function clientActions(org, x, ctx) {
    const named = { name: x.name };
    const out = [{
      label: FW["api.edit"], run: () => confirmDialog({
        spec: fspec("api-client-update"), vals: named, name: x.name, id: x.id, fields: clientFields(x, ctx),
        check: (v) => clientCheck(v, x),
        run: (v) => apiStep("settings/api/clients/update", { org, id: x.id, client: clientBody(v, x, ctx) }, "api.client.update"),
      }),
    }];
    if (x.state === "suspended") {
      out.push({ label: FW["api.resume"], run: () => confirmDialog({
        spec: fspec("api-client-resume"), vals: named, name: x.name, id: x.id,
        run: () => apiPost("settings/api/clients/resume", { org, id: x.id }),
      }) });
    } else {
      out.push({ label: FW["api.suspend"], run: () => confirmDialog({
        spec: fspec("api-client-suspend"), vals: named, name: x.name, id: x.id, danger: true, fields: [{ kind: "reason" }],
        run: (v) => apiPost("settings/api/clients/suspend", { org, id: x.id, reason: v.reason }),
      }) });
    }
    out.push({ label: FW["api.new-secret"], run: () => confirmDialog({
      spec: fspec("api-secret"), vals: { name: x.name, days: 90 }, vals2: (v) => ({ days: v.days }), name: x.name, id: x.id,
      fields: [{ key: "days", label: FW["api.f-secret-days"], value: 90, inputmode: "numeric" }],
      check: (v) => (wholeIn(v.days, 1, 90) ? "" : FW["api.check-number"]),
      run: (v) => apiStep("settings/api/clients/secret", { org, id: x.id, days: Number(v.days) }, "api.client.secret"),
      plain: true,
      done: (r) => render({ keepMessages: true }).then(() => {
        if (r && r.secret) revealOnce(fill(FW["api.reveal-secret"], named), r.hint || x.id, FW["api.secret-once"], r.secret);
      }),
    }) }, { label: FW["api.revoke-tokens"], run: () => confirmDialog({
      spec: fspec("api-revoke-tokens"), vals: named, name: x.name, id: x.id, danger: true,
      run: () => apiPost("settings/api/clients/revoke-tokens", { org, id: x.id }),
      done: (r) => render({ keepMessages: true }).then(() => say(fillText(FW["api.denied"], { n: r && r.denied != null ? r.denied : 0 }))),
    }) }, { label: FW["api.delete"], run: () => confirmDialog({
      spec: fspec("api-client-delete"), vals: named, name: x.name, id: x.id, danger: true, fields: [{ kind: "reason" }],
      run: (v) => apiPost("settings/api/clients/delete", { org, id: x.id, reason: v.reason }),
    }) });
    return out;
  }
  // The client fields of 2.2 (client_secret credentials come only from New secret).
  function clientFields(x, ctx) {
    const h = (x && x.hours) || {};
    const rate = (x && x.rate) || {};
    return [
      { key: "name", label: FW["api.f-name"], value: x ? x.name : "", maxlength: "32", required: true },
      { kind: "select", key: "kind", label: FW["api.f-kind"], options: CLIENT_KINDS.map((k) => [k, kindWord(k)]), value: x ? x.kind : "monitoring" },
      { key: "owner", label: FW["api.f-owner"], value: x ? x.owner : "", maxlength: "254" },
      { key: "scopes", label: FW["api.f-scopes"], value: x ? (x.scopes || []).join(", ") : "monitor.read" },
      { kind: "select", key: "ceiling", label: FW["api.col-ceiling"], options: CEILINGS.map((c) => [c, ceilingWord(c)]), value: x ? x.ceiling : "internal" },
      { key: "relays", label: FW["api.f-relays"], value: x ? (x.relays || []).join(", ") : "*" },
      { key: "networks", label: FW["api.f-networks"], value: x ? (x.networks || []).join(", ") : "" },
      { key: "tz", label: FW["api.f-hours-tz"], value: h.tz || "", maxlength: "64" },
      { key: "from", label: FW["api.f-hours-from"], value: h.from || "", maxlength: "5" },
      { key: "to", label: FW["api.f-hours-to"], value: h.to || "", maxlength: "5" },
      { key: "weekdays", label: FW["api.f-hours-days"], value: (h.days || []).join(", ") },
      { kind: "select", key: "mtls", label: FW["api.f-mtls"], options: yesNoOptions(), value: x && x.mtls_required ? "yes" : "no" },
      { key: "perMinute", label: FW["api.f-rate-minute"], value: rate.per_minute_each || 120, inputmode: "numeric" },
      { key: "perDay", label: FW["api.f-rate-day"], value: rate.per_day_each || 100000, inputmode: "numeric" },
      { kind: "textarea", key: "credentials", label: FW["api.f-credentials"], value: x ? "" : "[]", note: x ? FW["api.f-credentials-keep"] : null },
      // Revision 4 2.2: the compliance and directory blocks (the recipient and lowered limits also have their own actions)
      { kind: "textarea", key: "compliance", label: FW["api.f-compliance"], value: "", note: x ? FW["api.f-block-keep"] : null },
      { kind: "textarea", key: "directory", label: FW["api.f-directory"], value: "", note: x ? FW["api.f-block-keep"] : null },
      { key: "lifetime", label: FW["api.f-days"], value: x ? "" : 366, inputmode: "numeric", note: x ? FW["api.f-days-keep"] : null },
    ].concat(contentFields(x, ctx), delegationFields(x, ctx), spokesHubFields(x), a2aFields(x, ctx));
  }
  // A block field: empty keeps (or leaves out) the block, `null` removes it, else a JSON object; undefined when unreadable.
  function jsonBlock(t) {
    if (!t) return null;
    if (t === "null") return "null";
    try {
      const v = JSON.parse(t);
      return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
    } catch (e) {
      return undefined;
    }
  }
  function clientCheck(v, x) {
    const hours = [v.tz, v.from, v.to, v.weekdays];
    if (!/^[a-z0-9-]{1,32}$/.test(v.name)) return FW["api.check-name"];
    if (!/^[^@\s]+@[^@\s]+$/.test(v.owner)) return FW["api.check-owner"];
    if (!commaList(v.scopes).length) return FW["api.check-scopes"];
    if (!commaList(v.relays).length) return FW["api.check-relays"];
    if (hours.some(Boolean) && !(hours.every(Boolean) && commaList(v.weekdays).every((n) => wholeIn(n, 1, 7)))) return FW["api.check-hours"];
    if (!wholeIn(v.perMinute, 1, 6000) || !wholeIn(v.perDay, 1, 10000000)) return FW["api.check-number"];
    if ((v.credentials || !x) && !jsonList(v.credentials)) return FW["api.check-json"];
    if ((v.lifetime || !x) && !wholeIn(v.lifetime, 1, 366)) return FW["api.check-number"];
    if (jsonBlock(v.compliance) === undefined || jsonBlock(v.directory) === undefined) return FW["api.check-block"];
    return contentCheck(v) || a2aCheck(v, x);
  }
  // An edit sends every field shown; cleared hours go as null (any time), empty credentials and days keep the old ones.
  function clientBody(v, x, ctx) {
    const c = { name: v.name, kind: v.kind, owner: v.owner, scopes: commaList(v.scopes), ceiling: v.ceiling, relays: commaList(v.relays), networks: commaList(v.networks),
      mtls_required: v.mtls === "yes", rate: { per_minute_each: Number(v.perMinute), per_day_each: Number(v.perDay) } };
    if (v.tz) c.hours = { tz: v.tz, from: v.from, to: v.to, days: commaList(v.weekdays).map(Number) };
    else if (x && x.hours) c.hours = null;
    if (v.credentials || !x) c.credentials = jsonList(v.credentials);
    if (v.lifetime || !x) c.days = Number(v.lifetime);
    // 2.2: reach R1 exactly for an export client (kind compliance, scopes exactly compliance.export.request)
    c.reach = v.kind === "compliance" && c.scopes.length === 1 && c.scopes[0] === "compliance.export.request" ? "R1" : "R0";
    for (const k of ["compliance", "directory"]) {
      const b = jsonBlock(v[k]);
      if (b === "null") {
        if (x) c[k] = null;
      } else if (b) c[k] = b;
    }
    contentBody(v, x, c);
    a2aBody(v, x, c, ctx);
    return c;
  }

  // ---- Revision 5 14.2 (API-1c7): the client editor's Content and Delegation, the client's people, connectors and
  // identity providers (EMA). Adding or widening any of them is a two-person save (13.2); narrowing journals at once.
  const CLIENT_KINDS = ["monitoring", "integration", "compliance", "app", "agent", "agent_delegated", "spokes_hub"];
  const CONTENT_KINDS = ["app", "agent", "agent_delegated"];
  const CONTENT_SCOPES = ["content.read", "content.post"];
  const IDP_ALGS = ["ES256", "RS256", "PS256"];
  const kindWord = (k) => FW["api.kind-" + String(k || "").replace(/_/g, "-")] || stateWord(k);
  // 3.2 (R5-14): content.post always needs the person's approval for a delegated agent, and for an agent that reads too.
  const confirmForced = (kind, scopes) => kind === "agent_delegated" || (kind === "agent" && CONTENT_SCOPES.every((s) => scopes.includes(s)));
  const cimdOf = (x) => (x ? (x.credentials || []).find((k) => k.type === "cimd") || x.cimd || null : null);
  // 3.2: https, or a loopback IP literal with a path (any port); never localhost, never a fragment.
  const redirectOk = (r) => r.length <= 512 && !r.includes("#") && (/^https:\/\/[^\s/?]+(\/\S*)?$/.test(r) || /^http:\/\/(127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?\/\S*$/.test(r));
  const groupOptions = (ctx) => (ctx.o.ai_groups || []).map((g) => [g.id, g.label ? g.label + " (" + g.id + ")" : g.id]);
  function contentFields(x, ctx) {
    const view = ctx.view;
    const conns = view.connectors || [];
    const apps = [...new Set(conns.flatMap((k) => k.apps || []))];
    const names = Object.fromEntries((ctx.o.api_apps || []).map((a) => [a.principal, a.name]));
    const channels = (x && x.channels) || ["*"];
    const all = channels.includes("*");
    return [
      { kind: "checks", key: "connectors", label: FW["api.f-connectors"], options: conns.map((k) => [k.id, k.name]), value: (x && x.connectors) || [], note: FW["api.f-content-only"] },
      { kind: "checks", key: "apps", label: FW["api.f-apps"], options: apps.map((p) => [p, names[p] ? names[p] + " (" + p + ")" : p]), value: (x && x.apps) || [] },
      { kind: "select", key: "channels", label: FW["api.f-channels"], options: [["*", FW["api.channels-all"]], ["list", FW["api.channels-list"]]], value: all ? "*" : "list" },
      { kind: "textarea", key: "channelIds", label: FW["api.f-channel-ids"], value: all ? "" : channels.join("\n") },
      { kind: "select", key: "confirm", label: FW["api.f-confirm"], options: yesNoOptions(), value: x && (x.confirm || []).includes("content.post") ? "yes" : "no", note: FW["api.confirm-forced"] },
    ];
  }
  function delegationFields(x, ctx) {
    const dg = (x && x.delegation) || {};
    const cimd = cimdOf(x);
    return [
      { kind: "checks", key: "groups", label: FW["api.f-groups"], options: groupOptions(ctx), value: dg.groups || [], note: FW["api.f-delegation-only"] },
      { kind: "textarea", key: "people", label: FW["api.f-people"], value: (dg.principals || []).join("\n") },
      { kind: "textarea", key: "denied", label: FW["api.f-denied"], value: (dg.denied || []).join("\n") },
      { kind: "checks", key: "idps", label: FW["api.f-idps"], options: (ctx.view.idps || []).map((i) => [i.id, i.id + " (" + i.issuer + ")"]), value: dg.idps || [] },
      { key: "consentDays", label: FW["api.f-consent-days"], value: dg.consent_days || 7, inputmode: "numeric" },
      { kind: "textarea", key: "redirects", label: FW["api.f-redirects"], value: ((x && x.redirect_uris) || []).join("\n") },
      { key: "cimd", label: FW["api.f-cimd"], value: cimd ? cimd.hint || cimd.url || "" : "", maxlength: "512", note: FW["api.f-cimd-note"] },
      { kind: "select", key: "loopback", label: FW["api.f-loopback"], options: yesNoOptions(), value: x && x.loopback_ok ? "yes" : "no", note: FW["api.loopback-warn"] },
    ];
  }
  function contentCheck(v) {
    if (!CONTENT_KINDS.includes(v.kind)) return "";
    const scopes = commaList(v.scopes);
    const content = scopes.some((s) => CONTENT_SCOPES.includes(s));
    const conns = v.connectors || [];
    if ((v.kind === "app" || content || conns.length) && (conns.length < 1 || conns.length > 4)) return FW["api.check-content"];
    if (content && ((v.apps || []).length < 1 || v.apps.length > 16 || (v.channels !== "*" && !lines(v.channelIds).length))) return FW["api.check-content"];
    if (v.kind !== "agent_delegated") return "";
    if ((!(v.groups || []).length && !lines(v.people).length) || !wholeIn(v.consentDays, 1, 30)) return FW["api.check-delegation"];
    if (!lines(v.redirects).every(redirectOk)) return FW["api.check-redirects"];
    if (v.cimd && !/^https:\/\/\S+$/.test(v.cimd)) return FW["api.check-cimd"];
    return "";
  }
  // The 3.2 fields of a content or delegated client, added to the client body `c` of the editor's values `v`.
  function contentBody(v, x, c) {
    // An edit removes (null, CLIENT_NULLABLE) each field the client holds that its new kind, reach or scopes do not allow.
    const drop = (...keys) => keys.forEach((k) => {
      if (x && x[k] != null) c[k] = null;
    });
    const conns = CONTENT_KINDS.includes(v.kind) ? v.connectors || [] : [];
    if (v.kind === "app" || conns.length) {
      c.reach = "R1";
      c.connectors = conns;
      if (c.scopes.some((s) => CONTENT_SCOPES.includes(s))) {
        c.apps = v.apps || [];
        c.channels = v.channels === "*" ? ["*"] : lines(v.channelIds);
        c.confirm = c.scopes.includes("content.post") && (v.confirm === "yes" || confirmForced(v.kind, c.scopes)) ? ["content.post"] : [];
      } else drop("apps", "channels", "confirm");
    } else drop("connectors", "apps", "channels", "confirm");
    if (v.kind !== "agent_delegated") {
      // 4.1: the console itself drops a cimd credential once the client is no longer delegated (the editor sees only
      // hints, so it never resends the credentials for that)
      drop("delegation", "redirect_uris", "loopback_ok");
      return;
    }
    c.delegation = { groups: v.groups || [], principals: lines(v.people), idps: v.idps || [], consent_days: Number(v.consentDays), denied: lines(v.denied) };
    c.redirect_uris = lines(v.redirects);
    if (v.loopback === "yes") c.loopback_ok = true;
    else if (x && x.loopback_ok) c.loopback_ok = false;
    const had = cimdOf(x);
    if (v.cimd && v.cimd !== (had ? had.hint || had.url || "" : "")) {
      // 4.1: one cimd credential, never private, ending with the client
      const expires = v.lifetime ? nowSec() + Number(v.lifetime) * 86400 : (x && x.expires) || nowSec() + 366 * 86400;
      c.credentials = (c.credentials || []).filter((k) => k.type !== "cimd").concat([{ type: "cimd", url: v.cimd, private_ok: false, expires }]);
    }
  }
  // ---- Revision 6 7.14 (API-1d5): the client editor's service hub and agent (spokes.tasks.submit) fields. Narrowing
  // journals at once on the console; adding or widening, and any private network, is a two-person save (13).
  const KEY_STORES = ["os_store", "pkcs11", "azure_key_vault", "tpm"];
  const TASK_SCOPE = "spokes.tasks.submit";
  const originOk = (t) => t.length <= 512 && /^https:\/\/[^\s/?#@]+$/.test(t);
  const httpsOk = (t) => !!t && t.length <= 512 && /^https:\/\/[^\s#]+$/.test(t);
  const nodeCred = (x) => (x ? (x.credentials || []).find((k) => k.type === "spokes_node") || null : null);
  const a2aAgentsOf = (view) => (view.a2a && view.a2a.agents) || [];
  function spokesHubFields(x) {
    const had = nodeCred(x);
    return [
      { kind: "textarea", key: "targets", label: FW["api.f-targets"], value: ((x && x.spokes && x.spokes.targets) || []).join("\n"), note: FW["api.f-spokes-only"] },
      { kind: "textarea", key: "nodeCert", label: FW["api.f-node-cert"], value: "" },
      { kind: "select", key: "keyStore", label: FW["api.f-key-store"], options: KEY_STORES.map((k) => [k, FW["api.key-store-" + k.replace(/_/g, "-")]]), value: (had && had.key_store) || "os_store" },
    ];
  }
  function a2aFields(x, ctx) {
    const a = (x && x.a2a) || {};
    const push = a.push || {};
    const card = (x && x.card) || {};
    const agents = a2aAgentsOf(ctx.view).map((g) => [g.id, g.name + " (" + g.id + ")"]);
    for (const id of a.agents || []) if (!agents.some((g) => g[0] === id)) agents.push([id, id]);
    return [
      { kind: "checks", key: "a2aAgents", label: FW["api.f-a2a-agents"], options: agents, value: a.agents || [], note: FW["api.f-a2a-only"] },
      { kind: "textarea", key: "a2aSkills", label: FW["api.f-a2a-skills"], value: (a.skills || ["*"]).join("\n") },
      { key: "maxTasks", label: FW["api.f-max-tasks"], value: a.max_open_tasks || 8, inputmode: "numeric" },
      { kind: "textarea", key: "pushOrigins", label: FW["api.f-push-origins"], value: (push.origins || []).join("\n") },
      { kind: "textarea", key: "pushCidrs", label: FW["api.f-push-cidrs"], value: (push.private_cidrs || []).join("\n") },
      { key: "cardUrl", label: FW["api.f-card-url"], value: card.url || "", maxlength: "512" },
      { key: "cardJwks", label: FW["api.f-card-jwks"], value: card.jwks_uri || "", maxlength: "512" },
      { kind: "textarea", key: "cardCidrs", label: FW["api.f-card-cidrs"], value: (card.private_cidrs || []).join("\n") },
    ];
  }
  function a2aCheck(v, x) {
    const scopes = commaList(v.scopes);
    if (v.kind === "spokes_hub") {
      const t = lines(v.targets);
      const targetsOk = (t.length === 1 && t[0] === "*") || (t.length >= 1 && t.length <= 256 && t.every((n) => /^n_[0-9a-f]{32}$/.test(n)));
      const cert = !!v.nodeCert || !!nodeCred(x) || (jsonList(v.credentials) || []).length > 0;
      return scopes.length === 1 && scopes[0] === TASK_SCOPE && v.mtls === "no" && targetsOk && cert ? "" : FW["api.check-spokes-hub"];
    }
    if (v.kind !== "agent" || !scopes.includes(TASK_SCOPE)) return "";
    const skills = lines(v.a2aSkills);
    const skillsOk = (skills.length === 1 && skills[0] === "*") || (skills.length >= 1 && skills.length <= 64 && skills.every((s) => /^a_[0-9a-f]{16}\/[a-z0-9-]{1,64}$/.test(s)));
    const origins = lines(v.pushOrigins);
    const nets = [lines(v.pushCidrs), lines(v.cardCidrs)];
    const ok = v.a2aAgents.length >= 1 && v.a2aAgents.length <= 16 && skillsOk && wholeIn(v.maxTasks, 1, 256) && origins.length <= 8 && origins.every(originOk)
      && nets.every((n) => n.length <= 8 && n.every(cidrOk)) && (!nets[0].length || origins.length > 0) && (!nets[1].length || !!v.cardUrl)
      && (!v.cardUrl || (httpsOk(v.cardUrl) && httpsOk(v.cardJwks)));
    return ok ? "" : FW["api.check-a2a"];
  }
  // The 2.2 fields of a service hub (a pasted node certificate becomes a spokes_node credential on the console) or of an
  // agent with spokes.tasks.submit (its connectors include those of its agents), added to the client body `c`.
  function a2aBody(v, x, c, ctx) {
    if (v.kind === "spokes_hub") {
      c.reach = "R1";
      c.mtls_required = false;
      c.spokes = { targets: lines(v.targets) };
      if (v.nodeCert) c.credentials = (c.credentials || []).concat([{ type: "spokes_node", cert: v.nodeCert, key_store: v.keyStore }]);
      return;
    }
    if (v.kind !== "agent" || !c.scopes.includes(TASK_SCOPE)) return;
    const connOf = Object.fromEntries(a2aAgentsOf(ctx.view).map((g) => [g.id, g.connector]));
    c.reach = "R1";
    c.connectors = [...new Set((c.connectors || v.connectors || []).concat(v.a2aAgents.map((id) => connOf[id]).filter(Boolean)))];
    c.a2a = { agents: v.a2aAgents, skills: lines(v.a2aSkills), max_open_tasks: Number(v.maxTasks) };
    if (lines(v.pushOrigins).length) c.a2a.push = { origins: lines(v.pushOrigins), private_cidrs: lines(v.pushCidrs) };
    if (v.cardUrl) c.card = { url: v.cardUrl, jwks_uri: v.cardJwks, private_cidrs: lines(v.cardCidrs) };
    else if (x && x.card) c.card = null;
  }
  // 7.13 and 7.1.2 (R6-12): per client with `a2a`, what it may use, its partner card check (Check now) and Push off, and
  // the hand-off the admin gives the partner: the key set address and the key thumbprints to pin.
  const PARTNER_TONE = { verified: "ok", invalid: "bad", unchecked: "warn" };
  function apiPartners(o, view, admin) {
    const list = (view.clients || []).filter((x) => x.a2a);
    if (!list.length) return null;
    return section(uid("api-h"), FW["api.partners"], list.map((x) => sub([u(x.name), " ", code(x.id)], partnerPairs(x), partnerCard(o, x, admin), partnerHandoff(x))));
  }
  function partnerPairs(x) {
    const a = x.a2a;
    const card = x.card;
    return pairs([[FW["api.f-a2a-agents"], (a.agents || []).join(", ")], [FW["api.col-skills"], (a.skills || []).join(", ")],
      [FW["api.col-max-tasks"], String(a.max_open_tasks == null ? "" : a.max_open_tasks)],
      [FW["api.push-origins"], a.push ? (a.push.origins || []).join(", ") : FW["api.not-set"]],
      [FW["api.partner-card"], card ? code(card.url) : FW["api.not-set"]], [FW["api.handoff-jwks"], card ? code(card.jwks_uri) : undefined]]);
  }
  function partnerCard(o, x, admin) {
    const named = { name: x.name };
    const acts = admin && (x.card || x.a2a.push) ? el("div", { class: "wizard-actions" }, x.card ? btn(FW["api.card-check"], () => confirmDialog({
      spec: fspec("api-card-check"), vals: named, name: x.name, id: x.id,
      run: () => apiPost("settings/api/clients/card-check", { org: o.org, id: x.id }),
    })) : null, x.a2a.push ? btn(FW["api.push-off"], () => confirmDialog({
      spec: fspec("api-push-off"), vals: named, name: x.name, id: x.id, danger: true,
      run: () => apiPost("settings/api/clients/push-off", { org: o.org, id: x.id }),
    }), "danger") : null) : null;
    if (!x.card) return acts;
    const p = x.card_check || { state: "unchecked" };
    const st = p.state || "unchecked";
    const pv = p.provider || {};
    const rows = [[FW["api.col-checked"], p.checked_at ? whenSec(p.checked_at) : FW["api.partner-unchecked"]], [FW["api.col-why"], p.why ? u(p.why) : undefined],
      [FMSG.cols.name, p.name ? u(p.name) : undefined], [FW["api.col-provider"], pv.organization ? u(pv.organization + (pv.url ? " " + pv.url : "")) : undefined],
      [FW["api.col-version"], p.version ? code(p.version) : undefined], [FW["api.col-kid"], (p.kids || []).length ? p.kids.join(", ") : undefined]];
    return el("div", null, el("p", null, el("strong", null, FW["api.partner-card"]), " ", toneChip(FW["api.partner-" + st] || stateWord(st), PARTNER_TONE[st])), pairs(rows),
      (p.interfaces || []).length ? [el("p", null, el("strong", null, FW["api.partner-interfaces"])),
        el("ul", null, p.interfaces.map((i) => el("li", null, code(i.url || ""), " ", u((i.protocolBinding || "") + " " + (i.protocolVersion || "")))))] : null, acts);
  }
  function partnerHandoff(x) {
    const h = x.handoff;
    if (!h) return null;
    return el("div", null, el("p", null, el("strong", null, FW["api.handoff"])), el("p", { class: "note" }, FW["api.handoff-help"]),
      pairs([[FW["api.handoff-jwks"], h.jwks_url ? el("span", null, code(h.jwks_url), " ", copyButton(h.jwks_url)) : FW["api.not-set"]],
        [FW["api.handoff-thumbprints"], el("span", null, (h.thumbprints || []).map((t) => [code(t), " "]))]]));
  }

  // ---- Revision 6 7.14: the Agents tab (agents with their skills and signed cards, card keys, the root well-known card)
  // and its Tasks list (metadata only, never text).
  async function apiAgentsTab(o, view, admin, q) {
    const enc = encodeURIComponent;
    const filt = { agent: q.get("agent") || "", client: q.get("client") || "", state: q.get("state") || "" };
    const qs = "org=" + enc(o.org) + Object.entries(filt).filter(([, x]) => x).map(([k, x]) => "&" + k + "=" + enc(x)).join("");
    const [a, t] = await Promise.all([api("GET", "settings/api/a2a?org=" + enc(o.org), null, { direct: true }),
      api("GET", "settings/api/a2a/tasks?" + qs, null, { direct: true }).catch((e) => ({ error: e.message }))]);
    return [apiAgents(o, a, admin), apiCardKeys(o, a, admin), apiWellKnown(o, a, admin), apiTasks(o, a, view, filt, t)];
  }
  const CARD_TONE = { served: "ok", unsigned: "bad", off: "warn", "not-pinned": "warn" };
  const cardState = (g) => (g.off ? "off" : (g.card && g.card.state) || "not-pinned");
  const cardChip = (g) => toneChip(FW["api.card-" + cardState(g)] || stateWord(cardState(g)), CARD_TONE[cardState(g)]);
  function apiAgents(o, a, admin) {
    const conns = a.connectors || {};
    const hubName = Object.fromEntries((a.hubs || []).map((h) => [h.id, h.name]));
    const add = admin ? btn(FW["api.agent-add"], () => agentDialog(o, a, null), "primary") : null;
    return section(uid("api-h"), FW["api.agents"], el("p", { class: "note" }, FW["api.agents-help"]),
      pairs([[FW["api.agents-url"], a.agents_url ? code(a.agents_url) : FW["api.not-set"]], [FW["api.handoff-jwks"], a.jwks_url ? code(a.jwks_url) : FW["api.not-set"]]]),
      el("p", null, FW["api.a2a-second"]), el("ul", null, ["api.two-a2a-agent", "api.two-a2a-client", "api.two-a2a-private", "api.two-well-known"].map((k) => el("li", null, FW[k]))),
      add ? el("div", { class: "page-head" }, add) : null, dataTable({
        caption: FW["api.agents"], rows: a.agents || [], empty: MSG.noneYet, name: (g) => g.name, text: (g) => [g.name, g.id].join(" "),
        cols: [{ key: "name", label: FMSG.cols.name, cell: (g) => el("span", null, u(g.name), " ", code(g.id)) },
          { key: "version", label: FW["api.col-version"], cell: (g) => code(g.version || "") },
          { key: "connector", label: FW["api.col-connector"], cell: (g) => {
            const k = conns[g.connector] || {};
            return el("span", null, u(k.name || g.connector || ""), k.stale ? [" ", toneChip(FW["api.shown-stale"], "bad")] : null);
          } },
          { key: "hub", label: FW["api.col-hub"], cell: (g) => u(hubName[g.hub] || g.hub || "") },
          { key: "skills", label: FW["api.col-skills"], sortable: false, cell: (g) => (g.skills || []).map((s) => s.id).join(", ") },
          { key: "card", label: FW["api.col-card"], sort: cardState, cell: cardChip }],
        actions: (g) => (admin ? [{ label: FW["api.change"], run: () => agentDialog(o, a, g) }, g.off ? null : { label: FW["api.delete"], run: () => confirmDialog({
          spec: fspec("api-agent-delete"), vals: { name: g.name }, name: g.name, id: g.id, danger: true, fields: [{ kind: "reason" }],
          run: (v) => apiPost("settings/api/a2a/agents/delete", { org: o.org, id: g.id, reason: v.reason }),
        }) }] : []),
      }), (a.agents || []).map(agentCard));
  }
  // One agent: its card URL with Copy, the signing state, the signed card as served, and its skills.
  function agentCard(g) {
    const cv = g.card || {};
    return sub([u(g.name), " ", code(g.id)], pairs([[FW["api.card-url"], g.card_url ? el("span", null, code(g.card_url), " ", copyButton(g.card_url, FW["api.card-copy-url"])) : FW["api.not-set"]],
      [FMSG.cols.state, cardChip(g)], [FW["api.card-etag"], cv.etag ? code(cv.etag) : undefined]]),
      cardState(g) === "unsigned" ? banner("bad", MSG.sev.bad, FW["api.refusal-card-unsigned"]) : null,
      cv.signed_at ? el("p", null, fillText(FW["api.card-signed"], { time: whenSec(cv.signed_at), kids: (cv.kids || []).join(", "), seq: cv.map_seq == null ? "" : cv.map_seq })) : null,
      cv.card ? [el("p", null, el("strong", null, FW["api.card-preview"])), el("pre", null, el("code", null, cleanLines(JSON.stringify(cv.card, null, 2))))] : null,
      dataTable({
        caption: FW["api.col-skills"] + ": " + g.name, rows: g.skills || [], empty: MSG.noneYet, name: (s) => s.id,
        cols: [{ key: "id", label: W["dialog.id"], cell: (s) => code(s.id) }, { key: "name", label: FMSG.cols.name, cell: (s) => u(s.name) },
          { key: "targets", label: FW["api.col-targets"], sortable: false, cell: (s) => (s.targets || []).join(", ") },
          { key: "model", label: FW["api.col-model"], cell: (s) => (s.model ? code(s.model) : "") }, { key: "turns", label: FW["api.col-turns"], cell: (s) => u(s.turns || "") },
          { key: "approve_within_s", label: FW["api.col-approve-within"], cell: (s) => String(s.approve_within_s == null ? "" : s.approve_within_s) },
          { key: "dropped", label: FMSG.cols.state, cell: (s) => (s.dropped ? toneChip(FW["api.skill-dropped"], "bad") : toneChip(FW["api.shown-active"], "ok")) }],
      }));
  }
  // The skills editor: a JSON list of 2.2 skills, checked here before the console checks it again.
  const SKILL_KEYS = ["id", "name", "description", "tags", "examples", "targets", "model", "turns", "approve_within_s", "idle_close_s"];
  const skillOf = (s) => Object.fromEntries(SKILL_KEYS.filter((k) => s[k] != null).map((k) => [k, s[k]]));
  const textIn = (t, lo, hi) => typeof t === "string" && t.length >= lo && t.length <= hi;
  function skillsOk(list) {
    return Array.isArray(list) && list.length >= 1 && list.length <= 16 && new Set(list.map((s) => s && s.id)).size === list.length && list.every((s) => s && typeof s === "object"
      && /^[a-z0-9-]{1,64}$/.test(s.id) && textIn(s.name, 1, 64) && textIn(s.description, 1, 1024)
      && Array.isArray(s.tags) && s.tags.length >= 1 && s.tags.length <= 8 && s.tags.every((t) => textIn(t, 1, 32))
      && (s.examples == null || (Array.isArray(s.examples) && s.examples.length <= 4 && s.examples.every((t) => textIn(t, 1, 256))))
      && Array.isArray(s.targets) && s.targets.length >= 1 && s.targets.length <= 64 && (s.turns === "one" || s.turns === "many")
      && Number.isInteger(s.approve_within_s) && s.approve_within_s >= 300 && s.approve_within_s <= 86400);
  }
  // 7.1.3: what the generated card shows of an agent; a change to it needs a new version (card-version).
  const cardFace = (g) => JSON.stringify([g.name, g.description, g.provider || null, g.documentation_url || null, !!g.streaming, !!g.push,
    (g.skills || []).map((s) => [s.id, s.name, s.description, s.tags || [], s.examples || []])]);
  // Add agent or Change: the console draws the a_ id. A change widens (two-person) when it adds a skill or a spoke, or
  // allows a longer approval wait; a removed skill journals agent_drop_skill at once.
  function agentDialog(o, a, g) {
    const conns = Object.entries(a.connectors || {}).map(([id, k]) => [id, (k.name || id) + " (" + id + ")"]);
    const hubs = (a.hubs || []).map((h) => [h.id, h.name + " (" + h.id + ")"]);
    const p = (g && g.provider) || {};
    const skills = g ? (g.skills || []).filter((s) => !s.dropped).map(skillOf) : [];
    const was = Object.fromEntries(skills.map((s) => [s.id, s]));
    const read = (v) => {
      const agent = { name: v.name, description: v.description, version: v.version, connector: v.connector, hub: v.hub };
      if (v.providerOrg) agent.provider = { organization: v.providerOrg, url: v.providerUrl };
      else if (g && g.provider) agent.provider = null;
      if (v.docUrl) agent.documentation_url = v.docUrl;
      else if (g && g.documentation_url) agent.documentation_url = null;
      agent.streaming = v.streaming === "yes";
      agent.push = v.push === "yes";
      agent.skills = jsonList(v.skills);
      return agent;
    };
    const widens = (v) => !g || (jsonList(v.skills) || []).some((s) => !s || !was[s.id] || (s.targets || []).some((t) => !(was[s.id].targets || []).includes(t))
      || Number(s.approve_within_s) > Number(was[s.id].approve_within_s));
    confirmDialog({
      spec: fspec(g ? "api-agent-update" : "api-agent"), vals: { name: g ? g.name : "" }, vals2: g ? null : (v) => ({ name: v.name }),
      name: g ? g.name : o.org, id: g ? g.id : o.org, two: widens,
      fields: [{ key: "name", label: FW["api.f-agent-name"], value: g ? g.name : "", maxlength: "64" },
        { kind: "textarea", key: "description", label: FW["api.f-description"], value: g ? g.description : "" },
        { key: "version", label: FW["api.f-version"], value: g ? g.version : "1.0.0", maxlength: "32" },
        { kind: "select", key: "connector", label: FW["api.f-connector"], options: conns, value: g ? g.connector : (conns[0] || [])[0] },
        { kind: "select", key: "hub", label: FW["api.f-hub"], options: hubs, value: g ? g.hub : (hubs[0] || [])[0] },
        { key: "providerOrg", label: FW["api.f-provider-org"], value: p.organization || "", maxlength: "64" },
        { key: "providerUrl", label: FW["api.f-provider-url"], value: p.url || "", maxlength: "512" },
        { key: "docUrl", label: FW["api.f-doc-url"], value: (g && g.documentation_url) || "", maxlength: "512" },
        { kind: "select", key: "streaming", label: FW["api.f-streaming"], options: yesNoOptions(), value: g && g.streaming ? "yes" : "no" },
        { kind: "select", key: "push", label: FW["api.f-push"], options: yesNoOptions(), value: g && g.push ? "yes" : "no" },
        { kind: "textarea", key: "skills", label: FW["api.f-skills"], value: JSON.stringify(skills, null, 2), note: FW["api.f-skills-note"] }],
      check: (v) => {
        if (!(textIn(v.name, 1, 64) && textIn(v.description, 1, 1024) && /^[0-9A-Za-z.+-]{1,32}$/.test(v.version) && v.connector && v.hub
          && (!v.providerOrg || (v.providerOrg.length <= 64 && httpsOk(v.providerUrl))) && (!v.providerUrl || !!v.providerOrg) && (!v.docUrl || httpsOk(v.docUrl)))) return FW["api.check-agent"];
        if (!skillsOk(jsonList(v.skills))) return FW["api.check-skills"];
        return g && v.version === g.version && cardFace(read(v)) !== cardFace(Object.assign({}, g, { skills })) ? FW["api.refusal-card-version"] : "";
      },
      run: (v) => (g ? apiStep("settings/api/a2a/agents/update", { org: o.org, id: g.id, agent: read(v) }, "api.a2a.agent.update")
        : apiStep("settings/api/a2a/agents", { org: o.org, agent: read(v) }, "api.a2a.agent.stage")),
    });
  }
  // 7.1.2: the card keys (signed map and staged ones): Make a card key is step-up only; Drop key journals at once.
  const KEY_TONE = { active: "ok", pending: "warn", expired: "bad", dropped: "bad" };
  function cardKeys(caption, list, org, admin) {
    return dataTable({
      caption, rows: list, empty: MSG.noneYet, name: (k) => k.kid,
      cols: [{ key: "kid", label: W["dialog.id"], cell: (k) => code(k.kid) }, { key: "nbf", label: FW["exports.col-valid-from"], cell: (k) => whenSec(k.nbf) },
        { key: "exp", label: FMSG.cols.ends, cell: (k) => whenSec(k.exp) },
        { key: "state", label: FMSG.cols.state, cell: (k) => toneChip(FW["api.key-" + k.state] || stateWord(k.state), KEY_TONE[k.state]) },
        { key: "sealed", label: FW["api.col-sealed"], cell: (k) => yesNo(k.sealed) }, { key: "thumbprint", label: FW["api.col-thumbprint"], sortable: false, cell: (k) => code(k.thumbprint || "") }],
      actions: (k) => (admin && k.state !== "dropped" && k.state !== "expired" ? [{ label: FW["api.card-key-drop"], run: () => confirmDialog({
        spec: fspec("api-a2a-key-drop"), vals: { kid: k.kid }, name: org, id: k.kid, danger: true,
        run: () => apiPost("settings/api/a2a/keys/drop", { org, kid: k.kid }),
      }) }] : []),
    });
  }
  function apiCardKeys(o, a, admin) {
    const org = o.org;
    const add = admin ? btn(FW["api.card-key-new"], () => confirmDialog({
      spec: fspec("api-a2a-key"), vals: { org }, name: org, id: org,
      run: () => apiStep("settings/api/a2a/keys", { org }, "api.a2a.key"),
    }), "primary") : null;
    const staged = a.draft ? (a.draft.keys || []).filter((k) => !(a.keys || []).some((m) => m.kid === k.kid)) : [];
    return section(uid("api-h"), FW["api.card-keys"], el("p", { class: "note" }, FW["api.card-keys-help"]), add ? el("div", { class: "page-head" }, add) : null,
      cardKeys(FW["api.card-keys"], a.keys || [], org, admin), staged.length ? [el("p", null, el("strong", null, FW["api.draft-keys"])), cardKeys(FW["api.draft-keys"], staged, org, admin)] : null);
  }
  // 7.1.5: the agent this console publishes at its root well-known address (one per console, two-person).
  function apiWellKnown(o, a, admin) {
    const org = o.org;
    const names = Object.fromEntries((a.agents || []).map((g) => [g.id, g.name]));
    const opts = [["", FW["api.well-known-none"]]].concat((a.agents || []).filter((g) => !g.off).map((g) => [g.id, g.name + " (" + g.id + ")"]));
    const set = admin ? btn(FW["api.well-known-set"], () => confirmDialog({
      spec: fspec("api-well-known"), vals: { org }, name: org, id: org, two: (v) => !!v.agent,
      fields: [{ kind: "select", key: "agent", label: FW["api.f-well-known"], options: opts, value: a.well_known || "" }],
      run: (v) => apiStep("settings/api/a2a/well-known", { org, agent: v.agent || null }, "api.a2a.well-known"),
    })) : null;
    return section(uid("api-h"), FW["api.well-known"], a.well_known_url ? el("p", { class: "note" }, fill(FW["api.well-known-help"], { url: code(a.well_known_url) })) : null,
      pairs([[FW["api.f-well-known"], a.well_known ? el("span", null, u(names[a.well_known] || a.well_known), " ", code(a.well_known)) : FW["api.well-known-none"]]]),
      set ? el("div", { class: "wizard-actions" }, set) : null);
  }
  const TASK_STATES = ["submitted", "working", "input_required", "auth_required", "completed", "canceled", "failed", "rejected"];
  function apiTasks(o, a, view, filt, t) {
    const enc = encodeURIComponent;
    const go = (k, val) => {
      const f = Object.assign({}, filt, { [k]: val });
      location.hash = "#/security/api?org=" + enc(o.org) + "&tab=agents" + Object.entries(f).filter(([, x]) => x).map(([n, x]) => "&" + n + "=" + enc(x)).join("");
    };
    const pick = (k, label, options) => {
      const id = uid("flt");
      const s = el("select", { id, "data-filter": k }, [["", FW["api.filter-all"]]].concat(options).map(([v, w]) => el("option", { value: v }, clean(w))));
      s.value = filt[k];
      s.addEventListener("change", () => go(k, s.value));
      return el("div", { class: "field" }, el("label", { for: id }, label), s);
    };
    const agentName = Object.fromEntries((a.agents || []).map((g) => [g.id, g.name]));
    return section(uid("api-h"), FW["api.tasks"], el("p", { class: "note" }, FW["api.tasks-help"]),
      el("div", { class: "wizard-actions" }, pick("agent", FW["api.col-agent"], (a.agents || []).map((g) => [g.id, g.name])),
        pick("client", FW["api.f-client"], (view.clients || []).filter((x) => x.a2a).map((x) => [x.id, x.name])), pick("state", FMSG.cols.state, TASK_STATES.map((s) => [s, stateWord(s)]))),
      t.error ? emptyLine(u(t.error)) : dataTable({
        caption: FW["api.tasks"], rows: t.tasks || [], empty: MSG.noneYet, name: (r) => r.task, sortKey: "updated", sortDir: -1,
        text: (r) => [r.task, r.client_name, r.agent, r.skill, r.spoke].join(" "),
        cols: [{ key: "task", label: FW["api.col-task"], cell: (r) => code(r.task) }, { key: "client_name", label: FW["api.f-client"], cell: (r) => u(r.client_name || r.client || "") },
          { key: "agent", label: FW["api.col-agent"], cell: (r) => u(agentName[r.agent] || r.agent || "") }, { key: "skill", label: FW["api.col-skill"], cell: (r) => code(r.skill || "") },
          { key: "spoke", label: FW["api.col-spoke"], cell: (r) => (r.spoke ? code(r.spoke) : "") }, { key: "state", label: FMSG.cols.state, cell: (r) => u(stateWord(r.state)) },
          { key: "created", label: FW["api.col-created"], cell: (r) => whenSec(r.created) }, { key: "updated", label: FW["api.col-updated"], cell: (r) => whenSec(r.updated) },
          { key: "bytes_in", label: FW["api.col-bytes-in"], cell: (r) => String(r.bytes_in || 0) }, { key: "bytes_out", label: FW["api.col-bytes-out"], cell: (r) => String(r.bytes_out || 0) }],
      }));
  }

  // ---- Revision 6 7.14 and 5.1: the Remote Spokes tab: the console's root and the map's, Set root, the org's spokes
  // relays with Bind and Unbind (two-person to bind), the relays that can be bound, and the service hubs.
  async function apiSpokesTab(o, admin) {
    const org = o.org;
    const s = await api("GET", "settings/api/spokes?org=" + encodeURIComponent(org), null, { direct: true });
    const bind = (r, on) => confirmDialog({
      spec: fspec(on ? "api-spokes-bind" : "api-spokes-unbind"), vals: { relay: r.name || r.id, org }, name: r.name || r.id, id: r.id, two: on, danger: !on,
      run: () => apiStep("settings/api/spokes/" + (on ? "bind" : "unbind"), { org, relay: r.id }, on ? "api.spokes.bind" : "api.spokes.unbind"),
    });
    const rootLine = (x) => (x ? el("span", null, code(x.root), " ", code(x.root_spki)) : FW["api.root-none"]);
    const yn = (b) => toneChip(yesNo(b), b ? "ok" : "none");
    const relayCell = (r) => el("span", null, u(r.name || r.id), " ", code(r.id));
    const setRoot = admin && s.console_root ? btn(FW["api.root-set"], () => confirmDialog({
      spec: fspec("api-spokes-root"), vals: { org, root: s.console_root.id }, name: org, id: s.console_root.id,
      run: () => apiStep("settings/api/spokes/root", { org }, "api.spokes.root"),
    }), "primary") : null;
    const credText = (h) => (h.credentials || []).map((k) => [FW["api.col-node"] + " " + k.node, FW["api.col-serial"] + " " + k.serial, daySec(k.expires),
      FW["api.key-store-" + String(k.key_store || "").replace(/_/g, "-")] || k.key_store].join(", ")).join("; ");
    return [section(uid("api-h"), FW["api.spokes"], el("p", { class: "note" }, FW["api.spokes-help"]),
      pairs([[FW["api.console-root"], s.console_root ? code(s.console_root.id) : FW["api.root-none"]], [FW["api.map-root"], rootLine(s.map_root)],
        [FW["api.draft-root"], s.draft_root ? rootLine(s.draft_root) : undefined]]), setRoot ? el("div", { class: "wizard-actions" }, setRoot) : null),
    section(uid("api-h"), FW["api.bound-relays"], dataTable({
      caption: FW["api.bound-relays"], rows: s.relays || [], empty: MSG.noneYet, name: (r) => r.name || r.id,
      cols: [{ key: "name", label: FMSG.cols.relay, cell: relayCell }, { key: "connected", label: FW["api.col-connected"], cell: (r) => yn(r.connected) },
        { key: "bound", label: FW["api.col-bound"], cell: (r) => yn(r.bound) }, { key: "listed", label: FW["api.col-listed"], cell: (r) => yn(r.listed) },
        { key: "staged", label: FW["api.col-staged"], cell: (r) => yn(r.staged) }, { key: "outdated", label: FMSG.cols.state, cell: (r) => (r.outdated ? toneChip(FW["api.needs-update"], "bad") : "") }],
      actions: (r) => (admin ? [r.bound ? { label: FW["api.unbind"], run: () => bind(r, false) } : { label: FW["api.bind"], run: () => bind(r, true) }] : []),
    })),
    section(uid("api-h"), FW["api.candidates"], dataTable({
      caption: FW["api.candidates"], rows: s.candidates || [], empty: MSG.noneYet, name: (r) => r.name || r.id,
      cols: [{ key: "name", label: FMSG.cols.relay, cell: relayCell }],
      actions: (r) => (admin ? [{ label: FW["api.bind"], run: () => bind(r, true) }] : []),
    })),
    section(uid("api-h"), FW["api.hubs"], dataTable({
      caption: FW["api.hubs"], rows: s.hubs || [], empty: MSG.noneYet, name: (h) => h.name, text: (h) => [h.name, h.id, h.principal].join(" "),
      cols: [{ key: "name", label: FMSG.cols.name, cell: (h) => el("span", null, u(h.name), " ", code(h.id)) }, { key: "principal", label: FW["api.col-principal"], cell: (h) => u(h.principal || "") },
        { key: "state", label: FMSG.cols.state, cell: (h) => toneChip(FW["api.shown-" + h.state] || stateWord(h.state), SHOWN_TONE[h.state]) },
        { key: "ceiling", label: FW["api.col-ceiling"], cell: (h) => ceilingWord(h.ceiling) },
        { key: "targets", label: FW["api.col-targets"], sortable: false, cell: (h) => ((h.targets || []).includes("*") ? FW["api.targets-all"] : (h.targets || []).join(", ")) },
        { key: "relays", label: FMSG.cols.count, sortable: false, cell: (h) => relaysText(h.relays) },
        { key: "credentials", label: FW["api.col-credentials"], sortable: false, cell: credText },
        { key: "agent", label: FW["api.col-agent"], cell: (h) => (h.agent ? code(h.agent) : "") }],
    }))];
  }
  const enterpriseOnly = (o, list) => !!o.edition && o.edition !== "enterprise" && !list.length;
  // 14.1: each delegated client's people (GET settings/api/delegations) and each content client's approvals (GET
  // settings/api/approvals, metadata only); a failed read shows its words in place of the list.
  async function apiPeopleOf(o, view) {
    const ask = (path, id) => api("GET", path + "?org=" + encodeURIComponent(o.org) + "&client=" + encodeURIComponent(id), null, { direct: true }).catch((e) => ({ error: e.message }));
    const out = {};
    await Promise.all((view.clients || []).filter((x) => CONTENT_KINDS.includes(x.kind)).map(async (x) => {
      const [people, approvals] = await Promise.all([x.kind === "agent_delegated" ? ask("settings/api/delegations", x.id) : null,
        (x.connectors || []).length ? ask("settings/api/approvals", x.id) : null]);
      out[x.id] = { people, approvals };
    }));
    return out;
  }
  // Per content or delegated client: what it reaches, its delegation, its people (Revoke) and its approvals.
  function apiContent(o, view, admin, people) {
    const list = (view.clients || []).filter((x) => CONTENT_KINDS.includes(x.kind));
    if (!list.length) return null;
    const connName = Object.fromEntries((view.connectors || []).map((k) => [k.id, k.name]));
    return section(uid("api-h"), FW["api.content"], list.map((x) => sub([u(x.name), " ", code(x.id)], contentPairs(x, connName), clientPeople(o, x, admin, people[x.id] || {}))));
  }
  function contentPairs(x, connName) {
    const rows = [[FMSG.cols.kind, kindWord(x.kind)]];
    if ((x.connectors || []).length) {
      const ch = x.channels || [];
      rows.push([FW["api.col-connectors"], x.connectors.map((id) => connName[id] || id).join(", ")], [FW["api.col-apps"], (x.apps || []).join(", ")],
        [FW["api.f-channels"], ch.includes("*") ? FW["api.channels-all"] : ch.join(", ")], [FW["api.f-confirm"], yesNo((x.confirm || []).includes("content.post"))]);
    }
    const dg = x.delegation;
    const dgRows = dg ? [[FW["api.dlg-groups"], (dg.groups || []).join(", ")], [FW["api.dlg-people"], (dg.principals || []).join(", ")],
      [FW["api.dlg-denied"], (dg.denied || []).join(", ")], [FW["api.dlg-idps"], (dg.idps || []).join(", ")],
      [FW["api.dlg-consent"], String(dg.consent_days == null ? "" : dg.consent_days)], [FW["api.redirects"], (x.redirect_uris || []).join(", ")],
      [FW["api.loopback"], yesNo(x.loopback_ok)]] : [];
    const cimd = cimdOf(x);
    if (cimd) (dg ? dgRows : rows).push([FW["api.cimd"], code(cimd.hint || cimd.url || "")]);
    return el("div", null, pairs(rows), dg ? [el("p", null, el("strong", null, FW["api.delegation"])), pairs(dgRows)] : null,
      x.loopback_ok ? el("p", { class: "note" }, FW["api.loopback-warn"]) : null);
  }
  function clientPeople(o, x, admin, got) {
    const kids = [];
    const failed = (r) => (r && r.error ? emptyLine(u(r.error)) : null);
    if (got.people) {
      kids.push(el("p", null, el("strong", null, FW["api.people"])), el("p", { class: "note" }, FW["api.people-help"]), failed(got.people) || dataTable({
        caption: FW["api.people"] + ": " + x.name, rows: got.people.people || [], empty: MSG.noneYet, name: (p) => p.principal, text: (p) => [p.principal, p.grant].join(" "),
        cols: [{ key: "principal", label: FW["api.col-person"], cell: (p) => u(p.principal) }, { key: "grant", label: FW["api.col-grant"], cell: (p) => code(p.grant) },
          { key: "first_use", label: FW["api.col-first-use"], cell: (p) => whenSec(p.first_use) }, { key: "last_use", label: FW["api.col-last-use"], cell: (p) => whenSec(p.last_use) },
          { key: "ends", label: FMSG.cols.ends, cell: (p) => (p.ends ? whenSec(p.ends) : "") },
          { key: "revoked", label: FMSG.cols.state, cell: (p) => (p.revoked ? toneChip(FW["api.revoked"], "bad") : toneChip(FW["api.shown-active"], "ok")) }],
        actions: (p) => (admin && !p.revoked ? [{ label: FW["api.revoke"], run: () => confirmDialog({
          spec: fspec("api-delegation-revoke"), vals: { principal: p.principal, name: x.name }, name: p.principal, id: x.id, danger: true,
          run: () => apiStep("settings/api/delegations/revoke", { org: o.org, client: x.id, principal: p.principal }, "api.delegation.revoke"),
        }) }] : []),
      }));
    }
    if (got.approvals) {
      kids.push(el("p", null, el("strong", null, FW["api.approvals"])), el("p", { class: "note" }, FW["api.approvals-help"]), failed(got.approvals) || dataTable({
        caption: FW["api.approvals"] + ": " + x.name, rows: got.approvals.approvals || [], empty: MSG.noneYet, name: (a) => a.approval, sortKey: "ts", sortDir: -1,
        cols: [{ key: "ts", label: FW["api.col-when"], cell: (a) => whenSec(a.ts) }, { key: "approval", label: FW["api.col-approval"], cell: (a) => code(a.approval) },
          { key: "action", label: FMSG.change, cell: (a) => code(a.action) }, { key: "result", label: FW["api.col-result"], cell: (a) => u(a.result || "") },
          { key: "app", label: FW["api.col-app"], cell: (a) => u(a.app || "") }, { key: "connector", label: FW["api.col-connectors"], cell: (a) => code(a.connector) }],
      }));
    }
    return kids.length ? el("div", null, kids) : null;
  }
  // The org's active person_revoke entries (4.2): Allow again stages the clearing, a two-person save (O18).
  function apiRevokes(o, view, admin) {
    const list = o.person_revokes || [];
    if (!list.length) return null;
    const names = Object.fromEntries((view.clients || []).map((x) => [x.id, x.name]));
    const clientWord = (c) => (c === "*" ? FW["api.all-clients"] : names[c] || c);
    return section(uid("api-h"), FW["api.revokes"], el("p", { class: "note" }, FW["api.revokes-help"]), dataTable({
      caption: FW["api.revokes"], rows: list, empty: MSG.noneYet, name: (r) => r.principal, text: (r) => [r.principal, r.client, r.id].join(" "),
      cols: [{ key: "principal", label: FW["api.col-person"], cell: (r) => u(r.principal) }, { key: "client", label: FW["api.f-client"], cell: (r) => u(clientWord(r.client)) },
        { key: "ts", label: FW["api.col-when"], cell: (r) => whenSec(r.ts) }, { key: "id", label: W["dialog.id"], cell: (r) => code(r.id) }],
      actions: (r) => (admin ? [{ label: FW["api.allow"], run: () => confirmDialog({
        spec: fspec("api-delegation-allow"), vals: { principal: r.principal, name: clientWord(r.client) }, name: r.principal, id: r.id, two: true,
        run: () => apiStep("settings/api/delegations/allow", { org: o.org, client: r.client, principal: r.principal }, "api.delegation.allow"),
      }) }, r.client === "*" ? null : { label: FW["api.revoke-all"], run: () => confirmDialog({
        spec: fspec("api-delegation-revoke-all"), vals: { principal: r.principal }, name: r.principal, id: r.id, danger: true,
        run: () => apiStep("settings/api/delegations/revoke", { org: o.org, client: "*", principal: r.principal }, "api.delegation.revoke"),
      }) }] : []),
    }));
  }

  // Connectors (3.1, 14.2): each with its apps, conversations, sync age, state (stale and never synced from the
  // connector's last ack) and key store. Suspend and Delete journal at once; adding and widening are two-person.
  const CONN_TONE = { active: "ok", suspended: "warn", stale: "bad", "never-synced": "warn" };
  function connShown(k, st) {
    if (k.shown_state) return k.shown_state;
    if (k.state === "suspended") return "suspended";
    if (st.stale) return st.sync_age_s == null ? "never-synced" : "stale";
    return "active";
  }
  function apiConnectors(o, view, admin) {
    const list = view.connectors || [];
    if (enterpriseOnly(o, list)) return null;
    const status = o.connector_status || {};
    const apps = o.api_apps || [];
    const appName = Object.fromEntries(apps.map((a) => [a.principal, a.name]));
    const add = admin && apps.length ? btn(FW["api.conn-add"], () => connectorDialog(o, null), "primary") : null;
    return section(uid("api-h"), FW["api.connectors"], el("p", { class: "note" }, FW["api.connectors-help"]), add ? el("div", { class: "page-head" }, add) : null,
      admin && !apps.length ? emptyLine(FW["api.conn-no-apps"]) : null, dataTable({
        caption: FW["api.connectors"], rows: list, empty: MSG.noneYet, name: (k) => k.name, text: (k) => [k.name, k.id, k.origin].join(" "),
        cols: [{ key: "name", label: FMSG.cols.name, cell: (k) => el("span", null, u(k.name), " ", code(k.id)) },
          { key: "origin", label: FW["api.col-origin"], cell: (k) => code(k.origin), sortable: false },
          { key: "apps", label: FW["api.col-apps"], cell: (k) => (k.apps || []).map((p) => appName[p] || p).join(", "), sortable: false },
          { key: "conversations", label: FW["api.col-conversations"], sort: (k) => (status[k.id] || {}).conversations,
            cell: (k) => ((status[k.id] || {}).conversations == null ? FW["api.not-reported"] : String(status[k.id].conversations)) },
          { key: "sync_age_s", label: FW["api.col-sync-age"], sort: (k) => (status[k.id] || {}).sync_age_s,
            cell: (k) => ((status[k.id] || {}).sync_age_s == null ? FW["api.shown-never-synced"] : fillText(FW["api.sync-age"], { n: status[k.id].sync_age_s })) },
          { key: "shown_state", label: FMSG.cols.state, cell: (k) => {
            const s = connShown(k, status[k.id] || {});
            return toneChip(FW["api.shown-" + s] || stateWord(s), CONN_TONE[s]);
          } },
          { key: "seal", label: FW["api.col-key-store"], sortable: false, cell: (k) => ((status[k.id] || {}).seal ? code(status[k.id].seal) : FW["api.not-reported"]) }],
        actions: (k) => (admin ? connectorActions(o, k) : []),
      }));
  }
  function connectorActions(o, k) {
    const named = { name: k.name };
    const org = o.org;
    return [{ label: FW["api.change"], run: () => connectorDialog(o, k) }, k.state === "suspended" ? { label: FW["api.resume"], run: () => confirmDialog({
      spec: fspec("api-connector-resume"), vals: named, name: k.name, id: k.id, two: true,
      run: () => apiStep("settings/api/connectors/resume", { org, id: k.id }, "api.connector.resume"),
    }) } : { label: FW["api.suspend"], run: () => confirmDialog({
      spec: fspec("api-connector-suspend"), vals: named, name: k.name, id: k.id, danger: true, fields: [{ kind: "reason" }],
      run: (v) => apiStep("settings/api/connectors/suspend", { org, id: k.id, reason: v.reason }, "api.connector.suspend"),
    }) }, { label: FW["api.delete"], run: () => confirmDialog({
      spec: fspec("api-connector-delete"), vals: named, name: k.name, id: k.id, danger: true, fields: [{ kind: "reason" }],
      run: (v) => apiStep("settings/api/connectors/delete", { org, id: k.id, reason: v.reason }, "api.connector.delete"),
    }) }];
  }
  // Add connector (name, origin, apps, networks, stale seconds) or Change (apps, networks, stale seconds); the console
  // draws the k_ id. A change widens (two-person) when it adds an app, a network, empties the networks or waits longer.
  function connectorDialog(o, k) {
    const opts = (o.api_apps || []).map((a) => [a.principal, a.name + " (" + a.principal + ")"]);
    for (const p of (k && k.apps) || []) if (!opts.some((x) => x[0] === p)) opts.push([p, p]);
    const was = (k && k.networks) || [];
    const widens = (v) => {
      const nets = commaList(v.networks);
      return !k || v.apps.some((p) => !(k.apps || []).includes(p)) || Number(v.stale) > k.stale_s || nets.some((n) => !was.includes(n)) || (!nets.length && was.length > 0);
    };
    confirmDialog({
      spec: fspec(k ? "api-connector-update" : "api-connector"), vals: { name: k ? k.name : "" }, vals2: k ? null : (v) => ({ name: v.name }),
      name: k ? k.name : o.org, id: k ? k.id : o.org, two: widens,
      fields: (k ? [] : [{ key: "name", label: FW["api.f-name"], maxlength: "32", required: true }, { key: "origin", label: FW["api.f-conn-origin"], maxlength: "256" }]).concat([
        { kind: "checks", key: "apps", label: FW["api.f-conn-apps"], options: opts, value: k ? k.apps || [] : [] },
        { key: "networks", label: FW["api.f-networks"], value: was.join(", ") },
        { key: "stale", label: FW["api.f-conn-stale"], value: k ? k.stale_s : 60, inputmode: "numeric" }]),
      check: (v) => ((!k && (!/^[a-z0-9-]{1,32}$/.test(v.name) || !/^https:\/\/[^\s/?#@]+:[0-9]{1,5}$/.test(v.origin))) || v.apps.length < 1 || v.apps.length > 16
        || !wholeIn(v.stale, 30, 300) ? FW["api.check-conn"] : ""),
      run: (v) => {
        const connector = { apps: v.apps, networks: commaList(v.networks), stale_s: Number(v.stale) };
        return k ? apiStep("settings/api/connectors/update", { org: o.org, id: k.id, connector }, "api.connector.update")
          : apiStep("settings/api/connectors", { org: o.org, connector: Object.assign({ name: v.name, origin: v.origin }, connector) }, "api.connector.stage");
      },
    });
  }

  // Identity providers for EMA (3.1, 6.4): Test fetches discovery and keys (nothing stored but the time and the key
  // count); Suspend journals at once; adding, Resume and a private address are two-person.
  const IDP = { tested: null };
  function apiIdps(o, view, admin) {
    const list = view.idps || [];
    if (enterpriseOnly(o, list)) return null;
    const t = IDP.tested && IDP.tested.org === o.org ? IDP.tested : null;
    return section(uid("api-h"), FW["api.idps"], el("p", { class: "note" }, FW["api.idps-help"]), dataTable({
      caption: FW["api.idps"], rows: list, empty: MSG.noneYet, name: (i) => i.id, text: (i) => [i.id, i.provider, i.issuer].join(" "),
      cols: [{ key: "id", label: FMSG.cols.name, cell: (i) => u(i.id) }, { key: "provider", label: FW["api.col-provider"], cell: (i) => u(i.provider) },
        { key: "issuer", label: FW["api.col-issuer"], cell: (i) => code(i.issuer), sortable: false }, { key: "algs", label: FW["api.col-algs"], cell: (i) => (i.algs || []).join(", "), sortable: false },
        { key: "tenant", label: FW["api.dir-tenant"], cell: (i) => (i.tenant ? code(i.tenant) : "") }, { key: "max_age_s", label: FW["api.col-max-age"] },
        { key: "auth_max_s", label: FW["api.col-auth-max"], cell: (i) => String(i.auth_max_s || 43200) }, { key: "private_ok", label: FW["api.col-private"], cell: (i) => yesNo(i.private_ok) },
        { key: "shown_state", label: FMSG.cols.state, cell: (i) => {
          const s = i.shown_state || i.state;
          return toneChip(FW["api.shown-" + s] || stateWord(s), SHOWN_TONE[s]);
        } },
        { key: "last_test", label: FW["api.col-last-test"], cell: (i) => whenSec(i.last_test) }, { key: "keys", label: FW["api.col-keys"], cell: (i) => (i.keys == null ? "" : String(i.keys)) }],
      actions: (i) => (admin ? idpActions(o, i) : []),
    }), t ? idpTested(t) : null);
  }
  function idpActions(o, i) {
    const named = { name: i.id };
    const org = o.org;
    return [{ label: FW["api.idp-test"], run: () => confirmDialog({
      spec: fspec("api-idp-test"), vals: named, name: i.id, id: i.id,
      run: () => apiStep("settings/api/idps/test", { org, id: i.id }, "api.idp.test"),
      plain: true,
      done: (r) => {
        IDP.tested = { org, id: i.id, r: r || {} };
        render({ keepMessages: true });
      },
    }) }, { label: FW["api.change"], run: () => idpChange(o, i) }, i.state === "suspended" ? { label: FW["api.resume"], run: () => confirmDialog({
      spec: fspec("api-idp-resume"), vals: named, name: i.id, id: i.id, two: true,
      run: () => apiStep("settings/api/idps/resume", { org, id: i.id }, "api.idp.resume"),
    }) } : { label: FW["api.suspend"], run: () => confirmDialog({
      spec: fspec("api-idp-suspend"), vals: named, name: i.id, id: i.id, danger: true, fields: [{ kind: "reason" }],
      run: (v) => apiStep("settings/api/idps/suspend", { org, id: i.id, reason: v.reason }, "api.idp.suspend"),
    }) }];
  }
  // Change an identity provider (idps/update): a narrowing journals idp_limit at once; widening (an algorithm added, a
  // longer age, the tenant removed or changed, private addresses on) is two-person (13.2).
  function idpChange(o, i) {
    const algs = i.algs || [];
    const auth = i.auth_max_s || 43200;
    const widens = (v) => v.algs.some((a) => !algs.includes(a)) || Number(v.maxAge) > i.max_age_s || Number(v.authMax) > auth
      || (!!i.tenant && v.tenant !== i.tenant) || (v.private === "yes" && !i.private_ok);
    confirmDialog({
      spec: fspec("api-idp-update"), vals: { name: i.id }, name: i.id, id: i.id, two: widens, params: [[FW["api.col-issuer"], i.issuer]],
      fields: [{ kind: "checks", key: "algs", label: FW["api.f-algs"], options: IDP_ALGS.map((a) => [a, a]), value: algs },
        { key: "tenant", label: FW["api.f-tenant"], value: i.tenant || "", maxlength: "128" },
        { key: "maxAge", label: FW["api.f-max-age"], value: i.max_age_s, inputmode: "numeric" },
        { key: "authMax", label: FW["api.f-auth-max"], value: auth, inputmode: "numeric" },
        { kind: "select", key: "private", label: FW["exports.f-private"], options: yesNoOptions(), value: i.private_ok ? "yes" : "no" }],
      check: (v) => (v.algs.length && wholeIn(v.maxAge, 60, 600) && wholeIn(v.authMax, 300, 86400) ? "" : FW["api.check-idp-change"]),
      run: (v) => apiStep("settings/api/idps/update", { org: o.org, id: i.id, idp: { algs: v.algs, tenant: v.tenant || null, max_age_s: Number(v.maxAge),
        auth_max_s: Number(v.authMax), private_ok: v.private === "yes" } }, "api.idp.update"),
    });
  }
  // What a test found: the issuer, the key set address and each key's id, algorithm and type.
  function idpTested(t) {
    const r = t.r;
    return sub(FW["api.idp-tested"] + ": " + t.id, pairs([[FW["api.col-issuer"], code(r.issuer || "")], [FW["api.idp-jwks"], code(r.jwks_uri || "")]]), dataTable({
      caption: FW["api.col-keys"], rows: r.keys || [], empty: MSG.noneYet, name: (k) => k.kid || "",
      cols: [{ key: "kid", label: FW["api.col-kid"], cell: (k) => code(k.kid || "") }, { key: "alg", label: FW["api.col-alg"], cell: (k) => u(k.alg || "") },
        { key: "kty", label: FW["api.col-kty"], cell: (k) => u(k.kty || "") }],
    }));
  }
  // 3.2 (R5-9): the issuer is prefilled from the registry entry's iss where it matches: for Okta its org authorization
  // server (the scheme and host of the entry), for the others the entry's iss itself.
  function issuerFor(p) {
    try {
      return p.kind === "okta" ? new URL(p.iss).origin : p.iss || "";
    } catch (e) {
      return p.iss || "";
    }
  }
  function idpDialog(o, p) {
    confirmDialog({
      spec: fspec("api-idp"), vals: { name: "" }, vals2: (v) => ({ name: v.id }), name: p.id, id: p.id, two: true, params: [[FW["api.col-provider"], p.id]],
      fields: [{ key: "id", label: FW["api.f-name"], value: /^[a-z0-9-]{1,32}$/.test(p.id) ? p.id : "", maxlength: "32" },
        { key: "issuer", label: FW["api.f-issuer"], value: issuerFor(p), maxlength: "1024" },
        { kind: "checks", key: "algs", label: FW["api.f-algs"], options: IDP_ALGS.map((a) => [a, a]), value: ["RS256"] },
        { key: "tenant", label: FW["api.f-tenant"], maxlength: "128" },
        { key: "maxAge", label: FW["api.f-max-age"], value: 300, inputmode: "numeric" },
        { key: "authMax", label: FW["api.f-auth-max"], value: 43200, inputmode: "numeric" },
        { kind: "select", key: "private", label: FW["exports.f-private"], options: yesNoOptions(), value: "no" }],
      check: (v) => (/^[a-z0-9-]{1,32}$/.test(v.id) && /^https:\/\/\S+$/.test(v.issuer) && v.issuer.length <= 1024 && v.algs.length && wholeIn(v.maxAge, 60, 600)
        && wholeIn(v.authMax, 300, 86400) ? "" : FW["api.check-idp"]),
      run: (v) => {
        const idp = { id: v.id, provider: p.id, issuer: v.issuer, algs: v.algs, max_age_s: Number(v.maxAge), auth_max_s: Number(v.authMax), private_ok: v.private === "yes" };
        if (v.tenant) idp.tenant = v.tenant;
        return apiStep("settings/api/idps", { org: o.org, idp }, "api.idp.stage");
      },
    });
  }
  // The org's ID-1 providers (6.5 step 2): each one's SSO URL with Set, Add identity provider from it, and the exact
  // api_return value the SSO operator copies into sso.json.
  function apiProviders(o, view, admin) {
    const list = o.providers || [];
    if (!list.length || enterpriseOnly(o, [])) return null;
    const ret = o.api_return || (list.find((p) => p.api_return) || {}).api_return || null;
    return section(uid("api-h"), FW["api.providers"], el("p", { class: "note" }, FW["api.providers-help"]),
      ret ? el("dl", { class: "pairs" }, el("dt", null, FW["api.api-return"]), el("dd", null, code(ret), " ", copyButton(ret))) : emptyLine(FW["api.api-return-none"]), dataTable({
        caption: FW["api.providers"], rows: list, empty: MSG.noneYet, name: (p) => p.id,
        cols: [{ key: "id", label: W["dialog.id"], cell: (p) => code(p.id) }, { key: "kind", label: FMSG.cols.kind, cell: (p) => u(p.kind || "") },
          { key: "iss", label: FW["api.col-issuer"], cell: (p) => code(p.iss || ""), sortable: false },
          { key: "sso_url", label: FW["api.col-sso-url"], cell: (p) => (p.sso_url ? code(p.sso_url) : FW["api.not-set"]), sortable: false }],
        actions: (p) => (admin ? [{ label: FW["api.idp-add"], run: () => idpDialog(o, p) }, { label: FW["api.sso-set"], run: () => confirmDialog({
          spec: fspec("api-sso-url"), vals: { provider: p.id }, name: p.id, id: p.id,
          fields: [{ key: "url", label: FW["api.f-sso-url"], value: p.sso_url || "", maxlength: "512" }],
          check: (v) => (!v.url || /^https:\/\/[^\s?#]+$/.test(v.url) ? "" : FW["api.check-sso-url"]),
          run: (v) => apiStep("settings/api/sso-url", { org: o.org, provider: p.id, url: v.url || null }, "api.sso-url"),
        }) }] : []),
      }));
  }

  // Revision 4 13.2: per client with a compliance or directory block, its limits and recipient key (with its
  // thumbprint), the reviewers rule and the org's Meet CA fingerprint for compliance tools to pin; for a directory
  // client its identity provider, SCIM URL and domains, and for Entra the tenant, audience and authorized party with the
  // three values to paste into Entra. Raising a limit or a new recipient is a two-person save (13.3); lowering a limit
  // and dropping the recipient apply at once (2.4).
  const CAPS = [["holds_per_day", "api.cap-holds", "api.f-cap-holds", 1, 100, 1], ["jobs_per_day", "api.cap-jobs", "api.f-cap-jobs", 1, 20, 1],
    ["job_max_bytes", "api.cap-job-bytes", "api.f-cap-job-mib", 1, 51200, 1048576], ["day_max_bytes", "api.cap-day-bytes", "api.f-cap-day-mib", 1, 204800, 1048576]];
  function apiBlocks(o, view, admin, map, meetCa) {
    const list = (view.clients || []).filter((x) => x.compliance || x.directory);
    if (!list.length) return null;
    const issuer = (map && map.issuer_url) || view.issuer_url || "";
    const kids = [];
    if (list.some((x) => x.compliance) && meetCa && meetCa.fingerprint) kids.push(pairs([[FW["api.meet-ca"], el("code", { class: "fingerprint" }, clean(meetCa.fingerprint))]]));
    for (const x of list) kids.push(sub([u(x.name), " ", code(x.id)], x.compliance ? complianceBlock(o.org, x, admin) : null, x.directory ? directoryBlock(x, issuer) : null));
    return section(uid("api-h"), FW["api.blocks"], ...kids);
  }
  // The recipient key as the route takes it: {jwk} from a JSON object, {pem} from a PEM; null when it is neither.
  function recipientBody(t) {
    const s = String(t || "").trim();
    if (/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(s)) return { pem: s };
    if (!s.startsWith("{")) return null;
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) && v.kty === "EC" && !("d" in v) ? { jwk: v } : null;
    } catch (e) {
      return null;
    }
  }
  function complianceBlock(org, x, admin) {
    const cp = x.compliance;
    const r = cp.recipient;
    const exportClient = (x.scopes || []).includes("compliance.export.request");
    const rows = CAPS.filter(([k]) => cp[k] != null).map(([k, w, , , , unit]) => [FW[w], unit > 1 ? fmtBytes(Number(cp[k])) : String(cp[k])]);
    if (exportClient) rows.push([FW["api.recipient"], r ? code(r.kid) : FW["api.recipient-none"]]);
    if (r) rows.push([FW["api.thumbprint"], el("code", { class: "fingerprint" }, clean(r.jkt || ""))]);
    const named = { name: x.name };
    const acts = admin ? [
      exportClient ? btn(FW["api.recipient-set"], () => confirmDialog({
        spec: fspec("api-recipient"), vals: named, name: x.name, id: x.id, two: true,
        fields: [{ kind: "textarea", key: "key", label: FW["api.f-recipient"] }],
        check: (v) => (recipientBody(v.key) ? "" : FW["api.check-recipient"]),
        run: (v) => apiStep("settings/api/clients/recipient", Object.assign({ org, id: x.id }, recipientBody(v.key)), "api.client.recipient"),
      })) : null,
      exportClient && r ? btn(FW["api.recipient-drop"], () => confirmDialog({
        spec: fspec("api-recipient-drop"), vals: named, name: x.name, id: r.kid, danger: true,
        run: () => apiPost("settings/api/clients/recipient/drop", { org, id: x.id }),
      }), "danger") : null,
      rows.length ? btn(FW["api.caps-set"], () => capsDialog(org, x)) : null,
    ] : [];
    return el("div", null, el("p", null, el("strong", null, FW["api.compliance"])), pairs(rows), exportClient ? el("p", { class: "note" }, FW["api.compliance-rule"]) : null,
      acts.some(Boolean) ? el("div", { class: "wizard-actions" }, acts) : null);
  }
  function capsDialog(org, x) {
    const cp = x.compliance || {};
    const has = CAPS.filter(([k]) => cp[k] != null);
    confirmDialog({
      spec: fspec("api-caps"), vals: { name: x.name }, name: x.name, id: x.id, two: true,
      fields: has.map(([k, , label, , , unit]) => ({ key: k, label: FW[label], value: Math.max(1, Math.round(Number(cp[k]) / unit)), inputmode: "numeric" })),
      check: (v) => (has.every(([k, , , lo, hi]) => wholeIn(v[k], lo, hi)) ? "" : FW["api.check-caps"]),
      run: (v) => apiStep("settings/api/clients/caps", { org, id: x.id, caps: Object.fromEntries(has.map(([k, , , , , unit]) => [k, Number(v[k]) * unit])) }, "api.client.caps"),
    });
  }
  function directoryBlock(x, issuer) {
    const d = x.directory;
    const wif = (x.credentials || []).find((c) => c.type === "entra_wif");
    const kids = [el("p", null, el("strong", null, FW["api.directory"])),
      pairs([[FW["api.dir-provider"], u(d.provider || "")], [FW["api.dir-scim"], code(d.resource || "")], [FW["api.dir-domains"], (d.domains || []).join(", ")]])];
    if (wif) {
      kids.push(pairs([[FW["api.dir-tenant"], code(wif.tenant || "")], [FW["api.dir-audience"], code(wif.audience || "")], [FW["api.dir-azp"], code(wif.azp || "")]]));
      // 6.8: what the admin pastes back into Entra's provisioning settings
      const paste = [[FW["api.dir-client-id"], x.id], [FW["api.dir-token-url"], issuer ? issuer.replace(/\/+$/, "") + "/oauth/token" : ""], [FW["api.dir-scim"], d.resource || ""]];
      kids.push(el("p", null, FW["api.dir-paste"]), el("dl", { class: "pairs" }, paste.map(([k, v]) => [el("dt", null, k), el("dd", null, code(v), " ", copyButton(v))])));
    }
    return el("div", null, kids);
  }
  // Revision 4 2.3: the org's relay set with what each reported (api-features) and what it lacks for the pinned map;
  // Retire takes a relay out of the set (refused while it is connected and still reports the org).
  function apiRelaySet(o, admin) {
    const set = o.relay_set || [];
    if (!set.length) return null;
    return section(uid("api-h"), FW["api.relay-set"], dataTable({
      caption: FW["api.relay-set"], rows: set, empty: MSG.noneYet, name: (x) => relayName(x.id),
      cols: [{ key: "id", label: FMSG.cols.relay, cell: (x) => u(relayName(x.id)) }, { key: "connected", label: FW["api.col-connected"], cell: (x) => yesNo(x.connected) },
        { key: "features", label: FW["api.col-features"], sortable: false,
          cell: (x) => (x.reported_at ? (x.map || []).map((n) => "v" + n).concat(x.features || []).join(", ") : FW["api.not-reported"]) },
        { key: "lacks", label: FW["api.col-lacks"], sortable: false, cell: (x) => ((x.lacks || []).length ? toneChip(x.lacks.join(", "), "bad") : FW["api.lacks-none"]) }],
      actions: (x) => (admin && (!x.connected || (x.lacks || []).length) ? [{ label: FW["api.retire"], run: () => confirmDialog({
        spec: fspec("api-retire"), vals: { relay: relayName(x.id), org: o.org }, name: relayName(x.id), id: x.id, danger: true,
        run: () => apiStep("settings/api/relays/retire", { org: o.org, relay: x.id }, "api.relay.retire"),
      }) }] : []),
    }));
  }

  // Relay scrape tokens (4.4): a new token is shown once; deleting one journals scrape_deny.
  function apiScrape(o, view, admin) {
    const org = o.org;
    let label = "";
    const add = admin ? btn(FW["api.scrape-new"], () => confirmDialog({
      spec: fspec("api-scrape-token"), vals: { label: "", relays: FMSG.relaysAll, days: 90 },
      fields: [{ key: "label", label: FMSG.label, maxlength: "64", required: true },
        { kind: "select", key: "relays", label: FMSG.cols.count, options: [["*", FMSG.relaysAll]].concat(orgRelays(o.relays).map((x) => [x.id, relayName(x.id)])), value: "*" },
        { key: "days", label: FW["api.f-scrape-days"], value: 90, inputmode: "numeric" }],
      vals2: (v) => ({ label: v.label, relays: relaysText([v.relays]), days: v.days }),
      check: (v) => (!v.label || v.label.length > 64 ? FMSG.label : !wholeIn(v.days, 30, 90) ? FW["api.check-number"] : ""),
      run: (v) => {
        label = v.label;
        return apiStep("settings/api/scrape-tokens", { org, action: "create", label: v.label, relays: [v.relays], days: Number(v.days) }, "api.scrape-token");
      },
      plain: true,
      done: (r) => render({ keepMessages: true }).then(() => {
        if (r && r.token) revealOnce(fill(FW["api.reveal-token"], { label }), r.hint || "", FW["exports.token-once"], r.token);
      }),
    }), "primary") : null;
    return section(uid("api-h"), FW["api.scrape"], add ? el("div", { class: "page-head" }, add) : null, dataTable({
      caption: FW["api.scrape"], rows: view.scrape_tokens || [], empty: MSG.noneYet, name: (t) => t.label,
      cols: [{ key: "label", label: FMSG.label, cell: (t) => u(t.label) }, { key: "hint", label: W["dialog.id"], cell: (t) => code(t.hint) },
        { key: "relays", label: FMSG.cols.count, cell: (t) => relaysText(t.relays), sortable: false }, { key: "expires", label: FMSG.cols.ends, cell: (t) => whenSec(t.expires) }],
      actions: (t) => (admin ? [{ label: FW["api.delete"], run: () => confirmDialog({
        spec: fspec("api-scrape-delete"), vals: { hint: t.hint }, name: t.label, id: t.hint, danger: true,
        run: () => apiStep("settings/api/scrape-tokens", { org, action: "delete", hint: t.hint }, "api.scrape-token"),
      }) }] : []),
    }));
  }

  // Grace hours (3.1): 0 to 168 per kind; raising is two-person at save, lowering journals grace_lower.
  const GRACE = ["person", "app", "connector", "relay"];
  function apiGrace(o, view, admin) {
    const g = view.grace || {};
    const inputs = GRACE.map((k) => {
      const f = textField(FW["api.grace-" + k], { inputmode: "numeric", maxlength: "3", disabled: admin ? null : true });
      f.input.value = String(g[k] == null ? 0 : g[k]);
      return [k, f];
    });
    const stage = admin ? btn(FW["api.stage"], () => {
      const typed = Object.fromEntries(inputs.map(([k, f]) => [k, f.input.value.trim()]));
      if (!GRACE.every((k) => wholeIn(typed[k], 0, 168))) {
        fail(FW["api.check-grace"]);
        return;
      }
      const grace = Object.fromEntries(GRACE.map((k) => [k, Number(typed[k])]));
      confirmDialog({
        spec: fspec("api-grace"), vals: { org: o.org }, name: o.org, id: o.org, params: GRACE.map((k) => [FW["api.grace-" + k], String(grace[k])]),
        run: () => apiStep("settings/api/grace", { org: o.org, grace }, "api.grace"),
      });
    }, "primary") : null;
    return section(uid("api-h"), FW["api.grace"], el("p", { class: "note" }, FW["api.grace-help"]), inputs.map(([, f]) => f.box), stage ? el("div", { class: "wizard-actions" }, stage) : null);
  }

  // Relay API origins (2.2 relay_origins), with each relay's journal acknowledgment and sync.
  function apiOrigins(o, view, admin) {
    const origins = view.relay_origins || {};
    return section(uid("api-h"), FW["api.origins"], dataTable({
      caption: FW["api.origins"], rows: orgRelays(o.relays), empty: MSG.noneYet, name: (x) => relayName(x.id),
      cols: [{ key: "id", label: FMSG.cols.relay, cell: (x) => u(relayName(x.id)) }, { key: "origin", label: FW["api.col-origin"], cell: (x) => (origins[x.id] ? code(origins[x.id]) : ""), sortable: false },
        { key: "acked", label: FW["api.col-applied"], cell: (x) => (typeof x.acked === "boolean" ? yesNo(x.acked) : String(x.acked == null ? "" : x.acked)) },
        { key: "synced", label: FW["api.col-synced"], cell: (x) => yesNo(x.synced) }],
      actions: (x) => (admin ? [{ label: FW["api.set-origin"], run: () => confirmDialog({
        spec: fspec("api-origin"), vals: { relay: relayName(x.id) }, name: relayName(x.id), id: x.id,
        fields: [{ key: "origin", label: FW["api.f-origin"], value: origins[x.id] || "", maxlength: "300" }],
        check: (v) => (!v.origin || /^https:\/\/[^\s/?#@]+:[0-9]{1,5}$/.test(v.origin) ? "" : FW["api.check-origin"]),
        run: (v) => apiStep("settings/api/relay-origins", { org: o.org, relay: x.id, origin: v.origin }, "api.relay-origin"),
      }) }] : []),
    }));
  }

  // The kill switch (2.5 api_off): off journals at once with a reason; on stages its clearing (two-person at save).
  function apiKill(o, state) {
    const org = o.org;
    const on = state === "off"
      ? btn(FW["api.on"], () => confirmDialog({ spec: fspec("api-on"), vals: { org }, name: org, id: org, run: () => apiPost("settings/api/on", { org }) }), "primary")
      : btn(FW["api.off"], () => confirmDialog({
        spec: fspec("api-off"), vals: { org }, name: org, id: org, danger: true, fields: [{ kind: "reason" }],
        run: (v) => apiPost("settings/api/off", { org, reason: v.reason }),
      }), "danger");
    return section(uid("api-h"), FW["api.kill"], el("div", { class: "wizard-actions" }, on));
  }

  // The tightening journal (2.5, newest 50); a client or destination tightening can be undone by a signed clearing.
  const UNDO = /^(client_(suspend|drop_scope|drop_relay|lower_ceiling|drop_credential|limit)|destination_(suspend|disable_failover|drop_signal|lower_ceiling|identities))$/;
  // Journal actions with words of their own; the rest show the action as it is written.
  const ACTION_WORD = { client_limit: "api.action-client-limit" };
  const actionWord = (a) => (ACTION_WORD[a] ? FW[ACTION_WORD[a]] : a);
  // A target such as client_limit's {client, relays, networks, rate}: lists joined, objects as JSON.
  const journalTarget = (t) => (t && typeof t === "object"
    ? Object.entries(t).map(([k, v]) => k + " " + (Array.isArray(v) ? v.join(" ") : v && typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")
    : String(t == null ? "" : t));
  function apiJournal(o, admin) {
    const j = o.journal || {};
    return section(uid("api-h"), FW["api.journal"], dataTable({
      caption: FW["api.journal"], rows: j.entries || [], empty: MSG.noneYet, name: (e) => actionWord(e.action), text: (e) => [e.id, e.action, journalTarget(e.target)].join(" "),
      cols: [{ key: "id", label: W["dialog.id"], cell: (e) => code(e.id), sort: (e) => e.tseq }, { key: "action", label: FMSG.change, cell: (e) => (ACTION_WORD[e.action] ? actionWord(e.action) : code(e.action)) },
        { key: "target", label: FW["api.col-target"], cell: (e) => journalTarget(e.target), sortable: false }, { key: "ts", label: FW["api.col-when"], cell: (e) => whenSec(e.ts) },
        { key: "until", label: FMSG.cols.ends, cell: (e) => (e.until ? whenSec(e.until) : "") }],
      actions: (e) => (admin && UNDO.test(e.action) ? [{ label: FW["api.undo"], run: () => confirmDialog({
        spec: fspec("api-undo"), vals: { change: actionWord(e.action) }, name: actionWord(e.action), id: e.id,
        run: () => apiStep("settings/api/resume", { org: o.org, tightening: e.id }, "api.resume"),
      }) }] : []),
    }));
  }

  // Explain (6.2): each check in order with ok or the code and words that would refuse the request.
  function apiExplain(o, view) {
    const id = uid("ex");
    const clients = view.clients || [];
    const client = el("select", { id: id + "-c" }, clients.map((x) => el("option", { value: x.id }, clean(x.name))));
    const method = el("select", { id: id + "-m" }, ["GET", "POST"].map((m) => el("option", { value: m }, m)));
    if (clients.length) client.value = clients[0].id;
    method.value = "GET";
    const path = textField(FW["api.f-path"], { maxlength: "512" });
    path.input.value = "/v1/health";
    const ip = textField(FW["api.f-ip"], { maxlength: "64" });
    const out = el("div", { "aria-live": "polite" });
    const run = btn(FW["api.explain-run"], async () => {
      const body = { org: o.org, client: client.value, method: method.value, path: path.input.value.trim() };
      if (ip.input.value.trim()) body.ip = ip.input.value.trim();
      try {
        const r = await apiPost("settings/api/explain", body);
        out.replaceChildren(el("ul", { class: "checks" }, (r.checks || []).map((ch) => el("li", null, String(ch.n) + ". ", u(ch.name), ": ",
          ch.ok ? FW["api.check-passes"] : fill(FW["api.check-refuses"], { code: ch.code || "", words: ch.words || "" })))),
        el("p", null, r.first_fail == null ? FW["api.explain-ok"] : fill(FW["api.explain-first"], { n: r.first_fail })));
      } catch (e) {
        fail(e);
      }
    }, "primary");
    return section(uid("api-h"), FW["api.explain"], el("p", { class: "note" }, FW["api.explain-help"]),
      el("div", { class: "field" }, el("label", { for: id + "-c" }, FW["api.f-client"]), client),
      el("div", { class: "field" }, el("label", { for: id + "-m" }, FW["api.f-method"]), method), path.box, ip.box, el("div", { class: "wizard-actions" }, run), out);
  }

  // ---- Exports: API destinations (11.1 to 11.7) and their failover credentials (12.3) ----
  const DEST_TONE = { ok: "ok", retrying: "warn", paused: "bad", failed: "bad", suspended: "warn" };
  const CRED_WORD = { entra_certificate: "exports.cred-entra", aws_roles_anywhere: "exports.cred-aws", gcp_service_account_key: "exports.cred-gcp", mtls: "exports.cred-mtls", token: "exports.cred-token",
    entra_federated: "exports.cred-entra-fed", gcp_federated: "exports.cred-gcp-fed", none: "exports.cred-none" };
  const credWord = (t) => FW[CRED_WORD[t]] || stateWord(t);
  // Revision 4 8: credentials the console makes itself from its outbound identity (no material to enter).
  const FEDERATED = ["entra_federated", "gcp_federated"];
  // R4-D12: a Google Cloud service account key is offered with the advice to prefer federation.
  const preferFederation = (t) => (t === "gcp_service_account_key" ? FW["exports.prefer-federation"] : "");
  // Failover types whose key the relay makes (a CSR first).
  const CSR_TYPES = ["entra_certificate", "aws_roles_anywhere", "mtls"];
  const IDENTITIES = [["pseudonymized", "exports.identities-pseudonymized"], ["removed", "exports.identities-removed"], ["as_is", "exports.identities-as-is"]];
  const presetWord = (p) => p.id + " (" + p.kind + ")";
  function credCell(c) {
    if (!c || !c.type) return FW["exports.cred-missing"];
    if (c.type === "none" || FEDERATED.includes(c.type)) return credWord(c.type);
    const advice = preferFederation(c.type);
    return credWord(c.type) + ": " + (c.held ? FW["exports.cred-held"] : FW["exports.cred-missing"]) + (c.rotate_by ? "; " + fillText(FW["exports.rotate-by"], { date: dayAny(c.rotate_by) }) : "") +
      (advice ? ". " + advice : "");
  }
  // Revision 4 7.4: a destination's events state (a webhook's verification first, then paused or its feed position).
  function eventsCell(x) {
    const ev = x.status && x.status.events;
    if (!ev) return "";
    const parts = [];
    if (ev.verification) parts.push(toneChip(FW["exports.ev-" + ev.verification] || stateWord(ev.verification), ev.verification === "unverified" ? "bad" : ev.verification === "none" ? "warn" : "ok"), " ");
    if (ev.cursor) parts.push(fill(FW["exports.ev-at"], { cursor: code(ev.cursor) }));
    return el("span", null, parts);
  }
  // A destination's state; paused events say they wait for Resume (an audit backlog keeps its own words).
  function destState(x) {
    if (!x.status) return FW["exports.state-none"];
    const s = x.status.state;
    if (s === "paused" && x.status.events && x.status.events.paused) return toneChip(FW["exports.ev-paused"], "bad");
    return toneChip(FW["exports.state-" + s] || stateWord(s), DEST_TONE[s]);
  }
  function exportsApi(d) {
    const presets = d.presets || [];
    const entries = d.api || [];
    if (!entries.length) return null;
    return section("dest-h", FW["exports.destinations"], el("div", { id: "fo-csr" }), entries.map((e) => exportsOrg(e, presets, !!d.siem)));
  }
  function exportsOrg(e, presets, siem) {
    const org = e.org;
    const admin = isAdmin();
    const dests = e.destinations || [];
    const names = Object.fromEntries(dests.map((x) => [x.id, x.name]));
    const kids = [];
    if (admin && presets.length) {
      const sid = uid("pre");
      const pick = el("select", { id: sid }, presets.map((p) => el("option", { value: p.id }, clean(presetWord(p)))));
      pick.value = presets[0].id;
      kids.push(el("div", { class: "page-head" }, el("label", { for: sid }, FW["exports.dest-preset"], pick),
        btn(FW["exports.dest-add"], () => destDialog(org, presets.find((p) => p.id === pick.value) || presets[0], null, e), "primary"),
        siem ? btn(FW["exports.dest-from-siem"], () => confirmDialog({
          spec: fspec("dest-siem"), vals: { org }, name: org, id: org,
          run: () => apiStep("settings/exports/destinations", { org, from_siem: true }, "exports.destination.stage"),
        })) : null));
    }
    kids.push(dataTable({
      caption: fillText(FW["exports.dest-org"], { org }), rows: dests, empty: MSG.noneYet, name: (x) => x.name, text: (x) => [x.name, x.id, x.preset].join(" "),
      cols: [{ key: "name", label: FMSG.cols.name, cell: (x) => u(x.name) }, { key: "preset", label: FW["exports.dest-preset"], cell: (x) => (x.preset || "") + " (" + (x.kind || "") + ")" },
        { key: "signals", label: FW["exports.col-signals"], cell: (x) => (x.signals || []).join(", "), sortable: false },
        { key: "source", label: FW["exports.col-source"], cell: (x) => FW["exports.source-" + x.source] || stateWord(x.source) },
        { key: "state", label: FMSG.cols.state, sort: (x) => (x.status ? x.status.state : null),
          cell: destState },
        { key: "backlog", label: FW["exports.col-backlog"], cell: (x) => (x.status ? fmtBytes(Number(x.status.backlog_bytes || 0)) : ""), sort: (x) => (x.status ? x.status.backlog_bytes : null) },
        { key: "oldest", label: FW["exports.col-oldest"], cell: (x) => (x.status && x.status.oldest_s ? span(x.status.oldest_s) : ""), sortable: false },
        { key: "success", label: FW["exports.col-last-success"], cell: (x) => (x.status ? whenAny(x.status.last_success) : ""), sortable: false },
        { key: "error", label: FMSG.lastError, cell: (x) => u((x.status && x.status.last_error) || ""), sortable: false },
        { key: "credential", label: FW["exports.col-credential"], cell: (x) => credCell(x.credential), sortable: false },
        { key: "events", label: FW["exports.col-events"], cell: eventsCell, sortable: false },
        { key: "tested", label: FW["exports.col-tested"], cell: (x) => (x.tested ? MSG.yes : FW["exports.untested"]) }],
      actions: (x) => (admin ? destActions(org, x, presets, e) : []),
    }));
    for (const x of dests.filter((y) => y.failover)) kids.push(failoverPart(org, x, e));
    kids.push(webhookKeys(e, admin), outboundIdentity(e, admin));
    kids.push(apiStaged({ org, staged: e.staged, signing: null, relays: e.relays, names }));
    return sub(fill(FW["exports.dest-org"], { org }), ...kids);
  }
  function destActions(org, x, presets, e) {
    const p = presets.find((y) => y.id === x.preset) || { id: x.preset, kind: x.kind, credential_types: [(x.credential || {}).type].filter(Boolean), signals: x.signals || [] };
    const type = (x.credential || {}).type;
    const hook = x.kind === "webhook";
    const ev = (x.status && x.status.events) || {};
    const named = { name: x.name };
    // Revision 4 7.4, 13.2: Verify, Replay from, Resume (while paused) and a v1 secret shown once, for a webhook.
    const hookActions = !hook ? [] : [{
      label: FW["exports.verify"], run: async () => {
        try {
          const r = await apiPost("settings/exports/destinations/verify", { org, id: x.id });
          if (r && r.ok === false) fail(fillText(FW["exports.verify-failed"], { why: r.error || "" }));
          else say(FW["exports.verify-ok"]);
        } catch (err) {
          fail(err && err.status === 200 ? fillText(FW["exports.verify-failed"], { why: err.message }) : err);
        }
        render({ keepMessages: true });
      },
    }, { label: FW["exports.replay"], run: () => confirmDialog({
      spec: fspec("dest-replay"), vals: named, name: x.name, id: x.id, fields: [{ key: "from", label: FW["exports.f-from"], value: ev.cursor || "", maxlength: "512" }],
      run: (v) => apiStep("settings/exports/destinations/replay", { org, id: x.id, from: v.from || "oldest" }, "exports.destination.replay"),
    }) }].concat(ev.paused ? [{ label: FW["exports.resume"], run: () => confirmDialog({
      spec: fspec("dest-resume"), vals: named, name: x.name, id: x.id,
      run: () => apiPost("settings/exports/destinations/resume", { org, id: x.id }),
    }) }] : [], [{ label: FW["exports.secret"], run: () => confirmDialog({
      spec: fspec("dest-secret"), vals: named, name: x.name, id: x.id, two: ((x.settings || {}).signing || "v2a") !== "v1",
      run: () => apiStep("settings/exports/destinations/secret", { org, id: x.id }, "exports.destination.secret"),
      plain: true,
      // The secret lives in its own dialog only and leaves the page when the dialog closes.
      done: (r) => render({ keepMessages: true }).then(() => {
        if (r && r.secret) revealOnce(fill(FW["exports.secret-title"], named), x.id, r.rotate_by ? [FW["exports.secret-once"], " ", fill(FW["exports.secret-rotate"], { date: dayAny(r.rotate_by) })] : FW["exports.secret-once"], r.secret);
      }),
    }) }]);
    // Revision 4 8: one token exchange through the outbound identity, the result only.
    const fedTest = FEDERATED.includes(type) ? [{ label: FW["federation.test"], run: async () => {
      try {
        const r = await apiPost("settings/exports/destinations/federation-test", { org, id: x.id });
        if (r && r.ok === false) fail(fillText(FW["federation.test-failed"], { why: r.error || "" }));
        else say(fillText(FW["federation.test-ok"], { provider: (r && r.provider) || "", time: r && r.exp ? whenAny(r.exp) : "" }));
      } catch (err) {
        fail(err && err.status === 200 ? fillText(FW["federation.test-failed"], { why: err.message }) : err);
      }
    } }] : [];
    const settable = materialFields(type, false).length > 0;
    return [{ label: FW["api.edit"], run: () => destDialog(org, p, x, e) }].concat(hookActions, fedTest, [{
      label: hook ? FW["exports.send-test"] : FW["exports.dest-test"], run: async () => {
        try {
          await apiPost("settings/exports/destinations/test", { org, id: x.id });
          say(FW["exports.test-ok"]);
        } catch (err) {
          // {ok: false, error} arrives inside a 200 answer: the record did not arrive.
          fail(err && err.status === 200 ? fillText(FW["exports.test-failed"], { why: err.message }) : err);
        }
        render({ keepMessages: true });
      },
    }], settable ? [{ label: FW["exports.dest-credential"], run: () => confirmDialog({
      spec: fspec("dest-credential"), vals: { name: x.name }, name: x.name, id: x.id, fields: materialFields(type, false),
      params: [[FW["exports.f-credential-type"], credWord(type)]].concat(preferFederation(type) ? [[FW["exports.cred-gcp"], preferFederation(type)]] : []),
      check: (v) => materialCheck(type, v, false),
      run: (v) => apiStep("settings/exports/destinations/credential", { org, id: x.id, credential: Object.assign({ type }, materialOf(type, v, false)) }, "exports.destination.credential"),
      plain: true,
      done: () => render({ keepMessages: true }).then(() => say(FW["exports.cred-sealed"])),
    }) }] : [], [{ label: FW["api.delete"], run: () => confirmDialog({
      spec: fspec("dest-delete"), vals: { name: x.name }, name: x.name, id: x.id, danger: true, fields: [{ kind: "reason" }],
      run: (v) => apiStep("settings/exports/destinations/delete", { org, id: x.id, reason: v.reason }, "exports.destination.delete"),
    }) }]);
  }
  // Add or edit a destination of one preset: the 11.1 settings of its kind and a credential type the preset allows.
  function destDialog(org, p, x, e) {
    const q = (x && x.queue) || {};
    const types = (p.credential_types || []).length ? p.credential_types : [(x && x.credential && x.credential.type) || "token"];
    // Revision 4 2.2: the client whose grant selects the events (webhook `client`, other kinds `events_client`).
    const evClients = ((e && e.events_clients) || []).map((c) => [c.id, c.name + " (" + c.id + ")"]);
    const advice = types.map(preferFederation).find(Boolean);
    const fields = [
      { key: "name", label: FMSG.cols.name, value: x ? x.name : "", maxlength: "64", required: true },
      { key: "signals", label: FW["exports.f-signals"], value: ((x ? x.signals : p.signals) || []).join(", ") },
      { kind: "select", key: "ceiling", label: FW["api.col-ceiling"], options: CEILINGS.map((c) => [c, ceilingWord(c)]), value: x ? x.ceiling : "internal" },
      { kind: "select", key: "identities", label: FW["exports.f-identities"], options: IDENTITIES.map(([v, k]) => [v, FW[k]]), value: x ? x.identities : "pseudonymized" },
      { kind: "select", key: "failover", label: FW["exports.f-failover"], options: yesNoOptions(), value: x && x.failover ? "yes" : "no" },
      { kind: "select", key: "private", label: FW["exports.f-private"], options: yesNoOptions(), value: x && x.private_ok ? "yes" : "no" },
      { key: "endpoint", label: FW["exports.f-endpoint"], value: x ? x.endpoint || "" : "", maxlength: "2048" },
    ].concat(settingsFields(p.kind, (x && x.settings) || {}, evClients), [
      { kind: "select", key: "credType", label: FW["exports.f-credential-type"], options: types.map((t) => [t, credWord(t)]), value: x && x.credential && types.includes(x.credential.type) ? x.credential.type : types[0] },
    ], credPublicFields(types, (x && x.credential) || {}), [
      { key: "queueMib", label: FW["exports.f-queue-mib"], value: q.max_bytes ? Math.round(q.max_bytes / 1048576) : 1024, inputmode: "numeric" },
      { key: "queueHours", label: FW["exports.f-queue-hours"], value: q.max_age_s ? Math.round(q.max_age_s / 3600) : 72, inputmode: "numeric" },
    ]);
    confirmDialog({
      spec: fspec(x ? "dest-update" : "dest-add"), vals: { name: x ? x.name : "" }, vals2: (v) => ({ name: v.name }), name: x ? x.name : p.id, id: x ? x.id : p.id, fields,
      params: [[FW["exports.dest-preset"], presetWord(p)]].concat(advice ? [[FW["exports.cred-gcp"], advice]] : []),
      check: (v) => destCheck(p.kind, v),
      run: (v) => (x ? apiStep("settings/exports/destinations/update", { org, id: x.id, destination: destBody(p, v) }, "exports.destination.update")
        : apiStep("settings/exports/destinations", { org, destination: destBody(p, v) }, "exports.destination.stage")),
    });
  }
  function settingsFields(kind, s, evClients) {
    const e = s.endpoints || {};
    const clients = evClients || [];
    if (kind === "webhook") {
      return [{ kind: "select", key: "client", label: FW["exports.s-client"], options: clients, value: s.client || (clients[0] || [""])[0] },
        { key: "types", label: FW["exports.s-types"], value: (s.types || []).join(", ") },
        { kind: "select", key: "signing", label: FW["exports.s-signing"], options: [["v2a", FW["exports.s-signing-v2a"]], ["v1", FW["exports.s-signing-v1"]]], value: s.signing || "v2a" },
        { kind: "select", key: "verification", label: FW["exports.s-verification"], options: [["wev", FW["exports.s-verify-wev"]], ["none", FW["exports.s-verify-none"]]], value: s.verification || "wev" }];
    }
    // Revision 4 7.5: the other kinds name the client whose events they carry when their signals include events.
    const evField = kind === "syslog_cef" ? [] : [{ kind: "select", key: "eventsClient", label: FW["exports.s-client"], options: [["", FW["exports.cred-none"]]].concat(clients), value: s.events_client || "" }];
    return settingsOf(kind, s, e).concat(evField, kind === "azure_logs" ? [{ key: "eventsStream", label: FW["exports.s-events-stream"], value: s.events_stream || "Custom-LucidEvents_CL", maxlength: "128" }] : []);
  }
  function settingsOf(kind, s, e) {
    if (kind === "otlp") {
      return [{ key: "traces", label: FW["exports.s-traces"], value: e.traces || "", maxlength: "2048" }, { key: "metrics", label: FW["exports.s-metrics"], value: e.metrics || "", maxlength: "2048" },
        { key: "logs", label: FW["exports.s-logs"], value: e.logs || "", maxlength: "2048" },
        { kind: "select", key: "temporality", label: FW["exports.s-temporality"], options: [["delta", FW["exports.s-delta"]], ["cumulative", FW["exports.s-cumulative"]]], value: s.temporality || "delta" },
        { key: "headers", label: FW["exports.s-headers"], value: (s.headers || []).join(", ") },
        { key: "sampling", label: FW["exports.s-sampling"], value: s.sampling == null ? 1 : s.sampling, inputmode: "decimal" }];
    }
    if (kind === "splunk_hec") {
      return [{ key: "index", label: FW["exports.s-index"], value: s.index || "", maxlength: "128" },
        { key: "sourcetypes", label: FW["exports.s-sourcetypes"], value: (s.sourcetypes || ["lucid:audit", "lucid:relay", "lucid:api", "lucid:events"]).join(", ") }];
    }
    if (kind === "azure_logs") {
      return [{ key: "dce", label: FW["exports.s-dce"], value: s.dce || "", maxlength: "2048" }, { key: "dcr", label: FW["exports.s-dcr"], value: s.dcr_immutable_id || "", maxlength: "128" },
        { key: "stream", label: FW["exports.s-stream"], value: s.stream || "Custom-LucidAudit_CL", maxlength: "128" }];
    }
    if (kind === "syslog_cef") {
      return [{ key: "host", label: FMSG.siemHost, value: s.host || "", maxlength: "253" }, { key: "port", label: FMSG.siemPort, value: s.port || 6514, inputmode: "numeric" },
        { kind: "textarea", key: "caPem", label: FMSG.siemCa, value: s.caPem || "" }, { kind: "textarea", key: "clientCertPem", label: FMSG.siemCert, value: s.clientCertPem || "" },
        { key: "events", label: FW["exports.s-events"], value: (s.events || ["audit", "security"]).join(", ") },
        { kind: "select", key: "includeReasons", label: FW["exports.siem-reasons"], options: yesNoOptions(), value: s.includeReasons ? "yes" : "no" }];
    }
    return [];
  }
  function destCheck(kind, v) {
    if (!v.name) return FW["exports.check-name"];
    const urls = kind === "otlp" ? [v.endpoint, v.traces, v.metrics, v.logs] : kind === "azure_logs" ? [v.endpoint, v.dce] : [v.endpoint];
    if (!urls.every((t) => !t || /^https:\/\/\S+$/.test(t)) || (kind !== "syslog_cef" && !urls.some(Boolean))) return FW["exports.check-endpoint"];
    if (kind === "otlp" && !(v.sampling !== "" && Number(v.sampling) >= 0 && Number(v.sampling) <= 1)) return FW["api.check-number"];
    if (kind === "syslog_cef" && !wholeIn(v.port, 1, 65535)) return FW["api.check-number"];
    if (!wholeIn(v.queueMib, 64, 65536) || !wholeIn(v.queueHours, 1, 720)) return FW["api.check-number"];
    if ((CRED_PUBLIC[v.credType] || []).some((k) => !v[k])) return FW["exports.check-material"];
    // 2.2: a webhook and every destination carrying events name a client holding events.subscribe
    const events = kind === "webhook" || commaList(v.signals).includes("events");
    if (events && !(kind === "webhook" ? v.client : v.eventsClient)) return FW["exports.s-client"];
    return "";
  }
  // The public fields the map entry's credential names (11.3): Entra and AWS Roles Anywhere carry them in the map, and
  // the revision 4 federated credentials are public fields only (8.3).
  const CRED_PUBLIC = { entra_certificate: ["tenant", "client_id", "cloud"], aws_roles_anywhere: ["trust_anchor_arn", "profile_arn", "role_arn", "region"],
    entra_federated: ["tenant", "client_id", "cloud", "audience"], gcp_federated: ["audience", "token_audience"] };
  function credPublicFields(types, c) {
    const out = [];
    if (types.includes("entra_certificate") || types.includes("entra_federated")) {
      out.push({ key: "tenant", label: FW["exports.m-tenant"], value: c.tenant || "", maxlength: "512" }, { key: "client_id", label: FW["exports.m-client-id"], value: c.client_id || "", maxlength: "512" },
        { kind: "select", key: "cloud", label: FW["exports.m-cloud"], options: [["public", FW["exports.m-cloud-public"]], ["usgov", FW["exports.m-cloud-usgov"]]], value: c.cloud || "public" });
    }
    if (types.includes("entra_federated") || types.includes("gcp_federated")) {
      out.push({ key: "audience", label: FW["exports.m-audience"], value: c.audience || (types.includes("entra_federated") ? "api://AzureADTokenExchange" : ""), maxlength: "600" });
    }
    if (types.includes("gcp_federated")) {
      out.push({ key: "token_audience", label: FW["exports.m-token-audience"], value: c.token_audience || "", maxlength: "600" },
        { key: "service_account", label: FW["exports.m-service-account"], value: c.service_account || "", maxlength: "254" });
    }
    if (types.includes("aws_roles_anywhere")) {
      out.push({ key: "trust_anchor_arn", label: FW["exports.m-trust-anchor"], value: c.trust_anchor_arn || "", maxlength: "512" },
        { key: "profile_arn", label: FW["exports.m-profile"], value: c.profile_arn || "", maxlength: "512" },
        { key: "role_arn", label: FW["exports.m-role"], value: c.role_arn || "", maxlength: "512" }, { key: "region", label: FW["exports.m-region"], value: c.region || "", maxlength: "64" });
    }
    return out;
  }
  // The destination body: credential {type} plus the public fields Entra and AWS name in the map; the material goes
  // through Set credential and is never echoed back.
  function destBody(p, v) {
    const credential = { type: v.credType };
    for (const k of CRED_PUBLIC[v.credType] || []) credential[k] = v[k];
    if (v.credType === "gcp_federated" && v.service_account) credential.service_account = v.service_account;
    let settings = {};
    if (p.kind === "webhook") {
      // 2.2: a webhook carries exactly the events signal and exactly these settings
      return { name: v.name, kind: "webhook", preset: p.id, signals: ["events"], ceiling: v.ceiling, identities: v.identities, failover: false, private_ok: v.private === "yes",
        endpoint: v.endpoint, settings: { client: v.client, types: commaList(v.types), signing: v.signing, verification: v.verification }, credential,
        queue: { max_bytes: Number(v.queueMib) * 1048576, max_age_s: Number(v.queueHours) * 3600 } };
    }
    if (p.kind === "otlp") {
      const endpoints = {};
      for (const n of ["traces", "metrics", "logs"]) if (v[n]) endpoints[n] = v[n];
      settings = { endpoints, temporality: v.temporality, headers: commaList(v.headers), sampling: Number(v.sampling) };
    } else if (p.kind === "splunk_hec") settings = { index: v.index, sourcetypes: commaList(v.sourcetypes), ack: true };
    else if (p.kind === "azure_logs") settings = { dce: v.dce, dcr_immutable_id: v.dcr, stream: v.stream };
    else if (p.kind === "syslog_cef") {
      settings = { host: v.host, port: Number(v.port), events: commaList(v.events), includeReasons: v.includeReasons === "yes" };
      if (v.caPem) settings.caPem = v.caPem;
      if (v.clientCertPem) settings.clientCertPem = v.clientCertPem;
    }
    // Revision 4 7.5: the events signal names its client (and, on Logs Ingestion, its stream)
    if (p.kind !== "syslog_cef" && commaList(v.signals).includes("events")) {
      settings.events_client = v.eventsClient;
      if (p.kind === "azure_logs") settings.events_stream = v.eventsStream;
    }
    return { name: v.name, kind: p.kind, preset: p.id, signals: commaList(v.signals), ceiling: v.ceiling, identities: v.identities, failover: v.failover === "yes",
      private_ok: v.private === "yes", endpoint: v.endpoint, settings, credential,
      queue: { max_bytes: Number(v.queueMib) * 1048576, max_age_s: Number(v.queueHours) * 3600 } };
  }
  // The 11.3 material per credential type (Set credential), or the 12.3 install material of a failover credential.
  const OPTIONAL_MATERIAL = ["ca_pem", "chain_pem"];
  function materialFields(type, failover) {
    const ta = (key, label) => ({ kind: "textarea", key, label });
    const tx = (key, label) => ({ key, label, maxlength: "512" });
    const cert = failover ? [ta("cert_pem", FW["exports.m-cert"]), ta("chain_pem", FW["exports.m-chain"])] : [ta("cert_pem", FW["exports.m-cert"]), ta("key_pem", FW["exports.m-key"])];
    let f = [];
    if (type === "token") f = [ta("token", FW["exports.m-token"])];
    else if (type === "gcp_service_account_key") f = [ta(failover ? "key_json" : "key", FW["exports.m-key-json"])];
    else if (type === "mtls") f = cert.concat([ta("ca_pem", FW["exports.m-ca"])]);
    else if (type === "entra_certificate") {
      f = [tx("tenant", FW["exports.m-tenant"]), tx("client_id", FW["exports.m-client-id"]),
        { kind: "select", key: "cloud", label: FW["exports.m-cloud"], options: [["public", FW["exports.m-cloud-public"]], ["usgov", FW["exports.m-cloud-usgov"]]], value: "public" }].concat(cert);
    } else if (type === "aws_roles_anywhere") {
      f = [tx("trust_anchor_arn", FW["exports.m-trust-anchor"]), tx("profile_arn", FW["exports.m-profile"]), tx("role_arn", FW["exports.m-role"]), tx("region", FW["exports.m-region"])].concat(cert);
    }
    return failover && f.length ? f.concat([{ key: "days", label: FW["exports.fo-days"], value: 90, inputmode: "numeric" }]) : f;
  }
  function materialCheck(type, v, failover) {
    const fields = materialFields(type, failover);
    if (!fields.length || fields.some((f) => f.key !== "days" && !OPTIONAL_MATERIAL.includes(f.key) && !v[f.key])) return FW["exports.check-material"];
    return failover && !wholeIn(v.days, 1, 90) ? FW["api.check-number"] : "";
  }
  function materialOf(type, v, failover) {
    const out = {};
    for (const f of materialFields(type, failover)) if (f.key !== "days" && v[f.key]) out[f.key] = v[f.key];
    if (failover) out.expires = nowSec() + Number(v.days) * 86400;
    return out;
  }
  // Failover credentials per relay (12.3): one row per relay of the organization, with its record when there is one.
  function failoverPart(org, x, e) {
    const recs = x.failover_records || [];
    const ids = orgRelays(e.relays).map((r) => r.id);
    for (const r of recs) if (!ids.includes(r.relay)) ids.push(r.relay);
    const rows = ids.map((relay) => Object.assign({ relay }, recs.find((r) => r.relay === relay) || {}));
    const type = (x.credential || {}).type;
    const admin = isAdmin();
    return sub([FW["exports.failover"], ": ", u(x.name)], el("p", { class: "note" }, FW["exports.failover-help"]), dataTable({
      caption: FW["exports.failover"], rows, empty: MSG.noneYet, name: (r) => relayName(r.relay),
      cols: [{ key: "relay", label: FMSG.cols.relay, cell: (r) => u(relayName(r.relay)) }, { key: "type", label: FMSG.cols.kind, cell: (r) => (r.type ? credWord(r.type) : "") },
        { key: "public_id", label: FW["exports.col-public-id"], cell: (r) => (r.public_id ? code(r.public_id) : ""), sortable: false },
        { key: "not_before", label: FW["exports.col-valid-from"], cell: (r) => (r.not_before ? whenAny(r.not_before) : "") },
        { key: "expires", label: FMSG.cols.ends, cell: (r) => (r.expires ? whenAny(r.expires) : "") },
        { key: "state", label: FMSG.cols.state, cell: (r) => (r.state ? (FW["exports.fo-" + r.state] || stateWord(r.state)) + (r.note ? " (" + r.note + ")" : "") : "") }],
      actions: (r) => (admin ? failoverActions(org, x, r, type) : []),
    }));
  }
  function failoverActions(org, x, r, type) {
    const vals = { name: x.name, relay: relayName(r.relay) };
    const out = [];
    if (CSR_TYPES.includes(type)) {
      out.push({ label: FW["exports.fo-csr"], run: () => confirmDialog({
        spec: fspec("failover-csr"), vals, name: vals.relay, id: r.relay,
        run: () => apiPost("settings/exports/destinations/failover/csr", { org, id: x.id, relay: r.relay }),
        plain: true,
        done: (a) => render({ keepMessages: true }).then(() => showCsr(x, r.relay, a && a.csr)),
      }) });
    }
    out.push({ label: FW["exports.fo-install"], run: () => confirmDialog({
      spec: fspec("failover-install"), vals, name: x.name, id: r.relay, fields: materialFields(type, true),
      check: (v) => materialCheck(type, v, true),
      run: (v) => apiStep("settings/exports/destinations/failover/install", { org, id: x.id, relay: r.relay, material: materialOf(type, v, true) }, "exports.failover.install"),
    }) });
    if (r.state && r.state !== "deleted") {
      out.push({ label: FW["api.delete"], run: () => confirmDialog({
        spec: fspec("failover-delete"), vals, name: x.name, id: r.relay, danger: true,
        run: () => apiPost("settings/exports/destinations/failover/delete", { org, id: x.id, relay: r.relay }),
      }) });
    }
    return out;
  }
  // The CSR the relay made (no secret): shown with copy and download until the page is left.
  function showCsr(x, relay, csr) {
    const box = $("fo-csr");
    if (!box || !csr) return;
    const file = (x.name + "-" + relayName(relay) + ".csr.pem").replace(/[^A-Za-z0-9._-]/g, "_");
    box.replaceChildren(panel(FW["exports.fo-csr"], el("p", null, FW["exports.fo-csr-shown"]),
      el("p", { class: "id-line" }, el("span", { class: "id-label" }, FMSG.cols.relay), " ", u(relayName(relay))),
      el("pre", null, el("code", null, cleanLines(csr))), copyButton(csr), " ", btn(FW["exports.fo-download"], () => saveText(file, csr))));
  }
  // Revision 4 7.4, 13.2: the org's webhook keys for v2a signing: a new one is made and sealed here and staged; a drop
  // applies at once (webhook_key_drop).
  function webhookKeys(e, admin) {
    const org = e.org;
    const keys = e.webhook_keys || [];
    if (!keys.length && !(e.destinations || []).some((x) => x.kind === "webhook")) return null;
    const add = admin ? btn(FW["webhooks.key-new"], () => confirmDialog({
      spec: fspec("webhook-key"), vals: { org }, name: org, id: org,
      run: () => apiStep("settings/api/webhook-keys", { org }, "api.webhook-key"),
    }), "primary") : null;
    return sub(FW["webhooks.keys"], e.issuer_url ? el("p", { class: "note" }, fill(FW["webhooks.keys-help"], { url: code(e.issuer_url.replace(/\/+$/, "") + "/v1/webhooks/keys") })) : null,
      add ? el("div", { class: "page-head" }, add) : null, dataTable({
        caption: FW["webhooks.keys"], rows: keys, empty: MSG.noneYet, name: (k) => k.kid,
        cols: [{ key: "kid", label: W["dialog.id"], cell: (k) => code(k.kid) }, { key: "public", label: FW["webhooks.col-public"], cell: (k) => code(k.public), sortable: false },
          { key: "nbf", label: FW["exports.col-valid-from"], cell: (k) => whenSec(k.nbf) }, { key: "exp", label: FMSG.cols.ends, cell: (k) => whenSec(k.exp) },
          { key: "dropped", label: FMSG.cols.state, cell: (k) => toneChip(k.dropped ? FW["webhooks.dropped"] : FW["webhooks.in-force"], k.dropped ? "bad" : "ok") }],
        actions: (k) => (admin && !k.dropped ? [{ label: FW["webhooks.drop"], run: () => confirmDialog({
          spec: fspec("webhook-key-drop"), vals: { kid: k.kid }, name: org, id: k.kid, danger: true,
          run: () => apiPost("settings/api/webhook-keys/drop", { org, kid: k.kid }),
        }) }] : []),
      }));
  }
  // Revision 4 8, 13.2: the outbound identity (issuer and keys), its documents to publish, a dropped key's
  // confirmation that hosted key sets no longer list it; each federated destination has "Test exchange".
  function outboundIdentity(e, admin) {
    const org = e.org;
    const f = e.federation;
    const pending = e.federation_republish || [];
    if (!f && !pending.length && !admin) return null;
    const confirmGone = (kid) => confirmDialog({
      spec: fspec("federation-republished"), vals: { kid }, name: org, id: kid,
      run: () => apiPost("settings/api/federation/republished", { org, kid }),
    });
    const docs = el("div", { "aria-live": "polite" });
    const tools = admin ? [btn(FW["federation.set"], () => confirmDialog({
      spec: fspec("federation-issuer"), vals: { org }, name: org, id: org,
      fields: [{ key: "issuer", label: FW["federation.f-issuer"], value: f ? f.issuer || "" : "", maxlength: "512" }],
      check: (v) => (!v.issuer || /^https:\/\/[^\s?#@]+$/.test(v.issuer) ? "" : FW["exports.check-endpoint"]),
      run: (v) => apiStep("settings/api/federation", Object.assign({ org }, v.issuer ? { issuer: v.issuer } : {}), "api.federation.issuer"),
    }), f ? "" : "primary"), f ? btn(FW["federation.key-new"], () => confirmDialog({
      spec: fspec("federation-key"), vals: { org }, name: org, id: org,
      run: () => apiStep("settings/api/federation/key", { org }, "api.federation.key"),
    })) : null] : [];
    if (f) {
      tools.push(btn(FW["federation.download"], async () => {
        try {
          const d = await api("GET", "settings/api/federation/documents?org=" + encodeURIComponent(org), null, { direct: true });
          docs.replaceChildren(...[d.pinned, d.staged].map((x, i) => (x ? fedDocs(org, x, i === 1) : null)).filter(Boolean));
        } catch (err) {
          fail(err);
        }
      }));
    }
    const kids = [el("p", { class: "note" }, FW["federation.help"]), tools.length ? el("div", { class: "page-head" }, tools) : null];
    if (!f) kids.push(emptyLine(FW["federation.none"]));
    else {
      kids.push(pairs([[FW["federation.issuer"], code(f.issuer)]]), dataTable({
        caption: FW["federation.title"], rows: f.keys || [], empty: MSG.noneYet, name: (k) => k.kid,
        cols: [{ key: "kid", label: W["dialog.id"], cell: (k) => code(k.kid) }, { key: "nbf", label: FW["exports.col-valid-from"], cell: (k) => whenSec(k.nbf) },
          { key: "exp", label: FMSG.cols.ends, cell: (k) => whenSec(k.exp) },
          { key: "dropped", label: FMSG.cols.state, cell: (k) => toneChip(k.dropped ? FW["webhooks.dropped"] : FW["webhooks.in-force"], k.dropped ? "bad" : "ok") }],
        actions: (k) => (!admin ? [] : k.dropped ? (pending.includes(k.kid) ? [{ label: FW["federation.republished"], run: () => confirmGone(k.kid) }] : [])
          : [{ label: FW["webhooks.drop"], run: () => confirmDialog({
            spec: fspec("federation-key-drop"), vals: { kid: k.kid }, name: org, id: k.kid, danger: true,
            run: () => apiPost("settings/api/federation/key/drop", { org, kid: k.kid }),
          }) }]),
      }));
    }
    // A dropped key the map no longer lists still waits for its confirmation (the federation-jwks-republish item).
    const listed = ((f && f.keys) || []).map((k) => k.kid);
    const gone = pending.filter((kid) => !listed.includes(kid));
    if (gone.length) {
      kids.push(el("ul", { class: "plain" }, gone.map((kid) => el("li", null, fill(FW["attention.federation-jwks-republish"], { kid: code(kid), org }), " ",
        admin ? btn(FW["federation.republished"], () => confirmGone(kid)) : null))));
    }
    kids.push(docs);
    return sub(FW["federation.title"], ...kids);
  }
  // One federation block's documents: where to publish them (unless the front door serves them), each with Copy, and
  // one download of both files.
  function fedDocs(org, x, staged) {
    const disc = JSON.stringify(x.discovery, null, 2);
    const jwks = JSON.stringify(x.jwks, null, 2);
    const base = (org + (staged ? "-staged" : "")).replace(/[^A-Za-z0-9._-]/g, "_");
    return panel(null, staged ? banner("warn", MSG.sev.warn, FW["federation.staged"]) : null,
      el("p", null, x.front_door ? FW["federation.front-door"] : fill(FW["federation.publish"], { discovery: code(x.discovery_url), jwks: code(x.jwks_url) })),
      el("pre", null, el("code", null, cleanLines(disc))), copyButton(disc), el("pre", null, el("code", null, cleanLines(jwks))), copyButton(jwks), " ",
      btn(FW["federation.download"], () => {
        saveText(base + "-openid-configuration.json", disc, "application/json");
        saveText(base + "-jwks.json", jwks, "application/json");
      }));
  }
  function saveText(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || "application/x-pem-file" }));
    const a = el("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---- Compliance (API-1 revision 4 13.2): each organization's API holds and export jobs, never content ----
  // Reviewers release an export in their own Lucid Hub; this page shows who was asked and who released it.
  const ARCHIVE_TONE = { waiting: "warn", placed: "ok", declined: "bad", failed: "bad" };
  const JOB_TONE = { waiting: "warn", released: "ok", building: "ok", transferring: "ok", ready: "ok", failed: "bad", refused: "bad" };
  const JOB_ENDS_OPEN = ["waiting", "released", "building", "transferring", "ready"];
  pages.fleetCompliance = async (c) => {
    const d = await api("GET", "settings/api", null, { direct: true });
    await fleetRelays().catch(() => []);
    const orgs = (d.orgs || []).map((x) => x.org);
    if (!orgs.length) return [head(FW["compliance.title"]), panel(null, emptyLine(FW["api.no-orgs"]))];
    const want = c && c.q ? c.q.get("org") : null;
    const org = orgs.includes(want) ? want : orgs[0];
    const pick = orgs.length > 1 ? el("nav", { class: "chips", "aria-label": FW["api.org"] },
      orgs.map((x) => el("a", { href: "#/security/compliance?org=" + encodeURIComponent(x), "aria-current": x === org ? "page" : null }, u(x)))) : null;
    const q = "?org=" + encodeURIComponent(org);
    const [holds, jobs] = await Promise.all([api("GET", "compliance/holds" + q, null, { direct: true }), api("GET", "compliance/exports" + q, null, { direct: true })]);
    const kids = [head(FW["compliance.title"], pick), el("p", { class: "note" }, FW["compliance.help"])];
    if (jobs.storage && jobs.storage.low) kids.push(banner("bad", MSG.sev.bad, FW["compliance.storage-low"]));
    kids.push(complianceHolds(holds), complianceJobs(org, jobs, isAdmin()));
    return kids;
  };
  function complianceHolds(h) {
    const relayStates = (x) => Object.entries(x.relays || {}).map(([r, s]) => relayName(r) + ": " + (FW["compliance.relay-" + s] || stateWord(s))).join("; ");
    const by = (x) => (x.by && x.by.client ? code(x.by.client) : x.by && x.by.admin ? u(x.by.admin) : FW["compliance.by-console"]);
    return section(uid("cmp-h"), FW["compliance.holds"], missingLine((h.partial || []).map(relayName)), dataTable({
      caption: FW["compliance.holds"], rows: h.holds || [], empty: MSG.noneYet, name: (x) => x.hold, text: (x) => [x.hold, x.matter, (x.by || {}).client].join(" "),
      cols: [{ key: "hold", label: W["dialog.id"], cell: (x) => code(x.hold) }, { key: "by", label: FW["compliance.col-by"], cell: by, sortable: false },
        { key: "count", label: FW["compliance.col-people"], cell: (x) => String(x.count != null ? x.count : (x.principals || []).length) },
        { key: "matter", label: FW["compliance.col-matter"], cell: (x) => u(x.matter || "") }, { key: "placed_at", label: FW["compliance.col-placed"], cell: (x) => whenAny(x.placed_at) },
        { key: "relays", label: FW["compliance.col-relays"], cell: relayStates, sortable: false },
        { key: "archive", label: FW["compliance.col-archive"], cell: (x) => (x.archive ? toneChip(FW["compliance.archive-" + x.archive] || stateWord(x.archive), ARCHIVE_TONE[x.archive]) : "") },
        { key: "released_at", label: FW["compliance.relay-released"], cell: (x) => (x.released_at ? whenAny(x.released_at) : "") }],
    }));
  }
  function complianceJobs(org, j, admin) {
    const reviewed = (x) => el("span", null, fill(FW["compliance.released"], { n: x.releases || 0 }),
      (x.released_by || []).length ? [el("br"), fill(FW["compliance.released-by"], { reviewers: x.released_by.join(", ") })] : null,
      x.state === "waiting" && x.expires_waiting ? [el("br"), fill(FW["compliance.waiting-until"], { time: whenAny(x.expires_waiting) })] : null);
    return section(uid("cmp-h"), FW["compliance.exports"], el("p", null, FW["compliance.ask-reviewers"]), el("p", { class: "note" }, FW["api.compliance-rule"]),
      (j.archive_relays || []).length ? null : banner("warn", MSG.sev.warn, FW["compliance.no-archive"]), dataTable({
        caption: FW["compliance.exports"], rows: j.jobs || [], empty: MSG.noneYet, name: (x) => x.job, text: (x) => [x.job, x.client_name, x.matter, x.owner].join(" "),
        cols: [{ key: "job", label: W["dialog.id"], cell: (x) => code(x.job) }, { key: "client_name", label: FW["compliance.col-client"], cell: (x) => u(x.client_name || x.client) },
          { key: "matter", label: FW["compliance.col-matter"], cell: (x) => u(x.matter || "") }, { key: "requested_at", label: FW["compliance.col-requested"], cell: (x) => whenAny(x.requested_at) },
          { key: "state", label: FMSG.cols.state, cell: (x) => toneChip(FW["compliance.job-" + x.state] || stateWord(x.state), JOB_TONE[x.state]) },
          { key: "reviewers", label: FW["compliance.col-reviewers"], cell: (x) => (x.reviewers || []).join(", "), sortable: false },
          { key: "releases", label: FW["compliance.relay-released"], cell: reviewed, sortable: false },
          { key: "zip_bytes", label: FW["compliance.col-size"], cell: (x) => (x.zip_bytes ? fmtBytes(Number(x.zip_bytes)) : "") },
          { key: "expires", label: FMSG.cols.ends, cell: (x) => (x.expires ? whenAny(x.expires) : "") }],
        actions: (x) => (admin && JOB_ENDS_OPEN.includes(x.state) ? [{ label: FW["compliance.cancel"], run: () => confirmDialog({
          spec: fspec("compliance-cancel"), vals: { job: x.job }, name: x.client_name || x.client, id: x.job, danger: true, fields: [{ kind: "reason" }],
          run: (v) => apiPost("compliance/exports/cancel", { org, job: x.job, reason: v.reason }),
        }) }] : []),
      }));
  }

  // ---- The Directory card of the People page (API-1 revision 4 13.2): governed or legacy SCIM and its activity ----
  const NOT_REPORTED = { legacy_token_dates: "directory.tokens", pre_r4d3: "directory.pre-r4d3", pending_group_confirmations: "directory.pending" };
  async function directoryCards() {
    let orgs = [];
    try {
      orgs = (await api("GET", "settings/api", null, { direct: true })).orgs || [];
    } catch (e) {
      return [];
    }
    const out = [];
    for (const o of orgs) {
      try {
        const s = await api("GET", "directory/status?org=" + encodeURIComponent(o.org), null, { direct: true });
        if (s && s.mode) out.push(directoryCard(o, s));
      } catch (e) {
        // an organization without a directory answer shows no card
      }
    }
    return out;
  }
  function refusedCell(r) {
    const t = r || {};
    const list = Object.entries(t.refusals || {}).map(([k, n]) => k + " " + n).join(", ");
    return el("span", null, String(t.refused || 0), list ? [" ", fill(FW["directory.refusals"], { list })] : null);
  }
  const activityCols = [{ key: "last", label: FW["directory.col-last"], cell: (x) => whenAny((x.requests || x).last_request), sort: (x) => (x.requests || x).last_request },
    { key: "ok", label: FW["directory.col-requests"], cell: (x) => String((x.requests || x).ok || 0) },
    { key: "refused", label: FW["directory.col-refused"], cell: (x) => refusedCell(x.requests || x), sortable: false }];
  function directoryCard(o, s) {
    const kids = [banner(s.governed ? "info" : "warn", s.governed ? MSG.sev.info : MSG.sev.warn, FW[s.governed ? "directory.governed" : "directory.legacy"])];
    const nr = (s.not_reported || []).map((k) => (NOT_REPORTED[k] ? FW[NOT_REPORTED[k]] : k));
    if (nr.length) kids.push(el("p", { class: "note" }, fill(FW["directory.not-reported"], { list: nr.join(", ") })));
    if ((s.clients || []).length || s.governed) {
      kids.push(sub(FW["directory.clients"], dataTable({
        caption: FW["directory.clients"], rows: s.clients || [], empty: MSG.noneYet, name: (x) => x.name || x.id,
        cols: [{ key: "name", label: FMSG.cols.name, cell: (x) => u(x.name || x.id) }, { key: "provider", label: FW["api.dir-provider"], cell: (x) => u(x.provider || "") },
          { key: "resource", label: FW["api.dir-scim"], cell: (x) => code(x.resource || ""), sortable: false },
          { key: "state", label: FMSG.cols.state, cell: (x) => toneChip(FW["api.shown-" + x.state] || stateWord(x.state), SHOWN_TONE[x.state]) }].concat(activityCols),
      })));
    }
    const tokens = (s.legacy && s.legacy.tokens) || [];
    if (tokens.length) {
      // the SSO service reports no_address_list, never the addresses themselves (API-1 revision 4 13.1)
      const addresses = (x) => ((x.ip_allow || []).length ? x.ip_allow.join(", ") : x.no_address_list ? FW["directory.any-address"] : "");
      kids.push(sub(FW["directory.tokens"], tokens.some((x) => x.pre_r4d3) ? el("p", { class: "note" }, FW["directory.pre-r4d3-help"]) : null, dataTable({
        caption: FW["directory.tokens"], rows: tokens, empty: MSG.noneYet, name: (x) => x.token_id,
        cols: [{ key: "token_id", label: W["dialog.id"], cell: (x) => el("span", null, code(x.token_id), x.hint ? [" ", code(x.hint)] : null, x.pre_r4d3 ? [" ", toneChip(FW["directory.pre-r4d3"], "warn")] : null) },
          { key: "issued", label: FW["directory.col-issued"], cell: (x) => (x.issued ? whenAny(x.issued) : "") },
          // 6.1.1: from 14 days before its end the date is a warning
          { key: "expires", label: FMSG.cols.ends, cell: (x) => (!x.expires ? "" : x.ending ? toneChip(whenAny(x.expires), "warn") : whenAny(x.expires)) },
          { key: "ip_allow", label: FW["directory.col-networks"], cell: addresses, sortable: false }].concat(activityCols),
      })));
    }
    if ((s.pending || []).length) {
      kids.push(sub(FW["directory.pending"], el("p", { class: "note" }, FW["directory.pending-help"]), dataTable({
        caption: FW["directory.pending"], rows: s.pending, empty: MSG.noneYet, name: (x) => x.group,
        cols: [{ key: "group", label: FW["directory.col-group"], cell: (x) => u(x.group_name || x.group) }, { key: "principal", label: FMSG.cols.name, cell: (x) => u(x.principal || "") },
          { key: "since", label: FW["directory.col-since"], cell: (x) => whenAny(x.since) }],
      })));
    }
    // 6.7: owners the directory deprovisioned, or the console marks gone, whose clients the map still lists
    const clients = (o.map && o.map.clients) || [];
    const gone = new Set((s.people || []).filter((p) => p.state === "deprovisioned").map((p) => p.principal));
    for (const x of clients) if (x.shown_state === "owner-gone") gone.add(x.owner);
    const rows = [...gone].map((p) => ({ principal: p, clients: clients.filter((x) => x.owner === p).map((x) => x.name) })).filter((r) => r.clients.length);
    if (rows.length) {
      kids.push(sub(FW["directory.owner-gone"], dataTable({
        caption: FW["directory.owner-gone"], rows, empty: MSG.noneYet, name: (r) => r.principal,
        cols: [{ key: "principal", label: FW["api.col-owner"], cell: (r) => u(r.principal) }, { key: "clients", label: FW["directory.col-clients"], cell: (r) => r.clients.join(", "), sortable: false }],
      })));
    }
    return section(uid("dir-h"), [FW["directory.title"], ": ", u(o.org)], ...kids);
  }

  // ---- Sign-in, Email and Settings on a fleet console (12.4) ----
  pages.fleetSignIn = async () => {
    const d = await api("GET", "settings", null, { direct: true });
    S.settings = d;
    return [head(FW["nav.sign-in"]), settingsSignIn(d, W["settings.sections"][1]), el("p", { class: "note" }, FW["setup.sso-later"])];
  };
  pages.fleetEmail = async () => {
    const d = await api("GET", "settings", null, { direct: true });
    S.settings = d;
    return [head(FW["nav.email"]), settingsEmail(d, W["settings.sections"][2])];
  };
  pages.fleetConsole = async () => {
    const d = await api("GET", "settings", null, { direct: true });
    S.settings = d;
    return [head(pageLabel("settings", "console")), settingsSecurity(d, W["settings.sections"][0], null), ...(await pages.admins_sessions()).slice(1)];
  };
  pages.fleetConsoles = async () => {
    const d = await api("GET", "settings", null, { direct: true });
    return [head(pageLabel("settings", "consoles")), settingsLinks(d, W["settings.sections"][4])];
  };
  // A policy change on a fleet console (4.5): one fleet step-up of kind "policy" serves the console and every relay.
  async function policyPost(path, body, bind) {
    if (!fleet()) return post(path, body, bind);
    const ids = (await fleetRelays(true)).filter((x) => x.state === "active").map((x) => x.id);
    return fleetPost(path, body, bind, ids, "policy");
  }
  // Your account on a fleet console: "Key fingerprints for relays" (3.9 ceremony B).
  async function keyFingerprints(working) {
    let keys = [];
    try {
      keys = (await api("GET", "account/key-fingerprints", null, { direct: true })).keys || [];
    } catch (e) {
      keys = [];
    }
    return section("fp-h", FW["account.fingerprints"], working ? null : banner("warn", MSG.sev.warn, FW["fleet.webauthn-only"]),
      el("p", null, FW["account.fingerprints-help"]),
      dataTable({
        caption: FW["account.fingerprints"], rows: keys, empty: MSG.noneYet, name: (k) => k.label || k.hint,
        cols: [{ key: "label", label: FMSG.cols.name }, { key: "hint", label: W["dialog.id"], cell: (k) => code(k.hint) },
          { key: "fingerprint", label: FW["enroll.fingerprint"], cell: (k) => el("code", { class: "fingerprint" }, clean(k.fingerprint)), sortable: false }],
      }));
  }
  // "Record this key in my IDE or Hub app" (3.9): a step-up with that key, then the same loopback navigation as at
  // registration, with the record value the app gave this tab (#record=<port>.<nonce>).
  async function recordKey(k) {
    if (!recordPort(S.record)) {
      fail(FMSG.recordFirst);
      return;
    }
    const body = { hint: k.hint, record: S.record };
    const st = await stepup("account.key-record", k.hint, body);
    keyRecordGo(await api("POST", "account/key-record", Object.assign({}, body, { stepup: st })));
  }

  // ---- Setup wizard (12) ----
  const SETUP_STEPS = [["admin", 2, "setup.first-admin"], ["signin", 3, "setup.signin"], ["email", 4, "setup.email"], ["license", 5, "setup.license"], ["relay", 6, "setup.relay"]];
  async function loadSetup() {
    try {
      S.setup = await api("GET", "setup", null, { direct: true, activity: false });
    } catch (e) {
      S.setup = null;
    }
    return S.setup;
  }
  // GET setup's steps: the 12.3 states, read whether or not they come wrapped as {steps, hidden}.
  function stepsOf(s) {
    if (!s || !s.steps) return { steps: null, hidden: false };
    return s.steps.steps ? { steps: s.steps.steps, hidden: !!s.steps.hidden } : { steps: s.steps, hidden: !!s.hidden };
  }
  async function firstOpenStep() {
    const { steps } = stepsOf(await loadSetup());
    if (!steps) return null;
    if (S.fromSetup && profile() === "high") {
      S.fromSetup = false;
      return "admin";
    }
    const open = SETUP_STEPS.find(([id]) => steps[id] === "open");
    return open ? open[0] : null;
  }
  async function setupChecklist() {
    const { steps, hidden } = stepsOf(await loadSetup());
    if (!steps || hidden) return null;
    const list = SETUP_STEPS.filter(([id]) => steps[id] === "open" || steps[id] === "skipped");
    if (!list.length) return null;
    return section("setup-h", FW["setup.checklist"], el("ul", { class: "checklist" }, SETUP_STEPS.filter(([id]) => steps[id]).map(([id, , word]) => el("li", null,
      el("span", { class: "words" }, FW[word]), toneChip(FW["setup.state-" + steps[id]] || stateWord(steps[id]), steps[id] === "done" ? "ok" : "warn"),
      steps[id] !== "done" ? el("a", { href: "#/setup/" + id }, FW["setup.continue"]) : null))),
    btn(FW["setup.hide"], async () => {
      try {
        await api("POST", "setup/hide", {}, { direct: true });
        render({ keepMessages: true });
      } catch (e) {
        fail(e);
      }
    }));
  }
  pages.fleetSetup = async () => {
    const { steps } = stepsOf(await loadSetup());
    const title = pageLabel("settings", "setup");
    if (!steps) return [head(title)];
    // L-7: a finished step offers Review, an open or skipped one Continue; with every step done the page says so.
    const listed = SETUP_STEPS.filter(([id]) => steps[id]);
    const complete = listed.length && listed.every(([id]) => steps[id] === "done");
    return [head(title), panel(null, complete ? el("p", { role: "status" }, toneChip(FMSG.setupDone, "ok")) : null,
      el("ul", { class: "checklist" }, listed.map(([id, n, word]) => el("li", null,
        el("span", { class: "words" }, fillText(FW["setup.step"], { n }), ": ", FW[word]),
        toneChip(FW["setup.state-" + steps[id]] || stateWord(steps[id]), steps[id] === "done" ? "ok" : "warn"),
        el("a", { href: "#/setup/" + id }, steps[id] === "done" ? FMSG.review : FW["setup.continue"])))))];
  };
  // One wizard step (12.2): "Step <n> of 6", the step itself, Back, Skip for now (not for the first admin), and Save
  // and continue (Finish on the last). State is the server's (12.3), so a step can be resumed from any browser.
  async function setupPage(step, c) {
    const i = Math.max(0, SETUP_STEPS.findIndex(([id]) => id === step));
    const [id, n, word] = SETUP_STEPS[i];
    const { steps } = stepsOf(S.setup || (await loadSetup()));
    const body = await setupBody(id, c);
    const move = async (state) => {
      try {
        if (id !== "admin" && state) await api("POST", "setup/step", { step: id, state }, { direct: true });
        const done = Object.assign({}, steps || {}, id !== "admin" && state ? { [id]: state } : {});
        S.setup = null;
        const later = SETUP_STEPS.slice(i + 1).find(([x]) => done[x] !== "done");
        go(later ? "#/setup/" + later[0] : "#/overview");
      } catch (e) {
        fail(e);
      }
    };
    const last = id === "relay";
    return [head(FW[word]), el("p", { class: "step-line" }, fillText(FW["setup.step"], { n })), ...body,
      el("div", { class: "wizard-actions" },
        i > 0 ? btn(FW["setup.back"], () => go("#/setup/" + SETUP_STEPS[i - 1][0])) : null,
        id !== "admin" ? btn(FW["setup.skip"], () => move("skipped")) : null,
        btn(last ? FW["setup.finish"] : FW["setup.save"], () => move("done"), "primary"))];
  }
  async function setupBody(id, c) {
    if (id === "admin") {
      const out = [panel(null, pairs([[FW["setup.email-field"], myEmail()]]))];
      if (profile() === "high") {
        out.push(panel(null, el("p", null, FW["setup.breakglass"]), el("code", { class: "cmd" }, "lucid-relay console break-glass --email " + clean(myEmail()) + " --state <folder>")));
      }
      return out;
    }
    if (id === "signin" || id === "email") {
      const d = await api("GET", "settings", null, { direct: true });
      S.settings = d;
      return id === "signin" ? [settingsSignIn(d, W["settings.sections"][1]), el("p", null, FW["setup.sso-later"])] : [settingsEmail(d, W["settings.sections"][2])];
    }
    if (id === "license") {
      const d = await api("GET", "fleet/licenses", null, { direct: true }).catch(() => ({ library: [] }));
      return [libraryPanel(d.library || [])];
    }
    // Step 6 (12.2): "This host" or "Another host".
    const rows = await fleetRelays(true);
    const high = profile() === "high";
    const here = high
      ? [el("p", null, FW["setup.this-host-high"]), el("code", { class: "cmd" }, "lucid-relay console seal-setup --role console\nlucid-relay console seal-setup --role relay")]
      : [rows.length ? el("ul", { class: "plain" }, rows.map((x) => el("li", null, u(x.name), ": ", relayStateWord(x.state)))) : el("p", null, FW["setup.this-host-help"]),
        el("p", null, FW["setup.this-host-standard"])];
    return [section("host-h", FW["setup.this-host"], ...here), section("other-h", FW["setup.other-host"], ...(await deployPanel(c)))];
  }
  // The first-run screen (12.1, step 1): the setup code and the government question, then the first admin's email
  // (step 2); setup/start answers a join token and the page continues in AC-1's join flow.
  async function renderSetupStart() {
    ++S.gen;
    RUN = [];
    let s = {};
    try {
      s = await api("GET", "setup", null, { noRedirect: true, activity: false });
    } catch (e) {
      fail(e);
    }
    if (s.bootstrapped) {
      await renderSignIn();
      return;
    }
    const fixed = s.profileFixed === "high" || s.profileFixed === "standard" ? s.profileFixed : null;
    const codeF = textField(FW["setup.code-field"], { maxlength: "64", autocomplete: "off" }, FW["setup.code-help"]);
    const name = uid("gov");
    const radio = (value, label, on) => {
      const id = uid("gov");
      const r = el("input", { type: "radio", id, name, value, checked: on ? true : null });
      return [r, el("label", { class: "inline", for: id }, r, label)];
    };
    const yes = radio("high", FW["setup.gov-yes"], false);
    const no = radio("standard", FW["setup.gov-no"], true);
    const pick = () => fixed || (yes[0].checked ? "high" : "standard");
    const email = textField(FW["setup.email-field"], { type: "email", autocomplete: "username", maxlength: "254" });
    const step1 = () => showGate(gateTitle(FW["setup.code-title"]), el("p", { class: "step-line" }, fillText(FW["setup.step"], { n: 1 })), codeF.box,
      fixed ? el("p", null, fill(FW["setup.gov-fixed"], { profile: FMSG.profileWords[fixed] }))
        : el("fieldset", { class: "choice" }, el("legend", null, FW["setup.gov"]), yes[1], no[1]),
      el("p", { class: "note" }, FW["setup.gov-help"]),
      el("div", { class: "wizard-actions" }, btn(FW["setup.save"], () => {
        if (!codeF.input.value.trim()) {
          invalid(codeF.input, MSG.need.setupCode);
          return;
        }
        clearMessages();
        step2();
      }, "primary")));
    const step2 = () => showGate(gateTitle(FW["setup.first-admin"]), el("p", { class: "step-line" }, fillText(FW["setup.step"], { n: 2 })), email.box,
      el("div", { class: "wizard-actions" }, btn(FW["setup.back"], step1), btn(FW["setup.save"], async () => {
        clearMessages();
        try {
          const r = await api("POST", "setup/start", { code: codeF.input.value.trim(), profile: pick(), email: email.input.value.trim() }, { noRedirect: true });
          codeF.input.value = "";
          S.fromSetup = true;
          S.me.profile = pick();
          await renderJoin(r.join);
        } catch (e) {
          fail(e);
        }
      }, "primary")));
    step1();
  }

  // ---- The relay's own console: the "Lucid Admin Console" panel (5.7) and the fleet.managed banner (2.1) ----
  async function loadLink(force) {
    if (fleet() || !isAdmin()) return null;
    if (!force && S.link && Date.now() - S.link.at < 60000) return S.link;
    try {
      S.link = Object.assign({}, await api("GET", "fleet-link", null, { activity: false, noRedirect: true }), { at: Date.now() });
    } catch (e) {
      S.link = { enrolled: false, missing: e && e.status === 404, at: Date.now() };
    }
    return S.link;
  }
  function localFleetPanel(l) {
    if (!l || l.missing) return null;
    return l.enrolled ? localLinked(l) : localJoin();
  }
  // Join a console from this relay (5.7): check the console first (preview), then join with an AC-1 step-up. The
  // code field is a password-type field and the code travels only in the POST body.
  function localJoin() {
    const url = textField(FMSG.consoleUrl, { type: "url", maxlength: "300" });
    const enrollCode = textField(FW["enroll.code-title"], { type: "password", autocomplete: "off", maxlength: "160", "data-code": "enroll" });
    const kid = uid("ak");
    const keys = el("textarea", { id: kid, spellcheck: "false", autocomplete: "off" });
    const out = el("div");
    const check = btn(FMSG.preview, async () => {
      clearMessages();
      try {
        const p = await api("POST", "fleet-link/preview", { url: url.input.value.trim(), code: enrollCode.input.value.trim() });
        const c = p.console || {};
        const pol = p.policy || {};
        out.replaceChildren(panel(null, pairs([[FMSG.consoleUrl, c.origin || ""], [FW["enroll.name"], (p.enrollment || {}).name || ""],
          [FW["enroll.scopes"], scopesText((p.enrollment || {}).scopes)], [W["settings.profile"], FMSG.profileWords[pol.profile] || pol.profile || ""],
          [W["settings.two-person"], pol.twoPerson ? onOff(pol.twoPerson === "on") : ""]]),
        dataTable({
          caption: FMSG.keys, rows: p.roster || [], empty: MSG.noneYet, name: (e) => e.email,
          cols: [{ key: "email", label: FMSG.cols.email }, { key: "role", label: FMSG.cols.role, cell: (e) => ROLE_WORD[e.role] || stateWord(e.role) }, { key: "hint", label: W["dialog.id"], cell: (e) => code(e.hint || "") }],
        }),
        btn(FW["local.join"], async () => {
          clearMessages();
          const adminKeys = keys.value.split(/\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
          if (adminKeys.some((x) => !/^[0-9a-f]{64}$/.test(x))) {
            invalid(keys, MSG.need.adminKeys);
            return;
          }
          try {
            await post("fleet-link/join", { url: url.input.value.trim(), code: enrollCode.input.value.trim(), previewHash: p.previewHash, adminKeys }, { action: "fleet.join", target: url.input.value.trim() });
            enrollCode.input.value = "";
            S.link = null;
            say(MSG.done);
            render({ keepMessages: true });
          } catch (e) {
            fail(e);
          }
        }, "primary")));
      } catch (e) {
        fail(e);
      }
    });
    return section("sec-fleet", FW["local.title"], el("h4", null, FW["local.join"]), url.box, enrollCode.box,
      el("div", { class: "field" }, el("label", { for: kid }, FMSG.adminKeys), keys), check, out);
  }
  function localLinked(l) {
    const origin = l.console ? l.console.origin : "";
    const req = l.pendingScopes && typeof l.pendingScopes === "object" && !Array.isArray(l.pendingScopes) ? l.pendingScopes : null;
    const confirmBoxes = ["read-logs", "people", "config", "license"].map((s) => {
      const id = uid("lc");
      const cb = el("input", { id, type: "checkbox", value: s, checked: (l.confirm || []).includes(s) ? true : null });
      return [cb, el("label", { class: "inline", for: id }, cb, scopeWord(s))];
    });
    const gen = textField(FMSG.generation, { type: "number", min: "1", inputmode: "numeric" });
    const fp = textField(FW["enroll.fingerprint"], { maxlength: "160" });
    const waiting = l.waiting || [];
    const held = l.held || [];
    const one = (path, body, bind) => post(path, body, bind);
    const simple = (path, body) => async () => {
      try {
        await api("POST", path, body);
        say(MSG.done);
        S.link = null;
        render({ keepMessages: true });
      } catch (e) {
        fail(e);
      }
    };
    return section("sec-fleet", FW["local.title"],
      pairs([[FMSG.consoleUrl, origin], [W["dialog.id"], code(l.relayId || "")], [FW["enroll.name"], l.name || ""],
        [FW["enroll.fingerprint"], l.fingerprint ? el("code", { class: "fingerprint" }, clean(l.fingerprint)) : undefined],
        [FMSG.cols.contact, when(l.lastContactAt)], [FW["enroll.scopes"], scopesText(l.scopes)]]),
      req ? sub(FW["local.title"], el("p", null, fill(FW["local.accept-scopes"], { scopes: scopesText(req.requestedScopes) })),
        btn(FD["local-accept-scopes"].button, () => confirmDialog({
          spec: fspec("local-accept-scopes"), vals: { scopes: scopesText(req.requestedScopes) }, name: scopesText(req.requestedScopes), id: req.requestId,
          run: () => one("fleet-link/accept-scopes", { requestId: req.requestId, hash: req.hash }, { action: "fleet.scopes", target: req.requestId }),
          done: () => { S.link = null; render({ keepMessages: true }); },
        }), "primary")) : null,
      sub(FW["local.read-only"], el("p", null, toneChip(onOff(l.readOnly), l.readOnly ? "warn" : "ok")),
        btn(l.readOnly ? FD["local-read-only-off"].button : FD["local-read-only-on"].button, () => confirmDialog({
          spec: fspec(l.readOnly ? "local-read-only-off" : "local-read-only-on"), name: origin, id: l.relayId,
          run: () => one("fleet-link/read-only", { on: !l.readOnly }, { action: "fleet.read-only", target: "-" }),
          done: () => { S.link = null; render({ keepMessages: true }); },
        }))),
      sub(FW["local.confirm-scopes"], el("fieldset", { class: "choice" }, el("legend", { class: "vh" }, FW["local.confirm-scopes"]), confirmBoxes.map((x) => x[1])),
        btn(MSG.save, async () => {
          try {
            await one("fleet-link/confirm-scopes", { scopes: confirmBoxes.filter((x) => x[0].checked).map((x) => x[0].value) }, { action: "fleet.confirm-scopes", target: "-" });
            say(MSG.done);
            S.link = null;
            render({ keepMessages: true });
          } catch (e) {
            fail(e);
          }
        })),
      sub(FW["local.waiting"], dataTable({
        caption: FW["local.waiting"], rows: waiting, empty: MSG.noneYet, name: (w) => w.summary || w.id,
        cols: [{ key: "summary", label: FMSG.change }, { key: "actor", label: FMSG.cols.email }, { key: "at", label: FMSG.asked, cell: (w) => when(w.at) },
          { key: "expires", label: FMSG.cols.ends, cell: (w) => when(w.expires) }, { key: "id", label: W["dialog.id"], cell: (w) => code(w.id) }],
        actions: (w) => [{ label: FD["local-confirm"].button, run: () => confirmDialog({
          spec: fspec("local-confirm"), vals: { summary: w.summary, email: w.actor }, name: w.summary, id: w.id,
          run: () => one("fleet-link/confirm", { id: w.id }, { action: "fleet.confirm", target: w.id }),
          done: () => { S.link = null; render({ keepMessages: true }); },
        }) }, { label: MSG.refuse, run: simple("fleet-link/refuse", { id: w.id }) }],
      })),
      held.length ? sub(FMSG.held, el("ul", { class: "plain" }, held.map((h) => el("li", null, code(h), " ",
        btn(MSG.refuse, simple("fleet-link/refuse-key", { hint: h }), "danger", { "aria-label": MSG.refuse + " " + clean(h) }))))) : null,
      sub(FD["local-trust-ca"].button, gen.box, fp.box, btn(FD["local-trust-ca"].button, () => {
        const g = Number(gen.input.value), f = fp.input.value.trim();
        if (!(Number.isInteger(g) && g >= 1) || !f) {
          invalid(!(Number.isInteger(g) && g >= 1) ? gen.input : fp.input, MSG.need.generation);
          return;
        }
        confirmDialog({
          spec: fspec("local-trust-ca"), vals: { fingerprint: f }, name: FMSG.generation + " " + g, id: f,
          run: () => one("fleet-link/trust-ca", { generation: g, fingerprint: f }, { action: "fleet.ca.trust", target: String(g) }),
          done: () => { S.link = null; render({ keepMessages: true }); },
        });
      })),
      el("div", { class: "wizard-actions" }, btn(FW["local.leave"], () => confirmDialog({
        spec: fspec("local-leave"), vals: { origin }, name: origin, id: l.relayId, danger: true,
        run: () => one("fleet-link/leave", {}, { action: "fleet.left", target: "-" }),
        done: () => { S.link = null; render({ keepMessages: true }); },
      }), "danger")));
  }

  // ---- Search (4.2): header box, "/" focuses it ----
  async function runSearch() {
    const q = $("search").value.trim();
    const box = $("search-results");
    const gen = ++S.searchGen;
    if (q.length < 2) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    try {
      const d = await api("GET", "search?q=" + encodeURIComponent(q));
      if (gen !== S.searchGen) return;
      const hits = (d.hits || []).map((h) => [h, safeGo(h.go)]).filter(([, g]) => g);
      box.replaceChildren(hits.length
        ? el("ul", { "aria-label": "Results" }, hits.map(([h, g]) => el("li", null, el("a", { href: g, "data-act": "search-go" }, u(h.title || h.id),
          el("span", { class: "detail" }, u([stateWord(h.kind), h.detail].filter(Boolean).join(", ")))))))
        : el("p", null, fill(W["search.none"], { q })));
      box.hidden = false;
    } catch (e) {
      if (e.status !== 401) fail(e);
    }
  }

  // ---- Actions (delegated through data-act) ----
  const ACTS = {
    skip: (t, ev) => {
      ev.preventDefault();
      $("main").focus();
    },
    "nav-open": () => {
      $("nav-sheet-nav").replaceChildren(navTree());
      $("nav-sheet").showModal();
      const first = $("nav-sheet-nav").querySelector("a, button");
      if (first) first.focus();
    },
    "nav-close": () => $("nav-sheet").close(),
    "nav-group": (t) => {
      const g = t.getAttribute("data-group");
      const open = t.getAttribute("aria-expanded") !== "true";
      if (open) S.open.add(g);
      else S.open.delete(g);
      t.setAttribute("aria-expanded", open ? "true" : "false");
      const list = $(t.getAttribute("aria-controls"));
      if (list) list.hidden = !open;
    },
    menu: (t) => {
      if (t.getAttribute("aria-expanded") === "true") closeMenus();
      else openMenu(t);
    },
    run: (t) => {
      const fn = RUN[Number(t.getAttribute("data-k"))];
      const menu = t.closest('[role="menu"]');
      if (menu) {
        closeMenus();
        const b = document.querySelector('[aria-controls="' + menu.id + '"]');
        if (b) b.focus();
      }
      if (fn) Promise.resolve().then(fn).catch(fail);
    },
    theme: (t) => {
      const id = t.getAttribute("data-id");
      const T = window.LucidConsoleTheme;
      try {
        window.localStorage.setItem(T ? T.key : "lucid-console-theme", id);
      } catch (e) {
        /* private mode: the choice lasts for this page */
      }
      if (T) T.apply();
      for (const b of $("theme-menu").querySelectorAll('[role="menuitemradio"]')) b.setAttribute("aria-checked", b.getAttribute("data-id") === id ? "true" : "false");
      closeMenus();
      $("theme-btn").focus();
    },
    signout: async () => {
      closeMenus();
      try {
        await api("POST", "logout", {}, { noRedirect: true });
      } catch (e) {
        /* signed out either way */
      }
      toSignIn(null);
      say(MSG.signedOut);
    },
    stay: async () => {
      try {
        await api("GET", "me");
      } catch (e) {
        fail(e);
      }
    },
    relock: () => {
      S.locked = false;
      toSignIn(null);
    },
    "dlg-cancel": () => {
      if (S.dlg && S.dlg.busy) return;
      $("confirm").close();
    },
    "dlg-go": () => dialogGo(),
    "code-go": () => codeGo(),
    "code-cancel": () => $("code-dlg").close(),
    "search-go": () => {
      $("search-results").hidden = true;
    },
  };

  function wire() {
    document.addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-act]");
      if (!ev.target.closest(".menu-wrap")) closeMenus();
      if (!ev.target.closest(".searchbox")) $("search-results").hidden = true;
      if (!t) {
        const a = ev.target.closest("a[href]");
        if (a && $("nav-sheet").open && $("nav-sheet").contains(a)) $("nav-sheet").close();
        return;
      }
      const f = ACTS[t.getAttribute("data-act")];
      if (f) f(t, ev);
    });
    document.addEventListener("keydown", (ev) => {
      if (menuKeys(ev)) return;
      const t = ev.target;
      if (t.getAttribute && t.getAttribute("aria-haspopup") === "menu" && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
        ev.preventDefault();
        openMenu(t, ev.key === "ArrowUp");
        return;
      }
      if (ev.key === "Enter" && t.id === "code-input") {
        ev.preventDefault();
        codeGo();
        return;
      }
      // D-8: Enter in the only field of a confirmation dialog confirms it (a text area keeps Enter for new lines).
      if (ev.key === "Enter" && !ev.isComposing && t.tagName === "INPUT" && $("confirm-fields").contains(t)
        && $("confirm-fields").querySelectorAll("input, select, textarea").length === 1) {
        ev.preventDefault();
        dialogGo();
        return;
      }
      if (ev.key === "Escape" && !$("search-results").hidden) {
        $("search-results").hidden = true;
        $("search").focus();
        return;
      }
      const typing = t.closest && t.closest("input, textarea, select, [contenteditable]");
      if (ev.key === "/" && !typing && !document.querySelector("dialog[open]") && !$("hdr-search").hidden) {
        ev.preventDefault();
        $("search").focus();
      }
    });
    $("search").addEventListener("input", () => {
      clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(runSearch, 250);
    });
    $("confirm").addEventListener("cancel", (ev) => {
      if (S.dlg && S.dlg.busy && !S.code) ev.preventDefault();
    });
    $("confirm").addEventListener("close", dialogClosed);
    $("code-dlg").addEventListener("close", codeClosed);
    $("nav-sheet").addEventListener("close", () => $("menu-btn").focus());
    window.addEventListener("hashchange", () => {
      if (/^#(join|reset|record)=/.test(location.hash)) {
        boot();
        return;
      }
      render({ focus: true });
    });
  }

  async function boot() {
    const h = location.hash || "";
    const link = /^#(join|reset)=/.exec(h);
    const token = link ? new URLSearchParams(h.slice(1)).get(link[1]) : null;
    // AC-2a 3.9: the IDE plugin or the Hub app opens #join=<token>&record=<port>.<nonce>, or #record=<port>.<nonce>
    // for a key added later; the value stays in memory only.
    const rec = /^#(?:join=[^&]*&)?record=/.test(h) ? new URLSearchParams(h.slice(1)).get("record") : null;
    if (recordPort(rec)) S.record = rec;
    // A link works once: off the address bar and out of the history at once.
    if (link || rec) history.replaceState(null, "", location.pathname + location.search);
    try {
      await loadMe();
    } catch (e) {
      // AC-2a 12.1: before bootstrap a fleet console answers only the setup routes; the page shows the setup screen.
      if (e && e.code === "setup-needed") {
        S.me = { product: "fleet", profile: "standard", sections: [] };
        setHeader();
        await renderSetupStart();
        return;
      }
      S.me = S.me || { product: "spokes", profile: "high", sections: ["overview"] };
      setHeader();
      await renderSignIn();
      fail(e);
      return;
    }
    setHeader();
    if (S.record && !link) location.hash = fleet() ? "#/settings/account" : "#/admins/account";
    if (link && token) {
      if (link[1] === "join") await renderJoin(token);
      else renderReset(token);
      return;
    }
    if (me()) {
      touch();
      startIdle();
    }
    await render();
    if (!window.PublicKeyCredential) fail(MSG.noPasskeys);
  }

  if (window.LucidCharts) window.LucidCharts.setWords({ table: FW["charts.table"], noData: FW["charts.no-data"], time: FMSG.time, item: FMSG.cols.name, state: FMSG.cols.state });
  wire();
  boot();
})();
