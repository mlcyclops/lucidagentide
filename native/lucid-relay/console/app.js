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
    "banner.grace": "The license ended on <date>. This console keeps working for <n> more days. Install a new license.",
    "banner.expired": "The license and its grace days are over. <product> pages are read-only until a new license is installed.",
    "banner.license-inactive": "The Meeting Hub license is not active, so no one new can be added. People who already have a seat keep using Meeting Hub. Install a license to add people again.",
    "banner.upgrade-period": "This relay needs a Meeting Hub license. People can be added until <date>; after that no one new can be added until a license is installed. People who already have a seat keep using Meeting Hub.",
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
    "attention.license-grace": "The license ended. <n> grace days left.",
    "attention.license-expired": "The license and its grace days are over.",
    "attention.license-expiring": "The license ends in <n> days.",
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
    "attention.license-adding-off": "No one new can be added to Meeting Hub: the license is not active.",
    "attention.license-upgrade-period": "Install a Meeting Hub license by <date>, or no one new can be added after that.",
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
    "seats.last-license": "No Meeting Hub license is active. Seats still follow the last license, which covered <users> people.",
    "seats.no-license": "This relay has never had a Meeting Hub license. The <seated> people it has keep their seats, and no one new can be added until a license is installed.",
    "seats.no-license.upgrade": "This relay has no Meeting Hub license yet. People can be added until <date>.",
    // 8.1 "Words the Meeting Hub relay answers people": also the words beside disabled add controls (R41-1).
    "meet.license-inactive": "Your organization's Meeting Hub license is not active, so no one new can be added. Ask your admin.",
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
        "Every hub needs a new license seat from the root before it is admitted again."],
      meet: ["People can be added to Meeting Hub again.",
        "The upgrade period ends now: this license lasts past <date>.",
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
    adding: { open: "Open", closed: "Closed", "upgrade-period": "Open in the upgrade period, with no seat limit" },
    addingLabel: "Adding people",
    lastUsers: "Seat limit from the last license",
    wantedNeeded: "Write a number of seats above the license's <users>, at most 10,000.",
    emailNeeded: "Write an email.",
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
    "license-adding-off", "license-upgrade-period", "seats-unseated", "seats-protected", "profile-standard", "two-person-off",
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
  function passkeyError(e) {
    const err = new Error(e && (e.name === "NotAllowedError" || e.name === "AbortError") ? MSG.passkeyClosed : (e && e.message) || MSG.passkeyClosed);
    err.passkey = true;
    return err;
  }

  // ---- State ----
  const S = {
    me: null, overview: null, ovAt: 0, settings: null, gen: 0, timer: 0, idleTimer: 0, lastAct: 0, warned: false, locked: false,
    bannerOk: false, open: new Set(), dlg: null, code: null, searchTimer: 0, searchGen: 0, auditBroken: false,
  };
  let RUN = [];
  const reg = (fn) => {
    RUN.push(fn);
    return String(RUN.length - 1);
  };
  const product = () => (S.me && S.me.product) || "spokes";
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
  const locked = () => !!(S.me && (S.me.sections || []).includes("security"));
  const licState = () => (S.overview && S.overview.license ? S.overview.license.state : null);
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
  async function api(method, path, body, opts) {
    const o = opts || {};
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
    const st = await stepup(bind.action, bind.target, bind.params || body);
    return api("POST", path, Object.assign({}, body, { stepup: st }), opts);
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
      S.overview = await api("GET", "overview", null, { activity: false });
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
    chip.textContent = info ? W["product." + product()] : "";
    chip.hidden = !info;
    const prof = $("hdr-profile");
    prof.textContent = info ? (profile() === "standard" ? W["profile.chip.standard"] : W["profile.chip"]) : "";
    prof.hidden = !info;
    $("hdr-search").hidden = !signed;
    $("search").setAttribute("placeholder", product() === "spokes" ? W["search.placeholder.spokes"] : W["search.placeholder"]);
    $("account-wrap").hidden = !signed;
    $("account-email").textContent = signed ? clean(myEmail()) : "";
    if (signed) $("account-btn").setAttribute("aria-label", W["account.menu"][0] + ": " + clean(myEmail()));
    else $("account-btn").removeAttribute("aria-label");
    $("hdr-approvals").hidden = !(signed && isAdmin() && (info.sections || []).includes("approvals"));
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
  function navTree() {
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
      // A disabled item (R41-1) stays focusable with aria-disabled and carries its reason beside the label.
      if (it.disabled) {
        ul.append(el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", tabindex: "-1", "aria-disabled": "true", class: "is-disabled" },
          it.label, el("span", { class: "menu-note" }, it.disabled))));
      } else ul.append(el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", tabindex: "-1", "data-act": "run", "data-k": reg(it.run) }, it.label)));
    }
    return el("div", { class: "menu-wrap" }, b, ul);
  }
  function buildAccountMenu() {
    const m = $("account-menu");
    const [account, helpWord, out] = W["account.menu"];
    m.replaceChildren(
      el("li", { role: "none" }, el("a", { role: "menuitem", tabindex: "-1", href: "#/admins/account" }, account)),
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
  function licenseBanner(lic) {
    if (!lic) return null;
    if (lic.state === "grace") {
      const ended = lic.exp ? daySec(lic.exp) : "";
      return banner("warn", MSG.sev.warn, fill(W["banner.grace"], { date: ended, n: lic.daysLeft }), " ", el("a", { href: "#/license" }, W["license.install"]));
    }
    if (lic.state === "expired") return banner("bad", MSG.sev.bad, fill(W["banner.expired"], { product: PRODUCT_NAME[product()] }), " ", el("a", { href: "#/license" }, W["license.install"]));
    return null;
  }
  // Attention and banner arguments: dates and times formatted, n defaulting to days.
  function argsOf(args) {
    const out = { product: PRODUCT_NAME[product()] };
    for (const [k, v] of Object.entries(args || {})) {
      if (k === "date" && typeof v === "number") out[k] = dayAny(v);
      else if (k === "time" && typeof v === "number") out[k] = whenAny(v);
      else out[k] = v;
    }
    if (out.n == null && out.days != null) out.n = out.days;
    return out;
  }
  // The 7.2 banners under the header on every page: the relay's (overview "banners") and the session's reduced rights.
  const BANNER_TONE = { "banner.seats-over": "bad", "banner.license-inactive": "bad", "breakglass.gate": "bad", "attention.clock-uncertain": "bad" };
  // banner.license-inactive shows on Overview and every Meeting Hub page (7.2, R41-1); the others on every page.
  const MEET_ONLY_BANNERS = ["banner.license-inactive"];
  function bannerNodes() {
    const out = [];
    const where = parseHash().parts[0];
    const meetPage = where === "overview" || where === "meet" || where === "license";
    const why = me() ? me().rightsWhy : null;
    if (why === "not-attested") out.push(banner("warn", MSG.sev.warn, W["high.viewer-rights"]));
    if (why === "not-device-anchored") out.push(banner("warn", MSG.sev.warn, W["meet.viewer-rights"]));
    for (const b of (S.overview && S.overview.banners) || []) {
      if (!b || b.id === "high.viewer-rights" || b.id === "meet.viewer-rights") continue;
      if (MEET_ONLY_BANNERS.includes(b.id) && !meetPage) continue;
      const tpl = W[b.id];
      if (typeof tpl !== "string") continue;
      const tone = BANNER_TONE[b.id] || "warn";
      const extra = [];
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
    const st = { q: o.q || "", chip: o.chip || "", sel: o.sel || "", sort: o.sortKey || null, dir: o.sortDir || 1, shown: PAGE_SIZE };
    const root = el("div", { class: "datatable" });
    const out = el("div");
    let input = null, select = null;
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
    function syncChips() {
      for (const b of chipBtns) b.setAttribute("aria-pressed", b.getAttribute("data-v") === st.chip ? "true" : "false");
    }
    if (filterKids.length) {
      const narrow = window.matchMedia && window.matchMedia("(max-width: 600px)").matches;
      root.append(el("details", { class: "filters-fold", open: narrow ? null : true }, el("summary", null, MSG.filters), el("div", { class: "filters" }, filterKids)));
    }
    root.append(out);
    const active = () => !!(st.q || st.chip || st.sel);
    function rows() {
      const q = st.q.trim().toLowerCase();
      let list = o.rows.filter((r) => (!q || (o.text ? o.text(r) : "").toLowerCase().includes(q))
        && (!st.chip || (o.chips && o.chips.of(r) === st.chip))
        && (!st.sel || (o.select && o.select.of(r) === st.sel)));
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
    function refresh() {
      const cur = values();
      const spec = o.spec || D[o.dlgFor ? o.dlgFor(cur) : o.dlg];
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
      S.dlg && (S.dlg.asks = asks);
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
    for (const [k, v] of o.params || []) params.append(el("dt", null, k), el("dd", null, v instanceof Node ? v : u(v == null ? "" : v)));
    params.hidden = !(o.params && o.params.length);
    $("confirm-error").textContent = "";
    refresh();
    const opener = o.opener || document.activeElement;
    closeMenus();
    d.showModal();
    $("confirm-title").focus();
    return new Promise((resolve) => {
      S.dlg = { o, resolve, opener, values, busy: false };
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
    kids.push(step, el("p", { class: "note" }, W["signin.none." + product()]));
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
    touch();
    startIdle();
    setHeader();
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
            return api("POST", "register/finish", { ceremony: b.ceremony, credential: credJSON(cred), label: lbl.input.value.trim() || MSG.kinds[kind] }, { noRedirect: true });
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
      "search-results", "hdr-host", "hdr-product", "hdr-profile", "account-email", "account-menu", "hdr-approvals-n"]) $(id).replaceChildren();
    $("search").value = "";
    $("code-input").value = "";
    $("search-results").hidden = true;
    $("idle-warn").hidden = true;
    $("account-btn").removeAttribute("aria-label");
    $("hdr-approvals").removeAttribute("aria-label");
    for (const id of ["hdr-search", "account-wrap", "hdr-approvals", "menu-btn", "nav", "hdr-product", "hdr-profile"]) $(id).hidden = true;
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
    if (isAdmin() && !S.settings) await loadSettings();
    if (a !== "overview") await loadOverview(false);
    if (gen !== S.gen) return;
    renderNav();
    if ($("nav-sheet").open) $("nav-sheet").close();
    const ctx = { q: r.q, gen, user: o.auto !== true, sub: r.parts[2] || "" };
    let fn = pages.overview;
    if (a === "overview") fn = pages.overview;
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
      const tpl = W["attention." + it.kind];
      if (typeof tpl !== "string") continue;
      const sev = it.severity === "bad" ? "bad" : it.severity === "warn" ? "warn" : "info";
      const target = safeGo(it.go);
      ul.append(el("li", { class: "sev-" + sev }, el("span", { class: "st st-" + (sev === "info" ? "none" : sev) }, MSG.sev[sev]),
        el("span", { class: "words" }, fill(tpl, argsOf(it.args))), target && canOpen(target) ? el("a", { href: target }, MSG.go) : null));
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
    return [head(W["nav.overview"]), help("help.overview"), licenseBanner(o.license), cards,
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
    kids.push(licenseBanner(l));
    if (l) {
      kids.push(panel(null, pairs([
        ["Organization", l.org], ["Product", l.product === "meet" ? W["nav.meet"] : W["nav.spokes"]], ["Edition", l.edition],
        ["Users", l.used + " of " + l.users], ["Relays", l.relays], ["State", stateWord(l.state)], ["Days left", l.daysLeft],
        ["Ends", daySec(l.exp)], ["Grace days", l.graceDays], [W["dialog.id"], code(l.id)], ["Development license", l.dev ? MSG.yes : undefined],
      ])));
    } else kids.push(panel(null, emptyLine(fillText(W["attention.license-none"], { product: PRODUCT_NAME[product()] }))));
    // Meeting Hub (R41-1): the license limits adding people, never seated people's service.
    if (d.adding) {
      kids.push(panel(null, pairs([[MSG.addingLabel, MSG.adding[d.adding.state] || stateWord(d.adding.state)],
        ["Upgrade period ends", d.adding.upgradePeriodEnds ? when(d.adding.upgradePeriodEnds) : undefined],
        [MSG.lastUsers, d.adding.lastUsers != null && !(l && (l.state === "valid" || l.state === "grace")) ? d.adding.lastUsers : undefined]])));
    }
    if (isAdmin()) {
      const { box, area } = pasteOrFile(W["license.install.field"], ".lic,.txt");
      const install = btn(W["license.install.button"], () => installLicense(area.value, l, d.adding), "primary");
      kids.push(panel(W["license.install"], box, install));
    }
    return kids;
  };
  // The Meeting Hub lines of the license dialog (8.2, R3-L4, R3-M4, R41-1): adding reopens, the upgrade period, the
  // seat clock. `svc` is the license answer's `adding`.
  function meetLicenseLines(p, svc, seats) {
    const M = D.license.meet;
    const lines = [];
    const graceEnd = (p.exp || 0) + (p.graceDays != null ? p.graceDays : 14) * 86400;
    if (svc && svc.state === "closed") lines.push(M[0]);
    if (svc && svc.upgradePeriodEnds) {
      const ends = svc.upgradePeriodEnds / 1000;
      lines.push(fill(graceEnd >= ends ? M[1] : M[2], { date: daySec(ends) }));
    }
    if (seats) {
      const users = p.users || 0;
      const seated = seats.seated || 0;
      const vals = { seated, users, day: seats.clock ? seats.clock.day : 0 };
      if (seated > users) lines.push(fill(seats.clock ? M[4] : M[3], vals));
      else if (seats.clock) lines.push(fill(M[5], vals));
      if (seats.unseated > 0 && users > seated) lines.push(fill(M[6], { n: Math.min(seats.unseated, users - seated) }));
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
    const grace = (p.graceDays != null ? p.graceDays : 14) * 86400;
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

  // ---- Meeting Hub growth gate (R41-1): while adding is closed, add-people controls show disabled with the words ----
  async function meetLicense() {
    try {
      return await api("GET", "license");
    } catch (e) {
      return null;
    }
  }
  const addingClosed = (lic) => !!(lic && lic.adding && lic.adding.state === "closed");
  // A new principal has no unrevoked device on this relay (2.4).
  const isNewPrincipal = (p) => !p || !(p.devices || []).some((d) => !d.revoked);
  function disabledAdd(label) {
    const id = uid("why");
    return el("span", { class: "disabled-add" }, el("button", { type: "button", "aria-disabled": "true", class: "is-disabled", "aria-describedby": id }, label),
      " ", el("span", { class: "note", id }, W["meet.license-inactive"]));
  }

  // ---- Meeting Hub pages (7.4) ----
  const PERSON_STATES = [["online", "Online"], ["joined", "Joined"], ["waiting", "Waiting"], ["approved", "Approved"], ["invited", "Invited"], ["expired", "Expired"]];
  const lastSeenOf = (p) => Math.max(0, ...(p.devices || []).map((d) => d.lastSeenAt || 0)) || null;
  pages.meet_people = async (c) => {
    const [d, orgs, lic] = await Promise.all([api("GET", "meet/people?limit=500"), isAdmin() ? api("GET", "meet/organizations").catch(() => ({ organizations: [] })) : { organizations: [] },
      isAdmin() ? meetLicense() : null]);
    const closed = isAdmin() && addingClosed(lic);
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
          closed && isNewPrincipal(p) ? disabledAdd("Put in an organization") : canWrite() ? btn("Put in an organization", () => orgSet(p, orgList)) : null,
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
    const invite = closed ? disabledAdd("Ask an admin to invite someone") : canWrite() ? btn("Ask an admin to invite someone", () => {
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
    // R41-1: with no fitting license in force the limit is the last license's users (seats.last-license); a relay that
    // never had a license shows seats.no-license (its upgrade-period form while the period runs) instead of the summary.
    const adding = (lic && lic.adding) || {};
    const fitting = !!(lic && lic.license && (lic.license.state === "valid" || lic.license.state === "grace"));
    const never = !!lic && !lic.license && adding.lastUsers == null;
    let summary;
    if (never && adding.state === "upgrade-period") summary = [el("p", null, fill(W["seats.no-license.upgrade"], { date: dayAny(adding.upgradePeriodEnds) }))];
    else if (never) summary = [el("p", null, fill(W["seats.no-license"], { seated: d.seated }))];
    else {
      const users = !fitting && adding.lastUsers != null ? adding.lastUsers : d.users;
      summary = [el("p", null, fill(W["seats.summary"], { seated: d.seated, users })),
        !fitting && adding.lastUsers != null ? el("p", null, fill(W["seats.last-license"], { users: adding.lastUsers })) : null];
    }
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
    const [d, lic] = await Promise.all([api("GET", "meet/enrollments"), meetLicense()]);
    const rows = d.waiting || [];
    // While adding is closed (R41-1), approving a new principal's enrollment shows disabled with the words.
    const closed = addingClosed(lic);
    let known = new Set();
    if (closed) {
      try {
        known = new Set(((await api("GET", "meet/people?limit=500")).people || []).filter((p) => !isNewPrincipal(p)).map((p) => p.principal));
      } catch (e) {
        known = new Set();
      }
    }
    const blocksNew = (w) => closed && !known.has(w.principal);
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
        if (blocksNew(w)) return [{ label: "Ask an admin to approve", disabled: W["meet.license-inactive"] }, canWrite() ? { label: "Ask an admin to refuse", run: () => ask(w, "refuse") } : null];
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
      run: () => post("approvals/approve", { id: a.id }, { action: "approvals.approve", target: a.id, params: a.params || {} }),
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
    const t1 = el("a", { href: "#/approvals", "aria-current": tab === "mine" ? "page" : null, class: "btn" }, MSG.waitingFor);
    const t2 = el("a", { href: "#/approvals?tab=all", "aria-current": tab === "all" ? "page" : null, class: "btn" }, MSG.allApprovals);
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
      go("#/admins/audit" + (s ? "?" + s : ""));
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
    return [head(PAGE_LABEL.admins.settings), settingsSecurity(d, tSec, clock), settingsSignIn(d, tSign), settingsEmail(d, tMail),
      meet ? settingsLicense(d, tLic) : null, settingsLinks(d, tOther)];
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
          run: (v) => post("settings/profile", { profile: high ? "standard" : "high", reason: v.reason }, { action: "settings.profile", target: "-" }),
          done: settingsDone,
        }))),
      sub(W["settings.two-person"], el("p", null, stChip(on ? MSG.on : MSG.off, on ? "ok" : "warn")), el("p", { class: "note" }, W["help.two-person"]),
        btn(on ? MSG.turnOff : MSG.turnOn, () => confirmDialog({
          dlg: on ? "two-person-off" : "two-person-on", two: on, always: on, danger: on, fields: [{ kind: "reason" }],
          run: (v) => post("settings/two-person", { twoPerson: on ? "off" : "on", reason: v.reason }, { action: "settings.two-person", target: "-" }),
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
        clockHold(clock), btn(W["clock.title.button"], () => confirmTime(clock))) : null);
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
        return api("POST", "passkeys/add/finish", { ceremony: b.ceremony, credential: credJSON(cred), label: v.label || MSG.kinds.passkey });
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
        return api("POST", "account/security-key/finish", { ceremony: b.ceremony, credential: credJSON(cred), label: v.label || MSG.kinds["security-key"] });
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
      if (/^#(join|reset)=/.test(location.hash)) {
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
    // A link works once: off the address bar and out of the history at once.
    if (link) history.replaceState(null, "", location.pathname + location.search);
    try {
      await loadMe();
    } catch (e) {
      S.me = S.me || { product: "spokes", profile: "high", sections: ["overview"] };
      setHeader();
      await renderSignIn();
      fail(e);
      return;
    }
    setHeader();
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

  wire();
  boot();
})();
