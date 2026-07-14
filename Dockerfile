FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js storage.js postgres-schema.sql ./
COPY --chown=node:node public ./public

USER node

CMD ["node", "server.js"]
