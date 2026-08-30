// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  PREFLIGHT_REMOTE, parseArgs, parsePreflight, preflightVerdict, provisionRemoteArgs, registerBody,
  scpArgs, sshArgs, sshTarget, tunnelArgs, verifyArgs, type SetupOptions,
} from "./setup-backend.ts";

const opts = (over: Partial<SetupOptions> = {}): SetupOptions => ({
  host: "gpu-box", user: "", port: 8188, remoteDir: "", identity: "", dryRun: false,
  skipProvision: false, skipVerify: false, withDcgm: false, skipTorch: false,
  torchIndex: "https://download.pytorch.org/whl/cu130", workflow: "", register: false, lucidPort: 5320, ...over,
});

describe("argument parsing is fail-closed", () => {
  test("a host is required", () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--host is required");
  });

  test("shell metacharacters in a host, user, or path are REFUSED, not escaped", () => {
    for (const argv of [
      ["--host", "box; rm -rf /"],
      ["--host", "box$(whoami)"],
      ["--host", "box`id`"],
      ["--host", "box|nc evil 1"],
      ["--host", "ok", "--user", "me;id"],
      ["--host", "ok", "--remote-dir", "/tmp/$(id)"],
      ["--host", "ok", "--identity", "~/.ssh/id;rm"],
    ]) {
      const r = parseArgs(argv);
      expect(r.ok).toBe(false);
    }
  });

  test("a plain host, alias, or user@host style all parse", () => {
    const r = parseArgs(["--host", "gpu-box.internal", "--user", "me"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(sshTarget(r.options)).toBe("me@gpu-box.internal");
    const alias = parseArgs(["--host", "workstation-gpu"]);
    expect(alias.ok).toBe(true);
    if (alias.ok) expect(sshTarget(alias.options)).toBe("workstation-gpu");
  });

  test("ports must be real integers in range", () => {
    for (const p of ["0", "70000", "-1", "abc", "8188.5"]) {
      const r = parseArgs(["--host", "h", "--port", p]);
      expect(r.ok).toBe(false);
    }
    const ok = parseArgs(["--host", "h", "--port", "9001"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.options.port).toBe(9001);
  });

  test("the torch index must be a plain https URL", () => {
    expect(parseArgs(["--host", "h", "--torch-index", "http://insecure/whl"]).ok).toBe(false);
    expect(parseArgs(["--host", "h", "--torch-index", "https://example.com/whl/cu130; rm"]).ok).toBe(false);
    expect(parseArgs(["--host", "h", "--torch-index", "https://download.pytorch.org/whl/cu130"]).ok).toBe(true);
  });

  test("flags land where they belong and defaults are sane", () => {
    const r = parseArgs(["--host", "h", "--dry-run", "--dcgm", "--skip-torch", "--register", "--workflow", "./graph.json"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options).toMatchObject({ dryRun: true, withDcgm: true, skipTorch: true, register: true, workflow: "./graph.json", port: 8188, lucidPort: 5320 });
  });
});

describe("every remote invocation is a fixed argv", () => {
  test("ssh uses keys only, a timeout, and never a shell string", () => {
    const argv = sshArgs(opts(), ["uname", "-m"]);
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("ConnectTimeout=10");
    expect(argv[argv.length - 2]).toBe("uname");
    expect(argv[argv.length - 1]).toBe("-m");
    expect(argv.join(" ")).not.toContain("&&");
  });

  test("an identity file is passed with -i, never concatenated", () => {
    const argv = sshArgs(opts({ identity: "/home/me/.ssh/id_ed25519" }), ["true"]);
    expect(argv[argv.indexOf("-i") + 1]).toBe("/home/me/.ssh/id_ed25519");
  });

  test("scp targets host:path as ONE argv entry", () => {
    const argv = scpArgs(opts({ user: "me" }), "/local/x.sh", "/tmp/x.sh");
    expect(argv[0]).toBe("scp");
    expect(argv[argv.length - 1]).toBe("me@gpu-box:/tmp/x.sh");
    expect(argv[argv.length - 2]).toBe("/local/x.sh");
  });

  test("the tunnel is a pipe only (-N) and binds the remote LOOPBACK", () => {
    const argv = tunnelArgs(opts({ port: 8188 }));
    expect(argv).toContain("-N");
    expect(argv[argv.indexOf("-L") + 1]).toBe("8188:127.0.0.1:8188");
    expect(argv.join(" ")).not.toContain("0.0.0.0");
  });

  test("the provisioner gets its options as separate argv entries", () => {
    const argv = provisionRemoteArgs(opts({ port: 9001, remoteDir: "/opt/comfy", withDcgm: true, skipTorch: true, dryRun: true }), "/tmp/p.sh");
    expect(argv.slice(0, 4)).toEqual(["bash", "/tmp/p.sh", "--port", "9001"]);
    expect(argv).toContain("--dir");
    expect(argv[argv.indexOf("--dir") + 1]).toBe("/opt/comfy");
    expect(argv).toContain("--dcgm");
    expect(argv).toContain("--skip-torch");
    expect(argv).toContain("--dry-run");
  });

  test("the preflight command reads the machine and never modifies it", () => {
    const cmd = PREFLIGHT_REMOTE.join(" ");
    expect(cmd).toContain("uname -m");
    expect(cmd).toContain("nvidia-smi --query-gpu");
    expect(cmd).toContain("python3 --version");
    for (const destructive of ["rm ", "mv ", "dd ", "mkfs", "> /", "curl ", "wget ", "apt", "pip install"]) {
      expect(cmd).not.toContain(destructive);
    }
  });

  test("the verifier is probe-only until a workflow is supplied", () => {
    expect(verifyArgs(opts())).not.toContain("--workflow");
    expect(verifyArgs(opts({ workflow: "./g.json" }))).toContain("--workflow");
    expect(verifyArgs(opts({ port: 9001 }))).toContain("http://127.0.0.1:9001");
  });
});

describe("preflight reading is honest about what it saw", () => {
  const good = [
    "aarch64", "Linux",
    "NVIDIA GB10, 590.12, 131072 MiB",
    "Python 3.12.4", "GIT_OK", "SYSTEMD_OK",
  ].join("\n");

  test("a full answer is parsed field by field", () => {
    const info = parsePreflight(good);
    expect(info).toMatchObject({ arch: "aarch64", os: "Linux", gpu: "NVIDIA GB10", driver: "590.12", python: "Python 3.12.4", hasGit: true, hasSystemd: true, hasNvidiaSmi: true });
  });

  test("a missing field stays empty rather than becoming a guess", () => {
    const info = parsePreflight(["x86_64", "Linux", "NO_NVIDIA_SMI", "NO_PYTHON", "NO_GIT", "NO_SYSTEMD"].join("\n"));
    expect(info.gpu).toBe("");
    expect(info.python).toBe("");
    expect(info.hasNvidiaSmi).toBe(false);
    expect(info.hasGit).toBe(false);
    expect(parsePreflight("").arch).toBe("");
  });

  test("no GPU, no python, or no git BLOCKS the install", () => {
    const v = preflightVerdict(parsePreflight(["aarch64", "Linux", "NO_NVIDIA_SMI", "NO_PYTHON", "NO_GIT"].join("\n")));
    expect(v.ok).toBe(false);
    expect(v.blockers.join(" ")).toContain("nvidia-smi");
    expect(v.blockers.join(" ")).toContain("python3");
    expect(v.blockers.join(" ")).toContain("git");
  });

  test("an aarch64 host gets the CUDA 13 note, and the GPU line is echoed", () => {
    const v = preflightVerdict(parsePreflight(good));
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("cu130");
    expect(v.notes.join(" ")).toContain("sm_121");
    expect(v.notes.join(" ")).toContain("NVIDIA GB10");
  });

  test("a non-Linux or systemd-less host is a NOTE, not a blocker", () => {
    const v = preflightVerdict(parsePreflight(["x86_64", "Darwin", "NVIDIA X, 1, 2 MiB", "Python 3.11.0", "GIT_OK", "NO_SYSTEMD"].join("\n")));
    expect(v.ok).toBe(true);
    expect(v.notes.join(" ")).toContain("assume a Linux host");
    expect(v.notes.join(" ")).toContain("no systemd");
  });
});

describe("the registered declaration carries no secret", () => {
  test("it points at the tunnel, is zoned internal, and has a slugged id", () => {
    const body = registerBody(opts({ host: "GPU Box.internal", port: 9001 }));
    expect(body.endpoint).toMatchObject({ providerId: "comfyui", baseUrl: "http://127.0.0.1:9001", zone: "internal", enabled: true });
    expect(body.endpoint.id).toBe("comfyui-gpu-box-internal");
  });

  test("no credential-shaped field appears anywhere in it", () => {
    const json = JSON.stringify(registerBody(opts()));
    for (const banned of ["token", "secret", "password", "apiKey", "vaultRef", "authorization"]) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
