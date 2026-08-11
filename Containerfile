FROM node:24-trixie-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gh \
    pandoc \
    poppler-utils \
    python3 \
    python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir uv \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

FROM deps AS build
COPY . .
RUN uv venv --python python3 /opt/iva-userbot-venv \
  && uv pip sync --python /opt/iva-userbot-venv/bin/python \
    --require-hashes \
    --strict \
    services/telegram-userbot/requirements.lock \
  && npm run build

FROM deps AS runtime

WORKDIR /app
ARG GWS_VERSION=0.22.5
ENV NODE_ENV=production
ENV PORT=8723
LABEL org.opencontainers.image.source="https://github.com/Strongf-bob/iva"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    util-linux \
  && npm install --global "@googleworkspace/cli@${GWS_VERSION}" \
  && test "$(gws --version | sed -n '1p')" = "gws ${GWS_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
COPY --from=build /opt/iva-userbot-venv /opt/iva-userbot-venv
RUN mkdir -p /app/data /app/memory /app/vault \
  && chown -R node:node /app

EXPOSE 8723

USER node

CMD ["npm", "run", "start"]
