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
    { id: "nav.security", route: "security", pages: [["approvals", "Approvals"], ["requests", "Requests"], ["audit", "Audit log"], ["settings", "Security settings"], ["exports", "Exports"]] },
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
    cols: { name: "Name", product: "Product", site: "Site or region", version: "Version", license: "License", health: "Health", contact: "Last contact", relay: "Relay",
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
    open: "Open",
    rename: "Rename",
    scopes: "Change scopes",
    replace: "Replace",
    remove: "Remove from the console",
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
    daysField: "Days (30 to 365)",
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
    // AC-2b-D 3: labels the contract leaves to the page.
    deploy: {
      confirmRelay: "Confirm relay", installLicense: "Install a license", copyInstall: "Copy the install command", caFile: "ca.crt", keyFile: "ca.key",
      issuedFile: "issued.json (optional)", crlFile: "crl.pem (optional)", rootFile: "root.pub", subject: "Subject", serial: "Serial", names: "Names",
      kind: { server: "Server", "signer-client": "Certificate server client" }, revokedList: "Revocation list entries", at: "Since", savedRoot: "Saved root",
      caState: { ok: "OK", lost: "Key cannot be opened", unreadable: "Records do not read back" }, confirms: "Confirms", disagrees: "Disagrees",
      certPem: "The ended certificate (PEM)", dismiss: "Dismiss", saveDays: "Save", open: "Open",
    },
  };

  const PAGES = {
    spokes: ["hubs", "spokes", "relays", "seats", "license", "logs", "requests"],
    meet: ["people", "seats", "enrollments", "organizations", "signer", "bridges", "holds", "releases", "push", "identity", "calls", "servers", "license", "logs", "requests"],
    admins: ["people", "sessions", "audit", "settings", "account"],
  };
  const PAGE_LABEL = {
    spokes: Object.fromEntries(PAGES.spokes.map((id, i) => [id, W["nav.spokes.pages"][i]])),
    meet: Object.fromEntries(PAGES.meet.map((id, i) => [id, W["nav.meet.pages"][i]])),
    admins: Object.fromEntries(PAGES.admins.map((id, i) => [id, W["nav.admins.pages"][i]])),
  };
  // What each role below admin may open (2.3, 7.2): user managers the people lists and seats, viewers health and lists.
  const ROLE_PAGES = {
    "user-manager": { spokes: ["hubs", "spokes", "seats"], meet: ["people", "seats"], admins: ["people", "account"] },
    viewer: { spokes: ["hubs", "spokes", "relays", "license"], meet: ["calls", "releases", "license"], admins: ["account"] },
  };
  const PRODUCT_NAME = { spokes: W["nav.spokes"], meet: W["nav.meet"] };
  const ROLE_WORD = { admin: W["role.names"][0], "user-manager": W["role.names"][1], viewer: W["role.names"][2] };
  // The attention kinds of 7.3, for "Email me about" (account.mail).
  const ATTENTION_KINDS = ["license-none", "license-grace", "license-expired", "license-expiring", "seats-high", "seats-over", "uncounted",
    "crl-stale", "signer-unhealthy", "signer-expiring", "cert-expiring", "tls-expiring", "spokes-silent", "enrollments-waiting",
    "approvals-mine", "requests-old", "admins-few", "anchor-single", "admin-suspended", "passkey-waiting", "joiner-waiting",
    "audit-broken", "audit-rotating", "audit-dropped-unexported", "audit-not-exported", "quota-hits", "blocks-active", "admins-unproven",
    "license-stopped", "license-upgrade-period", "seats-unseated", "seats-protected", "profile-standard", "two-person-off",
    "break-glass-missing", "break-glass-used", "key-unattested", "mds-old", "signin-locked", "mail-failing", "clock-uncertain",
    "clock-back", "aaguids-relaxed", "seal-key-file", "seal-lost", "seats-held", "seal-machine-scope"];

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

  // ---- Times: the browser's locale with the time zone named ----
  const FMT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const DFMT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZoneName: "short" });
  const when = (ms) => (ms ? FMT.format(new Date(ms)) : MSG.never);
  const whenSec = (s) => (s ? FMT.format(new Date(s * 1000)) : MSG.never);
  const daySec = (s) => (s ? DFMT.format(new Date(s * 1000)) : MSG.never);
  // Values whose unit the route does not name: milliseconds when large, else seconds.
  const whenAny = (v) => (!v ? MSG.never : v > 1e12 ? when(v) : whenSec(v));
  const dayAny = (v) => (!v ? MSG.never : v > 1e12 ? DFMT.format(new Date(v)) : daySec(v));
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
      throw new ApiError(0, "network", MSG.noAnswer, null);
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
      const err = new ApiError(r.status, code, (data && data.error) || fillText(MSG.httpError, { status: r.status }), data);
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
    $("footer").textContent = W.footer;
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
      if (k === "date" && typeof v === "number") out[k] = dayAny(v);
      else if ((k === "time" || k === "date and time") && typeof v === "number") out[k] = whenAny(v);
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
      filterKids.push(el("div", null, el("span", { class: "note" }, o.chips.label), g));
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
    if (filterKids.length) {
      const narrow = window.matchMedia && window.matchMedia("(max-width: 600px)").matches;
      root.append(el("details", { class: "filters-fold", open: narrow ? null : true }, el("summary", null, MSG.filters), el("div", { class: "filters" }, filterKids)));
    }
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
    for (const f of o.fields || []) fieldsBox.append(field(f, getters, () => refresh()));
    const goBtn = $("confirm-go");
    let asksNow = false;
    function refresh() {
      const cur = values();
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
      return el("div", { class: "field" }, el("label", { for: id }, f.label), s);
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
    if (profile() === "standard") {
      const pw = currentPassword(W["signin.password.field"]);
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
    step.replaceChildren(el("p", null, W["signin.totp"]), c.box, el("div", null, btn(W["signin.totp.button"], async () => {
      clearMessages();
      try {
        await api("POST", "login/totp", { ceremony, code: c.input.value.trim() }, { noRedirect: true });
        await signedIn();
      } catch (e) {
        fail(e);
      }
    }, "primary")));
    stepFocus(step);
  }
  // High with requirePassword: the password after the WebAuthn assertion (3.3 step 3, R3-M1).
  function passwordStep(ceremony, step) {
    const pw = currentPassword(W["signin.password.field"]);
    step.replaceChildren(pw.box, el("div", null, btn(W["signin.password.button"], async () => {
      clearMessages();
      try {
        const r = await api("POST", "login/password", { ceremony, password: pw.input.value }, { noRedirect: true });
        if (r.next === "set-password") setPasswordStep(ceremony, step);
        else await signedIn();
      } catch (e) {
        fail(e);
      }
    }, "primary")));
    stepFocus(step);
  }
  // The restricted setup session: only password.required and the join.password form (login/set-password).
  function setPasswordStep(ceremony, step) {
    const n = minPassword();
    const pw = newPassword(W["join.password.field"], n);
    step.replaceChildren(el("p", null, W["password.required"]), el("h3", null, W["join.password"]),
      el("p", null, fill(W["join.password.body"], { n })), pw.box,
      el("div", null, btn(W["join.password.button"], async () => {
        clearMessages();
        try {
          await api("POST", "login/set-password", { ceremony, password: pw.input.value }, { noRedirect: true });
          await signedIn();
        } catch (e) {
          fail(e);
        }
      }, "primary")));
    stepFocus(step);
  }
  function forgotForm(prefill) {
    RUN = [];
    const email = textField(W["signin.forgot.field"], { type: "email", autocomplete: "username", maxlength: "254" });
    email.input.value = prefill || "";
    const result = el("div", { role: "status" });
    showGate(gateTitle(W["signin.forgot"]), email.box, el("div", null, btn(W["signin.forgot.button"], async () => {
      clearMessages();
      const addr = email.input.value.trim();
      try {
        await api("POST", "recover/begin", { email: addr }, { noRedirect: true });
        result.replaceChildren(el("p", null, fill(W["signin.forgot-sent"], { email: addr })));
      } catch (e) {
        fail(e);
      }
    }, "primary"), " ", btn(W["signin.title"], () => renderSignIn())), result);
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
    showGate(gateTitle(W["reset.title"]), pw.box, el("div", null, btn(W["reset.title.button"], async () => {
      clearMessages();
      try {
        await api("POST", "recover/finish", { token, password: pw.input.value }, { noRedirect: true });
        await renderSignIn();
        say(MSG.done);
      } catch (e) {
        fail(e);
      }
    }, "primary")));
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
        fn = async () => [head(FW["nav.overview"])];
        fail(e);
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
    }
    let kids;
    try {
      kids = await fn(ctx);
    } catch (e) {
      if (gen !== S.gen) return;
      if (e && e.status === 401) return;
      kids = [head(W["nav.overview"])];
      fail(e);
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
      const own = fleet() && (!it.relay || String(it.kind).startsWith("relay-")) ? FW["attention." + it.kind] : null;
      const tpl = own || W["attention." + it.kind];
      if (typeof tpl !== "string") continue;
      const sev = it.severity === "bad" ? "bad" : it.severity === "warn" ? "warn" : "info";
      const target = safeGo(it.go);
      const prefix = fleet() && it.relay && !own ? [u(relayName(it.relay)), ": "] : [];
      const row = it.relay ? (S.relays || []).find((r) => r.id === it.relay) : null;
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
      check: (v) => (!(Number.isInteger(v.hours) && v.hours >= 1 && v.hours <= 720) ? MSG.hours : ""),
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
  function disabledAdd(label) {
    const id = uid("why");
    return el("span", { class: "disabled-add" }, el("button", { type: "button", "aria-disabled": "true", class: "is-disabled", "aria-describedby": id }, label),
      " ", el("span", { class: "note", id }, W["meet.license-inactive"]));
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
    const invite = canWrite() ? btn("Ask an admin to invite someone", () => {
      confirmDialog({
        dlg: "request-invite", vals: {},
        fields: [{ kind: "text", key: "name", label: "Name", maxlength: "80", required: true }, { kind: "text", type: "email", key: "email", label: "Email", maxlength: "254", required: true },
          { kind: "text", type: "number", key: "days", label: "Days the invite works", value: 7, min: "1", max: "30" }, { kind: "reason" }],
        vals2: (v) => ({ name: v.name, email: v.email }),
        check: (v) => (!v.name || !/^[^@\s]+@[^@\s]+$/.test(v.email) ? "Write a name and an email." : ""),
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
          fail(fillText(MSG.wantedNeeded, { users: d.users || 0 }));
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
        { key: "lowering", label: "Pending lowering", cell: (o) => (o.policy && o.policy.pending_lowering ? u(clean(o.policy.pending_lowering.effective_at) + ": " + clean(o.policy.pending_lowering.reason)) : ""), sortable: false }],
    }))];
  };
  function genericTable(caption, rows, empty) {
    const keys = [...new Set(rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))].slice(0, 8);
    return dataTable({
      caption, rows, empty, text: (r) => JSON.stringify(r), name: (r) => String(r[keys[0]] == null ? "" : r[keys[0]]),
      cols: keys.map((k) => ({ key: k, label: stateWord(k), cell: (r) => u(typeof r[k] === "object" && r[k] !== null ? JSON.stringify(r[k]) : r[k] == null ? "" : r[k]) })),
    });
  }
  function objPairs(o) {
    return pairs(Object.entries(o || {}).map(([k, v]) => [stateWord(k), typeof v === "object" && v !== null ? JSON.stringify(v) : typeof v === "boolean" ? yesNo(v) : v]));
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
    return [head(PAGE_LABEL.meet.signer), panel("Signer", objPairs(d.signer)), panel("Revocation", objPairs(d.crl)),
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
    const labels = Object.fromEntries((orgs.organizations || []).map((o) => [o.id, o.label || o.id]));
    const policies = Object.entries(d.policies || {});
    const kids = [head(PAGE_LABEL.meet.bridges), help("help.meet-policies")];
    if (!policies.some(([, p]) => p && p.enabled)) kids.push(panel(null, emptyLine(W["empty.bridges"])));
    for (const [org, p] of policies) {
      const label = labels[org] || org;
      const platforms = (p.partners || []).length ? (p.partners || []).join(", ") : "every partner";
      kids.push(panel(null, el("h3", null, u(label)), el("p", { class: "id-line" }, el("span", { class: "id-label" }, W["dialog.id"]), code(org)), objPairs(p),
        el("div", { class: "page-head" },
          isAdmin() && p.enabled ? btn("Turn off", () => confirmDialog({
            dlg: "bridge-off", vals: { org: label, "platform list": platforms }, name: label, id: org, danger: true, fields: [{ kind: "reason" }],
            run: (v) => post("meet/bridge", { org, policy: Object.assign({}, p, { enabled: false }), reason: v.reason }, { action: "meet.bridge.set", target: org }),
          })) : null,
          canWrite() ? btn("Change", () => bridgeChange(org, label, p)) : null)));
    }
    const rows = a.rows || a.audit || a.entries || [];
    kids.push(panel(null, genericTable("Bridge audit", rows, W["empty.audit"])));
    return kids;
  };
  function bridgeChange(org, label, p) {
    confirmDialog({
      dlg: "bridge-change", vals: { org: label }, name: label, id: org, two: true,
      fields: [{ kind: "textarea", key: "policy", label: "Policy (JSON)", value: JSON.stringify(p, null, 2) }, { kind: "reason" }],
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
        const at = h[i].published > 1e12 ? h[i].published / 1000 : h[i].published;
        if (at >= cut && before && (!after || vcmp(after, before) < 0) && before === next) restored = true;
      }
      if (!restored) return true;
    }
    return false;
  }
  pages.meet_releases = async () => {
    const d = await api("GET", "meet/release");
    const rel = d.release || {};
    const mins = d.minimums || rel.minimum || {};
    const files = rel.files || {};
    const kids = [head(PAGE_LABEL.meet.releases), panel("Latest release", pairs([
      ["Version", rel.version || MSG.never], ["Published", rel.published],
      ...Object.entries(files).map(([plat, f]) => [stateWord(plat), u(clean(f.name) + ", SHA-256 " + clean(f.sha256) + ", " + f.size + " bytes")]),
      rel.ios && rel.ios.version ? ["iPhone", rel.ios.version + " (" + rel.ios.build + ", " + clean(rel.ios.channel) + ")"] : ["iPhone", undefined],
      ["Notes", rel.notes], ["Minimum Hub", mins.hub || ""], ["Minimum iPhone", mins.ios || ""],
    ])), panel(null, dataTable({
      caption: "Minimums, last 10 releases", rows: d.history || [], empty: MSG.noneYet, name: (h) => h.version,
      cols: [{ key: "version", label: "Version" }, { key: "minimum", label: "Minimums", cell: (h) => u(Object.entries(h.minimum || {}).map(([k, v]) => k + " " + v).join(", ")), sortable: false },
        { key: "published", label: "Published", cell: (h) => (h.published > 1e12 ? when(h.published) : whenSec(h.published)) },
        { key: "until", label: "Until", cell: (h) => (h.until ? (h.until > 1e12 ? when(h.until) : whenSec(h.until)) : "") }],
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
      for (const [plat, x] of Object.entries(m.files)) params.push([stateWord(plat) + " installer", x.name], [stateWord(plat) + " SHA-256", code(x.sha256)], [stateWord(plat) + " size", x.size + " bytes"]);
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
  pages.meet_calls = async () => {
    const d = await api("GET", "meet/calls");
    const links = Array.isArray(d.links) ? d.links : Object.entries(d.links || {}).map(([k, v]) => Object.assign({ link: k }, v));
    return [head(PAGE_LABEL.meet.calls), panel("Summary", objPairs(d.summary)), panel(null, genericTable(PAGE_LABEL.meet.calls, links, MSG.noneYet))];
  };
  pages.meet_servers = async () => {
    const d = await api("GET", "meet/servers");
    const s = d.signer || {};
    const files = d.files;
    return [head(PAGE_LABEL.meet.servers),
      panel("Signer", pairs([["Healthy", yesNo(s.healthy)], ["Days left", s.days_left]])),
      panel("Download server", files ? pairs([["State", stateWord(files.state)], ["Since", files.since ? whenSec(files.since) : ""]]) : emptyLine(MSG.unknown),
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
      waiting && mine ? btn(MSG.cancel, async () => {
        try {
          await api("POST", "approvals/cancel", { id: a.id });
          say(MSG.done);
          render({ keepMessages: true });
        } catch (e) {
          fail(e);
        }
      }) : null);
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
    const actions = (p) => {
      if (p.email === myEmail()) return [];
      if (!admin) {
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
    };
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
        { label: MSG.cancelInvite, run: async () => {
          try {
            await api("POST", "invites/revoke", { email: i.email });
            say(MSG.done);
            render({ keepMessages: true });
          } catch (e) {
            fail(e);
          }
        } },
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
  async function endSession(s) {
    try {
      await api("POST", "sessions/end", { id_hint: s.id_hint });
      if (s.current) {
        toSignIn(MSG.signedOut);
        return;
      }
      say(MSG.done);
      render({ keepMessages: true });
    } catch (e) {
      fail(e);
    }
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
      caption: PAGE_LABEL.admins.audit, rows: entries, total: d.total, empty: W["empty.audit"], name: (e) => "#" + e.seq + " " + e.action,
      cols: [{ key: "seq", label: "Entry" }, { key: "ts", label: "Time", cell: (e) => when(e.ts) }, { key: "actor", label: "Actor" }, { key: "role", label: "Role" },
        { key: "ip", label: "Address" }, { key: "action", label: "Action" }, { key: "target", label: "Target" },
        { key: "result", label: "Result", cell: (e) => stChip(e.result, e.result === "ok" ? "ok" : e.result === "refused" || e.result === "failed" ? "bad" : "none") },
        { key: "approval", label: "Approval", cell: (e) => (e.approval ? code(e.approval) : "") }, { key: "stepup", label: "Step-up", cell: (e) => yesNo(e.stepup) },
        { key: "detail", label: "Detail", cell: (e) => u(e.detail ? JSON.stringify(e.detail) : ""), sortable: false }],
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
            fail(MSG.aaguid);
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
            dlg: "metadata", vals: { no: p.no, date: p.nextUpdate || MSG.unknown },
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
          fail(fillText(W["settings.sessions"], { n: "5 to 60", h: "1 to 24" }));
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
      check: (v) => (!v.label ? W["join.label"] : ""),
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
    const boxes = ATTENTION_KINDS.map((k) => {
      const id = uid("mk");
      const c = el("input", { id, type: "checkbox", value: k, checked: chosen.includes(k) ? true : null });
      return [c, el("label", { class: "inline", for: id }, c, stateWord(k))];
    });
    return el("section", { class: "panel", "aria-labelledby": "mail-h" }, el("h3", { id: "mail-h" }, W["account.mail"]),
      el("fieldset", { class: "choice grid" }, el("legend", { class: "vh" }, W["account.mail"]), boxes.map((x) => x[1])),
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
    const keys = ["help.overview", "help.approvals", "help.requests", "help.audit", "help.blocks", "help.security", "help.two-person", "help.banner",
      profile() === "standard" ? "help.aaguids.standard" : "help.aaguids", "help.mds"]
      .concat(fleet() ? [] : product() === "spokes" ? ["help.spokes-elsewhere"] : ["help.seats", "help.meet-signing", "help.meet-policies", "help.id1", "help.push"]);
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
  const relayStateWord = (s) => FW["state." + s] || stateWord(s);
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
      else if (k === "date" && typeof v === "number") out.date = dayAny(v);
      else if ((k === "time" || k === "date and time") && typeof v === "number") out[k] = whenAny(v);
      else if (k === "stopsAt" && typeof v === "number") out["date and time"] = whenAny(v);
      else out[k] = v;
    }
    return out;
  }

  // ---- Routing (12.4 hash routes; AC-1's link routes kept) ----
  async function fleetRoute(r) {
    let [a, b] = r.parts;
    if (a === "approvals") [a, b] = ["security", "approvals"];
    else if (a === "admins") {
      const map = { account: ["settings", "account"], audit: ["security", "audit"], people: ["people"], sessions: ["settings", "console"], settings: ["settings", "console"] };
      [a, b] = map[b] || ["settings", "account"];
    }
    // The enrollment code is shown once (3.1): it leaves memory as soon as its screen is left.
    if (!((a === "relays" && b === "add") || (a === "setup" && b === "relay"))) S.enroll = null;
    if (a === "help") return pages.help;
    if (a === "setup") return isAdmin() ? (c) => setupPage(b || "signin", c) : pages.fleetOverview;
    // AC-2b-D 3.7: the Meeting Hub organization CA page (admin).
    if (a === "license" && b === "meet-ca") return isAdmin() ? pages.fleetMeetCa : pages.fleetOverview;
    const href = a === "relays" && (!b || /^r_/.test(b)) ? "#/relays" : "#/" + a + (b ? "/" + b : "");
    if (!canOpen(href)) return pages.fleetOverview;
    if (a === "people") return pages.fleetPeople;
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
      return { approvals: pages.approvals, audit: pages.admins_audit, settings: pages.fleetSecurity, exports: pages.fleetExports }[b] || pages.approvals;
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
    if (!mine.length) return async () => [head(group === "license" ? FW["nav.license"] : pageLabel(group, pg)), panel(null, emptyLine(MSG.noneYet))];
    const key = group + "/" + pg;
    const want = r.q.get("relay") || S.pick[key] || S.pick[group];
    const allowAll = group === "spokes" && (pg === "hubs" || pg === "spokes");
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
        kids.splice(1, 0, pick);
        return kids;
      } catch (e) {
        // A page whose scope the relay did not give shows fleet.scope-missing (8.3).
        if (e && e.code === "fleet-scope") return [head(group === "license" ? FW["nav.license"] : pageLabel(group, pg)), pick, scopeMissing(group, pg, row, e)];
        throw e;
      }
    };
  }
  function productPageFn(group, pg) {
    const blocks = async (c) => {
      const k = await pages.security(c);
      k[0] = head(pageLabel("spokes", "blocks"));
      return k.slice(0, -1);
    };
    const signer = async (c) => (await pages.meet_signer(c)).concat((await pages.meet_servers(c)).slice(1));
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
  // "Relay: <name>" (fleet.picker), remembered in the hash; "All relays" where the page is a list. The choice applies
  // with Show, so changing the select never moves the page by itself (WCAG 3.2.2).
  function relayPicker(base, rows, cur, allowAll) {
    const id = uid("pick");
    const opts = (allowAll ? [["all", FW["fleet.all"]]] : []).concat(rows.map((x) => [x.id, fillText(FW["fleet.picker"], { name: x.name })]));
    const s = el("select", { id }, opts.map(([v, w]) => el("option", { value: v }, w)));
    s.value = cur;
    return el("div", { class: "picker" }, el("label", { for: id }, FMSG.cols.relay, s),
      btn(MSG.show, () => go(base + (base.includes("?") ? "&" : "?") + "relay=" + encodeURIComponent(s.value))));
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
    return names.length ? el("p", { class: "banner warn", role: "status" }, fill(FW["fleet.missing"], { names: names.join(", ") })) : null;
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
  // The License part of the relay detail (8.2): the service state, why, the stop time, the reminders sent and next,
  // and "Install a license", which works on a stopped relay (11.4).
  function relayLicense(d, l) {
    const s = serviceOf(d) || serviceOf(l);
    const sent = (l && l.reminders) || (s && s.reminders) || [];
    const exp = l && l.license ? l.license.exp : d.license ? d.license.exp : null;
    const next = nextReminder(exp, s, sent);
    const list = sent.map((r) => (MSG.reminderKind[r.kind] || stateWord(r.kind)) + " " + whenAny(r.at)).join(", ");
    return panel(FMSG.cols.license, pairs([[FMSG.cols.license, licenseCell(d)],
      [MSG.serviceWhy, s && s.state === "stopped" ? relayWhy(s) || undefined : undefined]]),
      sent.length || next ? el("p", null, fill(FW["relay.license-reminders"], { list: list || MSG.noneYet, date: next ? when(next) : MSG.never })) : null,
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
    return [
      { label: FMSG.open, run: () => go("#/relays/" + encodeURIComponent(r.id)) },
      r.state === "unconfirmed" ? { label: FD["confirm-relay"].button, run: () => confirmRelay(r.id) } : null,
      live ? { label: FMSG.rename, run: () => labelDialog(r) } : null,
      live ? { label: FMSG.scopes, run: () => go("#/relays/" + encodeURIComponent(r.id) + "?tab=scopes") } : null,
      { label: FMSG.replace, run: () => go("#/relays/add?replaces=" + encodeURIComponent(r.id)) },
      live ? { label: FMSG.remove, run: () => removeRelayDialog(r) } : null,
    ];
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
  function productRelays(group, all, c) {
    const rows = all.filter((x) => x.product === group);
    const title = pageLabel(group, "relays");
    if (!rows.length) return [head(title), panel(null, el("p", null, FW["fleet.no-relays-" + group]), addLink())];
    return [head(title, addLink()), panel(null, relaysTable(rows, title, group, c))];
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
      check: (v) => (!v.fingerprint ? FW["enroll.fingerprint"] : ""),
      run: (v) => post("fleet/relays/confirm", { relay: id, fingerprint: v.fingerprint }, { action: "fleet.relay.confirm", target: id }),
      done: relaysChanged,
    });
  }
  function labelDialog(r) {
    confirmDialog({
      spec: fspec("label"), vals: { name: r.name }, name: r.name, id: r.id,
      fields: [{ kind: "text", key: "name", label: FW["enroll.name"], value: r.name, maxlength: "64", required: true },
        { kind: "text", key: "site", label: FW["enroll.site"], value: r.site || "", maxlength: "64" }],
      check: (v) => (!NAME_RE.test(v.name) ? FW["enroll.name"] : !SITE_RE.test(v.site) ? FW["enroll.site"] : ""),
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
      d.state !== "removed" ? btn(FMSG.rename, () => labelDialog(d)) : null, btn(FMSG.replace, () => go("#/relays/add?replaces=" + encodeURIComponent(id))),
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
      nodes ? [FMSG.nodes, [nodes.hubsOnline + " of " + nodes.hubs + " hubs online", nodes.spokesOnline + " of " + nodes.spokes + " spokes online", nodes.spokesSilent + " silent"].join(", ")] : [FMSG.nodes, undefined],
      svc ? [FMSG.services, [svc.signer ? FMSG.signer + " " + (svc.signer.healthy ? MSG.yes : MSG.no) + (svc.signer.daysLeft != null ? ", " + svc.signer.daysLeft + " " + FMSG.daysWord : "") : null,
        svc.push ? FMSG.push + " " + onOff(svc.push.enabled) + ", " + (svc.push.failed24h || 0) : null].filter(Boolean).join("; ")] : [FMSG.services, undefined],
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
      el("div", { class: "wizard-actions" }, cont)];
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
      }), cont)];
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
    const replaces = el("select", { id: rid }, el("option", { value: "" }, MSG.no), rows.filter((x) => x.product === p).map((x) => el("option", { value: x.id }, fillText(FW["enroll.replaces"], { name: x.name }))));
    replaces.value = f.replaces || "";
    replaces.addEventListener("change", () => {
      f.replaces = replaces.value;
    });
    const kids = [name.box, site.box, el("fieldset", { class: "choice" }, el("legend", null, FW["enroll.scopes"]), boxes.map((x) => x[1])),
      el("div", { class: "field" }, el("label", { for: rid }, FMSG.replace), replaces)];
    let host = null, turn = null, clients = null, pkiGroup = null, lic = null;
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
        kids.push(el("fieldset", { class: "choice" }, el("legend", null, FW["deploy.pki"]), choices,
          ca ? null : el("p", { class: "note" }, high ? FW["meet-ca.high"] : FW["deploy.pki-ca-missing"])));
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
      if (!NAME_RE.test(body.name)) {
        fail(FW["enroll.name"]);
        name.input.focus();
        return;
      }
      if (!SITE_RE.test(body.site)) {
        fail(FW["enroll.site"]);
        return;
      }
      if (body.scopes.includes("read-logs") && !body.scopes.includes("people")) {
        fail(FR["fleet-scope-needs-people"]);
        return;
      }
      if (!installed) {
        const h = host.input.value.trim().toLowerCase();
        if (!(dnsOk(h) || (p === "spokes" && addressOk(h)))) {
          fail(FR["deploy-host"]);
          host.input.focus();
          return;
        }
        const d = { host: h, turnHost: null, clients: null, pki: null, license: lic.value || null };
        if (p === "meet") {
          const t = turn.input.value.trim().toLowerCase();
          if (t && !dnsOk(t) && !addressOk(t)) {
            fail(FR["deploy-host"]);
            turn.input.focus();
            return;
          }
          d.turnHost = t || null;
          if (f.pki !== "console" && f.pki !== "own") {
            fail(FW["deploy.pki"]);
            return;
          }
          d.pki = f.pki;
        } else {
          const list = clients.input.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
          if (!list.length || list.length > 16 || !list.every(cidrOk)) {
            fail(FR["deploy-clients"]);
            clients.input.focus();
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
      }), make)];
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
    }, "primary"))];
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
      kids.push(chartBox("charts.calls", barsOf(FMSG.metric.call_minutes, pointsOf(aMt, "call_minutes", F), range),
        lineOf(FMSG.metric.calls_active, [{ name: FMSG.metric.calls_active, points: pointsOf(aMt, "calls_active", F) }])));
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
      kids.push(chartBox("charts.calls", barsOf(FMSG.metric.call_minutes, p("call_minutes"), range), lineOf(FMSG.metric.calls_active, [{ name: FMSG.metric.calls_active, points: p("calls_active") }])));
    }
    kids.push(chartBox("charts.messages", barsOf(FW["charts.messages"], p("messages"), range)));
    if (d.product !== "meet") kids.push(chartBox("charts.spokes", lineOf(FW["charts.spokes"], ["spokes_busy", "spokes_online", "lanes_busy", "lanes_total"].map((k) => ({ name: FMSG.metric[k], points: p(k) })))));
    kids.push(chartBox("charts.cpu", lineOf(FW["charts.cpu"], [{ name: FMSG.metric.cpu_host, points: p("cpu_host") }, { name: FMSG.metric.cpu_process, points: p("cpu_process") }], { yMax: 100, yFormat: fmtPct })));
    kids.push(chartBox("charts.memory", lineOf(FW["charts.memory"], [{ name: FMSG.metric.mem_host_used, points: p("mem_host_used") }], { yMax: 100, yFormat: fmtPct }),
      lineOf(FMSG.metric.mem_process, [{ name: FMSG.metric.mem_process, points: p("mem_process").map(([t, v]) => [t, Number.isFinite(v) ? v / 1048576 : null]) }], { yFormat: (v) => fmtN(v) + " MiB" })));
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
    const show = btn(MSG.show, () => {
      const p = new URLSearchParams();
      for (const k of PEOPLE_FILTERS) if (f[k].value.trim()) p.set(k, f[k].value.trim());
      const s = p.toString();
      go("#/people" + (s ? "?" + s : ""));
    }, "primary");
    const filters = el("div", { class: "filters" },
      sel("product", FMSG.cols.kind, [["console", FW["people.kind-console"]], ["meet", FW["people.kind-meet"]], ["spokes", FW["people.kind-spokes"]]]),
      sel("relay", FMSG.cols.relay, relays.map((x) => [x.id, x.name])),
      sel("role", FMSG.cols.role, [["admin", ROLE_WORD.admin], ["user-manager", ROLE_WORD["user-manager"]], ["viewer", ROLE_WORD.viewer], ["relay-admin", FMSG.roles["relay-admin"]], ["member", FMSG.roles.member], ["hub-user", FMSG.roles["hub-user"]]]),
      sel("state", FMSG.cols.state, ["active", "suspended", "invited", "waiting", "silent", "blocked", "revoked", "unseated"].map((s) => [s, stateWord(s)])),
      sel("source", FMSG.cols.source, ["invite", "operator", "app", "request", "hub", "sso", "scim"].map((s) => [s, stateWord(s)])),
      el("label", { for: qid }, MSG.filterText, f.q), show);
    const kindWord = (p) => FW["people.kind-" + p.kind] || stateWord(p.kind);
    const roleWord = (p) => ROLE_WORD[p.role] || FMSG.roles[p.role] || stateWord(p.role);
    const actions = (p) => {
      const relay = p.relay ? relays.find((x) => x.id === p.relay) || { id: p.relay, name: relayName(p.relay) } : null;
      if (p.kind === "console") {
        if (p.id === myEmail()) return [];
        const acct = { email: p.id, role: p.role, state: p.state };
        if (!admin && !manageable(acct)) return [];
        return [p.state === "active" ? { label: "Suspend", run: () => suspendDialog(acct, consoleAdmins) } : null,
          p.state === "suspended" ? { label: "Unsuspend", run: () => unsuspendDialog(acct) } : null,
          admin ? { label: MSG.remove, run: () => removeDialog(acct) } : null];
      }
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
    const missing = (d.missing || []).map((m) => relayName(m.relay || m));
    const asOf = [...new Map(rows.filter((p) => p.relay && p.asOf).map((p) => [p.relay, p.asOf])).entries()];
    const kids = [head(FW["people.title"], isManager() ? btn(FW["people.invite"], () => inviteFleet(relays, stopped), "primary") : null),
      missingLine(missing),
      asOf.length ? el("ul", { class: "plain asof" }, asOf.map(([id, t]) => el("li", null, u(relayName(id)), ": ", fill(FW["fleet.as-of"], { time: when(t) })))) : null,
      panel(null, filters, dataTable({
        caption: FW["people.title"], rows, total: d.total, empty: MSG.noneYet, name: personName,
        text: (p) => [p.id, p.name, p.org].join(" "),
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
      check: (v) => (op === "suspend" && !(Number.isInteger(v.hours) && v.hours >= 1 && v.hours <= 720) ? MSG.hours : ""),
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
        { kind: "select", key: "role", label: FMSG.cols.role, options: roles, value: "viewer" },
        meet.length ? { kind: "select", key: "relay", label: FMSG.cols.relay, options: meet.map((x) => [x.id, x.name]), value: meet[0].id } : null,
        { kind: "text", key: "name", label: FMSG.cols.name, maxlength: "80" },
        { kind: "text", type: "number", key: "days", label: FMSG.daysInvite, value: 7, min: "1", max: "30", inputmode: "numeric" }].filter(Boolean),
      vals2: (v) => ({ email: v.email, relay: v.product === "meet" ? relayName(v.relay) : "" }),
      two: (v) => v.product !== "meet" && v.role === "admin",
      check: (v) => (!/^[^@\s]+@[^@\s]+$/.test(v.email) ? MSG.emailNeeded
        : v.product === "meet" && stopped(v.relay) ? W["meet.license-inactive"]
          : v.product === "meet" && (!v.name || !(Number.isInteger(v.days) && v.days >= 1 && v.days <= 30)) ? FMSG.cols.name : ""),
      run: (v) => (v.product === "meet"
        ? fleetPost("fleet/people/invite", { product: "meet", relay: v.relay, email: v.email, name: v.name, role: "member", days: v.days }, { action: "people.invite", target: v.email }, [v.relay])
        // Console accounts are AC-1's `admins/invite` with the console's own step-up (fleet/people/invite takes only
        // Meeting Hub people, with a fleet step-up).
        : post("admins/invite", { email: v.email, role: v.role }, { action: "admins.invite", target: v.email })),
      done: (r) => showLink(r, r && r.mailed ? r.email || null : null),
    });
  }
  // A Seats strip per Meeting Hub relay (11.4): seated of the license's users (no total without a license), the clock
  // while over, and, while the relay is stopped for its license, seats.stopped with the invite disabled.
  async function seatStrips(mrel, stopped) {
    if (!mrel.length) return null;
    let lic = null;
    try {
      lic = await api("GET", "fleet/licenses", null, { direct: true, activity: false });
    } catch (e) {
      lic = null;
    }
    const byRelay = new Map(((lic && lic.relays) || []).map((x) => [x.relay, x]));
    return panel(W["nav.meet.pages"][1], el("ul", { class: "checklist" }, mrel.map((x) => {
      const l = byRelay.get(x.id) || {};
      const s = l.seats || {};
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
    return [head(FW["nav.license"]), panel(null, dataTable({
      caption: FW["nav.license"], rows, empty: MSG.noneYet, name: (x) => relayName(x.relay),
      cols: [{ key: "relay", label: FMSG.cols.relay, cell: (x) => u(relayName(x.relay)) }, { key: "product", label: FMSG.cols.product, cell: (x) => productWord(x.product) },
        { key: "state", label: FMSG.cols.state, cell: (x) => stateWord((x.license || {}).state || "none"), sort: (x) => (x.license || {}).state },
        { key: "users", label: "Users", cell: (x) => (x.license && x.license.users != null ? (x.license.used || 0) + " of " + x.license.users : "") },
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
          return sent.length || next ? el("span", null, fill(FW["relay.license-reminders"], { list: sent.map((r) => (MSG.reminderKind[r.kind] || stateWord(r.kind)) + " " + whenAny(r.at)).join(", ") || MSG.noneYet,
            date: next ? when(next) : MSG.never })) : "";
        } }],
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
    const ca = section("meet-ca-h", FW["meet-ca.title"], el("p", null, high ? FW["meet-ca.high"] : el("a", { href: "#/license/meet-ca" }, FW["meet-ca.title"])));
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
      check: (v) => (!serial && !/^[0-9a-fA-F]{2,64}$/.test(v.serial || "") ? FMSG.deploy.serial : ""),
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
      check: (v) => (!pemDer(v.certPem, "CERTIFICATE") ? FMSG.deploy.certPem : ""),
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
      actions: (l) => (admin ? [{ label: MSG.remove, run: async () => {
        try {
          await post("fleet/licenses/library", { remove: l.id }, { action: "fleet.license.library", target: l.id });
          say(MSG.done);
          render({ keepMessages: true });
        } catch (e) {
          fail(e);
        }
      } }] : []),
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
      spec: fspec("token"), vals: { label: "", relays: FMSG.relaysAll, days: 365 },
      fields: [{ kind: "text", key: "label", label: FMSG.label, maxlength: "64", required: true },
        { kind: "select", key: "relays", label: FMSG.cols.count, options: [["all", FMSG.relaysAll]].concat(relays.map((x) => [x.id, x.name])), value: "all" },
        { kind: "text", type: "number", key: "days", label: FMSG.daysField, value: 365, min: "30", max: "365", inputmode: "numeric" }],
      vals2: (v) => ({ label: v.label, relays: relaysWord(v.relays), days: v.days }),
      check: (v) => (!v.label || v.label.length > 64 ? FMSG.label : !(Number.isInteger(v.days) && v.days >= 30 && v.days <= 365) ? FMSG.daysField : ""),
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
        { key: "expires", label: FMSG.cols.ends, cell: (t) => when(t.expires) }, { key: "lastUsedAt", label: "Last used", cell: (t) => when(t.lastUsedAt) }],
      actions: (t) => [{ label: FMSG.revoke, run: async () => {
        try {
          await api("POST", "settings/exports/token/revoke", { hint: t.hint }, { direct: true });
          say(MSG.done);
          render({ keepMessages: true });
        } catch (e) {
          fail(e);
        }
      } }],
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
          }), "danger") : null))];
  };

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
    return [head(title), panel(null, el("ul", { class: "checklist" }, SETUP_STEPS.filter(([id]) => steps[id]).map(([id, n, word]) => el("li", null,
      el("span", { class: "words" }, fillText(FW["setup.step"], { n }), ": ", FW[word]),
      toneChip(FW["setup.state-" + steps[id]] || stateWord(steps[id]), steps[id] === "done" ? "ok" : "warn"),
      el("a", { href: "#/setup/" + id }, FW["setup.continue"])))))];
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
          fail(FW["setup.code-field"]);
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
            fail(FMSG.adminKeys);
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
          fail(FMSG.generation);
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
