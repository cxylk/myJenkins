# ---------- build ----------
FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.6.2 \
 && printf 'registry=https://registry.npmmirror.com\n' > /root/.npmrc
WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY apps ./apps
RUN pnpm --filter @myjenkins/web build \
 && pnpm --filter @myjenkins/server build

# ---------- production dependencies only ----------
FROM node:24-alpine AS prod-deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.6.2 \
 && printf 'registry=https://registry.npmmirror.com\n' > /root/.npmrc
WORKDIR /app
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @myjenkins/server

# ---------- runtime ----------
FROM node:24-alpine AS runtime

ARG EXTRA_APK_PACKAGES=""

RUN apk add --no-cache \
      ca-certificates \
      curl \
      git \
      openssh-client \
      tini \
      tzdata \
      dotnet10-sdk \
      ${EXTRA_APK_PACKAGES}

RUN npm install -g pnpm@10.6.2

# 国内网络访问 registry.npmjs.org 容易 ECONNRESET，固定使用 npmmirror；
# store 放在 /data 下，容器重建后仍可复用已下载的依赖包。
RUN printf '%s\n' \
      'registry=https://registry.npmmirror.com' \
      'store-dir=/data/pnpm-store' \
      'fetch-retries=5' \
      'fetch-retry-mintimeout=10000' \
      'fetch-retry-maxtimeout=120000' \
      'fetch-timeout=300000' \
      > /home/node/.npmrc \
 && chown node:node /home/node/.npmrc

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

RUN mkdir -p /home/node/.nuget/NuGet \
 && printf '%s\n' \
      '<?xml version="1.0" encoding="utf-8"?>' \
      '<configuration>' \
      '  <packageSources>' \
      '    <clear />' \
      '    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />' \
      '    <add key="dhkj" value="http://101.200.219.56:8001/nuget" allowInsecureConnections="true" />' \
      '  </packageSources>' \
      '</configuration>' \
      > /home/node/.nuget/NuGet/NuGet.Config \
 && chown -R node:node /home/node/.nuget

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# 预建子目录：named volume 首次挂载时继承这里的属主（node:node）
RUN mkdir -p /data/workspaces /data/pnpm-store && chown -R node:node /app /data
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
