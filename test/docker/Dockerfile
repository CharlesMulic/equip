FROM node:22-bookworm

WORKDIR /workspace

COPY . .

RUN npm ci

CMD ["npm", "run", "test:docker:acceptance:internal"]
