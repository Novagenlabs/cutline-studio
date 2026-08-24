# One app: the cutter UI, the account pages and the API are all served by
# Next. There is no separate front-end container and no nginx in front of it.
# Prisma's query engine links against OpenSSL, which node:*-slim does not
# include — without it the build warns and falls back to guessing a version.
FROM node:22-slim AS deps
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-slim AS build
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build:cutter bundles the cutter's TypeScript into public/cutline/app.js,
# then prisma generate + next build produce the server.
RUN npm run build

FROM node:22-slim AS run
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
# @napi-rs/canvas is a native module, so node_modules is carried over rather
# than relying on a fully self-contained bundle.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
# Bind to every interface: the default localhost binding is unreachable from
# outside the container, so the proxy would get connection refused.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
CMD ["npm", "run", "start"]
