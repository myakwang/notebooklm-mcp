FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN npm run build

FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/

ENV NODE_ENV=production
EXPOSE 8080

# Required env vars (set at deploy time):
# PORT - assigned by platform (Zeabur, Railway, etc.)
# NOTEBOOKLM_COOKIES - Google NotebookLM cookies
# MCP_API_KEY - API key for MCP endpoint auth

CMD ["node", "dist/cli.js", "serve-remote"]
