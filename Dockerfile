FROM node:20-slim

# ffmpeg + Chromium dependencies install karo
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libcairo2 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

RUN mkdir -p /app/storage

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
