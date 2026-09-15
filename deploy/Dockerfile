FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "src/index.js", "--config", "/app/config.json", "--data", "/app/data/monitor.db"]
