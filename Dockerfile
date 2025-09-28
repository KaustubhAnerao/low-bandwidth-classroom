# 1. Start with an official Node.js image
FROM node:18-slim

# 2. Set the working directory inside the container
WORKDIR /usr/src/app

# 3. Update the package manager and install poppler-utils
# This is the crucial step that installs the system dependency
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