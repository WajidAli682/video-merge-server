FROM node:20-slim

# ffmpeg install karo (trim + merge ke liye zaroori)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Storage folder (temporary, jobs ke output ke liye)
RUN mkdir -p /app/storage

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
