FROM oven/bun:1.3.5-alpine

WORKDIR /app

COPY package.json ./
COPY convert-oversub-to-v2ray.js ./
COPY subscription-service.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "subscription-service.js"]
