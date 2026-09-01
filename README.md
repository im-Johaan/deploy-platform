# Automated Deployment Platform

Give it a GitHub URL, get back a working URL.

```
POST /deploy {repoUrl}
  ↓
[upload]   clone → tar.gz → PUT sources/<id>.tar.gz → LPUSH build:queue
  ↓
[worker]   BLPOP → GET tarball → build in disposable container → PUT builds/<id>/**
  ↓
[proxy]    GET abc123xy.localhost:3000/assets/x.js → builds/abc123xy/assets/x.js → stream
```

Static site hosting: the build artifact is a `dist/` folder in object storage.
Nothing runs per deployment — one proxy serves every site by mapping
subdomain → storage prefix.

## Layout

| Path             | What it is                                                     |
|------------------|----------------------------------------------------------------|
| `packages/core`  | Shared contract: config, types, Redis keys, S3 storage, id/host helpers |
| `apps/upload`    | HTTP API + web UI — accepts a repo, snapshots source, enqueues (:3002) |
| `apps/worker`    | Queue consumer — builds in a container, uploads artifacts       |
| `apps/proxy`     | Serves deployments by subdomain                        (:3000) |
| `scripts/smoke`  | Proves MinIO + Redis + config are wired up                     |

### Upload API

| Route              | Behaviour                                              |
|--------------------|--------------------------------------------------------|
| `POST /deploy`     | `{repoUrl, branch?, outputDir?}` → `202` with id + URL. Clone runs in the background. |
| `GET /status/:id`  | The deployment record, or `404`.                        |
| `GET /logs/:id`    | Build logs. Streams as SSE with `Accept: text/event-stream`, otherwise JSON. |

### Build worker

Builds run in a disposable `node:22-bookworm-slim` container — **not** Alpine,
whose musl libc breaks the prebuilt binaries of esbuild, SWC, Rollup and sharp.

Source is copied *in* and output copied *out*; no bind mounts. They are slow
through Docker's macOS VM, and once the worker is itself containerized a `-v`
path would have to be a host path rather than the worker's own.

| Concern            | Handling                                                |
|--------------------|---------------------------------------------------------|
| Package manager    | From the lockfile: npm / pnpm / yarn (corepack). `npm ci` only when `package-lock.json` exists. |
| Output directory   | Container writes `/app/.outdir`; probed `dist`, `build`, `out`, `public`. `public` last — it is an *input* dir for Vite/CRA. |
| Reading the marker | `docker cp` (works on a stopped container; `docker exec` does not). |
| Resource caps      | `--memory 2g --cpus 2 --pids-limit 512 --security-opt no-new-privileges` |
| `NODE_ENV`         | Deliberately **not** `production` — that skips devDependencies, where the build tool lives. |
| Timeout            | 10 min, then `docker rm -f`. Containers removed in a `finally`. |
| Content-Type       | Stamped at upload from the file extension, so the proxy can stream it back. |

### Request handler

Subdomain is the storage prefix, so serving is one object lookup — no database
join on the hot path.

| Case                          | Response                                       |
|-------------------------------|------------------------------------------------|
| `/` or `/docs/`               | `index.html` / `docs/index.html`               |
| Hit                           | Stream, `Content-Type` from object metadata (extension fallback) |
| Miss, no file extension       | `index.html` with **200** — the SPA fallback   |
| Miss, has extension           | `404`                                          |
| Path containing `..`          | `400` — rejected after decoding, not normalised away |
| Deployment not `READY`        | `503` + `Retry-After`                          |
| Deployment `FAILED`           | `502` with the build error                     |
| Unknown / reserved subdomain  | `404`                                          |
| Non-GET/HEAD                  | `405` + `Allow`                                |

Assets get `max-age=31536000, immutable` — deployments are immutable, since a
new deploy means a new id and a new hostname. HTML stays `no-cache`.

## Running

```bash
npm install
npm run infra:up     # redis :6380, minio :9100 (console :9101)
npm run smoke        # verify infra wiring
npm run test         # unit tests (validation boundary)
npm run dev          # all three services
```

Then open **http://localhost:3002** — paste a repo, watch the build stream, get a link.

Or from the terminal:

```bash
curl -X POST localhost:3002/deploy -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/sveltejs/template"}'
# -> {"id":"khgshptl","url":"http://khgshptl.localhost:3000","status":"CLONING",...}

curl localhost:3002/status/khgshptl
curl localhost:3002/logs/khgshptl

# follow the build live
curl -N -H 'Accept: text/event-stream' localhost:3002/logs/khgshptl
```

SSE replays the log history first, then streams live lines, and closes itself
once the deployment reaches READY or FAILED.

Ports avoid the `ard-*` stack already on this machine (6379, 5432, 9000/9001, 3001).

```bash
curl localhost:3002/health
curl localhost:3000/health
curl http://abc123xy.localhost:3000/     # *.localhost needs no /etc/hosts entry
```

## Running in containers

