# OpenMulti production image. Multi-stage: build (tsc -> dist), prod deps, runtime.
# OM-09 : image de base épinglée par digest (manifest list multi-arch de node:22-alpine),
# pas par tag mutable. Pour la bumper : re-résoudre le digest du tag
#   TOKEN=$(curl -s 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
#   curl -sI -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.oci.image.index.v1+json' \
#     https://registry-1.docker.io/v2/library/node/manifests/22-alpine | grep -i docker-content-digest
# puis remplacer les trois FROM d'un coup.
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
