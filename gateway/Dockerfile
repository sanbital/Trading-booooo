FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
COPY v17-stop-commands.mjs ./v17-stop-commands.mjs
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
