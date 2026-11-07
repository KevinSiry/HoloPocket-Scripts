FROM node:22-alpine
WORKDIR /app
COPY package.json server.js hash-password.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production
RUN mkdir /data && chown node /data
VOLUME ["/data"]
USER node
EXPOSE 8080
CMD ["node", "server.js"]
