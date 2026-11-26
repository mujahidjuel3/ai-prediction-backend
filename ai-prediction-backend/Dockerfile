# NestJS API — long-running Node host (Render/Railway/Fly/VM). Not for Vercel serverless.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma Client inside Linux Bookworm (OpenSSL 3). Never reuse a Windows-generated client.
RUN npx prisma generate \
  && test -f node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node \
  && npm run build \
  && npm prune --omit=dev \
  && test -f node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 nest
COPY --from=build --chown=nest:nest /app/package.json /app/package-lock.json ./
COPY --from=build --chown=nest:nest /app/node_modules ./node_modules
COPY --from=build --chown=nest:nest /app/dist ./dist
COPY --from=build --chown=nest:nest /app/prisma ./prisma
# Fail the image build if the Azure/Bookworm Query Engine was stripped somehow.
RUN test -f node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node
USER nest
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node dist/main.js"]
