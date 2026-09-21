# GRAFT licensing service — dependency-free Node, secrets from the environment only.
FROM node:24-alpine
WORKDIR /srv/graft
COPY src ./src
COPY package.json ./package.json
ENV NODE_ENV=production PORT=8787 GRAFT_LICENSE_STORE=/data/licenses.json
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "src/cli.js"]
