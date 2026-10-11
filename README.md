# ci-workflows

Shared GitHub Actions CI for the create-tigra style repositories. One reusable workflow, one small detector, no per-project configuration: a project adds a 15-line caller ([templates/ci.yml](templates/ci.yml)) and gets the checks that fit what it contains.

This repository is **public on purpose**: a public repository can only call a public reusable workflow, and many of the projects are public. It contains no secrets and nothing project-specific.

## What runs

Everything runs on GitHub's machines, never on your PC.

| Job | What it does | When |
|---|---|---|
| detect | Looks at the repo, decides what applies, writes the plan on the run summary | always |
| checks (per app) | `npm ci`, then typecheck, lint, test, build. All four run even if one fails, so one run shows every problem | always |
| migrations | Prisma `migrate deploy` against a throwaway MySQL 8.4, then a drift check (schema file vs migration history) | the Prisma app's schema, migrations, `prisma.config`, `package.json` or lockfile changed (not seed scripts or data kept under `prisma/`) |
| docker-check | Every Dockerfile, without building it: the static rules below, plus `npm ci --dry-run` under the npm version the image's Node ships. Seconds | always (when the repo has a Dockerfile) |
| docker (per image) | `docker build`, and for images that need no database and no secrets (judged from Prisma and the `.env.example` beside the Dockerfile): start and probe | something that image is built from changed (see below) |
| audit | `npm audit --omit=dev --audit-level=high`, advisory (a warning, never a failure) | always |
| secrets | gitleaks over the pushed commits, values redacted. Fails on a finding | always |
| **CI** | One summary job. Fails if anything failed or detect raised a blocking finding | always |

Apps are looked for in `.`, `client`, `server`, `web`, `api`, `frontend`, `backend`. A script is only run if the app has it (`typecheck`, `type-check`, `check-types` or `tsc`; `lint`; `test`; `build`), and the `npm init` placeholder test script is ignored.

Blocking findings (they turn the **CI** job red): from **docker-check**, a `FROM` registry that exists on one machine only (`localhost:5000/...`, private IPs, `.local`), a `COPY` source that is missing (also when only the letter case differs) or hidden by `.dockerignore`, a `COPY --from` naming a stage that is not defined earlier, `npm ci` without a lockfile, and a lockfile the image's npm rejects; from **detect**, an app that uses pnpm or yarn only (unsupported, so it would otherwise be silently unchecked). Everything else is a warning annotation: unpinned image tags, no `HEALTHCHECK` or `curl`/`wget` for Coolify's health check, an `ARG` without a default copied into `ENV` (empty unless `docker-build-args` passes it), no lockfile, missing scripts.

### When an image is built

Never just because the push went to the default branch: projects push straight to `main` and CD waits for this CI, so that rule made every deploy wait for image builds. An image is built when one of these changed, and only that image:

