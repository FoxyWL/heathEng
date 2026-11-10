'use strict';
// Каталоги модов, плагинов и сборок для каждой игры: площадки, где их обычно берут.
// Ссылки открываются в браузере по умолчанию; открыть можно только адреса из этого списка.
const L = (ru, en) => ({ ru, en });

const SW = (name, appid) => ({ id: 'steam-workshop', name: 'Steam Workshop', url: `https://steamcommunity.com/app/${appid}/workshop/`, note: L(`Моды ${name} из Мастерской Steam`, `${name} mods from the Steam Workshop`) });
const NEXUS = (slug, name) => ({ id: 'nexus', name: 'Nexus Mods', url: `https://www.nexusmods.com/${slug}`, note: L(`Моды и сборки ${name}`, `${name} mods and packs`) });
const TSTORE = (slug, name) => ({ id: 'thunderstore', name: 'Thunderstore', url: `https://thunderstore.io/c/${slug}/`, note: L(`Моды ${name} с менеджером зависимостей`, `${name} mods with dependency manager`) });
const SOURCEMOD = { id: 'sourcemod', name: 'SourceMod', url: 'https://www.sourcemod.net/plugins.php', note: L('Плагины для серверов на движке Source', 'Plugins for Source engine servers') };
const METAMOD = { id: 'metamod', name: 'Metamod:Source', url: 'https://www.sourcemm.net/', note: L('Основа для плагинов Source и Source 2', 'Base layer for Source and Source 2 plugins') };
const AMXX = { id: 'amxx', name: 'AMX Mod X', url: 'https://www.amxmodx.org/', note: L('Плагины для серверов на GoldSrc (CS 1.6, DoD)', 'Plugins for GoldSrc servers (CS 1.6, DoD)') };
const GAMEBANANA = { id: 'gamebanana', name: 'GameBanana', url: 'https://gamebanana.com/', note: L('Карты, скины и моды для игр Valve', 'Maps, skins and mods for Valve games') };
const WIKI = { id: 'valve-wiki', name: 'Valve Developer Wiki', url: 'https://developer.valvesoftware.com/wiki/Dedicated_Servers_List', note: L('Список игр с выделенным сервером и их AppID', 'Games with a dedicated server and their AppIDs') };

const MC_MODRINTH = (kind) => ({ id: 'modrinth', name: 'Modrinth', url: `https://modrinth.com/${kind}`, primary: true, note: L('Основной каталог: открытые моды и плагины, поиск доступен прямо в Hearth', 'Main catalog: open mods and plugins, searchable right inside Hearth') });

