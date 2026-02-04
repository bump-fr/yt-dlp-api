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
   - (optionnel mais souvent nécessaire) cookies YouTube pour éviter le blocage anti-bot :
     - `YT_DLP_COOKIES_B64=<base64_du_fichier_cookies_txt>`
     - ou `YT_DLP_COOKIES=<contenu_multiligne_du_fichier_cookies_txt>`
     - ou `YT_DLP_COOKIES_FILE=/path/dans_le_container` (si tu montes un fichier)
   - (optionnel) `YT_DLP_VERBOSE=1` pour des logs yt-dlp très détaillés
4. Railway détecte automatiquement le Dockerfile

### Notes cookies (anti-bot YouTube)

Si tu vois une erreur du type “Sign in to confirm you’re not a bot”, il faut fournir des cookies à `yt-dlp`.

- **Exporter les cookies** depuis ton navigateur (format Netscape `cookies.txt`) en étant connecté à YouTube.\n- **Ne jamais commit** le fichier cookies.\n- Sur Railway, le plus simple est de mettre le contenu en base64 dans `YT_DLP_COOKIES_B64`.\n
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
