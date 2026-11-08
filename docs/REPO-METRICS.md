# Repo usage metrics

A daily GitHub Actions job keeps a history of release downloads, clones and repository views. GitHub itself keeps download counts only as running totals with no dates, and keeps clones and views for 14 days only. Design and rules: DECISIONS.md ADR-0525 (P-METRICS.1).

## Where the numbers are

- **`metrics` branch, `SUMMARY.md`:** the readable view. Per release: installer downloads by platform, the change over the last 7 days, and update checks. Then clones and views for the last 14 days, the recorded history, and top referrers.
- **`metrics` branch, `snapshots/<date>.json`:** everything GitHub reported that day, per release file.
- **`metrics` branch, `traffic-daily.json`:** clones and views per day, growing past GitHub's 14 days.
- **Actions, "repo metrics" run, Summary tab:** the same `SUMMARY.md` for that run.

## How to read them

- Counts are downloads, not people. GitHub does not record who downloaded a file.
- Installer downloads include apps updating themselves on Windows, because the updater downloads Setup.exe again.
- Update checks are reads of the `latest*.yml` files that installed apps poll. They show active installs checking in, not new installs.
- Unique cloners and unique visitors are only meaningful per day or per 14-day window. Do not add them up across days.

## One-time setup for clones and views

Release downloads are collected with no setup. Clones and views need one secret, because GitHub only shows traffic to tokens with the repository Administration permission, and a workflow's own token cannot have it.

1. On GitHub, open Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token.
2. Resource owner: the account that owns this repository. Repository access: Only select repositories, this repository only.
3. Repository permissions: Administration, Read-only. Leave every other permission at No access.
4. Pick an expiry and put a reminder in your calendar to rotate it.
5. In this repository, open Settings, Secrets and variables, Actions, New repository secret. Name it `METRICS_TRAFFIC_TOKEN` and paste the token.

Without the secret the job still saves release downloads and records traffic as "not collected". With a token that GitHub rejects, the job saves release downloads and fails red, naming the missing permission.

## Running it by hand

```
bun run tools/metrics/repo_metrics.ts collect --repo owner/name --dir <data dir>
bun run tools/metrics/repo_metrics.ts summary --dir <data dir>
```

`collect` reads `GITHUB_TOKEN` and `METRICS_TRAFFIC_TOKEN` from the environment. To start the scheduled job now, open Actions, "repo metrics", Run workflow.
