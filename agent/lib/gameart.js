'use strict';
// Откуда брать настоящие значки игр. app: номер игры (клиента) в Steam: по нему берётся обложка из CDN Steam;
// wiki: название статьи в Википедии (для игр вне Steam, например Minecraft): обложка берётся из карточки статьи.
// Номера приложений серверов (appId в gamedefs) для картинок не подходят: у серверных приложений обложек обычно нет.
const ART = {
  'minecraft-vanilla': { wiki: 'Minecraft' },
  'minecraft-paper': { wiki: 'Minecraft' },
  'minecraft-folia': { wiki: 'Minecraft' },
  'minecraft-purpur': { wiki: 'Minecraft' },
  'minecraft-fabric': { wiki: 'Minecraft' },
  terraria: { app: 105600 },
  cs16: { app: 10 },
  czero: { app: 80 },
  dod: { app: 30 },
  svencoop: { app: 225840 },
  cs2: { app: 730 },
  tf2: { app: 440 },
  gmod: { app: 4000 },
  l4d2: { app: 550 },
  rust: { app: 252490 },
  ark: { app: 346110 },
  palworld: { app: 1623730 },
  valheim: { app: 892970 },
  '7dtd': { app: 251570 },
  zomboid: { app: 108600 },
  vrising: { app: 1604030 },
  satisfactory: { app: 526870 },
  unturned: { app: 304930 },
  conan: { app: 440900 },
};

module.exports = { ART };
