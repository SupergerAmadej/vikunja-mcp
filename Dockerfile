FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 9090

COPY package.json package-lock.json LICENSE ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD node --eval "fetch('http://127.0.0.1:'+(process.env.PORT||9090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
