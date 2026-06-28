# Linux deployment runbook (rpm / YUM·DNF + deb / APT)

How to package, sign, mirror, and install **LucidAgentIDE** on Linux from an
**internal** repository — `dnf install` / `apt install`, then `dnf upgrade` /
`apt upgrade` in place, preserving user data.

> **Part of PI-4 / ADR-A009 (issue #76).** The `.deb` and `.rpm` are built by
> [`build-desktop.yml`](../.github/workflows/build-desktop.yml) (electron-builder,
> `dist:linux`). Managed-config enforcement is the #74 channel; air-gap
> distribution is #73.

## Package facts

| Property | Value |
| --- | --- |
| Artifacts | `lucidagentide_${version}_amd64.deb`, `lucidagentide-${version}.x86_64.rpm`, `LucidAgentIDE-x86_64.AppImage` |
| Install location | `/opt/LucidAgentIDE/` + launcher `/usr/bin/lucidagentide` + `.desktop` entry |
| Package id | `lucidagentide` (appId `com.lucidagentide.desktop`) |
| Signature | **unsigned from CI** — the org signs with **its own** GPG key when populating the internal mirror (see §2) |
| Upgrade behavior | dnf/apt replace the files the package owns, in place |
| User data | `~/.config/LucidAgentIDE` (+ `~/.cache`, the encrypted graph / `knowledge.duckdb` / audit log) — **never packaged, never touched** on upgrade |
| Admin policy | `/etc/lucidagentide/managed-config.json` — **not packaged** (deployed via ADR-A010), so upgrades never clobber it |

Only x86_64 is built today (matches the AppImage target).

## Why upgrades never clobber user state

The package owns only the app under `/opt` + the launcher + the desktop entry. **No
user-editable file is shipped**, so an upgrade has nothing user-owned to overwrite:

- **Per-user state** (settings, the encrypted knowledge graph, `knowledge.duckdb`,
  the audit log) lives under `~/.config/LucidAgentIDE` / `~/.cache` — outside the
  package (ADR-A009 "userData-preserving upgrades").
- **Admin policy** (`/etc/lucidagentide/managed-config.json`) is deployed out of
  band (ADR-A010 / the add-on's `iac/ansible` role), not by this package.

If a future build ever ships an editable file under `/etc`, mark it so the package
managers treat it as a conffile / `%config(noreplace)` (dpkg keeps your edited copy;
rpm writes the new default as `.rpmnew`). With electron-builder that is one line:

```jsonc
// desktop/package.json  ->  build.deb / build.rpm
"deb": { "fpm": ["--config-files", "/etc/lucidagentide/<file>"] },
"rpm": { "fpm": ["--config-files", "/etc/lucidagentide/<file>"] }
```

`fpm --config-files` emits dpkg **conffiles** for the `.deb` and `%config(noreplace)`
for the `.rpm` from the same declaration. (Only add it once the file is actually in
the package — fpm errors on a config path it does not ship.)

## 1. Build the packages

CI (`build-desktop.yml`) builds them on `ubuntu-latest` and attaches `*.deb` /
`*.rpm` to the run artifacts and the release. Locally:

```bash
cd desktop
bun install
bun run dist:linux        # AppImage + .deb + .rpm into desktop/release/
```

(`.rpm` generation uses `rpmbuild`/`fpm`; on Debian/Ubuntu build hosts install the
`rpm` package first. Builds are unsigned — see §2.)

## 2. Sign with the organization's GPG key

CI ships **unsigned** packages (the vendor holds no per-customer key). The org signs
with **its** key when populating the internal mirror, so endpoints trust *your* key.

Generate/keep an RPM-compatible signing key (once), export the public key for clients:

```bash
gpg --batch --gen-key <<'EOF'
%no-protection
Key-Type: RSA
Key-Length: 4096
Name-Real: Acme LucidAgentIDE Repo
Name-Email: repo@acme.com
Expire-Date: 0
EOF
gpg --armor --export repo@acme.com > RPM-GPG-KEY-acme   # distribute to clients
```

**RPM (sign each package):**

```bash
cat > ~/.rpmmacros <<'EOF'
%_signature gpg
%_gpg_name repo@acme.com
EOF
rpm --addsign desktop/release/*.rpm
rpm --checksig desktop/release/*.rpm          # expect: digests signatures OK
```

**DEB:** APT trusts the **repository** (the signed `Release`), not individual
`.deb`s, so signing happens at the repo step (§3) — no per-file signing needed.
(Optional belt-and-suspenders: `dpkg-sig --sign builder *.deb`.)

## 3. Internal mirror layout

Serve both repos over plain HTTP(S) from an internal host (`repo.acme.com`). Nothing
leaves the network — suitable for air-gapped sites (§6).

### YUM/DNF (rpm)

```
/var/www/repo/lucidagentide/rpm/
├── RPM-GPG-KEY-acme
├── x86_64/
│   ├── lucidagentide-<version>.x86_64.rpm
│   └── repodata/                # created by createrepo_c
```

```bash
mkdir -p /var/www/repo/lucidagentide/rpm/x86_64
cp desktop/release/*.rpm /var/www/repo/lucidagentide/rpm/x86_64/
createrepo_c /var/www/repo/lucidagentide/rpm/x86_64
# sign the repo metadata so dnf can verify the index too
gpg --detach-sign --armor /var/www/repo/lucidagentide/rpm/x86_64/repodata/repomd.xml
cp RPM-GPG-KEY-acme /var/www/repo/lucidagentide/rpm/
```

Client config (push via your config-mgmt / the add-on `iac/ansible` role):

```ini
# /etc/yum.repos.d/lucidagentide.repo
[lucidagentide]
name=LucidAgentIDE (internal)
baseurl=https://repo.acme.com/lucidagentide/rpm/x86_64/
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://repo.acme.com/lucidagentide/rpm/RPM-GPG-KEY-acme
```

### APT (deb) — reprepro

```
/var/www/repo/lucidagentide/apt/
├── conf/distributions
├── dists/   pool/   …          # managed by reprepro
└── acme-archive-keyring.gpg     # the public key for clients
```

```bash
# conf/distributions
cat > /var/www/repo/lucidagentide/apt/conf/distributions <<'EOF'
Origin: Acme
Label: LucidAgentIDE
Codename: stable
Architectures: amd64
Components: main
Description: LucidAgentIDE internal APT repo
SignWith: repo@acme.com
EOF

cd /var/www/repo/lucidagentide/apt
reprepro includedeb stable /path/to/desktop/release/*.deb   # signs Release with the key above
gpg --armor --export repo@acme.com > acme-archive-keyring.gpg
```

Client config:

```bash
sudo install -m644 acme-archive-keyring.gpg /etc/apt/keyrings/acme.gpg
echo "deb [signed-by=/etc/apt/keyrings/acme.gpg] https://repo.acme.com/lucidagentide/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/lucidagentide.list
```

## 4. Install & upgrade (clients)

```bash
# RHEL / Fedora / Rocky / Alma
sudo dnf install lucidagentide          # or: yum install
sudo dnf upgrade lucidagentide          # in-place; ~/.config/LucidAgentIDE untouched

# Debian / Ubuntu
sudo apt update && sudo apt install lucidagentide
sudo apt upgrade                        # in-place; user data untouched
```

To publish a new version: rebuild, re-sign (§2), re-run `createrepo_c` / `reprepro`
(§3); clients pick it up on their next `dnf upgrade` / `apt upgrade`.

## 5. Disable the in-app updater (let the repo own the version)

In a managed fleet the package manager owns the version. Drop the admin-only policy
(see [`desktop/managed_config.ts`](../desktop/managed_config.ts)) at
`/etc/lucidagentide/managed-config.json`:

```json
{ "orgName": "Acme Corp", "updateChannel": "managed" }
```

`"managed"` disables the in-app update check; use `"feed"` + `updateFeedUrl` to point
electron-updater at an internal mirror instead. The file MUST be `root:root` and not
group/world-writable or the app ignores it (tamper guard):

```bash
sudo install -d -m 755 /etc/lucidagentide
sudo install -m 644 managed-config.json /etc/lucidagentide/managed-config.json
```

It only ever *adds* constraints — never relaxes the security gate. Deploy it fleet-wide
with the add-on's `iac/ansible` role (ADR-A010).

## 6. Air-gapped sites (#73)

The packages are self-contained (Bun + uv runtimes are bundled), so install needs no
network. Mirror the signed repo (§3) to the enclave's internal host; clients install
and upgrade entirely offline. Keep `updateChannel: "managed"` (or `"feed"` against the
internal mirror) so the app never reaches for the public release feed.

## Validation checklist (issue #76 "done when")

- [ ] `dnf install lucidagentide` / `apt install lucidagentide` install from the internal repo and launch.
- [ ] `dnf upgrade` / `apt upgrade` upgrade **in place**; `~/.config/LucidAgentIDE` is intact.
- [ ] A newer version published to the mirror is picked up by `upgrade`, preserving user data.
- [ ] `rpm --checksig` passes and `gpgcheck=1`/signed `Release` verify against the org key.
- [ ] `/etc/lucidagentide/managed-config.json` survives an upgrade untouched.

> Full validation requires the air-gap build profile (#73) for a no-network build/runner;
> the packaging targets, signing, mirror layout, and upgrade semantics here are
> independent of it and complete now.
