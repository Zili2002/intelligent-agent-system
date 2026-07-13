FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY .npmrc package.json package-lock.json ./
COPY packages ./packages

RUN npm ci --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

ENTRYPOINT ["node", "packages/autonomous-agent/dist/cli.js"]
CMD ["--help"]
