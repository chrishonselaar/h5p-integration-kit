FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src/ ./src/

# Create H5P directories
RUN mkdir -p h5p/libraries h5p/content h5p/temp h5p/core h5p/editor

EXPOSE 3000

CMD ["npm", "start"]
