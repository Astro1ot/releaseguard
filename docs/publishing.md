# Publish the project

## GitHub

Create an empty repository under your account, then from this project directory:

```sh
git init -b main
git add .
git status --short
git commit -m "Build ReleaseGuard release engineering lab"
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

Inspect staged files before committing. `.env`, `.secrets`, node_modules, build output and raw artifacts are ignored. `package-lock.json` is intentionally included. Add a small sanitized evidence sample only after reviewing its contents.

The `Verify` workflow will run both the real Compose lab and the Kubernetes rollback rehearsal. Keep the evidence artifacts and link the successful workflow runs from README. Local run evidence is already included; do not present it as a GitHub-hosted CI run until those workflows finish.

Run `Publish image` manually when ready. It needs the repository's normal GitHub Actions package-write permission and publishes `ghcr.io/OWNER/REPOSITORY:COMMIT_SHA`. Repository/organization settings may require making the package readable for your deployment. No public repository or account was created automatically as part of generating this project.

Suggested description: **A Kubernetes release engineering lab with verified rollback, failure drills, a transactional outbox and observable recovery.**

Suggested topics: `kubernetes`, `helm`, `devops`, `github-actions`, `python`, `nestjs`, `postgresql`, `observability`, `portfolio`.

## Public demo

For the first publication, a public source repository, the screenshot and a 3–5 minute video are sufficient. The working local demo can be served as an explicitly labeled in-memory demonstration; it is not a real marketplace.

Before exposing a full lab, choose a host/domain, configure TLS and authentication for administrative surfaces, review trusted proxy IP handling, provision persistent dependencies, and move status monitoring outside the app. Do not expose Docker's API, PostgreSQL, Kafka, Redis, Prometheus or Grafana publicly by changing loopback bindings.

## Presenting the work honestly

Use: “Built a reproducible lab; verified [specific checks], measured [specific environment], documented [limitations].”

Avoid: “Operated production at scale,” “99.99% availability,” “zero downtime proven,” or “exactly once” without corresponding evidence. A finished, reproducible failure scenario is stronger than unsupported claims about a large stack.