One `Dockerfile`, three targets. All three services share `@adp/core` and the
root lockfile, so the dependency layer is built once and reused; only the
per-service extras differ.

| Target   | Extra tooling      | Why                                              |
|----------|--------------------|--------------------------------------------------|
| `upload` | `git`              | Clones repositories. **Not** in `node:*-slim`.   |
| `worker` | `docker` CLI       | Drives the host daemon. Needs no git — it reads source tarballs from storage. |
| `proxy`  | none               | Streams objects only.                            |

```bash
cp .env.prod.example .env.prod          # then edit the S3 keys
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Redis and MinIO are unpublished — only the services reach them. Verified end to
end in containers: a repo deploys in ~20s and is served by the containerized proxy.

### The worker builds *sibling* containers

With `/var/run/docker.sock` mounted, containers the worker starts are children
of the **host** daemon, not of the worker. This is exactly why the build copies
source in and out with `docker cp` instead of bind-mounting it: `docker cp`
streams through the daemon API and works across the boundary, whereas a `-v`
path is resolved on the host — where the worker's `/app/.data/work/<id>` does
not exist. Bind mounting would have broken the moment the worker was containerized.

> **Security:** the socket mount grants the worker **root-equivalent access to
> the host**. From inside it, `docker ps` lists every container on the machine,
> and `docker run -v /:/host` would expose the whole filesystem. Acceptable on a
> private VM you own; before anything wider, put a socket proxy in front
> restricting the API to `create`/`start`/`cp`/`rm`, or move builds to a
> dedicated VM.

## TLS with Caddy

Caddy is the only service facing the internet; `upload` and `proxy` bind to
loopback behind it.

```
<domain>          →  upload  (UI + API)
*.<domain>        →  proxy   (deployments)
```

```bash
# in .env.prod
ROOT_DOMAIN=project1.abc.in
ACME_EMAIL=you@abc.in
PUBLIC_SCHEME=https
PUBLIC_PORT=443

docker compose -f docker-compose.prod.yml --env-file .env.prod --profile tls up -d --build
```

**On-demand TLS, not a wildcard certificate.** Deployment subdomains are created
dynamically, so instead of one `*.domain` certificate (which would require the
DNS-01 challenge and a Caddy image rebuilt with your DNS provider's plugin),
Caddy issues a normal per-hostname certificate the first time each subdomain is
requested. Nothing provider-specific, and the stock `caddy:2-alpine` image works.

The catch is that on-demand issuance is only safe when it is gated: otherwise
anyone hitting `random.<domain>` triggers a certificate request and exhausts the
Let's Encrypt limit of 50 certs per week per registered domain. Caddy's
`on_demand_tls.ask` calls `upload:/tls-check` first, which answers `200` only
for hostnames that map to a real deployment, and `404` for everything else —
unknown ids, reserved names, and unrelated domains.

`PUBLIC_SCHEME` / `PUBLIC_PORT` only change the URL string the app hands out;
Caddy is what actually terminates TLS. Keep the `caddy-data` volume — it holds
the issued certificates.

## Deploying to a VM

1. **DNS** — a wildcard `A` record `*.<domain>` → the VM's IP, plus `<domain>`
   itself. Without the wildcard, deployment subdomains will not resolve.
2. **`.env.prod`** — set `ROOT_DOMAIN`, `PUBLIC_PORT=80`, `PROXY_PUBLISH_PORT=80`,
   and real S3 credentials. `deploymentUrl()` omits the port when it is the
   default for the scheme, so URLs come out as `http://abc123.<domain>`.
3. **TLS** — run the `tls` profile; see the Caddy section above.
4. **Firewall** — only Caddy's 80/443 need to be open; `upload` and `proxy` are
   already bound to loopback. There is still **no authentication**: anyone who
   can reach the upload service can run builds on your VM.
5. **Architecture** — images built on an Apple Silicon Mac are `arm64` and will
   not run on a standard `amd64` VM. Build on the VM (`--build`), or use
   `docker buildx build --platform linux/amd64`.

## State

| Store | Key                | Purpose                          |
|-------|--------------------|----------------------------------|
| Redis | `dep:<id>`         | HASH — the deployment record     |
| Redis | `build:queue`      | LIST — LPUSH upload, BLPOP worker|
| Redis | `logs:<id>`        | LIST — build output              |
| Redis | `logs:<id>:events` | pub/sub — live log streaming     |
| S3    | `sources/<id>.tar.gz` | source snapshot               |
| S3    | `builds/<id>/**`   | build artifacts, served directly |

## Build order

1. ~~`core` + infra~~ — done, verified by `npm run smoke`
2. ~~`apps/upload`~~ — done: validate, clone, tarball, enqueue
3. ~~`apps/worker`~~ — done: containerized build, artifact upload
4. ~~`apps/proxy`~~ — done: subdomain serving, MIME types, SPA fallback
5. ~~Log streaming (SSE)~~ — done

All five planned steps are complete: a GitHub URL becomes a live URL in ~25s.
