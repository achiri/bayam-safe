# Production image: API + Telegram bot + checkout page.
FROM node:22-alpine AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY backend/package.json ./backend/
COPY web ./web
USER node
EXPOSE 4000
WORKDIR /app/backend
CMD ["node", "dist/index.js"]