const sources = {
  'minecraft-vanilla': [MC_MODRINTH('datapacks'), { id: 'modrinth-res', name: 'Modrinth: ресурспаки', url: 'https://modrinth.com/resourcepacks', note: L('Ресурспаки и шейдеры', 'Resource packs and shaders') }],
  'minecraft-paper': [MC_MODRINTH('plugins'), { id: 'hangar', name: 'Hangar', url: 'https://hangar.papermc.io/', note: L('Официальный каталог плагинов PaperMC', 'Official PaperMC plugin catalog') }, { id: 'spigot', name: 'SpigotMC', url: 'https://www.spigotmc.org/resources/', note: L('Крупнейший архив плагинов', 'The biggest plugin archive') }, { id: 'curseforge', name: 'CurseForge', url: 'https://www.curseforge.com/minecraft/bukkit-plugins', note: L('Плагины Bukkit и Paper', 'Bukkit and Paper plugins') }],
  'minecraft-folia': [MC_MODRINTH('plugins'), { id: 'hangar', name: 'Hangar', url: 'https://hangar.papermc.io/', note: L('Берите плагины с пометкой Folia', 'Pick plugins marked Folia-compatible') }],
  'minecraft-purpur': [MC_MODRINTH('plugins'), { id: 'hangar', name: 'Hangar', url: 'https://hangar.papermc.io/', note: L('Совместимо с Paper и Purpur', 'Works with Paper and Purpur') }, { id: 'spigot', name: 'SpigotMC', url: 'https://www.spigotmc.org/resources/', note: L('Крупнейший архив плагинов', 'The biggest plugin archive') }],
  'minecraft-fabric': [MC_MODRINTH('mods'), { id: 'curseforge', name: 'CurseForge', url: 'https://www.curseforge.com/minecraft/mc-mods', note: L('Моды для Fabric и Forge', 'Mods for Fabric and Forge') }],
  terraria: [{ id: 'steam-workshop', name: 'Steam Workshop (tModLoader)', url: 'https://steamcommunity.com/app/1281930/workshop/', primary: true, note: L('Моды для tModLoader', 'Mods for tModLoader') }, { id: 'tshock', name: 'TShock', url: 'https://github.com/Pryaxis/TShock/releases', note: L('Сервер с плагинами и правами игроков', 'Server with plugins and player permissions') }],
  cs16: [AMXX, GAMEBANANA, { id: 'metamod-p', name: 'Metamod-P', url: 'https://github.com/rehlds/Metamod-R', note: L('Metamod для GoldSrc', 'Metamod for GoldSrc') }],
  czero: [AMXX, GAMEBANANA],
  dod: [AMXX, GAMEBANANA],
  svencoop: [SW('Sven Co-op', 225840), { id: 'metamod-p', name: 'Metamod-P', url: 'https://github.com/rehlds/Metamod-R', note: L('Metamod для GoldSrc', 'Metamod for GoldSrc') }],
  cs2: [{ id: 'cssharp', name: 'CounterStrikeSharp', url: 'https://docs.cssharp.dev/', primary: true, note: L('Плагины на C# для CS2', 'C# plugins for CS2') }, METAMOD, SW('CS2', 730)],
  tf2: [{ ...SOURCEMOD, primary: true }, METAMOD, SW('Team Fortress 2', 440), GAMEBANANA],
  gmod: [{ ...SW("Garry's Mod", 4000), primary: true }, { id: 'gmod-wiki', name: 'Garry\'s Mod Wiki', url: 'https://wiki.facepunch.com/gmod/', note: L('Документация по серверу и аддонам', 'Server and addon documentation') }],
  l4d2: [{ ...SOURCEMOD, primary: true }, METAMOD, SW('Left 4 Dead 2', 550)],
  rust: [{ id: 'umod', name: 'uMod (Oxide)', url: 'https://umod.org/plugins', primary: true, note: L('Плагины для серверов Rust', 'Plugins for Rust servers') }, { id: 'codefling', name: 'Codefling', url: 'https://codefling.com/rust-plugins', note: L('Платные и бесплатные плагины', 'Paid and free plugins') }],
  ark: [{ ...SW('ARK', 346110), primary: true }],
  palworld: [{ ...NEXUS('palworld', 'Palworld'), primary: true }, TSTORE('palworld', 'Palworld')],
  valheim: [{ ...TSTORE('valheim', 'Valheim'), primary: true }, NEXUS('valheim', 'Valheim')],
  '7dtd': [{ ...NEXUS('7daystodie', '7 Days to Die'), primary: true }, SW('7 Days to Die', 251570)],
  zomboid: [{ ...SW('Project Zomboid', 108600), primary: true }],
  vrising: [{ ...TSTORE('v-rising', 'V Rising'), primary: true }],
  satisfactory: [{ id: 'ficsit', name: 'Satisfactory Mod Repository', url: 'https://ficsit.app/', primary: true, note: L('Каталог модов Satisfactory', 'Satisfactory mod catalog') }],
  unturned: [{ ...SW('Unturned', 304930), primary: true }],
  conan: [{ ...SW('Conan Exiles', 440900), primary: true }],
  custom: [WIKI],
  'steam-custom': [WIKI, { id: 'steamdb', name: 'SteamDB', url: 'https://steamdb.info/', note: L('Поиск AppID по названию игры или сервера', 'Find an AppID by game or server name') }],
};

const ALLOWED = new Set();
for (const list of Object.values(sources)) for (const s of list) ALLOWED.add(s.url);

function forGame(id) {
  return sources[id] || [];
}

function allowed(url) {
  return ALLOWED.has(String(url));
}

module.exports = { forGame, allowed, sources };
