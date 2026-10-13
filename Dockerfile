FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY data/ ./data/
COPY public/ ./public/
RUN mkdir -p data/accounts && chmod -R 777 data
ENV NODE_ENV=production
CMD ["node", "src/server.mjs"]
