const { app } = require('electron');
app.on('ready', () => {
  try {
    require('better-sqlite3');
    console.log('SUCCESS_SQLITE_ELECTRON');
  } catch (e) {
    console.error('ERROR_SQLITE_ELECTRON:', e.message);
  }
  app.quit();
});
