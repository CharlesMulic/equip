FROM ghcr.io/astral-sh/uv:0.9.13 AS uv
FROM docker:27-cli AS docker-cli
FROM node:22-bookworm

WORKDIR /workspace

COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

COPY . .

RUN npm ci

CMD ["npm", "run", "test:docker:acceptance:internal"]