- its Dockerfile, its `<Dockerfile>.dockerignore`, or the `.dockerignore` of its build context;
- a dependency file (`package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `.npmrc`) in the folder its `npm ci` installs from, or that folder's Prisma schema, migrations or `prisma.config`;
- a file or folder the Dockerfile copies by name (`COPY entrypoint.sh`, `COPY vendor ./vendor`, `COPY ai-runtime/src ./src`);
- anything in its build context when it copies the whole context (`COPY . .`) and no checks job compiles that code (a Python or Go service, an npm app outside the folders listed above).

Code inside a checked npm app is not a reason: the checks job compiles, lints, tests and builds it on every push, and docker-check covers the Dockerfile. A manual run, a first push or a force-push over a missing commit cannot know what changed, so everything is built. `docker: always` builds every image on every run.

The build context is the Dockerfile's folder, unless its `COPY` sources only exist from a parent folder (a monorepo Dockerfile such as project-fire's `ai-runtime`), in which case the image is built from there, as the servers build it.

## Use it in a project

Copy [templates/ci.yml](templates/ci.yml) to `.github/workflows/ci.yml` (change `main` if the default branch differs). Options, all optional:

| Input | Meaning |
|---|---|
| `skip` | Comma list of `typecheck, lint, test, build, migrations, docker, docker-check, audit, secrets` to turn off |
| `node-version` | Default: `.nvmrc`, then `engines.node`, then the Dockerfile's `FROM node:NN`, then 22 |
| `docker` / `migrations` | `auto` (default), `always`, `never`. `docker` covers image builds only; docker-check is turned off with `skip` |
| `docker-build-args` | Extra Docker build arguments, one `KEY=VALUE` per line, passed to every image build. For build-time values the image needs and the real deploy supplies (typically `NEXT_PUBLIC_*`). Public placeholders only, never secrets: they appear in the build log |

A known gitleaks false positive is allowed with a `.gitleaksignore` or `.gitleaks.toml` in the project (picked up automatically).

## A gate only if something depends on it

CI by itself only reports. It blocks nothing unless a pull request needs a green **CI** check before merging (branch protection: require the check named `ci / CI`), or a deploy step waits for it. Pushing straight to the default branch just produces a red or green mark after the fact.

## Where to read a result

Each run's summary page carries a "CI plan" (what ran and why), and a failed drift check lists the changed columns and tables there (`prisma migrate diff` exit code 2 is drift; any other failure is reported as the command failing, not as drift). The audit job lists each app's vulnerability count. `gh run view --log-failed` shows only "UNKNOWN STEP" for the jobs of a reusable workflow; read the job log through `gh api repos/OWNER/REPO/actions/jobs/JOB_ID/logs`, or use `ci_run.py` from the seed-plugins toolkit, which does that and prints just the failing steps.

The Docker job builds with the `network.host` permission granted, so a Dockerfile that uses `RUN --network=host ...` (as several of the server-built images do) is built in CI exactly as the servers build it.

## CD: deploy to Coolify after green CI

`templates/cd.yml` is a second small caller, written into a project by the seed-plugins `cd_setup.py` tool (a reviewed, confirmed step; never automatic). It runs when the project's **CI workflow succeeds for a push to the default branch** and calls the reusable `cd.yml`, which deploys the project's Coolify applications:

- **Only the commit CI tested.** Coolify deploys the latest commit of the branch, not a given one. If the branch has moved on since CI went green, the run deploys nothing and says so; the newer commit gets its own CI and CD run. If GitHub cannot say what the head is, nothing is deployed.
- **In order, to the end.** Apps are deployed one after the other in the order given (server before client); each deployment is followed until it is finished, failed, cancelled or timed out. The first failure stops the run and later apps are not touched. An app that already has a deployment queued or running is waited for, so two builds of one app never overlap. One CD run per repository at a time (`concurrency`, never cancelled half-way).
- **A finished build is not a working site.** The app's https domains are probed (health path or `/`) and must answer 2xx/3xx.
- **The token.** A Coolify API token with the `deploy` and `read` abilities only, in the repository secret `COOLIFY_TOKEN`. It is only sent to an `https://` Coolify URL, redirects are refused, it is never printed, and the workflow checks out no project code, so a pull request cannot get anything run with it. Fork pull requests cannot start the job at all.
- **No automatic rollback.** A failure ends with the failing app and which apps were not deployed. To go back, revert the commit on the default branch (CI then CD run again) or redeploy from Coolify.
- **Dry run.** The `dry-run` input reads, checks idleness and probes but never starts a deployment; the logic and its tests are in `.github/actions/coolify-deploy/` (`npm test` runs them against a fake Coolify).

GitHub cannot see a server's memory, so whether a server can take a build is checked when CD is set up (the toolkit's deploy-readiness verdict), not on every run.

## How a run decides (so the logs are never a mystery)

`detect` compares the pushed range (or the pull request range) to find changed files; the default branch is planned exactly like any other. If it cannot (first push, force-push over a missing commit, manual run) it assumes everything changed, which only ever runs more, never less. The decision and its reasons (which image is built and the file that caused it) are on the run's summary page under "CI plan"; docker-check adds its own section.

## Releasing a change

The reusable workflow references the detector as `.../actions/detect@v1`, because a workflow cannot refer to "my own ref". So the release process is:

1. Change, run `npm test` here, commit, push to `main`.
2. Move the tag: `git tag -f v1 && git push -f origin v1`. Every project on `@v1` picks it up on its next run.

Breaking changes get a new major tag (`v2`) and projects move deliberately. Never move `v1` to a commit that changes the inputs incompatibly.

## Limits (deliberate, for now)

- npm only (`package-lock.json`). pnpm and yarn repos are flagged, not checked.
- Ubuntu runners only, pinned to `ubuntu-24.04`. `ubuntu-latest` changes Ubuntu on GitHub's schedule (26 on 2026-10-19), which would change Docker, Node and every tool under all projects with no commit anywhere. To move on: change the pin in `ci.yml`, run the self-test, then move the tag.
- The drift check supports Prisma 6. On Prisma 7 it warns that it was skipped rather than guessing the new CLI flags.
- Build-time environment variables a project needs for `npm run build` or a Docker build are not provided by default; a project that needs them fails that step visibly. For Docker builds, supply public placeholders with the `docker-build-args` input.
- Private repositories draw on the account's monthly Actions minutes; public ones are free. The concurrency block in the caller, and the heavy jobs waking only on relevant changes, are the cost controls.

## Development

`npm test` runs the detector's and the Dockerfile check's offline unit tests (`node --test`, no dependencies, builds throwaway git repos as fixtures). `dockerfile-check.mjs` is a port of the seed-plugins `docker/dockerfile_check.py` (the tool agents run locally instead of a Docker build); a rule changed in one must be changed in the other. Locally: `node .github/actions/dockerfile-check/dockerfile-check.mjs --repo-root <project>` (`--no-lockfile` for no network). `self-test.yml` lints the workflow files with actionlint and runs this repository through its own CI. Lint locally the way the runner does, with shellcheck included (without it, shell problems inside `run:` blocks only show up after the push): `uv tool run --from actionlint-py --with shellcheck-py actionlint`. The audit tests need `jq`, which runners have.
