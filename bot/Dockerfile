# Image officielle Playwright : Chromium et ses dépendances déjà installés
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY *.js ./

ENV NODE_ENV=production
# Mémoire des scripts et session du navigateur
VOLUME ["/app/profile"]
CMD ["node", "runner.js"]
