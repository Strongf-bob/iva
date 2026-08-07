FROM node:24-bookworm-slim AS deps

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
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8723
LABEL org.opencontainers.image.source="https://github.com/Strongf-bob/iva"

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

COPY --from=build /app /app
RUN mkdir -p /app/data /app/memory /app/vault \
  && chown -R node:node /app

EXPOSE 8723

USER node

CMD ["npm", "run", "start"]
