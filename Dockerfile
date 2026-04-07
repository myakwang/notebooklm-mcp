FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ dist/

ENV NODE_ENV=production
EXPOSE 3000

# Required env vars (set at deploy time):
# NOTEBOOKLM_COOKIES - Google NotebookLM cookies
# MCP_API_KEY - API key for MCP endpoint auth

CMD ["node", "dist/cli.js", "serve-remote", "--port", "3000"]
