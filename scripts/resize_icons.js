const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.on('ready', () => {
  const iconPath = path.join(__dirname, '..', 'extension', 'icon.png');
  const img = nativeImage.createFromPath(iconPath);

  [16, 48, 128].forEach((s) => {
    const outPath = path.join(__dirname, '..', 'extension', `icon${s}.png`);
    fs.writeFileSync(outPath, img.resize({ width: s, height: s }).toPNG());
  });

  console.log('ICONS_RESIZED_SUCCESSFULLY');
  app.quit();
});
