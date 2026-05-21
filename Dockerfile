FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

# tzdata é necessário para que o timezone (TZ env) seja aplicado nas APIs
# de data/hora do Node (Date, toLocaleString) e nos logs.
RUN apk add --no-cache sqlite-libs tini tzdata && addgroup -S app && adduser -S app -G app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /app/data && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV PORT=3000
# Horário de Brasília — afeta logs, Date, etc. (pode ser sobrescrito via env)
ENV TZ=America/Sao_Paulo
EXPOSE 3000

VOLUME ["/app/data"]
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
