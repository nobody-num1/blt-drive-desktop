# BLT Drive Desktop

Client bureau Windows pour le BLT Drive : connecte ton compte Discord, importe des vidéos, transcode en local (ffmpeg) et uploade l'original + les renditions 720/480/360p. Inclut la connexion via navigateur externe et l'auto-mise à jour.

## Développer

```bash
npm install
npm start
```

## Builder (Windows)

```bash
npm run dist
```

Lanceur d'installation : `dist/BLT Drive Desktop Setup <version>.exe`

## Publier une mise à jour

```bash
git tag v<version> && git push origin v<version>
GH_TOKEN=<token> npm run dist -- --publish
```

L'application vérifie les mises à jour au démarrage et les installe toute seule.