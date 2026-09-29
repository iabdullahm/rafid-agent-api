FROM apify/actor-node:24
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --include=dev
COPY src ./src
CMD ["node", "--import", "tsx", "src/entrypoint.ts"]
