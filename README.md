# ci-workflows

Shared GitHub Actions CI for the create-tigra style repositories. One reusable workflow, one small detector, no per-project configuration: a project adds a 15-line caller ([templates/ci.yml](templates/ci.yml)) and gets the checks that fit what it contains.

This repository is **public on purpose**: a public repository can only call a public reusable workflow, and many of the projects are public. It contains no secrets and nothing project-specific.

## What runs

Everything runs on GitHub's machines, never on your PC.

| Job | What it does | When |
|---|---|---|
| detect | Looks at the repo, decides what applies, writes the plan on the run summary | always |
| checks (per app) | `npm ci`, then typecheck, lint, test, build. All four run even if one fails, so one run shows every problem | always |
| migrations | Prisma `migrate deploy` against a throwaway MySQL 8.4, then a drift check (schema file vs migration history) | `prisma/` changed, or a push to the default branch |
| docker (per Dockerfile) | Static findings, `docker build`, and for images that need no database: start and probe | a Dockerfile, `.dockerignore`, `package*.json`, lockfile or `prisma/` changed, or a push to the default branch |
| audit | `npm audit --omit=dev --audit-level=high`, advisory (a warning, never a failure) | always |
| secrets | gitleaks over the pushed commits, values redacted. Fails on a finding | always |
| **CI** | One summary job. Fails if anything failed or detect raised a blocking finding | always |

Apps are looked for in `.`, `client`, `server`, `web`, `api`, `frontend`, `backend`. A script is only run if the app has it (`typecheck`, `type-check`, `check-types` or `tsc`; `lint`; `test`; `build`), and the `npm init` placeholder test script is ignored.

Blocking findings (they turn the **CI** job red): a Dockerfile whose `FROM` points at a registry that exists on one machine only (`localhost:5000/...`, private IPs, `.local`), and an app that uses pnpm or yarn only (unsupported, so it would otherwise be silently unchecked). Everything else the detector notices is a warning annotation: unpinned image tags, no `HEALTHCHECK` or `curl`/`wget` for Coolify's health check, no lockfile, missing scripts.

## Use it in a project

Copy [templates/ci.yml](templates/ci.yml) to `.github/workflows/ci.yml` (change `main` if the default branch differs). Options, all optional:

| Input | Meaning |
|---|---|
| `skip` | Comma list of `typecheck, lint, test, build, migrations, docker, audit, secrets` to turn off |
| `node-version` | Default: `.nvmrc`, then `engines.node`, then the Dockerfile's `FROM node:NN`, then 22 |
| `docker` / `migrations` | `auto` (default), `always`, `never` |

A known gitleaks false positive is allowed with a `.gitleaksignore` or `.gitleaks.toml` in the project (picked up automatically).

## A gate only if something depends on it

CI by itself only reports. It blocks nothing unless a pull request needs a green **CI** check before merging (branch protection: require the check named `ci / CI`), or a deploy step waits for it. Pushing straight to the default branch just produces a red or green mark after the fact.

## Where to read a result

Each run's summary page carries a "CI plan" (what ran and why), and a failed drift check lists the changed columns and tables there (`prisma migrate diff` exit code 2 is drift; any other failure is reported as the command failing, not as drift). The audit job lists each app's vulnerability count. `gh run view --log-failed` shows only "UNKNOWN STEP" for the jobs of a reusable workflow; read the job log through `gh api repos/OWNER/REPO/actions/jobs/JOB_ID/logs`, or use `ci_run.py` from the seed-plugins toolkit, which does that and prints just the failing steps.

## How a run decides (so the logs are never a mystery)

`detect` compares the pushed range (or the pull request range) to find changed files. If it cannot (first push, force-push over a missing commit, manual run) it assumes everything changed, which only ever runs more, never less. The decision and its reasons are on the run's summary page under "CI plan".

## Releasing a change

The reusable workflow references the detector as `.../actions/detect@v1`, because a workflow cannot refer to "my own ref". So the release process is:

1. Change, run `npm test` here, commit, push to `main`.
2. Move the tag: `git tag -f v1 && git push -f origin v1`. Every project on `@v1` picks it up on its next run.

Breaking changes get a new major tag (`v2`) and projects move deliberately. Never move `v1` to a commit that changes the inputs incompatibly.

## Limits (deliberate, for now)

- npm only (`package-lock.json`). pnpm and yarn repos are flagged, not checked.
- Ubuntu runners only, pinned to `ubuntu-24.04`. `ubuntu-latest` changes Ubuntu on GitHub's schedule (26 on 2026-10-19), which would change Docker, Node and every tool under all projects with no commit anywhere. To move on: change the pin in `ci.yml`, run the self-test, then move the tag.
- The drift check supports Prisma 6. On Prisma 7 it warns that it was skipped rather than guessing the new CLI flags.
- Build-time environment variables a project needs for `npm run build` or a Docker build are not provided; a project that needs them will fail that step visibly.
- Private repositories draw on the account's monthly Actions minutes; public ones are free. The concurrency block in the caller, and the heavy jobs waking only on relevant changes, are the cost controls.

## Development

`npm test` runs the detector's offline unit tests (`node --test`, no dependencies, builds throwaway git repos as fixtures). `self-test.yml` lints the workflow files with actionlint and runs this repository through its own CI.
