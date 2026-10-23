FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node cli/ ./cli/
COPY --chown=node:node skills/ ./skills/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENV YEET_DATA=/data YEET_PORT=3000 YEET_HOST=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.YEET_PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/server.mjs"]
