module.exports = {
  BOT_NAME: "BOT BUILD BY MINZ",
  BOT_VERSION: "3.0",
  BOT_TOKEN: process.env.BOT_TOKEN || "8997739231:AAEuL-DLrRDloSWF7oY2HKyDCtKgX3vZcZw",
  ADMIN_IDS: (process.env.ADMIN_IDS || "8617552468").split(",").map(Number).filter(Boolean),

  
  CHANNEL_USERNAME: process.env.CHANNEL_USERNAME || "@infobuildingp",
CHANNEL_USERNAME2: process.env.CHANNEL_USERNAME2 || "@chmarga",
CHANNEL_USERNAME3: process.env.CHANNEL_USERNAME3 || "@MinzzRoxy",
  
  OWNER_ID: parseInt(process.env.OWNER_ID || "8617552468"),

  WELCOME_PHOTO: process.env.WELCOME_PHOTO || "https://files.catbox.moe/ix53g4.jpg",
  NEW_USER: process.env.NEW_USER || "https://files.catbox.moe/ix53g4.jpg",
  TMP_DIR: "./tmp",

  BUILD_TIMEOUT_MS: 30 * 60 * 10000,
  POLL_INTERVAL_MS: 7000,       
  WEB2APK_MAINTENANCE: false,
};
