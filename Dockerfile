FROM node:20-alpine
WORKDIR /app
COPY index.html server.js package.json ./
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
