// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

/* Lucid Meet password sign-in: one page for /meet/join (accept an invite: choose a username
 * and a password, or set a new password) and /meet/signin (sign in on the web and get a code
 * to paste into Lucid Meet). The invite token comes from the URL fragment (#t=...), which
 * browsers never send to a server. No inline script (the CSP allows only this file); every
 * value from the server is shown as text. */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const SECTIONS = ["join", "join-done", "signin", "signin-done"];
  const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  const DEVICES = { computer: "your computer", iphone: "your iPhone" };

  function show(id, title) {
    $("loading").hidden = true;
    SECTIONS.forEach((s) => { $(s).hidden = s !== id; });
    if (title) {
      $("title").textContent = title;
      document.title = `${title} | Lucid Meet`;
    }
  }

  // One message area (role alert): errors stay until the next action.
  function say(text) {
    const m = $("message");
    m.textContent = text || "";
    m.hidden = !text;
  }

  async function post(path, body) {
    let resp;
    try {
      resp = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), credentials: "omit", cache: "no-store", redirect: "error",
      });
    } catch (e) {
      throw new Error("The server cannot be reached. Check your internet connection and try again.");
    }
    let data = {};
    try { data = await resp.json(); } catch (e) { data = {}; }
    if (!resp.ok) {
      const err = new Error(data.error || `Something went wrong (the server answered ${resp.status}). Try again in a few minutes.`);
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  // A submit button refuses clicks while its request runs.
  async function busy(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    say("");
    try { await fn(); } catch (e) { say(e.message || "Something went wrong."); } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function day(ts) {
    const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
    return isNaN(d.getTime()) ? "" : d.toLocaleString();
  }

  // ---- accept an invite -------------------------------------------------------------------
  function joinToken() {
    // the fragment stays in the address bar so a reload still works; it is never sent
    return new URLSearchParams(location.hash.replace(/^#/, "")).get("t") || "";
  }

  // The rules the server checks too; here they only explain early.
  function passwordProblem(password, username, email) {
    if (password.length < 12) return "The password needs at least 12 characters.";
    if (password.length > 256) return "The password can have 256 characters at most.";
    const low = password.toLowerCase();
    const local = (email || "").split("@")[0].toLowerCase();
    for (const part of [username.toLowerCase(), local]) {
      if (part && (low === part || (part.length >= 3 && low.includes(part)))) {
        return "The password must not contain your username or your email address.";
      }
    }
    return "";
  }

  async function startJoin() {
    const token = joinToken();
    show("join", "Welcome to Lucid Meet");
    $("join-form").hidden = true;
    if (!token) {
      say("This link is incomplete. Open the link from your invitation email again, or ask your administrator for a new one.");
      return;
    }
    let info;
    try {
      info = await post("/meet/api/join/info", { token });
    } catch (e) {
      say(e.message);
      return;
    }
    const first = String(info.name || "").split(/\s+/)[0] || "there";
    const user = $("join-username");
    if (info.reset) {
      show("join", "Set a new password");
      $("join-who").textContent = `Hi ${first}. Choose a new password for your Lucid Meet account. Your username stays ${info.username_suggestion}.`;
      user.value = info.username_suggestion || "";
      user.readOnly = true;
      $("join-submit").textContent = "Save my new password";
    } else {
      $("join-who").textContent = `Hi ${first} (${info.email}). Choose the username and password you will sign in to Lucid Meet with.`;
      user.value = info.username_suggestion || "";
    }
    $("join-form").hidden = false;
    (info.reset ? $("join-password") : user).focus();

    $("join-show").addEventListener("change", () => {
      const type = $("join-show").checked ? "text" : "password";
      $("join-password").type = type;
      $("join-confirm").type = type;
    });
    $("join-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy($("join-submit"), async () => {
        const username = user.value.trim().toLowerCase();
        const password = $("join-password").value;
        if (!USERNAME.test(username)) {
          user.focus();
          throw new Error("Choose a username of 3 to 32 lower-case letters, digits, dots, dashes or underscores, starting with a letter or a digit.");
        }
        const problem = passwordProblem(password, username, info.email);
        if (problem) {
          $("join-password").focus();
          throw new Error(problem);
        }
        if (password !== $("join-confirm").value) {
          $("join-confirm").focus();
          throw new Error("The two passwords are not the same.");
        }
        const out = await post("/meet/api/join", { token, username, password });
        $("join-password").value = "";
        $("join-confirm").value = "";
        joinDone(out, info.reset);
      });
    });
  }

  function joinDone(out, reset) {
    show("join-done", reset ? "Your new password is set" : "Your account is ready");
    $("done-lede").textContent = reset
      ? `Sign in to Lucid Meet as ${out.username} with your new password.`
      : `Welcome, ${String(out.name || "").split(/\s+/)[0] || out.username}. Here is how to set up Lucid Meet.`;
    $("done-org").textContent = out.org;
    $("done-username").textContent = out.username;
    $("done-open").href = `lucidmeet://signin?o=${encodeURIComponent(out.org)}&u=${encodeURIComponent(out.username)}`;
    $("title").focus();
  }

  // ---- sign in on the web -----------------------------------------------------------------
  function startSignin() {
    show("signin", "Sign in to Lucid Meet");
    $("signin-username").focus();
    $("signin-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy($("signin-submit"), async () => {
        const checked = document.querySelector('input[name="platform"]:checked');
        const platform = checked ? checked.value : "computer";
        const out = await post("/meet/api/signin", {
          username: $("signin-username").value.trim(),
          password: $("signin-password").value,
          platform, label: "",
        });
        $("signin-password").value = "";
        signinDone(out, platform);
      });
    });
    $("copy").addEventListener("click", async () => {
      const code = $("code");
      try {
        await navigator.clipboard.writeText(code.value);
        $("copy").textContent = "Copied";
        setTimeout(() => { $("copy").textContent = "Copy the code"; }, 2000);
      } catch (e) {
        code.focus();
        code.select();
        say("Copying did not work here. The code is selected: copy it with your keyboard or the menu.");
      }
    });
    $("again").addEventListener("click", () => {
      $("code").value = "";
      say("");
      show("signin", "Sign in to Lucid Meet");
      $("signin-password").focus();
    });
  }

  function signinDone(out, platform) {
    show("signin-done", "Your code is ready");
    const device = DEVICES[platform] || "your device";
    $("code-lede").textContent = `Signed in as ${out.name}. This code sets up Lucid Meet on ${device}. It works once, on one device.`;
    $("code").value = out.code;
    $("code-device").textContent = device;
    $("code-approval").textContent = out.approval === "auto"
      ? "Lucid Meet then sets itself up. No one needs to approve it."
      : "An administrator then approves this device. Until then Lucid Meet shows \"Waiting for an administrator to approve this device\".";
    const until = day(out.expires);
    $("code-expires").textContent = until ? `Use the code before ${until}. Sign in again for another device.` : "";
    $("copy").textContent = "Copy the code";
    $("title").focus();
  }

  // ---- the organization's brand (contract TH-1 section 5) ---------------------------------
  // The standard Lucid theme shows until the brand answers, and stays on any failure; joining never waits for it.
  // Colors go through the CSSOM (allowed by style-src 'self'); every text from the server is set as text.
  const COLOR = /^#[0-9a-f]{6}$/;
  const LIGHT = "(prefers-color-scheme: light)";

  // `hex` moved `share` of the way toward white or black.
  function mix(hex, toward, share) {
    const n = parseInt(hex.slice(1), 16);
    const end = toward === "white" ? 255 : 0;
    return "#" + [n >> 16, (n >> 8) & 255, n & 255]
      .map((v) => Math.round(v + (end - v) * share).toString(16).padStart(2, "0")).join("");
  }

  function applyBrand(b) {
    if (!b || typeof b !== "object" || !COLOR.test(b.accent) || !COLOR.test(b.onAccent)) return;
    const root = document.documentElement;
    const forced = b.mode === "dark" || b.mode === "light";
    if (forced) root.dataset.mode = b.mode;
    const light = () => (forced ? b.mode === "light" : matchMedia(LIGHT).matches);
    const paint = () => {
      root.style.setProperty("--accent", b.accent);
      root.style.setProperty("--accent-2", mix(b.accent, light() ? "black" : "white", 0.15));
      root.style.setProperty("--on-accent", b.onAccent);
    };
    paint();
    if (!forced) matchMedia(LIGHT).addEventListener("change", paint);
    const name = typeof b.name === "string" ? b.name : "";
    if (name) $("topTitle").textContent = name;
    if (typeof b.logo === "string" && b.logo.startsWith("/meet/brand/logo?v=")) {
      // the pi mark stays until the logo has loaded, and for good if it does not
      const img = document.createElement("img");
      img.className = "mark";
      img.alt = name;
      img.addEventListener("load", () => {
        img.id = "topMark";
        $("topMark").replaceWith(img);
      });
      img.src = b.logo;
    }
    if (typeof b.welcome === "string" && b.welcome) {
      $("joinLead").textContent = b.welcome;
      $("joinLead").hidden = false;
    }
    if (typeof b.support === "string" && /^(https:\/\/|mailto:)/.test(b.support)) {
      $("brandHelp").href = b.support;
      $("brandHelp").hidden = false;
    }
  }

  async function loadBrand() {
    try {
      const resp = await fetch("/meet/api/brand", { credentials: "omit", cache: "no-cache", redirect: "error" });
      if (!resp.ok) return;
      const data = await resp.json();
      applyBrand(data && data.brand);
    } catch (e) {
      // the standard theme stays
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadBrand();
    const path = location.pathname.replace(/\/+$/, "");
    if (path === "/meet/join") startJoin();
    else startSignin();
  });
})();
