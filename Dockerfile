FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY agent.js ./
CMD ["node", "agent.js"]
