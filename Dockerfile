# Specify the parent image from which we build
# The "apify/actor-node-playwright-chrome" image contains all the dependencies
# for running Chromium and Playwright.
FROM apify/actor-node-playwright-chrome:latest

# Copy all files from the current directory to the container
COPY . ./

# Install packages, skip installing Playwright browsers (already in the image)
# Run as root to ensure permissions are correct if needed, but Apify usually handles this
RUN npm install --include=dev --audit=false

# Specify the command to run the Actor
CMD npm start
