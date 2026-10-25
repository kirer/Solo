# 一人公司 · 网页服务镜像
#
# 直接用 node --experimental-strip-types 跑 TypeScript，不需要 tsc 构建步骤：
# 运行时只需要源码 + 依赖，镜像更小、构建更快，也不会出现 dist 与 src 不一致。
#
# 构建/运行见 docs/DEPLOY.md。

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# 先只拷依赖清单：依赖没变时这一层可以命中缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 运行所需：源码、界面静态资源、脚本。test/ 与 docs/ 不进镜像。
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts

# 数据目录：数据库、settings.json、uploads/ 都在这里，必须挂卷持久化
RUN mkdir -p /app/workspace && chown -R node:node /app
VOLUME ["/app/workspace"]

ENV PORT=7788
ENV AI_COMPANY_HOST=0.0.0.0
EXPOSE 7788

# 非 root 运行。workspace 挂载目录需要对 uid 1000 可写（见 docs/DEPLOY.md）
USER node

CMD ["node", "--experimental-strip-types", "src/server/main.ts", \
     "--port", "7788", "--host", "0.0.0.0", "--no-open", \
     "--db", "/app/workspace/company.sqlite", "--workspace", "/app/workspace"]
