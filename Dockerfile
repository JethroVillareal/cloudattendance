FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js storage.js postgres-schema.sql ./
COPY --chown=node:node public ./public

# The non-root runtime user needs a writable location for the JSON/audit
# fallback files created during server startup.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "server.js"]
