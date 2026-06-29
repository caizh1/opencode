FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    fonts-dejavu \
    fonts-liberation \
    fonts-noto-cjk \
    chromium \
    libreoffice-writer \
    poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY server.js /app/server.js

ENV PORT=6001 \
    PACKAGE_ROOT=/packages \
    MAX_DOCX_BYTES=52428800 \
    MAX_MERMAID_SOURCE_BYTES=524288 \
    RENDER_TIMEOUT_MS=120000

EXPOSE 6001

CMD ["node", "/app/server.js"]
