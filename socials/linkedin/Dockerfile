FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=3000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
