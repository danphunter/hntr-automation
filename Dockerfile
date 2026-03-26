FROM node:20-slim

# Install ffmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install dependencies
RUN npm install
RUN cd server && npm install
RUN cd client && npm install

# Copy all source
COPY . .

# Build the client
RUN cd client && npm run build

# Create uploads directory
RUN mkdir -p server/uploads server/renders

EXPOSE 3001

CMD ["node", "server/index.js"]
