FROM node:20-slim

WORKDIR /app

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
