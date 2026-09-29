FROM apify/actor-node:24
WORKDIR /usr/src/app
COPY package*.json ./
COPY apify/company-intelligence/package*.json ./apify/company-intelligence/
# The Actor entrypoint is TypeScript and uses the official tsx loader. Keep the
# loader in the image; the Rafid runtime dependencies remain production deps.
RUN npm ci && cd apify/company-intelligence && npm ci
COPY src ./src
COPY apify/company-intelligence ./apify/company-intelligence
WORKDIR /usr/src/app/apify/company-intelligence
CMD ["node", "--import", "tsx", "src/entrypoint.ts"]
