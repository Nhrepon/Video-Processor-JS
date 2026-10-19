git reset --hard HEAD~1

git restore --staged *.mp4

git reset --soft HEAD~1


node src/scripts/cartoon_daily_pipeline.js
node src/scripts/cartoonToReels.js

npm run y2shorts -- --url <url> --download-only
npm run y2shorts -- <url> --download-only
npm run y2dl -- <url>


