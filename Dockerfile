# qa-analyzer runtime image. The base tag must match the installed @playwright/test
# version exactly (see package-lock.json), so the bundled browsers fit the library.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# git lets qa-analyzer read the HEAD commit message to find the ticket key.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production

# Bitbucket Pipelines ignores ENTRYPOINT and runs the step script instead,
# so pipeline steps call `node /app/dist/cli/main.js verify` explicitly.
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["--help"]
