# ChipMate Word/Mermaid Render Server

This offline Docker service provides:

- `GET /health`
- `POST /render/word`
- `POST /render/mermaid`
- `GET /packages/<file>`

It is intended for Ubuntu/Linux x86-64 Docker hosts. The VSIX does not bundle LibreOffice, Poppler, or Chromium; ChipMate calls this service when `chipmate.wordRender.remoteEndpoint` is configured.

## Offline Install

Copy these files to the target server:

- `chipmate-word-render-<version>-linux-amd64.docker.tar.gz`
- `chipmate-word-render-<version>-linux-amd64.docker.tar.gz.sha256`
- `install-render-server.sh`

Then run:

```bash
sha256sum -c chipmate-word-render-<version>-linux-amd64.docker.tar.gz.sha256
chmod +x install-render-server.sh
./install-render-server.sh chipmate-word-render-<version>-linux-amd64.docker.tar.gz
```

The default endpoint is:

```text
http://<server-ip>:6001
```

Override defaults when needed:

```bash
PORT=6001 SERVICE_NAME=chipmate-word-render PACKAGE_ROOT_ON_HOST=/opt/chipmate/packages ./install-render-server.sh ./chipmate-word-render-<version>-linux-amd64.docker.tar.gz
```

## Smoke Tests

```bash
curl -fsS http://127.0.0.1:6001/health
curl -fsS -X POST http://127.0.0.1:6001/render/mermaid \
  -H 'content-type: application/json' \
  --data '{"source":"flowchart TD\nA[Start] --> B[Done]","filename":"smoke.mmd"}'
```

`/render/word` accepts JSON with `filename`, `docxBase64`, and optional `timeoutMs`.

## Package File Service

Files under the host directory mounted as `/packages` are available through:

```text
http://<server-ip>:6001/packages/<file>
```

Use this for future offline package distribution. The install script mounts `./packages` by default.
