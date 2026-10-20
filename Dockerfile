FROM node:20-slim

WORKDIR /app

# ffmpeg: transcodea a Opus los tracks que se suben a R2 (POST /api/cdn-cache)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Instalar dependencias (incluye devDependencies para poder compilar TS)
COPY package.json package-lock.json* ./
RUN npm install

# Copiar código fuente y compilar
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Limpiar devDependencies tras compilar (imagen más liviana)
RUN npm prune --omit=dev

# Hugging Face Spaces (Docker SDK) expone el puerto 7860 por defecto
EXPOSE 7860
ENV PORT=7860

CMD ["node", "dist/server.js"]
