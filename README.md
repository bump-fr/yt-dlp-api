# yt-dlp API

Microservice HTTP pour extraire des métadonnées YouTube via yt-dlp.

## Endpoints

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/` | Health check |
| POST | `/api/video` | Métadonnées d'une vidéo |
| POST | `/api/channel` | Métadonnées d'une chaîne |
| POST | `/api/channel/videos` | Liste des vidéos d'une chaîne |

Tous les endpoints `/api/*` nécessitent un header `Authorization: Bearer <token>`.

## Développement local

```bash
# Installer les dépendances
npm install

# Installer yt-dlp
pip install yt-dlp

# Lancer en dev
npm run dev
```

## Déploiement Railway

1. Créer un nouveau projet sur [Railway](https://railway.app)
2. Connecter ce repo (ou déployer depuis le dossier `yt-dlp-api`)
3. Définir les variables d'environnement :
   - `PORT=3001`
   - `YT_DLP_API_TOKEN=<ton-token-secret>`
4. Railway détecte automatiquement le Dockerfile

## Déploiement Render

1. Créer un nouveau Web Service sur [Render](https://render.com)
2. Sélectionner "Docker" comme environnement
3. Pointer vers ce dossier
4. Définir les variables d'environnement

## Déploiement Hetzner/VPS

```bash
# Sur le serveur
git clone <repo>
cd yt-dlp-api

# Build et run avec Docker
docker build -t yt-dlp-api .
docker run -d -p 3001:3001 \
  -e YT_DLP_API_TOKEN=<ton-token> \
  --name yt-dlp-api \
  yt-dlp-api
```

## Utilisation

```bash
# Health check
curl https://your-api.railway.app

# Extraire métadonnées vidéo
curl -X POST https://your-api.railway.app/api/video \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```
