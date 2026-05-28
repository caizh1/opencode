FROM node:22-bookworm-slim AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful.
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    gzip \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    ripgrep \
    tar \
  && rm -rf /var/lib/apt/lists/*

COPY dist-linux/mermaid-cli-linux-x64.tar.gz /tmp/mermaid-cli-linux-x64.tar.gz
RUN set -eux; \
  node --version; \
  tar -xzf /tmp/mermaid-cli-linux-x64.tar.gz -C /usr/local/bin; \
  chmod +x /usr/local/bin/mmdc; \
  rm -f /root/.cache/opencode/bin/mmdc; \
  mmdc --version; \
  printf 'graph TD\nA-->B\n' > /tmp/mermaid-smoke.mmd; \
  mmdc -i /tmp/mermaid-smoke.mmd -o /tmp/mermaid-smoke.svg; \
  test -s /tmp/mermaid-smoke.svg; \
  rm /tmp/mermaid-smoke.mmd /tmp/mermaid-smoke.svg; \
  rm /tmp/mermaid-cli-linux-x64.tar.gz

COPY dist-linux/opencode-linux-x64/bin/opencode /usr/local/bin/opencode
RUN opencode --version

ENTRYPOINT ["opencode"]
