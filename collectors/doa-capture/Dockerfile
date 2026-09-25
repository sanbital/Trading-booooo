FROM node:22.22.0-alpine
WORKDIR /capture
COPY core.mjs worker.mjs context.mjs ./
USER node
CMD ["node", "--max-old-space-size=160", "worker.mjs"]
