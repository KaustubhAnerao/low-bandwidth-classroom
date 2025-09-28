# ✅ FIX: Updated the Node.js version from 18 to 20 to match the
# requirements of the node-poppler library.
FROM node:20-slim

# 2. Set the working directory inside the container
WORKDIR /usr/src/app

# 3. Update the package manager and install poppler-utils
RUN apt-get update && apt-get install -y poppler-utils --no-install-recommends && rm -rf /var/lib/apt/lists/*

# 4. Copy package.json and package-lock.json to the container
COPY package*.json ./

# 5. Install the Node.js dependencies
RUN npm install

# 6. Copy the rest of your application code into the container
COPY . .

# 7. Tell Docker what port the app will run on
EXPOSE 8080

# 8. Define the command to start your server
CMD [ "npm", "start" ]