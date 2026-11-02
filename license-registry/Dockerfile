FROM node:22-alpine

RUN apk add --no-cache python3 ca-certificates

WORKDIR /app
ENV NODE_ENV=production PYTHONUNBUFFERED=1

# .dockerignore permits only runtime source and non-secret configuration.
# All credentials and durable state are supplied at runtime.
COPY . ./

CMD ["node", "server.mjs"]
