FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Copy package.json and package-lock.json from the root
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of your application code (all files from the root)
COPY . .

# Expose the port your app runs on (e.g., 3000 for your server.js)
EXPOSE 3000

# Command to run your application
CMD ["node", "server.js"]