# Clip worker. Built from the repository root (Railway), so paths include server/.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ .

CMD ["node", "index.js"]
